import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BRIDGE_HOME } from './config.js';

// Small persistent store, split by how often each part changes:
// - state.json, rewritten after Claude turns, so it stays small:
//   - sessions[sid].lastTurnId: newest completed bridged turn, used to spot rollbacks/forks
//   - sessions[sid].threadId / agentMessageIds: owning Codex chat and delivered agent messages
//   - contextWindows[model]: real context window reported by Claude Code
// - state.catalogs.json (beside state.json), rewritten only when a catalog actually changes:
//   - keys[requestContextHash]: which catalog a client/account last received, for upstream outages
//   - bodies[contentHash]: each distinct GPT catalog once
//   - latest: last observed catalog, for housekeeping model selection
// Before 2026-10-25 every catalog lived in state.json (`upstreamCatalogs`, `upstreamModels`) and the
// whole file (16 MB live) was rewritten after every model-list request and turn. Those fields are
// migrated on load and dropped at the next save; an older bridge reading the new state.json simply
// starts without outage fallbacks.

export const CATALOG_KEY_LIMIT = 16; // Request contexts (client version x account) retained for outage fallback.
const SAVE_DELAY_MS = 200; // Session markers: coalesced, but written promptly.
const CATALOG_SAVE_DELAY_MS = 60_000; // Outage fallbacks only: even a catalog whose content changes on every fetch is written at most once a minute.

function digest(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // first run or unreadable: start empty
  }
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? { text, value } : null;
  } catch {
    return null;
  }
}

export function catalogFileFor(stateFile) {
  return stateFile.endsWith('.json') ? `${stateFile.slice(0, -5)}.catalogs.json` : `${stateFile}.catalogs.json`;
}

function emptyCatalogs() {
  return { latest: null, keys: {}, bodies: {} };
}

export class State {
  constructor(file = path.join(BRIDGE_HOME, 'state.json'), { catalogFile = catalogFileFor(file), catalogKeyLimit = CATALOG_KEY_LIMIT, catalogSaveDelayMs = CATALOG_SAVE_DELAY_MS } = {}) {
    this.file = file;
    this.catalogFile = catalogFile;
    this.catalogKeyLimit = catalogKeyLimit;
    this.catalogSaveDelayMs = catalogSaveDelayMs;
    this.data = { sessions: {}, contextWindows: {}, catalogs: emptyCatalogs() };
    this.timer = null;
    this.catalogTimer = null;
    this.legacyCatalogsPending = false; // Migrated catalogs not yet on disk: write them before the state file that drops their legacy copy.
    this.legacyCatalogFallback = null;
    this.dirty = { state: false, catalogs: false };
    this.written = { state: null, catalogs: null }; // Digests of the content on disk, so unchanged saves are skipped.
    this.bytes = { state: 0, catalogs: 0 };
    this.counters = { writes: 0, bytesWritten: 0, skippedWrites: 0, writeErrors: 0, unchangedCatalogs: 0, lastWriteMs: null };

    let legacy = null;
    const loaded = readJson(file);
    if (loaded) {
      const { upstreamCatalogs, upstreamModels, catalogs: _ignored, ...rest } = loaded.value;
      this.data = { ...this.data, ...rest, catalogs: this.data.catalogs };
      if (!this.data.sessions || typeof this.data.sessions !== 'object') this.data.sessions = {};
      if (!this.data.contextWindows || typeof this.data.contextWindows !== 'object') this.data.contextWindows = {};
      this.written.state = digest(loaded.text);
      this.bytes.state = Buffer.byteLength(loaded.text);
      if (upstreamCatalogs !== undefined || upstreamModels !== undefined) {
        legacy = { upstreamCatalogs, upstreamModels };
        this.dirty.state = true; // Written at the next real save, never from this constructor: a failed second instance must not overwrite a running bridge.
      }
    }
    const loadedCatalogs = readJson(this.catalogFile);
    if (loadedCatalogs) {
      this.data.catalogs = this.normalizeCatalogs(loadedCatalogs.value);
      this.written.catalogs = digest(loadedCatalogs.text);
      this.bytes.catalogs = Buffer.byteLength(loadedCatalogs.text);
    } else if (legacy) {
      this.migrateLegacyCatalogs(legacy);
    }
    this.lastCatalogUse = Math.max(0, ...Object.values(this.data.catalogs.keys).map((entry) => entry.at));
    if (this.trimCatalogs()) this.dirty.catalogs = true;
  }

