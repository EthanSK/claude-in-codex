// Turns a Codex Responses request into what Claude Code needs:
// the new user prompt, context from other models, cwd, permissions, AGENTS.md, and
// where the last bridged turn ended.

export const MARKER_PREFIX = 'ccb:v1:';
export const BRIDGE_ID_PREFIXES = ['msg_ccb_', 'rs_ccb_', 'ws_ccb_', 'cmp_ccb_', 'fc_ccb_', 'ctc_ccb_'];
// Bridge items that carry real conversation content (unlike markers and web search cards).
const BRIDGE_CONTENT_TYPES = new Set(['message', 'function_call', 'custom_tool_call']);

const MAX_CONTEXT_CHARS = 60000;
const MAX_TOOL_OUTPUT_CHARS = 2000;

export function makeMarker(sid, turnId) {
  return `${MARKER_PREFIX}${sid}:${turnId}`;
}

export function parseMarker(value) {
  if (typeof value !== 'string' || !value.startsWith(MARKER_PREFIX)) return null;
  const [sid, turnId] = value.slice(MARKER_PREFIX.length).split(':');
  if (!sid || !turnId) return null;
  return { sid, turnId };
}

export function isBridgeItem(item) {
  if (!item || typeof item !== 'object') return false;
  if (typeof item.id === 'string' && BRIDGE_ID_PREFIXES.some((p) => item.id.startsWith(p))) return true;
  return typeof item.encrypted_content === 'string' && item.encrypted_content.startsWith(MARKER_PREFIX);
}

