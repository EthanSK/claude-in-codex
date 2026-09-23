import path from 'node:path';

function rel(file, cwd) {
  if (!file) return '';
  if (cwd && file.startsWith(cwd + path.sep)) return file.slice(cwd.length + 1);
  return file;
}

function lines(s) {
  if (!s) return 0;
  return String(s).split('\n').length;
}

function short(s, n = 160) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function fence(code, lang = '') {
  const tick = code.includes('```') ? '````' : '```';
  return `${tick}${lang}\n${code}\n${tick}`;
}

// Returns { kind: 'reasoning', text } | { kind: 'web', action } | { kind: 'plan', plan } | null
export function describeToolUse(block, cwd) {
  const name = block.name || 'tool';
  const input = block.input || {};
  switch (name) {
    case 'Bash': {
      const cmd = String(input.command || '');
      const head = input.description ? `**Running:** ${short(input.description, 100)}` : '**Running command**';
      return { kind: 'reasoning', text: `${head}\n\n${fence(cmd.length > 1500 ? `${cmd.slice(0, 1500)}\n…` : cmd, 'sh')}` };
    }
    case 'BashOutput':
    case 'KillShell':
    case 'KillBash':
      return { kind: 'reasoning', text: `**${name === 'BashOutput' ? 'Checking background command' : 'Stopping background command'}**` };
    case 'Read':
      return { kind: 'reasoning', text: `**Reading** \`${rel(input.file_path, cwd)}\`` };
    case 'Edit': {
      const removed = lines(input.old_string);
      const added = lines(input.new_string);
      return { kind: 'reasoning', text: `**Editing** \`${rel(input.file_path, cwd)}\` (+${added} −${removed})` };
    }
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      const added = edits.reduce((n, e) => n + lines(e.new_string), 0);
      const removed = edits.reduce((n, e) => n + lines(e.old_string), 0);
      return { kind: 'reasoning', text: `**Editing** \`${rel(input.file_path, cwd)}\` (${edits.length} edits, +${added} −${removed})` };
    }
    case 'Write':
      return { kind: 'reasoning', text: `**Writing** \`${rel(input.file_path, cwd)}\` (${lines(input.content)} lines)` };
    case 'NotebookEdit':
      return { kind: 'reasoning', text: `**Editing notebook** \`${rel(input.notebook_path, cwd)}\`` };
    case 'Grep':
      return {
        kind: 'reasoning',
        text: `**Searching** for \`${short(input.pattern, 80)}\`${input.path ? ` in \`${rel(input.path, cwd)}\`` : ''}`,
      };
    case 'Glob':
      return { kind: 'reasoning', text: `**Finding files** \`${short(input.pattern, 80)}\`` };
    case 'LS':
      return { kind: 'reasoning', text: `**Listing** \`${rel(input.path, cwd) || '.'}\`` };
    case 'WebSearch':
      return { kind: 'web', action: { type: 'search', query: String(input.query || '') } };
    case 'WebFetch':
      return { kind: 'web', action: { type: 'open_page', url: String(input.url || '') } };
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      const list = todos
        .map((t) => {
          const box = t.status === 'completed' ? '[x]' : '[ ]';
          const now = t.status === 'in_progress' ? ' ← in progress' : '';
          return `- ${box} ${t.content}${now}`;
        })
        .join('\n');
      return { kind: 'reasoning', text: `**Updated plan**\n\n${list}` };
    }
    case 'Task':
    case 'Agent':
      return {
        kind: 'reasoning',
        text: `**Delegating to ${input.subagent_type ? `\`${input.subagent_type}\` ` : ''}subagent:** ${short(input.description || input.prompt, 140)}`,
      };
    case 'ExitPlanMode':
      return { kind: 'plan', plan: String(input.plan || '') };
    case 'Skill':
      return { kind: 'reasoning', text: `**Using skill** \`${input.skill || input.name || ''}\`` };
    case 'AskUserQuestion':
      return null;
    default: {
      if (name.startsWith('mcp__')) {
        const [, server, ...tool] = name.split('__');
        return { kind: 'reasoning', text: `**${server} · ${tool.join('__')}** ${short(JSON.stringify(input), 140)}` };
      }
      return { kind: 'reasoning', text: `**${name}** ${short(JSON.stringify(input), 140)}` };
    }
  }
}

export function describeToolError(name, content) {
  let text = content;
  if (Array.isArray(content)) text = content.map((c) => c?.text || '').join('\n');
  text = String(text ?? '').trim();
  const first = text.split('\n').find((l) => l.trim()) || 'failed';
  return `**${name || 'Tool'} failed:** ${short(first, 220)}`;
}
