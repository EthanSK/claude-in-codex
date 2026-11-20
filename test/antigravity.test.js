import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const neon = {
  slug: 'gemini-4-neon', displayName: 'Gemini 4 Neon', antigravityModel: 'gemini-4-neon',
};

test('Antigravity models are opt-in, preserve the default routes and expose their supported settings', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-neon-config-'));
  process.env.CODEX_CLAUDE_BRIDGE_HOME = home;
  try {
    const { loadModels } = await import('../src/config.js');
    const { mergeCatalog } = await import('../src/catalog.js');
    const defaults = loadModels();
    const file = path.join(home, 'config.json');
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
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Antigravity resumes without replay, maps attachments and grants only current Codex tools once', () => {
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
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const events = run.stdout.trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.filter((e) => e.type === 'stream_event').map((e) => e.event.delta), [
      { type: 'thinking_delta', thinking: 'Thinking' },
      { type: 'text_delta', text: 'Verified' },
    ]);
    assert.equal(events.at(-1).session_id, resume);
    assert.equal(events.at(-1).usage.output_tokens, 7);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
