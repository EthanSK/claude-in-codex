const EFFORT_LEVELS = [
  { effort: 'low', description: 'Fastest; light thinking' },
  { effort: 'medium', description: 'Balanced speed and depth' },
  { effort: 'high', description: 'Deeper thinking for harder tasks' },
  { effort: 'xhigh', description: 'Extra-deep thinking' },
  { effort: 'max', description: 'Maximum thinking budget' },
];

// Minimal entry used only if the GPT catalog can't be fetched to clone from.
const FALLBACK_TEMPLATE = {
  shell_type: 'shell_command',
  visibility: 'list',
  supported_in_api: true,
  priority: 100,
  availability_nux: null,
  upgrade: null,
  base_instructions: '',
  supports_reasoning_summaries: true,
  support_verbosity: false,
  default_verbosity: null,
  apply_patch_tool_type: 'freeform',
  truncation_policy: { mode: 'tokens', limit: 10000 },
  supports_parallel_tool_calls: true,
  experimental_supported_tools: [],
};

export function claudeEntries(config, state, template, maxPriority = 0) {
  const base = template || FALLBACK_TEMPLATE;
  return config.models.map((m, i) => {
    const entry = structuredClone(base);
    const contextWindow = state.contextWindow(m.slug) || m.contextWindow || config.defaultContextWindow;
    Object.assign(entry, {
      slug: m.slug,
      display_name: m.displayName,
      description: m.description,
      default_reasoning_level: m.defaultEffort || 'high',
      supported_reasoning_levels: EFFORT_LEVELS,
      visibility: 'list',
      supported_in_api: true,
      priority: (m.priority ?? maxPriority + 1 + i),
      upgrade: null,
      availability_nux: null,
      additional_speed_tiers: [],
      service_tiers: [],
      context_window: contextWindow,
      max_context_window: contextWindow,
      input_modalities: ['text', 'image'],
      supports_reasoning_effort_updates: false,
      // Classic request shape (tools in `tools`, prompt in `instructions`), not responses-lite.
      use_responses_lite: false,
    });
    for (const k of ['default_service_tier', 'available_access_programs', 'auto_compact_token_limit', 'guardian']) {
      delete entry[k];
    }
    return entry;
  });
}

export function pickTemplate(models) {
  if (!Array.isArray(models) || !models.length) return null;
  const listed = models.filter((m) => m.visibility === 'list');
  const pool = listed.length ? listed : models;
  return pool.slice().sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))[0];
}

export function mergeCatalog(config, state, upstreamModels) {
  const gpt = (upstreamModels || []).filter((m) => !config.models.some((c) => c.slug === m.slug));
  const maxPriority = Math.max(0, ...gpt.map((m) => m.priority ?? 0));
  return [...gpt, ...claudeEntries(config, state, pickTemplate(gpt), maxPriority)];
}

export function fallbackGptModel(config, state) {
  if (config.fallbackModel) return config.fallbackModel;
  const t = pickTemplate(state.data.upstreamModels || []);
  return t?.slug || 'gpt-5.5';
}
