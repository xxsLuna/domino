import { describe, expect, it } from 'vitest'
import { parseDomino } from './parse'
import {
  actionGotoTarget,
  formatActionSteps,
  interpolateBodyFields,
  interpolateCallPath,
  selectedRecordId
} from './actions'

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

describe('interpolateBodyFields', () => {
  it('passes literals through and fills placeholders unencoded', () => {
    expect(
      interpolateBodyFields(
        { status: 'approved', note: '{form.note}' },
        { data: { note: 'ok then' }, state: {} }
      )
    ).toEqual({ status: 'approved', note: 'ok then' })
    expect(interpolateBodyFields({ by: '{user}' }, { state: { user: 'kim' } })).toEqual({
      by: 'kim'
    })
  })

  it('refuses to send half a body', () => {
    expect(interpolateBodyFields({ status: '{form.status}' }, { data: {} })).toBeNull()
  })
})

describe('selectedRecordId', () => {
  it('reads the id a select carries, top level or inside the record', () => {
    expect(selectedRecordId({ id: '7', title: 'A' })).toBe('7')
    expect(selectedRecordId({ index: 0, row: { Name: 'A' }, record: { id: 42 } })).toBe('42')
    expect(selectedRecordId(undefined)).toBeNull()
    expect(selectedRecordId({ title: 'no id here' })).toBeNull()
    expect(selectedRecordId({ id: '  ' })).toBeNull()
  })
})

describe('body steps', () => {
  const file = (line: string): string =>
    `[meta]\nname = X\n[api]\nbase_url = https://api.test\nallow = /requests, /requests/*\n[data]\nrequests = GET /requests\n[actions]\napprove = ${line}\n`

  it('parses fixed body values and round-trips them as written', () => {
    const res = parseDomino(
      file('call PATCH /requests/{selected} body status=approved ; refresh requests ; goto main')
    )
    expect(res.errors).toEqual([])
    expect(res.domino?.actions[0].steps[0]).toEqual({
      kind: 'call',
      method: 'PATCH',
      path: '/requests/{selected}',
      body: 'none',
      fields: { status: 'approved' }
    })
    expect(formatActionSteps(res.domino!.actions[0])).toBe(
      'call PATCH /requests/{selected} body status=approved ; refresh requests ; goto main'
    )
  })

  it('keeps fixed fields and form values together, form winning', () => {
    const res = parseDomino(file('call PUT /requests/{id} with form body kind=leave, why={form.why}'))
    expect(res.errors).toEqual([])
    expect(res.domino?.actions[0].steps[0]).toEqual({
      kind: 'call',
      method: 'PUT',
      path: '/requests/{id}',
      body: 'form',
      fields: { kind: 'leave', why: '{form.why}' }
    })
  })

  it('rejects a pair that is not field=value and a bad placeholder in a value', () => {
    const bare = parseDomino(file('call PATCH /requests/1 body status'))
    expect(bare.errors.some((e) => e.message.includes('must be field=value'))).toBe(true)
    const deep = parseDomino(file('call PATCH /requests/1 body note={form.a.b}'))
    expect(deep.errors.some((e) => e.message.includes('body note=') && e.message.includes('{form.a.b}'))).toBe(
      true
    )
  })
})
