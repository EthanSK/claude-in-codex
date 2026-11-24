import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const neon = {
  slug: 'gemini-4-neon', displayName: 'Gemini 4 Neon', antigravityModel: 'gemini-4-neon',
};

const bridgeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-neon-config-'));
process.env.CODEX_CLAUDE_BRIDGE_HOME = bridgeHome;
after(() => fs.rmSync(bridgeHome, { recursive: true, force: true }));

test('Antigravity models are opt-in, preserve the default routes and expose their supported settings', async () => {
  const { loadModels } = await import('../src/config.js');
  const { mergeCatalog } = await import('../src/catalog.js');
  const defaults = loadModels();
  const file = path.join(bridgeHome, 'config.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ antigravityModels: [neon] }));
    assert.deepEqual(loadModels(), [...defaults, neon]);
    const catalog = mergeCatalog({ models: loadModels() }, { contextWindow: () => null }, []);
    const listed = catalog.find((m) => m.slug === neon.slug);
    assert.deepEqual(listed.supported_reasoning_levels.map(({ effort }) => effort), ['low', 'medium', 'high', 'xhigh']);
    assert.deepEqual(listed.service_tiers, []);
    assert.deepEqual(listed.input_modalities, ['text', 'image']);
    assert.equal(listed.shell_type, 'shell_command');
    fs.writeFileSync(file, JSON.stringify({ antigravityModels: [{ ...neon, claudeModel: 'opus' }] }));
    assert.throws(loadModels, /exactly one claudeModel or antigravityModel/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

function runAdapter(scenario, expectedStatus = 0) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-neon-'));
  const resume = 'agy-8ec454da-f0d0-48bf-b487-429d0d2005fa';
  try {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../src/antigravityAdapter.js', import.meta.url))], {
      cwd: home,
      env: {
        ...process.env,
        PATH: [path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
        HOME: home,
        GEMINI_API_KEY: 'sentinel',
        FAKE_AGY_SCENARIO: scenario,
      },
      input: JSON.stringify({
        agy: fileURLToPath(new URL('./fixtures/fake-agy.js', import.meta.url)),
        model: neon.antigravityModel, effort: 'low', planMode: true, resume,
        system: 'system notes',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'image-data' } }],
        tools: ['echo'], mcpServers: [],
      }) + '\n',
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(run.error, undefined);
    assert.equal(run.status, expectedStatus, run.stdout + run.stderr);
    return run.stdout.trim().split('\n').map(JSON.parse);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('Antigravity resumes without replay, maps attachments and grants only current Codex tools once', () => {
  const events = runAdapter('');
  assert.deepEqual(events.filter((e) => e.type === 'stream_event').map((e) => e.event.delta), [
      { type: 'thinking_delta', thinking: 'Thinking' },
      { type: 'text_delta', text: 'Verified' },
    ]);
  assert.equal(events.at(-1).session_id, 'agy-8ec454da-f0d0-48bf-b487-429d0d2005fa');
  assert.equal(events.at(-1).usage.output_tokens, 7);
});

test('Antigravity continues a reasoning-only turn once and sends the visible reply', () => {
  const events = runAdapter('reasoning-only');
  assert.deepEqual(events.filter((e) => e.event?.delta?.type === 'text_delta').map((e) => e.event.delta.text), ['Visible continuation']);
  assert.equal(events.at(-1).usage.input_tokens, 12);
  assert.equal(events.at(-1).usage.output_tokens, 4);
});

test('Antigravity continues a cancelled request when its only tool was denied', () => {
  const events = runAdapter('denied-tool');
  assert.deepEqual(events.filter((e) => e.event?.delta?.type === 'text_delta').map((e) => e.event.delta.text), ['Recovered after a denied tool']);
});

test('Antigravity reports an empty answer after an approved tool without replaying work', () => {
  const events = runAdapter('approved-tool', 1);
  assert.equal(events.at(-1).is_error, true);
  assert.match(events.at(-1).result, /stopped before giving a final reply/);
});

test('Antigravity switches providers and then compacts the same native session with pending tool output', async () => {
  const { createBridge } = await import('../src/server.js');
  const { DEFAULTS } = await import('../src/config.js');
  const { State } = await import('../src/state.js');
  const state = new State(path.join(bridgeHome, 'state.json'));
  const vars = ['FAKE_AGY_SCENARIO', 'HOME', 'PATH'];
  const envBefore = vars.map((key) => [key, process.env[key]]);
  process.env.FAKE_AGY_SCENARIO = 'compact';
  process.env.HOME = bridgeHome;
  process.env.PATH = [path.dirname(process.execPath), process.env.PATH].join(path.delimiter);
  const { server } = createBridge({
    ...DEFAULTS, models: [neon], logLevel: 'error',
    antigravityPath: fileURLToPath(new URL('./fixtures/fake-agy.js', import.meta.url)),
  }, state);
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    async function compact(input) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/backend-api/codex/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'thread-id': 'checkpoint-thread' },
        body: JSON.stringify({ model: neon.slug, reasoning: { effort: 'low' }, input: [...input, { type: 'compaction_trigger' }] }),
      });
      const data = await res.text();
      const events = data.split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)));
      const response = events.find((e) => e.type === 'response.completed')?.response;
      assert.ok(response, data);
      assert.deepEqual(response.output.map(({ type }) => type), ['compaction']);
      return response;
    }
    const response = await compact([
      { type: 'compaction', encrypted_content: 'ccb:v1:claude-session:previous-turn' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Remember checkpoint-token-389.' }] },
    ]);
    const sid = response.output[0].encrypted_content.split(':')[2];
    assert.match(sid, /^agy-/);
    assert.equal(state.ownerThread(sid), 'checkpoint-thread');
    assert.equal(state.ownerThread('claude-session'), null);
    const resumed = await compact([
      response.output[0],
      { type: 'function_call_output', call_id: 'last-call', output: `${'x'.repeat(12_000)}finished-tool-token-179` },
    ]);
    assert.equal(resumed.output[0].encrypted_content.split(':')[2], sid);
    assert.notEqual(resumed.output[0].encrypted_content, response.output[0].encrypted_content);
    assert.equal(fs.readFileSync(path.join(bridgeHome, 'antigravity-workspace', 'tool-output-received'), 'utf8'), 'finished-tool-token-179');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of envBefore) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    state.flush();
  }
});


