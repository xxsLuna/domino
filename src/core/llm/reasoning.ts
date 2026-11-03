import type { LLMConfig } from './types'

/** One provider-agnostic depth, mapped onto each adapter's own wire knob. */
export type ReasoningLevel = NonNullable<LLMConfig['reasoning']>

/** Every valid level, shallowest first — the escalation order. */
export const REASONING_LEVELS: readonly ReasoningLevel[] = ['none', 'low', 'medium', 'high']

/** Type guard for stored/untrusted values (a config file, a settings draft). */
export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === 'string' && (REASONING_LEVELS as readonly string[]).includes(value)
}

/**
 * Whether a model id advertises a reasoning knob of its own. Backends reject
 * unknown parameters with a hard 400, so the knob is only ever sent to a
 * model that asks for it — on classic models an explicit level is simply
 * ignored (the engine's corrective round still escalates by retrying).
 */
export function modelTakesReasoning(model: string): boolean {
  // Anthropic: 3.7+ and the 4/5 families think; 3.6 and older reject the param.
  if (/claude/i.test(model)) return !/3[-.][0-6]/.test(model)
  return /o[134]\b|gpt-5|deepseek[-_ ]?r\d|qwq|glm[-_.]?4\.[5-9]|thinking|reasoner/i.test(model)
}

/**
 * OpenAI-family reasoning models (o1/o3/o4 and gpt-5…, with or without a
 * gateway prefix like `openai/`). They always think, and they reject any
 * `temperature` but the default — so the adapters leave it out entirely.
 * The `-chat` variants of gpt-5 are classic chat models and keep it.
 */
export function isOpenAIReasoningModel(model: string): boolean {
  return /(^|[^a-z0-9])o[134](\b|-)|gpt-5(?!.*chat)/i.test(model)
}

/**
 * A Claude model id taken apart: family and version. Both id styles are
 * read — `claude-opus-4-7` / `claude-sonnet-4-5-20250929` and the older
 * `claude-3-7-sonnet-20250219` — with or without a gateway prefix
 * (`anthropic/`, `us.anthropic.`). A date suffix is never a minor version.
 * Unknown shapes (other models behind an Anthropic-compatible gateway) are
 * null, and every capability below then answers like a classic model.
 */
export interface ClaudeModelInfo {
  family: 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos'
  major: number
  minor: number
}

export function claudeModelInfo(model: string): ClaudeModelInfo | null {
  const m = model.toLowerCase()
  const named = /claude-(opus|sonnet|haiku|fable|mythos)(?:-(\d{1,2})(?:[-.](\d{1,2})(?!\d))?)?(?![a-z0-9])/.exec(m)
  if (named) {
    const family = named[1] as ClaudeModelInfo['family']
    // `claude-mythos-preview` and friends carry no number: the newest generation.
    const major = named[2] ? Number(named[2]) : family === 'fable' || family === 'mythos' ? 5 : 0
    return { family, major, minor: named[3] ? Number(named[3]) : 0 }
  }
  if (/claude-(fable|mythos)/.test(m)) {
    return { family: /fable/.test(m) ? 'fable' : 'mythos', major: 5, minor: 0 }
  }
  const legacy = /claude-(\d{1,2})(?:[-.](\d{1,2})(?!\d))?-(opus|sonnet|haiku)/.exec(m)
  if (legacy) {
    return {
      family: legacy[3] as ClaudeModelInfo['family'],
      major: Number(legacy[1]),
      minor: legacy[2] ? Number(legacy[2]) : 0
    }
  }
  return null
}

const atLeast = (info: ClaudeModelInfo, major: number, minor: number): boolean =>
  info.major > major || (info.major === major && info.minor >= minor)

/**
 * Claude models that reject sampling parameters outright (`temperature`,
 * `top_p`, `top_k` → 400): Opus 4.7, 4.8, 5 and 5.5, Sonnet 5, and the
 * Fable / Mythos families.
 */
export function anthropicForbidsSampling(model: string): boolean {
  const info = claudeModelInfo(model)
  if (!info) return false
  if (info.family === 'fable' || info.family === 'mythos') return true
  if (info.family === 'opus') return atLeast(info, 4, 7)
  if (info.family === 'sonnet') return info.major === 5 && info.minor === 0
  return false
}

/**
 * Claude models that accept sampling parameters only at their defaults
 * (any other value is a 400): Sonnet 5.5 and Haiku 5.5 onwards. Leaving the
 * parameter out is the only value that is always right.
 */
export function anthropicSamplingDefaultOnly(model: string): boolean {
  const info = claudeModelInfo(model)
  if (!info) return false
  if (info.family === 'sonnet') return atLeast(info, 5, 1)
  if (info.family === 'haiku') return atLeast(info, 5, 0)
  return false
}

/** Whether an Anthropic request for this model must leave `temperature` out. */
export function anthropicOmitsTemperature(model: string): boolean {
  return anthropicForbidsSampling(model) || anthropicSamplingDefaultOnly(model)
}

/**
 * Claude models that think adaptively (`thinking: {type: 'adaptive'}` plus
 * `output_config.effort`): the 4.6 generation and everything after it. They
 * reject — or are deprecated for — `budget_tokens`; 3.7 through 4.5 and
 * Haiku 4.5 still take a fixed budget.
 */
