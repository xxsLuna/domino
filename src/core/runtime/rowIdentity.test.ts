import { describe, expect, it } from 'vitest'
import { recoverRowIdentity } from './rowIdentity'

/** The shape a source snapshot takes: the response body, records under a field. */
const snaps = {
  notes: {
    count: 2,
    notes: [
      {
        id: '551',
        name: 'Tom Weber',
        title: 'Tom Weber — notes',
        company: 'Contoso',
        status: 'new',
        owner: 'Yuki Tanaka',
        done: false
      },
      {
        id: '552',
        name: 'Sofia Rossi',
        title: 'Sofia Rossi — notes',
        company: 'Tailspin',
        status: 'active',
        owner: 'Grace Kim',
        done: true
      }
    ]
  }
}

describe('recoverRowIdentity', () => {
  it('maps a baked Table row back to its record through the visible cells', () => {
    // The EditTrail bug: rows copied into props, so the select carries only
    // the displayed cells — the notes snapshot still holds the real records.
    const data = {
      index: 0,
      row: { Name: 'Tom Weber', Owner: 'Yuki Tanaka', Company: 'Contoso', Status: 'new' },
      record: { Name: 'Tom Weber', Owner: 'Yuki Tanaka', Company: 'Contoso', Status: 'new' }
    }
    const hit = recoverRowIdentity(data, snaps)
    expect(hit?.id).toBe('551')
    expect(hit?.record.name).toBe('Tom Weber')
  })

  it('maps a baked List item back by its title', () => {
    const hit = recoverRowIdentity({ title: 'Sofia Rossi — notes' }, snaps)
    expect(hit?.id).toBe('552')
  })

  it('recovers from a partial row (only some fields shown)', () => {
    const hit = recoverRowIdentity({ row: { Company: 'Tailspin', Status: 'active' } }, snaps)
    expect(hit?.id).toBe('552')
  })

  it('finds records when the snapshot IS the array', () => {
    const hit = recoverRowIdentity({ row: { Name: 'Tom Weber' } }, { notes: snaps.notes.notes })
    expect(hit?.id).toBe('551')
  })

  it('refuses when two records fit the row (ambiguous)', () => {
    const two = {
      a: [{ id: '1', name: 'Same', tag: 'x' }],
      b: [{ id: '2', name: 'Same', tag: 'y' }]
    }
    expect(recoverRowIdentity({ row: { Name: 'Same' } }, two)).toBeNull()
  })

  it('refuses when no record covers EVERY cell', () => {
    // "Ghost" appears in no note: a partial guess is a wrong record.
    expect(recoverRowIdentity({ row: { Name: 'Ghost', Company: 'Contoso' } }, snaps)).toBeNull()
  })

  it('refuses with nothing to match on', () => {
    expect(recoverRowIdentity({ index: 2 }, snaps)).toBeNull()
    expect(recoverRowIdentity(undefined, snaps)).toBeNull()
    expect(recoverRowIdentity({ row: { Note: '' } }, snaps)).toBeNull()
  })

  it('accepts numeric ids and numeric cells', () => {
    const s = { leads: { rows: [{ id: 701, company: 'Acme', amount: 120 }] } }
    const hit = recoverRowIdentity({ row: { Company: 'Acme', Amount: 120 } }, s)
    expect(hit?.id).toBe('701')
  })

  it('skips records without an identity', () => {
    expect(recoverRowIdentity({ row: { Name: 'Tom Weber' } }, { x: [{ name: 'Tom Weber' }] })).toBeNull()
  })
})
