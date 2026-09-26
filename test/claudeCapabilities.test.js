import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeCapabilities } from '../src/claudeRunner.js';

test('a timed-out startup probe recovers on the next request without restarting', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-capabilities-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'claude');
  fs.writeFileSync(executable, '#!/bin/sh\nexec sleep 20\n', { mode: 0o700 });
  assert.equal((await claudeCapabilities(executable)).ok, false);
  fs.writeFileSync(executable, '#!/bin/sh\necho "--effort --include-partial-messages"\n');
  assert.deepEqual(await claudeCapabilities(executable), {
    ok: true, permissionPrompts: false, effort: true, partial: true,
  });
});

test('a missing or failed executable does not poison the cache or borrow another path', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-capabilities-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'claude');
  assert.equal((await claudeCapabilities(executable)).ok, false);
  fs.writeFileSync(executable, '#!/bin/sh\necho "failed --effort"\nexit 1\n', { mode: 0o700 });
  assert.equal((await claudeCapabilities(executable)).ok, false);
  fs.writeFileSync(executable, '#!/bin/sh\necho "--effort"\n');
  assert.equal((await claudeCapabilities(executable)).ok, true);
  assert.equal((await claudeCapabilities(path.join(directory, 'different-claude'))).ok, false);
});
