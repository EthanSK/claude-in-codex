// Turns a Codex Responses request into what Claude Code needs:
// the new user prompt, context from other models, cwd, permissions, AGENTS.md, and
// where the last bridged turn ended.

export const MARKER_PREFIX = 'ccb:v1:';
export const BRIDGE_ID_PREFIXES = ['msg_ccb_', 'rs_ccb_', 'ws_ccb_', 'cmp_ccb_'];

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

const CONTEXT_TAG = /^\s*<([a-z][a-z0-9_]*)[\s>]/i;

// Mirrors Codex's own "contextual user fragment" idea: injected context, not typed by the user.
export function classifyUserText(text) {
  const t = text.trimStart();
  if (t.startsWith('# AGENTS.md instructions')) return 'agents_md';
  const m = t.match(CONTEXT_TAG);
  if (!m) return 'prompt';
  const tag = m[1].toLowerCase();
  if (!text.includes(`</${m[1]}>`)) return 'prompt';
  if (tag === 'environment_context') return 'environment';
  if (tag === 'user_instructions') return 'agents_md';
  if (tag === 'turn_aborted') return 'aborted';
  if (tag === 'image') return 'prompt';
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
      return t ? `Assistant (another model in this Codex thread):\n${t}` : null;
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
 */
export function parseCodexRequest(body, isLatestTurn = () => false) {
  const input = Array.isArray(body.input) ? body.input : [];
  let cwd = null;
  let sandboxMode = null;
  let planMode = false;
  let agentsMd = [];
  let marker = null;
  let hasCompactionTrigger = false;
  let skills = null;

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
  const newItems = resume ? input.slice(resume.index + 1) : input;

  // The prompt is the trailing run of user prompt messages; everything earlier is context.
  let promptStart = newItems.length;
  for (let i = newItems.length - 1; i >= 0; i--) {
    const it = newItems[i];
    if (isPromptMessage(it)) {
      promptStart = i;
      continue;
    }
    if (it?.type === 'message' && it.role !== 'assistant' && !isBridgeItem(it)) continue; // context fragments between prompts
    if (it?.type === 'reasoning' || it?.type === 'compaction_trigger') continue;
    break;
  }

  const contextLines = [];
  for (const it of newItems.slice(0, promptStart)) {
    if (isBridgeItem(it)) continue;
    const line = renderContextItem(it);
    if (line) contextLines.push(line);
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
    context,
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
    if (item.type === 'message') {
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
