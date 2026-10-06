import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function isolatedInstaller(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-installer-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const scripts = path.join(directory, 'scripts');
  const bin = path.join(directory, 'bin');
  const home = path.join(directory, 'test-home');
  fs.mkdirSync(scripts);
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  for (const name of ['install.sh', 'uninstall.sh']) {
    const source = fs.readFileSync(new URL(`../scripts/${name}`, import.meta.url), 'utf8');
    fs.writeFileSync(path.join(scripts, name), source.replace(/\$HOME\b/g, '$TEST_INSTALLER_HOME')); // Redirect script paths in the test copy without changing HOME or touching the user's service/config.
  }
  for (const [name, script] of Object.entries({ npm: 'exit 0', claude: 'echo "fake Claude"', launchctl: '[ "$1" != print ]', lsof: 'exit 1', curl: 'exit 0', sleep: 'exit 0' })) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }
  const config = path.join(home, '.codex/config.toml');
  const run = (name, env = {}) => spawnSync('/bin/bash', [path.join(scripts, name)], { env: { ...process.env, TEST_INSTALLER_HOME: home, PATH: `${bin}:${process.env.PATH}`, ...env }, encoding: 'utf8', timeout: 5000 });
  return { config, run, home };
}

test('reinstalling on a different port updates only the managed Codex route', (t) => {
  const installer = isolatedInstaller(t);
  fs.writeFileSync(installer.config, 'openai_base_url = "http://127.0.0.1:18787/backend-api/codex" # codex-claude-bridge\nmodel = "gpt-test"\n');
  const result = installer.run('install.sh', { CODEX_CLAUDE_BRIDGE_PORT: '18888' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(installer.home, '.codex-claude-bridge/config.json'))).port, 18888);
  assert.equal(fs.readFileSync(installer.config, 'utf8'), 'openai_base_url = "http://127.0.0.1:18888/backend-api/codex" # codex-claude-bridge\nmodel = "gpt-test"\n');
});

test('uninstall restores the direct route even when the bridge line is the entire config', (t) => {
  const installer = isolatedInstaller(t);
  fs.writeFileSync(installer.config, 'openai_base_url = "http://127.0.0.1:18787/backend-api/codex" # codex-claude-bridge\n');
  const result = installer.run('uninstall.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(installer.config, 'utf8'), '');
});