  // Strictly increasing, so contexts used within the same millisecond still have a clear recency order.
  catalogUseTime() {
    this.lastCatalogUse = Math.max(Date.now(), this.lastCatalogUse + 1);
    return this.lastCatalogUse;
  }

  isLatestTurn(sid, turnId) {
    return this.data.sessions[sid]?.lastTurnId === turnId;
  }

  // Which Codex thread owns a Claude session (another thread resuming it = fork).
  ownerThread(sid) {
    return this.data.sessions[sid]?.threadId ?? null;
  }

  agentMessageIds(sid) {
    return this.data.sessions[sid]?.agentMessageIds ?? [];
  }

  recordAgentMessageIds(sid, agentMessageIds) {
    this.data.sessions[sid].agentMessageIds = agentMessageIds; // A tool continuation acknowledges messages without advancing the pending session marker.
    this.save();
  }

  recordTurn(sid, turnId, threadId = null, agentMessageIds = this.agentMessageIds(sid)) {
    const prev = this.data.sessions[sid] || {};
    this.data.sessions[sid] = {
      lastTurnId: turnId,
      threadId: threadId || prev.threadId || null,
      agentMessageIds, // Only delivered IDs are retained; replayed cross-chat messages must not consume context again after a process or service restart.
      updatedAt: new Date().toISOString(),
    };
    this.prune();
    this.save();
  }

  setContextWindow(model, size) {
    if (!size || this.data.contextWindows[model] === size) return;
    this.data.contextWindows[model] = size;
    this.save();
  }

  contextWindow(model) {
    return this.data.contextWindows[model] ?? null;
  }

  /** Records a successful catalog for one request context. Unchanged catalogs cause no write. */
  setUpstreamModels(models, cacheKey) {
    const catalogs = this.data.catalogs;
    const hash = this.addCatalogBody(models);
    const changed = catalogs.keys[cacheKey]?.hash !== hash;
    catalogs.keys[cacheKey] = { hash, at: this.catalogUseTime() }; // Recency is kept in memory and persisted with the next real catalog change.
    catalogs.latest = hash;
    if (!changed) {
      this.counters.unchangedCatalogs++;
      return;
    }
    this.trimCatalogs();
    this.dirty.catalogs = true;
    this.scheduleCatalogs();
  }

  /** The last good catalog for this exact client/account context, or null. */
  upstreamCatalog(cacheKey) {
    const entry = this.data.catalogs.keys[cacheKey];
    const body = entry && this.data.catalogs.bodies[entry.hash];
    if (!body) return null;
    entry.at = this.catalogUseTime();
    return body;
  }

  /** The most recently observed catalog from any client, for housekeeping model selection. */
  upstreamModels() {
    const { latest, bodies } = this.data.catalogs;
    return (latest && bodies[latest]) || null;
  }

  addCatalogBody(models) {
    const hash = digest(JSON.stringify(models));
    this.data.catalogs.bodies[hash] ??= models;
    return hash;
  }

  normalizeCatalogs(value) {
    const catalogs = emptyCatalogs();
    for (const [hash, models] of Object.entries(value.bodies || {})) if (Array.isArray(models)) catalogs.bodies[hash] = models;
    for (const [key, entry] of Object.entries(value.keys || {})) {
      if (typeof entry?.hash === 'string' && catalogs.bodies[entry.hash]) catalogs.keys[key] = { hash: entry.hash, at: Number(entry.at) || 0 };
    }
    if (typeof value.latest === 'string' && catalogs.bodies[value.latest]) catalogs.latest = value.latest;
    return catalogs;
  }

  migrateLegacyCatalogs({ upstreamCatalogs, upstreamModels }) {
    const entries = Object.entries(upstreamCatalogs && typeof upstreamCatalogs === 'object' ? upstreamCatalogs : {});
    entries.forEach(([key, models], index) => {
      if (!Array.isArray(models)) return;
      this.data.catalogs.keys[key] = { hash: this.addCatalogBody(models), at: index + 1 }; // Legacy entries have no timestamps; keep their insertion order so the newest survive the bound.
    });
    if (Array.isArray(upstreamModels)) this.data.catalogs.latest = this.addCatalogBody(upstreamModels);
    if (entries.length || Array.isArray(upstreamModels)) {
      this.dirty.catalogs = true;
      this.legacyCatalogsPending = true;
      this.legacyCatalogFallback = { upstreamCatalogs, upstreamModels }; // Retain the old schema on disk if the separate cache cannot be written.
    }
  }

