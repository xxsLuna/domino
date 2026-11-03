/**
 * Tool-call arguments as a provider re-reads them from history. Chat
 * Completions and Responses replay `arguments` as a string, and strict
 * OpenAI-compatible backends (Ollama's /v1 layer, vLLM chat templates,
 * Gemini's compat endpoint) JSON-parse it and answer 400 when it is not an
 * object — a cut-off or malformed call from an earlier pass would then fail
 * every later request of the turn. Anything that is not a JSON object is
 * sent as a valid wrapper holding the head of what the model wrote.
 */
const INVALID_HEAD_CHARS = 500

export function wireToolArgs(args: string): string {
  try {
    const v: unknown = JSON.parse(args)
    if (v && typeof v === 'object' && !Array.isArray(v)) return args
  } catch {
    // fall through to the wrapper
  }
  if (!args.trim()) return '{}'
  return JSON.stringify({ _invalid: args.slice(0, INVALID_HEAD_CHARS) })
}
