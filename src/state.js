import fs from 'node:fs';
import path from 'node:path';
import { BRIDGE_HOME } from './config.js';

// Small persistent store:
// - sessions[sid].lastTurnId: newest completed bridged turn, used to spot rollbacks/forks
// - contextWindows[model]: real context window reported by Claude Code
// - upstreamModels: last good GPT catalog, served if chatgpt.com is unreachable
export class State {
  constructor(file = path.join(BRIDGE_HOME, 'state.json')) {
    this.file = file;
    this.data = { sessions: {}, contextWindows: {}, upstreamModels: null };
    try {
      this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      // first run or unreadable: start empty
    }
    this.timer = null;
  }

  isLatestTurn(sid, turnId) {
    return this.data.sessions[sid]?.lastTurnId === turnId;
  }

  recordTurn(sid, turnId) {
    this.data.sessions[sid] = { lastTurnId: turnId, updatedAt: new Date().toISOString() };
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

  setUpstreamModels(models) {
    this.data.upstreamModels = models;
    this.save();
  }

  prune() {
    const entries = Object.entries(this.data.sessions);
    if (entries.length <= 2000) return;
    entries.sort((a, b) => (a[1].updatedAt < b[1].updatedAt ? 1 : -1));
    this.data.sessions = Object.fromEntries(entries.slice(0, 1500));
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
    this.timer.unref?.();
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[bridge] could not save state: ${err.message}`);
    }
  }
}