  /** Keeps the most recently used request contexts and drops catalog bodies none of them use. */
  trimCatalogs() {
    const catalogs = this.data.catalogs;
    let changed = false;
    const entries = Object.entries(catalogs.keys);
    if (entries.length > this.catalogKeyLimit) {
      entries.sort((a, b) => b[1].at - a[1].at);
      catalogs.keys = Object.fromEntries(entries.slice(0, this.catalogKeyLimit));
      changed = true;
    }
    const used = new Set(Object.values(catalogs.keys).map((entry) => entry.hash));
    if (catalogs.latest) used.add(catalogs.latest);
    for (const hash of Object.keys(catalogs.bodies)) {
      if (!used.has(hash)) {
        delete catalogs.bodies[hash];
        changed = true;
      }
    }
    return changed;
  }

  prune() {
    const entries = Object.entries(this.data.sessions);
    if (entries.length <= 2000) return;
    entries.sort((a, b) => (a[1].updatedAt < b[1].updatedAt ? 1 : -1));
    this.data.sessions = Object.fromEntries(entries.slice(0, 1500));
  }

  save() {
    this.dirty.state = true;
    this.schedule();
  }

  // Coalesce bursts without postponing forever: the first pending change fixes when the write happens,
  // so continuous turn activity cannot starve the durable session-marker write.
  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushState();
    }, SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  scheduleCatalogs() {
    if (this.catalogTimer) return;
    this.catalogTimer = setTimeout(() => {
      this.catalogTimer = null;
      this.flushCatalogs();
    }, this.catalogSaveDelayMs);
    this.catalogTimer.unref?.();
  }

  /** Writes everything pending now (planned exits and tests). */
  flush() {
    if (this.catalogTimer) {
      clearTimeout(this.catalogTimer);
      this.catalogTimer = null;
    }
    this.flushCatalogs();
    this.flushState();
  }

  flushState() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.legacyCatalogsPending) this.flushCatalogs(); // A failed migration retains its legacy fields while still persisting durable session markers.
    if (this.dirty.state && this.writeFile('state', this.file, JSON.stringify(this.stateData(), null, 2))) this.dirty.state = false;
  }

  flushCatalogs() {
    if (!this.dirty.catalogs) return;
    if (this.writeFile('catalogs', this.catalogFile, JSON.stringify(this.catalogData()))) {
      this.dirty.catalogs = false;
      if (this.legacyCatalogsPending) {
        this.legacyCatalogFallback = null;
        this.dirty.state = true;
        this.schedule(); // Also remove the legacy copy after a successful delayed retry.
      }
      this.legacyCatalogsPending = false;
    }
  }

  stateData() {
    const { catalogs: _catalogs, ...rest } = this.data;
    return this.legacyCatalogsPending ? { ...rest, ...this.legacyCatalogFallback } : rest;
  }

  catalogData() {
    const { latest, keys, bodies } = this.data.catalogs;
    return { version: 1, latest, keys, bodies };
  }

  writeFile(kind, file, text) {
    const hash = digest(text);
    if (hash === this.written[kind]) {
      this.counters.skippedWrites++;
      return true;
    }
    const started = process.hrtime.bigint();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
    } catch (err) {
      this.counters.writeErrors++;
      console.error(`[bridge] could not save state: ${err.message}`);
      return false;
    }
    const bytes = Buffer.byteLength(text);
    this.written[kind] = hash;
    this.bytes[kind] = bytes;
    this.counters.writes++;
    this.counters.bytesWritten += bytes;
    this.counters.lastWriteMs = Number(process.hrtime.bigint() - started) / 1e6;
    return true;
  }

  /** Sizes and counters for /health and resource log lines; no session or catalog contents. */
  stats() {
    return {
      sessions: Object.keys(this.data.sessions).length,
      catalogKeys: Object.keys(this.data.catalogs.keys).length,
      catalogBodies: Object.keys(this.data.catalogs.bodies).length,
      stateBytes: this.bytes.state,
      catalogBytes: this.bytes.catalogs,
      pendingWrite: Boolean(this.timer || this.catalogTimer),
      ...this.counters,
    };
  }
}