test('Antigravity requires a final answer after its last Codex tool handoff', async (t) => {
  const { createBridge } = await import('../src/server.js');
  const { DEFAULTS } = await import('../src/config.js');
  const { State } = await import('../src/state.js');
  const state = new State(path.join(bridgeHome, 'final-reply-state.json'));
  const { server } = createBridge({
    ...DEFAULTS, models: [neon], logLevel: 'error',
    antigravityPath: fileURLToPath(new URL('./fixtures/fake-agy.js', import.meta.url)),
  }, state);
  const envKeys = ['FAKE_AGY_SCENARIO', 'HOME', 'PATH'];
  const previousEnv = envKeys.map((name) => [name, process.env[name]]);
  process.env.HOME = bridgeHome;
  process.env.PATH = [path.dirname(process.execPath), process.env.PATH].join(path.delimiter);
  t.after(async () => {
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise((resolve) => server.close(resolve));
    state.flush();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  async function turn(thread, input) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/backend-api/codex/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'thread-id': thread },
      body: JSON.stringify({
        model: neon.slug, reasoning: { effort: 'low' }, input,
        tools: [{ type: 'function', name: 'echo', parameters: { type: 'object' } }],
      }),
      signal: AbortSignal.timeout(5000),
    });
    assert.ok(res.ok);
    return (await res.text()).split('\n').filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6))).at(-1);
  }

  for (const scenario of ['commentary-then-tool', 'commentary-then-tool-and-thought', 'answer-after-tool']) {
    process.env.FAKE_AGY_SCENARIO = scenario;
    const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check the file.' }] }];
    const first = await turn(scenario, input);
    assert.equal(first.type, 'response.completed');
    assert.equal(first.response.end_turn, false);
    const items = first.response.output;
    assert.equal(items.find((item) => item.type === 'message')?.phase, 'commentary');
    const call = items.find((item) => item.type === 'function_call');
    assert.equal(call?.name, 'echo');
    const final = await turn(scenario, [
      ...input, ...items,
      { type: 'function_call_output', call_id: call.call_id, output: 'tool completed' },
    ]);
    if (scenario === 'answer-after-tool') {
      assert.equal(final.type, 'response.completed');
      assert.equal(final.response.output.find((item) => item.phase === 'final_answer')?.content[0].text, 'I found the file.');
    } else {
      assert.equal(final.type, 'response.failed');
      assert.match(final.response.error.message, /^Antigravity stopped\. Gemini stopped before giving a final reply/);
      const [, , sid, turnId] = items.find((item) => item.encrypted_content?.startsWith('ccb:v1:')).encrypted_content.split(':');
      assert.equal(state.isLatestTurn(sid, turnId), true, 'Keep the last delivered session marker');
    }
  }
});