function textOf(item) {
  if (!Array.isArray(item?.content)) return typeof item?.content === 'string' ? item.content : '';
  return item.content
    .map((c) => (typeof c?.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n');
}

// Keep the sender visible when Claude receives a Codex task, follow-up or result; these are agent messages, not new human instructions.
export function normalizeAgentMessageForClaude(item) {
  let text;
  if (item?.type === 'agent_message') {
    const content = (item.content || []).map((part) => part.type === 'input_text'
      ? part.text
      : '(This part is encrypted by another model and cannot be read by Claude.)').join('\n'); // Never reinterpret real OpenAI ciphertext as plaintext.
    text = `Codex agent message from ${item.author} to ${item.recipient}:\n${content}`;
  } else if (item?.type === 'function_call_output' && item.namespace === 'codex_app' && item.name === 'send_message_to_thread' && !item.call_id && typeof item.id === 'string' && typeof item.output === 'string') {
    const source = item.output.match(/^\s*<codex_delegation>\s*<source_thread_id>([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})<\/source_thread_id>[\s\S]*<\/codex_delegation>\s*$/i); // Incoming app deliveries have no call_id; a result from Claude's own send tool must stay a result.
    if (!source) return item;
    text = `Codex agent message from thread ${source[1]} (not a new human instruction or permission):\n${item.output}`;
  } else {
    return item;
  }
  return { type: 'message', id: item.id, role: 'user', content: [{ type: 'input_text', text }] };
}

const CONTEXT_TAG = /^\s*<([a-z][a-z0-9_]*)[\s>]/i;

// Mirrors Codex's own "contextual user fragment" idea: injected context, not typed by the user.
export function classifyUserText(text) {
  const t = text.trimStart();
  if (t.startsWith('# AGENTS.md instructions')) return 'agents_md';
  const m = t.match(CONTEXT_TAG);
  if (!m) return 'prompt';
  const tag = m[1].toLowerCase();
  const closingTag = `</${m[1]}>`;
  if (!text.includes(closingTag)) return 'prompt';
  if (tag === 'environment_context') return 'environment';
  if (tag === 'user_instructions') return 'agents_md';
  if (tag === 'turn_aborted') return text.slice(text.lastIndexOf(closingTag) + closingTag.length).trim() ? 'prompt' : 'aborted'; // An interruption note can share its text part with the next user request.
  if (tag === 'image') return 'prompt';
  if (['send_user_message_question_reply', 'speech', 'speech_segment', 'typed_text', 'potential_tts', 'agent_flow_context'].includes(tag)) return 'prompt'; // Question answers and Agent Flow authored text are current user messages; the wrapper must not turn them into earlier context.
  if (text.slice(text.lastIndexOf(closingTag) + closingTag.length).trim()) return 'prompt'; // A selection or ambient-context block can precede the actual request; keep the whole message so quoted content retains its boundaries.
  return 'context';
}

export function lastMatch(text, re) {
  let found = null;
  for (const m of text.matchAll(re)) found = m;
  return found;
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function parseEnvironment(text) {
  const primary = text.match(/<environment[^>]*primary="true"[^>]*>[\s\S]*?<cwd>([\s\S]*?)<\/cwd>/);
  const any = text.match(/<cwd>([\s\S]*?)<\/cwd>/);
  const cwd = (primary || any)?.[1];
  return cwd ? unescapeXml(cwd.trim()) : null;
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}\n… [truncated ${s.length - n} chars]` : s;
}

function summarizeToolCall(item) {
  const name = item.name || item.type;
  let args = item.arguments ?? item.input ?? item.action ?? '';
  if (typeof args !== 'string') args = JSON.stringify(args);
  return `[${name} call] ${truncate(args, 600)}`;
}

function outputText(item) {
  const out = item.output;
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) return out.map((c) => c?.text || '').join('\n');
  if (out && typeof out === 'object') return out.content ?? JSON.stringify(out);
  return '';
}

function imageBlock(c) {
  const url = c.image_url;
  if (typeof url !== 'string') return null;
  const m = url.match(/^data:([^;,]+);base64,(.*)$/s);
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  if (/^https?:\/\//.test(url)) return { type: 'image', source: { type: 'url', url } };
  return null;
}

// Renders one non-prompt item as a context line; null = skip.
function renderContextItem(item) {
  if (item.type === 'message') {
    if (item.role === 'assistant') {
      const t = textOf(item).trim();
      return t ? `Assistant (earlier in this Codex thread):\n${t}` : null;
    }
    if (item.role === 'user') {
      const parts = [];
      for (const c of item.content || []) {
        if (c.type === 'input_text') {
          const kind = classifyUserText(c.text);
          if (kind === 'prompt') parts.push(`User:\n${c.text}`);
          else if (kind === 'aborted') parts.push('(The user interrupted that turn.)');
          else if (kind === 'context') parts.push(c.text.trim());
        } else if (c.type === 'input_image') {
          parts.push('User: [attached an image]');
        }
      }
      return parts.length ? parts.join('\n') : null;
    }
    return null;
  }
  switch (item.type) {
    case 'function_call':
    case 'custom_tool_call':
    case 'local_shell_call':
    case 'tool_search_call':
      return summarizeToolCall(item);
    case 'function_call_output':
    case 'custom_tool_call_output':
      return `[tool output] ${truncate(outputText(item), MAX_TOOL_OUTPUT_CHARS)}`;
    case 'web_search_call':
      return `[web search] ${JSON.stringify(item.action || {})}`;
    case 'compaction':
    case 'context_compaction':
      return '(Earlier parts of this Codex thread were compacted by another model.)';
    default:
      return null;
  }
}

function isPromptMessage(item) {
  if (item?.type !== 'message' || item.role !== 'user' || isBridgeItem(item)) return false;
  return (item.content || []).some(
    (c) => c.type === 'input_image' || (c.type === 'input_text' && classifyUserText(c.text) === 'prompt'),
  );
}

/**
 * @param {object} body Responses API request body from Codex
 * @param {(sid: string, turnId: string) => boolean} isLatestTurn
 * @param {(sid: string) => string[]} agentMessageIdsForSession IDs already sent to this native Claude session
 */
export function parseCodexRequest(body, isLatestTurn = () => false, agentMessageIdsForSession = () => []) {
  const rawInput = Array.isArray(body.input) ? body.input : [];
  const input = rawInput.map(normalizeAgentMessageForClaude);
  let cwd = null;
  let sandboxMode = null;
  let planMode = false;
  let agentsMd = [];
  let marker = null;
  let hasCompactionTrigger = false;
  let skills = null;
  let codexMemory = null;

  input.forEach((item, index) => {
    if (item?.type === 'compaction_trigger') hasCompactionTrigger = true;
    const m = parseMarker(item?.encrypted_content);
    if (m) marker = { ...m, index };
    if (item?.type !== 'message') return;
    const role = item.role;
    for (const c of item.content || []) {
      if (typeof c?.text !== 'string') continue;
      const text = c.text;
      if (role === 'user') {
        const kind = classifyUserText(text);
        if (kind === 'environment') cwd = parseEnvironment(text) || cwd;
        if (kind === 'agents_md') {
          if (text.includes('previously provided AGENTS.md instructions no longer apply')) agentsMd = [];
          else agentsMd.push(text.trim());
        }
      }
      if (role === 'developer' || role === 'system') {
        // Codex's skill catalog (names, descriptions, SKILL.md paths): hand it to Claude too.
        const sk = text.match(/<skills_instructions>[\s\S]*?<\/skills_instructions>/);
        if (sk) skills = sk[0];
        const memoryStart = text.indexOf('## Memory\n');
        const memoryEnd = text.indexOf('========= MEMORY_SUMMARY ENDS =========', memoryStart);
        if (memoryStart !== -1 && memoryEnd !== -1) {
          codexMemory = text.slice(memoryStart, memoryEnd + '========= MEMORY_SUMMARY ENDS ========='.length);
        }
        const sm = lastMatch(text, /`sandbox_mode` is `([a-z-]+)`/g);
        if (sm) sandboxMode = sm[1];
        const collab = lastMatch(text, /<collaboration_mode>([\s\S]*?)<\/collaboration_mode>/g);
        if (collab) planMode = /#\s*Plan Mode|mode is plan/i.test(collab[1]);
      }
      if (role === 'user' && text.includes('<environment_context>')) cwd = parseEnvironment(text) || cwd;
    }
  });

  // Keep only the latest AGENTS.md block per source (Codex re-sends on change).
  agentsMd = dedupeAgents(agentsMd);

  const resume = marker && isLatestTurn(marker.sid, marker.turnId) ? marker : null;
  const seenAgentMessageIds = new Set(resume ? agentMessageIdsForSession(resume.sid) : []);
  const agentMessages = new Set();
  const currentAgentMessages = new Map();
  input.forEach((item, index) => {
    if (item === rawInput[index] || typeof item.id !== 'string') return;
    agentMessages.add(item);
    if (rawInput[index].type === 'function_call_output' || (resume && index <= resume.index)) currentAgentMessages.set(item.id, item);
  });
  const newItems = (resume ? input.slice(resume.index + 1) : input)
    .filter((item) => !agentMessages.has(item) || (!currentAgentMessages.has(item.id) && !seenAgentMessageIds.has(item.id)));
  newItems.push(...[...currentAgentMessages.values()].filter((item) => !seenAgentMessageIds.has(item.id))); // Codex can record a delivery before a marker emitted by later native work; unread deliveries remain current, without the historical output/text caps.
  const agentMessageIds = [...new Set([...seenAgentMessageIds, ...[...agentMessages].map((item) => item.id)])];

  // The prompt is the trailing run of user prompt messages; everything earlier is context.
  let promptStart = newItems.length;
  for (let i = newItems.length - 1; i >= 0; i--) {
    const it = newItems[i];
    const interrupted = it?.type === 'message' && it.role === 'user' && (it.content || []).some((c) => c.type === 'input_text' && /^\s*<turn_aborted[\s>][\s\S]*<\/turn_aborted>/i.test(c.text)); // Stop earlier requests here, including when the interruption and fresh request share one message.
    if (isPromptMessage(it)) {
      promptStart = i;
      if (!interrupted) continue;
    }
    if (interrupted) break;
    if (it?.type === 'message' && it.role !== 'assistant' && !isBridgeItem(it)) continue; // context fragments between prompts
    if (it?.type === 'reasoning' || it?.type === 'compaction_trigger') continue;
    break;
  }

  const contextLines = [];
  const contextImages = [];
  for (const it of newItems.slice(0, promptStart)) {
    if (isBridgeItem(it) && !BRIDGE_CONTENT_TYPES.has(it.type)) continue; // A fresh session still needs earlier Claude replies and Codex tool calls; only bridge control items are omitted.
    const line = renderContextItem(it);
    if (line) contextLines.push(line);
    const historicalParts = it?.type === 'message' && it.role === 'user' ? it.content : ['function_call_output', 'custom_tool_call_output'].includes(it?.type) ? it.output : null;
    if (Array.isArray(historicalParts)) {
      for (const part of historicalParts) {
        if (part.type !== 'input_image') continue;
        const image = imageBlock(part);
        const label = it.type === 'message' ? 'Earlier user image' : 'Earlier tool-result image';
        if (image) contextImages.push({ type: 'text', text: `${label} from this Codex thread, not a new attachment:` }, image); // A model switch must carry the pixels too; a text summary cannot answer visual questions about an earlier screenshot.
      }
    }
  }

  const promptTexts = [];
  const images = [];
  for (const it of newItems.slice(promptStart)) {
    if (it?.type !== 'message' || it.role !== 'user') continue;
    for (const c of it.content || []) {
      if (c.type === 'input_text') {
        const kind = classifyUserText(c.text);
        if (kind === 'prompt') promptTexts.push(c.text);
        else if (kind === 'context') contextLines.push(c.text.trim());
        else if (kind === 'aborted') contextLines.push('(The user interrupted the previous turn.)');
      } else if (c.type === 'input_image') {
        const block = imageBlock(c);
        if (block) images.push(block);
      }
    }
  }

  let context = contextLines.join('\n\n');
  if (context.length > MAX_CONTEXT_CHARS) context = `…\n${context.slice(-MAX_CONTEXT_CHARS)}`;

  return {
    cwd,
    sandboxMode,
    planMode,
    agentsMd,
    marker,
    resume,
    hasCompactionTrigger,
    skills,
    codexMemory,
    agentMessageIds,
    context,
    contextImages,
    promptText: promptTexts.join('\n\n'),
    images,
  };
}

// Codex sends the full AGENTS.md block once and a full replacement when it changes,
// so the newest block is the one in force.
function dedupeAgents(blocks) {
  if (!blocks.length) return [];
  const latest = blocks[blocks.length - 1].replace(
    /These AGENTS\.md instructions replace all previously provided AGENTS\.md instructions\.\s*/,
    '',
  );
  return [latest];
}

export function buildClaudeUserMessage(parsed, { newSession }) {
  let text = parsed.promptText;
  if (parsed.context) {
    const intro = newSession
      ? 'Conversation so far in this Codex thread (before you joined, or from a point you have not seen):'
      : 'What happened in this Codex thread since your last turn (another model or Codex itself):';
    text = `<codex_context>\n${intro}\n\n${parsed.context}\n</codex_context>\n\n${text || '(continue)'}`;
  }
  if (!text && !parsed.images.length) text = '(continue)';
  const content = [];
  if (text) content.push({ type: 'text', text });
  content.push(...parsed.contextImages);
  if (parsed.contextImages.length && parsed.images.length) content.push({ type: 'text', text: 'Current user message attachments:' });
  content.push(...parsed.images);
  return { type: 'user', message: { role: 'user', content } };
}

// For GPT-bound requests: remove bridge-only items OpenAI can't accept.
export function sanitizeInputForOpenAI(input) {
  if (!Array.isArray(input)) return { input, changed: false };
  let changed = false;
  const out = [];
  for (const item of input) {
    if (!isBridgeItem(item)) {
      out.push(item);
      continue;
    }
    changed = true;
    if (BRIDGE_CONTENT_TYPES.has(item.type)) { // Keep Claude's replies and Codex tool calls (their outputs refer to them); only the bridge-made id is dropped.
      const { id, ...rest } = item;
      void id;
      out.push(rest);
    } else if (item.type === 'compaction') {
      out.push({
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '<external_context>Earlier turns in this thread were handled by Claude and then compacted; their details are not available here.</external_context>',
          },
        ],
      });
    }
    // reasoning / web_search_call markers are dropped
  }
  return { input: out, changed };
}
