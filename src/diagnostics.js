// Bounded lifecycle and resource diagnostics for the bridge.
//
// Records only identifiers, counts, sizes and durations: never prompt or tool
// bodies, credentials, image data or file paths. One module-level registry
// serves /health and the occasional `resources` log line, so a future memory or
// process spike can be traced to running, waiting or abandoned Claude turns,
// open WebSockets, cached context or state writes.

const MIB = 1024 * 1024;
const SAFE_VALUE = /^[\w.:@+-]*$/;
const MAX_VALUE_LENGTH = 400; // Keeps a hostile local header or a five-turn waiting list on one bounded line.
const MAX_LISTED_TURNS = 50;

const processes = new Map(); // bridge process id -> record
const sockets = new Map(); // WebSocket -> { kind, openedAt }
const contexts = new Map(); // client WebSocket -> approximate cached context bytes
const totals = {
  spawned: 0,
  exited: 0,
  cancelled: 0,
  clientGone: 0,
  handoffs: 0,
  resumes: 0,
  escalations: 0,
  forcedStdioClose: 0,
};
let httpActive = 0;

function clean(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.round(value * 10) / 10) : String(value);
  if (typeof value === 'boolean') return String(value);
  const text = String(value).slice(0, MAX_VALUE_LENGTH);
  return SAFE_VALUE.test(text) ? text : JSON.stringify(text); // A local client controls thread headers; quoting keeps one event per line.
}

