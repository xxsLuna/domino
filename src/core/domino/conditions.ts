/**
 * Tiny boolean expression DSL used by `[script]` rules.
 *
 *   logged_in
 *   not logged_in
 *   param.plan == "pro"
 *   logged_in and error == null
 *   error == "auth" or token_expired
 *
 * Identifiers resolve against a context: dotted paths walk nested objects,
 * `logged_in` and friends are top-level vars.
 */

export interface EvalContext {
  vars: Record<string, unknown>
}

type Token =
  | { t: 'id'; v: string }
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'op'; v: string }
  | { t: 'lparen' }
  | { t: 'rparen' }

export class ConditionError extends Error {}

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '(') {
      tokens.push({ t: 'lparen' })
      i++
      continue
    }
    if (c === ')') {
      tokens.push({ t: 'rparen' })
      i++
      continue
    }
    if (c === '"' || c === "'") {
      const quote = c
      let j = i + 1
      let out = ''
      while (j < src.length && src[j] !== quote) {
        out += src[j]
        j++
      }
      if (j >= src.length) throw new ConditionError(`unterminated string: ${src.slice(i)}`)
      tokens.push({ t: 'str', v: out })
      i = j + 1
      continue
    }
    const two = src.slice(i, i + 2)
    if (['==', '!=', '>=', '<='].includes(two)) {
      tokens.push({ t: 'op', v: two })
      i += 2
      continue
    }
    if (['>', '<'].includes(c)) {
      tokens.push({ t: 'op', v: c })
      i++
      continue
    }
    if (/[0-9]/.test(c)) {
      let j = i
      while (j < src.length && /[0-9._]/.test(src[j])) j++
      const raw = src.slice(i, j)
      const n = Number(raw)
      if (Number.isNaN(n)) throw new ConditionError(`bad number: ${raw}`)
      tokens.push({ t: 'num', v: n })
      i = j
      continue
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i
      while (j < src.length && /[A-Za-z0-9_$.]/.test(src[j])) j++
      tokens.push({ t: 'id', v: src.slice(i, j) })
      i = j
      continue
    }
    throw new ConditionError(`unexpected character '${c}' in condition`)
  }
  return tokens
}

type Node =
  | { k: 'and' | 'or'; l: Node; r: Node }
  | { k: 'not'; v: Node }
  | { k: 'cmp'; op: string; l: Node; r: Node }
  | { k: 'lit'; v: unknown }
  | { k: 'ref'; path: string }

class Parser {
  private pos = 0
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }

  private next(): Token {
    const t = this.tokens[this.pos++]
    if (!t) throw new ConditionError('unexpected end of condition')
    return t
  }

  parse(): Node {
    const node = this.parseOr()
    if (this.pos < this.tokens.length) throw new ConditionError('trailing tokens in condition')
    return node
  }

  private parseOr(): Node {
    let left = this.parseAnd()
    for (;;) {
      const t = this.peek()
      if (t?.t === 'id' && t.v === 'or') {
        this.next()
        left = { k: 'or', l: left, r: this.parseAnd() }
      } else break
    }
    return left
  }

  private parseAnd(): Node {
    let left = this.parseNot()
    for (;;) {
      const t = this.peek()
      if (t?.t === 'id' && t.v === 'and') {
        this.next()
        left = { k: 'and', l: left, r: this.parseNot() }
      } else break
    }
    return left
  }

  private parseNot(): Node {
    const t = this.peek()
    if (t?.t === 'id' && t.v === 'not') {
      this.next()
      return { k: 'not', v: this.parseNot() }
    }
    return this.parseCmp()
  }

  private parseCmp(): Node {
    const left = this.parsePrimary()
    const t = this.peek()
    if (t?.t === 'op') {
      this.next()
      const right = this.parsePrimary()
      return { k: 'cmp', op: t.v, l: left, r: right }
    }
    return left
  }

  private parsePrimary(): Node {
    const t = this.next()
    if (t.t === 'lparen') {
      const node = this.parseOr()
      const close = this.next()
      if (close.t !== 'rparen') throw new ConditionError('expected )')
      return node
    }
    if (t.t === 'id') {
      if (t.v === 'true') return { k: 'lit', v: true }
      if (t.v === 'false') return { k: 'lit', v: false }
      if (t.v === 'null') return { k: 'lit', v: null }
      if (t.v === 'and' || t.v === 'or' || t.v === 'not') throw new ConditionError(`unexpected '${t.v}'`)
      return { k: 'ref', path: t.v }
    }
    if (t.t === 'str') return { k: 'lit', v: t.v }
    if (t.t === 'num') return { k: 'lit', v: t.v }
    throw new ConditionError('expected value in condition')
  }
}

function resolve(path: string, vars: Record<string, unknown>): unknown {
  const parts = path.split('.')
  let cur: unknown = vars
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

function truthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v.length > 0 && v !== 'false'
  // NaN is neither 0 nor a meaningful value: treat it as false, not true.
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v)
  return Boolean(v)
}

/** Natural string order ("item2" < "item10"); raw < compares UTF-16 code units. */
function compareStrings(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true })
}

function evalNode(node: Node, ctx: EvalContext): unknown {
  switch (node.k) {
    case 'lit':
      return node.v
    case 'ref':
      return resolve(node.path, ctx.vars)
    case 'not':
      return !truthy(evalNode(node.v, ctx))
    case 'and':
      return truthy(evalNode(node.l, ctx)) && truthy(evalNode(node.r, ctx))
    case 'or':
      return truthy(evalNode(node.l, ctx)) || truthy(evalNode(node.r, ctx))
    case 'cmp': {
      const l = evalNode(node.l, ctx)
      const r = evalNode(node.r, ctx)
      const ls = l === null || l === undefined ? '' : String(l)
      const rs = r === null || r === undefined ? '' : String(r)
      const ln = Number(l)
      const rn = Number(r)
      const numeric = !Number.isNaN(ln) && !Number.isNaN(rn) && ls !== '' && rs !== ''
      switch (node.op) {
        case '==':
          return numeric ? ln === rn : ls === rs
        case '!=':
          return numeric ? ln !== rn : ls !== rs
        case '>':
          return numeric ? ln > rn : compareStrings(ls, rs) > 0
        case '<':
          return numeric ? ln < rn : compareStrings(ls, rs) < 0
        case '>=':
          return numeric ? ln >= rn : compareStrings(ls, rs) >= 0
        case '<=':
          return numeric ? ln <= rn : compareStrings(ls, rs) <= 0
        default:
          throw new ConditionError(`unknown operator ${node.op}`)
      }
    }
  }
}

const cache = new Map<string, Node>()
// Conditions come from remote .domino files; keep the memo bounded (FIFO).
const MAX_CACHED_CONDITIONS = 1_000

/** Parse (and memoize) a condition string; throws ConditionError on bad syntax. */
export function parseCondition(src: string): Node {
  const key = src.trim()
  const hit = cache.get(key)
  if (hit) return hit
  const node = new Parser(tokenize(key)).parse()
  if (cache.size >= MAX_CACHED_CONDITIONS) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, node)
  return node
}

/** Syntax check for [script] conditions: null when valid, else the reason. */
export function validateCondition(src: string): string | null {
  try {
    parseCondition(src)
    return null
  } catch (err) {
    return (err as Error).message
  }
}

/** Returns false (with a console warning) on syntax errors rather than throwing. */
export function evalCondition(src: string, ctx: EvalContext): boolean {
  try {
    return truthy(evalNode(parseCondition(src), ctx))
  } catch (err) {
    console.warn(`[domino] bad condition "${src}": ${(err as Error).message}`)
    return false
  }
}
