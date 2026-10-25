// Bounded shutdown for one Claude Code process and the processes it started.
//
// Stopping starts gently: SIGINT to Claude Code only, so it can save its session
// and close its own MCP servers. After a grace period the bridge signals any
// survivors, including descendants orphaned by a politely exiting Claude Code
// (found with `ps`), first with SIGTERM and then SIGKILL. The bridge never signals
// a process group or anything outside that tree, and it stays in launchd's job
// group, so launchd's own cleanup on a bridge exit is unchanged.
import { execFile } from 'node:child_process';

let pendingCleanups = 0;
export const hasPendingProcessCleanup = () => pendingCleanups > 0;

/** Current pid -> { ppid, started } table, or null when `ps` is unavailable. */
export function processTable() {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,lstart='], { timeout: 2000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null);
      const table = new Map();
      for (const line of String(stdout).split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (match) table.set(Number(match[1]), { ppid: Number(match[2]), started: match[3] });
      }
      resolve(table);
    });
  });
}

/** Every descendant of `root` in `table`, parents before children. */
export function descendantsOf(table, root) {
  const children = new Map();
  for (const [pid, { ppid }] of table) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const found = [];
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) {
    for (const pid of children.get(queue.shift()) || []) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      found.push(pid);
      queue.push(pid);
    }
  }
  return found;
}

/**
 * Returns idempotent `stop()`. Capture descendants before SIGINT: Claude can exit
 * immediately and leave an MCP child reparented to launchd. Remember start times
 * as well as PIDs so a later signal cannot hit an unrelated reused PID.
 */
export function createProcessStopper(child, { graceMs = 4000, killGraceMs = 4000, onEscalate = () => {} } = {}) {
  let requested = false;
  const remembered = new Map();
  const alive = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  const schedule = (fn, ms) => {
    const timer = setTimeout(() => {
      void fn();
    }, ms);
    timer.unref?.();
  };

  function rememberTree(table) {
    if (!table || !alive()) return;
    for (const pid of descendantsOf(table, child.pid)) remembered.set(pid, table.get(pid).started);
  }

  async function signalTree(signal) {
    const table = await processTable();
    const targets = new Set();
    if (table) {
      rememberTree(table);
      // Descendants can start their own children during graceful shutdown. Follow
      // only still-identical owned processes, even after their parent has exited.
      for (const [pid, started] of remembered) {
        if (table.get(pid)?.started !== started) continue;
        targets.add(pid);
        for (const descendant of descendantsOf(table, pid)) {
          remembered.set(descendant, table.get(descendant).started);
          targets.add(descendant);
        }
      }
    }
    if (alive()) targets.add(child.pid);
    let delivered = 0;
    for (const pid of targets) {
      try {
        process.kill(pid, signal);
        delivered++;
      } catch {
        // Already exited.
      }
    }
    if (delivered) onEscalate(signal, delivered);
  }

  return {
    get requested() {
      return requested;
    },
    async stop() {
      if (requested) return;
      requested = true;
      if (!alive()) return;
      pendingCleanups++; // Idle reload must wait even when the parent exits before its MCP children.
      rememberTree(await processTable()); // Must finish before the parent can react to our signal.
      try {
        child.kill('SIGINT');
      } catch {
        // Exited meanwhile.
      }
      schedule(async () => {
        await signalTree('SIGTERM');
        schedule(async () => {
          try {
            await signalTree('SIGKILL');
          } finally {
            pendingCleanups--;
          }
        }, killGraceMs);
      }, graceMs);
    },
  };
}

/**
 * Node emits 'close' only after every stdio pipe closes. A grandchild that keeps
 * Claude Code's stdout open would otherwise hold a session lock and every handle
 * forever after Claude Code exits; destroy the pipes after a bounded grace instead.
 */
export function closeStdioAfterExit(child, graceMs, onForced = () => {}) {
  let closed = false;
  let timer = null;
  child.once('close', () => {
    closed = true;
    if (timer) clearTimeout(timer);
  });
  child.once('exit', () => {
    if (closed) return;
    timer = setTimeout(() => {
      if (closed) return;
      onForced();
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
    }, graceMs);
    timer.unref?.();
  });
}