/** Formats `key=value` pairs, dropping empty values. */
export function formatFields(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${clean(value)}`)
    .join(' ');
}

function counts() {
  let running = 0;
  let waiting = 0;
  let stopping = 0;
  let compacting = 0;
  for (const record of processes.values()) {
    if (record.kind === 'compact') compacting++;
    else if (record.state === 'waiting') waiting++;
    else if (record.state === 'stopping') stopping++;
    else running++;
  }
  return { running, waiting, stopping, compacting };
}

/** One lifecycle event, with the current live counts appended. */
export function logLifecycle(log, event, fields = {}) {
  const live = counts();
  log.info(`lifecycle ${event} ${formatFields({ ...fields, running: live.running, waiting: live.waiting, stopping: live.stopping, compacting: live.compacting })}`);
}

export const diagnostics = {
  processStarted({ id, kind = 'turn', threadId = null, codexTurnId = null, pid = null, model = null, session = null }) {
    const record = { id, kind, threadId, codexTurnId, pid: pid ?? null, model, session, startedAt: Date.now(), state: 'running', waitingSince: null, handoffs: 0, endReason: null };
    processes.set(id, record);
    totals.spawned++;
    return record;
  },

  processWaiting(id) {
    const record = processes.get(id);
    if (!record) return;
    record.state = 'waiting';
    record.waitingSince = Date.now();
    record.handoffs++;
    totals.handoffs++;
  },

  /** Returns how long the process waited for Codex, in milliseconds. */
  processResumed(id) {
    const record = processes.get(id);
    if (!record || record.state !== 'waiting') return null;
    const waited = Date.now() - record.waitingSince;
    record.state = 'running';
    record.waitingSince = null;
    totals.resumes++;
    return waited;
  },

  /** The first stop reason wins; later requests for the same process are not counted twice. */
  processStopping(id, reason) {
    const record = processes.get(id);
    if (!record || record.endReason) return null;
    const waitedMs = record.waitingSince ? Date.now() - record.waitingSince : null;
    record.endReason = reason;
    record.state = 'stopping';
    if (reason === 'client-gone') totals.clientGone++;
    else totals.cancelled++;
    return { waitedMs };
  },

  processEscalated() {
    totals.escalations++;
  },

  processStdioForced() {
    totals.forcedStdioClose++;
  },

  /** Removes the record exactly once and returns it with its lifetime. */
  processEnded(id) {
    const record = processes.get(id);
    if (!record) return null;
    processes.delete(id);
    totals.exited++;
    return { ...record, durationMs: Date.now() - record.startedAt };
  },

  /** Follows a WebSocket until it closes; bufferedAmount is read only for snapshots. */
  trackSocket(socket, kind) {
    if (sockets.has(socket)) return;
    sockets.set(socket, { kind, openedAt: Date.now() });
    socket.once('close', () => {
      sockets.delete(socket);
      contexts.delete(socket);
    });
  },

  setContextBytes(socket, bytes) {
    if (sockets.has(socket)) contexts.set(socket, bytes);
  },

  requestStarted() {
    httpActive++;
  },

  requestFinished() {
    httpActive = Math.max(0, httpActive - 1);
  },
};

function mib(bytes) {
  return Math.round((bytes / MIB) * 10) / 10;
}

/** Plain-data snapshot used by /health, tests and the resource log line. */
export function diagnosticsSnapshot({ state = null, now = Date.now() } = {}) {
  const memory = process.memoryUsage();
  const live = counts();
  const turns = [...processes.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(0, MAX_LISTED_TURNS)
    .map((record) => ({
      turn: record.id,
      kind: record.kind,
      thread: record.threadId,
      codexTurn: record.codexTurnId,
      pid: record.pid,
      model: record.model,
      session: record.session,
      state: record.state,
      ageSeconds: Math.round((now - record.startedAt) / 1000),
      waitingSeconds: record.waitingSince ? Math.round((now - record.waitingSince) / 1000) : null,
      handoffs: record.handoffs,
    }));
  const waitingAges = turns.filter((turn) => turn.waitingSeconds !== null).map((turn) => turn.waitingSeconds);
  let clients = 0;
  let upstreams = 0;
  let bufferedBytes = 0;
  let maxBufferedBytes = 0;
  for (const [socket, info] of sockets) {
    if (socket.readyState === 3) { // CLOSED without a close event (for example an aborted handshake): never let the registry retain it.
      sockets.delete(socket);
      contexts.delete(socket);
      continue;
    }
    if (info.kind === 'upstream') upstreams++;
    else clients++;
    const buffered = Number(socket.bufferedAmount) || 0;
    bufferedBytes += buffered;
    maxBufferedBytes = Math.max(maxBufferedBytes, buffered);
  }
  let contextBytes = 0;
  for (const bytes of contexts.values()) contextBytes += bytes;
  return {
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    memory: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    },
    claude: {
      ...live,
      oldestWaitingSeconds: waitingAges.length ? Math.max(...waitingAges) : null,
      totals: { ...totals },
    },
    turns,
    websockets: { clients, upstreams, bufferedBytes, maxBufferedBytes, cachedContexts: contexts.size, cachedContextBytes: contextBytes },
    http: { active: httpActive },
    state: state?.stats ? state.stats() : null,
  };
}

export function formatResourceLine(snapshot) {
  const { memory, claude, websockets, http, state } = snapshot;
  const waiting = snapshot.turns
    .filter((turn) => turn.state === 'waiting')
    .slice(0, 5)
    .map((turn) => `${turn.turn}@${turn.thread ?? 'none'}:${turn.waitingSeconds}s`)
    .join(',');
  return formatFields({
    rssMiB: mib(memory.rssBytes),
    heapUsedMiB: mib(memory.heapUsedBytes),
    heapTotalMiB: mib(memory.heapTotalBytes),
    externalMiB: mib(memory.externalBytes),
    running: claude.running,
    waiting: claude.waiting,
    stopping: claude.stopping,
    compacting: claude.compacting,
    oldestWaitingS: claude.oldestWaitingSeconds,
    spawned: claude.totals.spawned,
    exited: claude.totals.exited,
    cancelled: claude.totals.cancelled,
    escalations: claude.totals.escalations,
    wsClients: websockets.clients,
    wsUpstreams: websockets.upstreams,
    wsBufferedBytes: websockets.bufferedBytes,
    contexts: websockets.cachedContexts,
    contextMiB: mib(websockets.cachedContextBytes),
    http: http.active,
    sessions: state?.sessions,
    catalogKeys: state?.catalogKeys,
    catalogBodies: state?.catalogBodies,
    stateBytes: state?.stateBytes,
    catalogBytes: state?.catalogBytes,
    stateWrites: state?.writes,
    stateWriteMiB: state ? mib(state.bytesWritten) : undefined,
    skippedWrites: state?.skippedWrites,
    waitingTurns: waiting || undefined,
  });
}

/**
 * Samples resources once a minute and logs a line only when it helps explain a spike:
 * at start, on a new RSS high-water mark, when a wait crosses a long-wait threshold,
 * when WebSocket send buffers grow large, and as a sparse heartbeat. Returns a stop function.
 */
export function startResourceMonitor({
  log,
  state = null,
  intervalMs = 60_000,
  heartbeatMs = 15 * 60_000,
  idleHeartbeatMs = 60 * 60_000,
  rssStepBytes = 128 * MIB,
  bufferedWarnBytes = 8 * MIB,
  waitingThresholdsSeconds = [30 * 60, 2 * 60 * 60, 6 * 60 * 60, 12 * 60 * 60],
} = {}) {
  let lastLoggedAt = 0;
  let peakRss = 0;
  let bufferedWarned = false;
  const waitAlerts = new Map(); // turn id -> thresholds already logged
  const tick = () => {
    const snapshot = diagnosticsSnapshot({ state });
    const now = Date.now();
    const reasons = [];
    if (!lastLoggedAt) reasons.push('start');
    if (lastLoggedAt && snapshot.memory.rssBytes >= peakRss + rssStepBytes) reasons.push('rss-high');
    for (const turn of snapshot.turns) {
      if (turn.waitingSeconds === null) continue;
      const logged = waitAlerts.get(turn.turn) ?? 0;
      const crossed = waitingThresholdsSeconds.filter((seconds) => turn.waitingSeconds >= seconds).length;
      if (crossed > logged) {
        waitAlerts.set(turn.turn, crossed);
        if (!reasons.includes('long-wait')) reasons.push('long-wait');
      }
    }
    for (const id of waitAlerts.keys()) if (!snapshot.turns.some((turn) => turn.turn === id && turn.waitingSeconds !== null)) waitAlerts.delete(id);
    if (snapshot.websockets.maxBufferedBytes >= bufferedWarnBytes) {
      if (!bufferedWarned) reasons.push('ws-buffered');
      bufferedWarned = true;
    } else {
      bufferedWarned = false;
    }
    const active = snapshot.claude.running + snapshot.claude.waiting + snapshot.claude.stopping + snapshot.claude.compacting + snapshot.websockets.clients + snapshot.http.active > 0;
    if (lastLoggedAt && !reasons.length && now - lastLoggedAt >= (active ? heartbeatMs : idleHeartbeatMs)) reasons.push('heartbeat');
    if (!reasons.length) return;
    lastLoggedAt = now;
    peakRss = Math.max(peakRss, snapshot.memory.rssBytes);
    log.info(`resources reason=${reasons.join(',')} ${formatResourceLine(snapshot)}`);
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