export function anthropicAdaptiveThinking(model: string): boolean {
  const info = claudeModelInfo(model)
  if (!info) return false
  if (info.family === 'fable' || info.family === 'mythos') return true
  if (info.family === 'haiku') return atLeast(info, 5, 0)
  return atLeast(info, 4, 6)
}

/**
 * Claude models whose thinking cannot be switched off from the request: an
 * omitted `thinking` runs adaptive, and several of them reject
 * `{type: 'disabled'}` (Opus 5.5, Sonnet 5.5, Fable). Opus 5, Sonnet 5 and
 * Haiku 5.5 onwards, Fable and Mythos. The adapter never sends `disabled`;
 * the shallowest depth is effort "low".
 */
export function anthropicThinkingAlwaysOn(model: string): boolean {
  const info = claudeModelInfo(model)
  if (!info) return false
  if (info.family === 'fable' || info.family === 'mythos') return true
  return atLeast(info, 5, 0)
}

/**
 * The level an adapter actually sends. Leaving the knob unset does not mean
 * "no thinking" on a reasoning model — the provider default (medium) applies,
 * which is far too slow for screen generation (mechanical transcription of a
 * spec). So an unset config runs those models at low: OpenAI-family
 * reasoning models, and Claude models that always think. Every other Claude
 * model stays opt-in (unset = no extended thinking). An explicit level
 * always wins.
 */
export function effectiveReasoning(
  config: Pick<LLMConfig, 'provider' | 'model' | 'reasoning'>
): ReasoningLevel | undefined {
  if (config.reasoning) return config.reasoning
  if (config.provider === 'anthropic') {
    return anthropicThinkingAlwaysOn(config.model) ? 'low' : undefined
  }
  if (isOpenAIReasoningModel(config.model)) return 'low'
  return undefined
}

/**
 * OpenAI-family effort per level. "none" maps to the least each family
 * accepts: gpt-5 takes "minimal", the gpt-5.x point releases take "none",
 * and the o-series only low/medium/high (anything else is a 400).
 */
export function openaiReasoningEffort(level: ReasoningLevel, model = 'gpt-5'): string {
  if (level !== 'none') return level
  if (/gpt-5\.\d/i.test(model)) return 'none'
  if (/gpt-5/i.test(model)) return 'minimal'
  return 'low'
}

/**
 * Anthropic extended-thinking budget per level. The API requires
 * budget_tokens ≥ 1024 and < max_tokens; the adapter adds the budget on top
 * of the visible output room (anthropicMaxTokens), so thinking never eats
 * the screen's space.
 */
export function anthropicThinkingBudget(level: ReasoningLevel): number | null {
  const budgets = { low: 2_048, medium: 4_096, high: 6_144 } as const
  return level === 'none' ? null : budgets[level]
}

/**
 * Visible output room per Anthropic response. A whole app-wide edit or a
 * dense page easily needs more than the old 8k; a cut-off spec is wasted
 * work plus a corrective round.
 */
export const ANTHROPIC_VISIBLE_TOKENS = 16_384

/**
 * The most a Claude model can emit in one response — sending more is a 400.
 * Unknown ids (Anthropic-compatible gateways serving other models) get no
 * clamp: their limits are unknowable here, and the visible default is
 * modest.
 */
export function anthropicMaxOutput(model: string): number | null {
  const m = model.toLowerCase()
  if (!/claude/.test(m)) return null
  if (/claude-(2|instant)/.test(m)) return 4_096
  if (/claude-3[-.]5/.test(m)) return 8_192
  if (/claude-3[-.]7/.test(m)) return 64_000
  if (/claude-3(?![-.]\d)/.test(m)) return 4_096 // claude-3-opus / sonnet / haiku
  if (/opus-4(?![-.]?[5-9])|claude-4-opus/.test(m)) return 32_000 // opus 4 / 4.1
  return 64_000 // sonnet/haiku 4+, opus 4.5+, and newer families
}

/**
 * max_tokens for one Anthropic request: the visible room (config override or
 * the default) plus the thinking budget, clamped to the model's ceiling.
 */
export function anthropicMaxTokens(
  model: string,
  thinkingBudget: number | null,
  visible: number = ANTHROPIC_VISIBLE_TOKENS
): number {
  const room =
    Number.isFinite(visible) && visible >= 1 ? Math.floor(visible) : ANTHROPIC_VISIBLE_TOKENS
  const want = room + (thinkingBudget ?? 0)
  const cap = anthropicMaxOutput(model)
  return cap === null ? want : Math.min(cap, want)
}

/**
 * The depth the engine's corrective round reaches for. Unset/none is treated
 * as "one notch below low" so an untouched config still climbs to low on a
 * retry — the escalation is never wasted, and it saturates at high. Callers
 * should pass `effectiveReasoning(config)`: a gpt-5 config that is unset
 * already runs at low, so its corrective round must climb to medium.
 */
export function nextReasoningLevel(level: ReasoningLevel | undefined): ReasoningLevel {
  const order = REASONING_LEVELS
  const at = level ? order.indexOf(level) : 0
  return order[Math.min(at + 1, order.length - 1)]
}
