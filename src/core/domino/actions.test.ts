import { describe, expect, it } from 'vitest'
import { parseDomino } from './parse'
import { actionGotoTarget, formatActionSteps, interpolateCallPath } from './actions'

describe('formatActionSteps', () => {
  it('round-trips the file syntax, declared page ids included', () => {
    const line =
      'set q = form.query ; call POST /leads/{row.id}/notes with form ; refresh leads ; goto lead-detail'
    const res = parseDomino(
      `[meta]\nname = X\n[data]\nleads = GET /leads\n[actions]\nsave = ${line}\n`
    )
    const decl = res.domino!.actions[0]
    expect(formatActionSteps(decl)).toBe(line)
    expect(actionGotoTarget(decl)).toBe('lead-detail')
    expect(actionGotoTarget({ steps: [{ kind: 'refresh', source: 'x' }] })).toBeUndefined()
  })
})

describe('interpolateCallPath', () => {
  it('fills form/row fields from event data and plain keys from state, encoded', () => {
    expect(
      interpolateCallPath('/leads/{row.id}/notes?by={user}', {
        data: { id: 'a/b 1' },
        state: { user: 'kim' }
      })
    ).toBe('/leads/a%2Fb%201/notes?by=kim')
    expect(interpolateCallPath('/x/{form.n}', { data: { n: 3 } })).toBe('/x/3')
  })

  it('reads a selected row from the record, then the visible cells', () => {
    const select = { index: 2, row: { Name: 'Ana' }, record: { id: 7, stage: 'won' } }
    expect(interpolateCallPath('/leads/{row.id}/{row.stage}/{row.Name}', { data: select })).toBe(
      '/leads/7/won/Ana'
    )
  })

  it('refuses to run half-filled', () => {
    expect(interpolateCallPath('/x/{row.id}', { data: {} })).toBeNull()
    expect(interpolateCallPath('/x/{row.id}', { data: { id: '  ' } })).toBeNull()
    expect(interpolateCallPath('/x/{row.id}', { data: { id: { a: 1 } } })).toBeNull()
    expect(interpolateCallPath('/x/{id}', { data: { id: '1' } })).toBeNull()
    expect(interpolateCallPath('/x/{row.constructor}', { data: {} })).toBeNull()
  })
})
