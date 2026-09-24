#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { loadConfig, BASE_PATH, BRIDGE_HOME } from './config.js';
import { State } from './state.js';
import { parseCodexRequest, buildClaudeUserMessage, sanitizeInputForOpenAI, makeMarker } from './codexInput.js';
import { ResponsesStream, usageObject, rid } from './responsesStream.js';
import { runClaudeTurn, compactSession, claudeCapabilities } from './claudeRunner.js';
import { mergeCatalog, fallbackGptModel } from './catalog.js';

const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
]);

function makeLogger(level) {
  const ts = () => new Date().toISOString();
  return {
    info: (m) => level !== 'error' && console.log(`${ts()} [bridge] ${m}`),
    error: (m) => console.error(`${ts()} [bridge] ERROR ${m}`),
    debug: (m) => level === 'debug' && console.log(`${ts()} [bridge] ${m}`),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function decodeBody(raw, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  if (!enc || enc === 'identity') return raw;
  if (enc === 'zstd') {
    if (typeof zlib.zstdDecompressSync !== 'function') {
      throw new Error(
        'Codex sent a zstd-compressed body but this Node has no zstd support. Use Node >= 22.15, or set `[features] enable_request_compression = false` in ~/.codex/config.toml.',
      );
    }
    return zlib.zstdDecompressSync(raw);
  }
  if (enc === 'gzip') return zlib.gunzipSync(raw);
  if (enc === 'br') return zlib.brotliDecompressSync(raw);
  if (enc === 'deflate') return zlib.inflateSync(raw);
  throw new Error(`unsupported content-encoding ${enc}`);
}

// A real Codex agent turn (vs. a housekeeping call like title generation).
// Tools arrive either in `tools` or, in Codex's "responses-lite" shape, as an
// `additional_tools` input item; agent turns also always carry <environment_context>.
export function isAgentTurn(body) {
  if (Array.isArray(body.tools) && body.tools.length > 0) return true;
  const input = Array.isArray(body.input) ? body.input : [];
  return input.some(
    (i) =>
      i?.type === 'additional_tools' ||
      i?.type === 'compaction_trigger' ||
      (i?.type === 'message' &&
        Array.isArray(i.content) &&
        i.content.some((c) => typeof c?.text === 'string' && c.text.includes('<environment_context>'))),
  );
}

export function createBridge(config = loadConfig(), state = new State()) {
  const log = makeLogger(config.logLevel);
  const claudeSlugs = new Map(config.models.map((m) => [m.slug, m]));
  const isClaude = (model) => claudeSlugs.has(model);

  function forwardHeaders(req, { bodyRewritten }) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();
      if (HOP_BY_HOP.has(key)) continue;
      if (key === 'accept-encoding') continue; // fetch negotiates and decodes itself
      if (bodyRewritten && key === 'content-encoding') continue;
      headers[key] = v;
    }
    if (bodyRewritten) headers['content-type'] = 'application/json';
    return headers;
  }

  async function passthrough(req, res, subpath, query, body, { bodyRewritten = false } = {}) {
    const url = `${config.upstream}${subpath}${query}`;
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    let upstream;
    try {
      upstream = await fetch(url, {
        method: req.method,
        headers: forwardHeaders(req, { bodyRewritten }),
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      log.error(`upstream ${subpath} failed: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `bridge could not reach OpenAI: ${err.message}` } }));
      }
      return;
    }
    const headers = {};
    upstream.headers.forEach((v, k) => {
      if (HOP_BY_HOP.has(k) || k === 'content-encoding') return;
      headers[k] = v;
    });
    res.writeHead(upstream.status, headers);
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body)
      .on('error', () => res.destroy())
      .pipe(res);
  }

  async function handleModels(req, res, subpath, query) {
    let upstreamModels = null;
    let etag = null;
    try {
      const r = await fetch(`${config.upstream}${subpath}${query}`, {
        headers: forwardHeaders(req, { bodyRewritten: false }),
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        const json = await r.json();
        upstreamModels = json.models;
        etag = r.headers.get('etag');
        state.setUpstreamModels(upstreamModels);
      } else {
        log.error(`model catalog upstream returned ${r.status}`);
      }
    } catch (err) {
      log.error(`model catalog fetch failed: ${err.message}`);
    }
    if (!upstreamModels) upstreamModels = state.data.upstreamModels || [];
    const models = mergeCatalog(config, state, upstreamModels);
    const headers = { 'content-type': 'application/json' };
    if (etag) {
      const extra = JSON.stringify([config.models, state.data.contextWindows]);
      headers.etag = `"ccb-${crypto.createHash('sha1').update(etag + extra).digest('hex').slice(0, 16)}"`;
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify({ models }));
  }

  async function handleClaudeResponses(req, res, body, modelCfg) {
    const parsed = parseCodexRequest(body, (sid, turnId) => state.isLatestTurn(sid, turnId));
    const stream = new ResponsesStream(res, { model: body.model });
    stream.begin();

    if (parsed.hasCompactionTrigger) {
      // Codex wants to compact a Claude thread: compact the Claude session instead.
      const sid = parsed.marker?.sid;
      let newSid = sid;
      if (sid) {
        stream.reasoning('**Compacting Claude Code context**');
        const keep = setInterval(() => stream.keepAlive(), config.keepAliveSeconds * 1000);
        const r = await compactSession({ config, sid, cwd: parsed.cwd, log });
        clearInterval(keep);
        newSid = r.sessionId;
      }
      const turnId = rid('t');
      stream.compaction(newSid ? makeMarker(newSid, turnId) : 'ccb:v1:none:none');
      if (newSid) state.recordTurn(newSid, turnId);
      stream.complete(usageObject());
      return;
    }

    const userMessage = buildClaudeUserMessage(parsed, { newSession: !parsed.resume });
    if (config.debugDumpDir) dump('claude-prompt', { parsed: { ...parsed, images: parsed.images.length }, userMessage });
    await runClaudeTurn({
      config,
      state,
      stream,
      parsed,
      modelCfg,
      effort: body.reasoning?.effort,
      userMessage,
      log,
      req,
    });
  }

  function dump(kind, obj) {
    try {
      fs.mkdirSync(config.debugDumpDir, { recursive: true });
      const file = path.join(config.debugDumpDir, `${Date.now()}-${kind}.json`);
      fs.writeFileSync(file, JSON.stringify(obj, null, 2));
    } catch {
      // debugging only
    }
  }

  function localOnly(req) {
    const addr = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) return 'not loopback';
    if (req.headers.origin) return 'browser origin';
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return 'bad host';
    return null;
  }

  async function handle(req, res) {
    const denied = localOnly(req);
    if (denied) {
      res.writeHead(403);
      return res.end();
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, models: config.models.map((m) => m.slug) }));
    }
    if (!url.pathname.startsWith(BASE_PATH)) {
      res.writeHead(404);
      return res.end();
    }
    const subpath = url.pathname.slice(BASE_PATH.length) || '/';
    const query = url.search || '';

    if (req.method === 'GET' && subpath === '/models') return handleModels(req, res, subpath, query);
    if (req.method === 'GET' || req.method === 'HEAD') return passthrough(req, res, subpath, query, undefined);

    const raw = await readBody(req);
    const encoding = req.headers['content-encoding'];
    let body = null;
    const isJson = String(req.headers['content-type'] || '').includes('json');
    if (isJson) {
      try {
        body = JSON.parse(decodeBody(raw, encoding).toString('utf8'));
      } catch (err) {
        log.error(`could not read ${subpath} body: ${err.message}`);
        if (/zstd/.test(err.message)) {
          res.writeHead(500, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: err.message } }));
        }
      }
    }
    if (!body) return passthrough(req, res, subpath, query, raw);
    if (config.debugDumpDir && subpath.startsWith('/responses')) dump('request', { subpath, body });

    const modelCfg = claudeSlugs.get(body.model);
    if (subpath === '/responses' && modelCfg && isAgentTurn(body)) {
      try {
        return await handleClaudeResponses(req, res, body, modelCfg);
      } catch (err) {
        log.error(`claude turn crashed: ${err.stack || err}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: String(err.message || err) } }));
        } else if (!res.writableEnded) res.end();
        return;
      }
    }

    // Everything else goes to OpenAI. Housekeeping calls made "as" a Claude model
    // (titles, summaries, memories) are answered by a GPT model instead.
    let rewritten = false;
    if (isClaude(body.model)) {
      body.model = fallbackGptModel(config, state);
      if (body.reasoning?.effort && !['low', 'medium', 'high'].includes(body.reasoning.effort)) body.reasoning.effort = 'medium';
      rewritten = true;
      log.info(`routed Claude-model housekeeping request ${subpath} to ${body.model}`);
    }
    if (Array.isArray(body.input)) {
      const s = sanitizeInputForOpenAI(body.input);
      if (s.changed) {
        body.input = s.input;
        rewritten = true;
      }
    }
    if (rewritten) return passthrough(req, res, subpath, query, JSON.stringify(body), { bodyRewritten: true });
    return passthrough(req, res, subpath, query, raw);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error(`request failed: ${err.stack || err}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  // Codex tries Responses-over-WebSocket first; 426 makes it switch to HTTP at once.
  server.on('upgrade', (req, socket) => {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });

  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 65000;

  return { server, log, config, state };
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (isMain) {
  const { server, log, config } = createBridge();
  claudeCapabilities(config.claudePath).then((caps) => {
    if (!caps.ok) log.error(`claude CLI not found at "${config.claudePath}" — set claudePath in ${BRIDGE_HOME}/config.json`);
    else log.info(`claude CLI ok (${config.claudePath})`);
  });
  server.listen(config.port, config.host, () => {
    log.info(`listening on http://${config.host}:${config.port}${BASE_PATH} → ${config.upstream}`);
    log.info(`Claude models: ${config.models.map((m) => `${m.displayName} (${m.slug})`).join(', ')}`);
  });
  // Reload after code updates: exit once idle and let launchd restart us with the new code.
  let active = 0;
  let reloadPending = false;
  server.on('request', (req, res) => {
    active++;
    res.on('close', () => {
      active--;
      if (reloadPending && active === 0) process.exit(0);
    });
  });
  const srcDir = path.dirname(fs.realpathSync(new URL(import.meta.url).pathname));
  try {
    fs.watch(srcDir, { persistent: false }, (_e, file) => {
      if (!file || !file.endsWith('.js') || reloadPending) return;
      reloadPending = true;
      log.info(`${file} changed; restarting when idle`);
      setTimeout(() => active === 0 && process.exit(0), 500);
    });
  } catch (err) {
    log.error(`could not watch ${srcDir}: ${err.message}`);
  }
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
