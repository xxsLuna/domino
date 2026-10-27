import type { LLMConfig } from './types'

/** One provider-agnostic depth, mapped onto each adapter's own wire knob. */
export type ReasoningLevel = NonNullable<LLMConfig['reasoning']>

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
 * OpenAI-family effort per level. An explicit "none" floors at "minimal" —
 * o-series always think a little; minimal is the least they can spend.
 */
export function openaiReasoningEffort(level: ReasoningLevel): string {
  return level === 'none' ? 'minimal' : level
}

/**
 * Anthropic extended-thinking budget per level. The API requires
 * budget_tokens < max_tokens (the adapters send 8192) and ≥ 1024.
 */
export function anthropicThinkingBudget(level: ReasoningLevel): number | null {
  const budgets = { low: 2_048, medium: 4_096, high: 6_144 } as const
  return level === 'none' ? null : budgets[level]
}

/**
 * The depth the engine's corrective round reaches for. Unset/none is treated
 * as "one notch below low" so an untouched config still climbs to low on a
 * retry — the escalation is never wasted, and it saturates at high.
 */
export function nextReasoningLevel(level: ReasoningLevel | undefined): ReasoningLevel {
  const order: ReasoningLevel[] = ['none', 'low', 'medium', 'high']
  const at = level ? order.indexOf(level) : 0
  return order[Math.min(at + 1, order.length - 1)]
}
