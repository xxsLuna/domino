import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KvStore, bulkFileName, isSecretKey, isSensitiveBulkKey, type Cipher } from './kvStore'

/** Reversible stand-in for safeStorage: base64 with a marker. */
const cipher: Cipher = {
  available: () => true,
  encrypt: (v) => Buffer.from(`enc:${v}`).toString('base64'),
  decrypt: (s) => {
    const plain = Buffer.from(s, 'base64').toString()
    if (!plain.startsWith('enc:')) throw new Error('bad ciphertext')
    return plain.slice(4)
  }
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'domino-kv-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const open = (extra: Partial<ConstructorParameters<typeof KvStore>[0]> = {}): KvStore =>
  new KvStore({ dir, cipher, debounceMs: 5, ...extra })

describe('KvStore', () => {
  it('keeps secrets encrypted in the secure file and bulk data in per-key files', async () => {
    const kv = open()
    await kv.set('domino:llm-config', '{"apiKey":"sk-1"}')
    await kv.set('domino:screens:App|', '{"v":2}')
    await kv.flush()

    const secure = JSON.parse(await readFile(join(dir, 'secure-store.json'), 'utf-8')) as Record<
      string,
      string
    >
    expect(Object.keys(secure)).toEqual(['domino:llm-config'])
    expect(secure['domino:llm-config']).not.toContain('sk-1')
    const bulk = JSON.parse(
      await readFile(join(dir, 'kv', bulkFileName('domino:screens:App|')), 'utf-8')
    ) as { k: string; e: string }
    // Encrypted at rest like every bulk value (pages embed records).
    expect(bulk).toEqual({ k: 'domino:screens:App|', e: cipher.encrypt('{"v":2}') })

    const reopened = open()
    expect(await reopened.get('domino:llm-config')).toBe('{"apiKey":"sk-1"}')
    expect(await reopened.get('domino:screens:App|')).toBe('{"v":2}')
  })

  it('a bulk write rewrites only that key', async () => {
    const kv = open()
    await kv.set('domino:llm-config', 'secret')
    await kv.set('domino:view:A|::auth:true', 'one')
    await kv.flush()
    const before = await readFile(join(dir, 'secure-store.json'), 'utf-8')
    await kv.set('domino:history:A|::auth:true', 'h')
    await kv.flush()
    expect(await readFile(join(dir, 'secure-store.json'), 'utf-8')).toBe(before)
    expect((await readdir(join(dir, 'kv'))).length).toBe(2)
  })

  it('coalesces a burst of sets into one write per key', async () => {
    const kv = open({ debounceMs: 30 })
    for (let i = 0; i < 50; i++) await kv.set('domino:view:A|::auth:true', String(i))
    expect(await kv.get('domino:view:A|::auth:true')).toBe('49') // reads are from memory
    await new Promise((r) => setTimeout(r, 80))
    const file = JSON.parse(
      await readFile(join(dir, 'kv', bulkFileName('domino:view:A|::auth:true')), 'utf-8')
    ) as { e: string }
    expect(cipher.decrypt(file.e)).toBe('49')
    expect(kv.dirty).toBe(false)
  })

  it('encrypts private API snapshots in their own file', async () => {
    const kv = open()
    await kv.set('domino:apisnaps:A|', '{"GET /me":{"email":"x@y"}}')
    await kv.flush()
    const raw = await readFile(join(dir, 'kv', bulkFileName('domino:apisnaps:A|')), 'utf-8')
    expect(raw).not.toContain('x@y')
    expect(await open().get('domino:apisnaps:A|')).toBe('{"GET /me":{"email":"x@y"}}')
  })

  it('encrypts [data] snapshots and every other bulk value on disk', async () => {
    const kv = open()
    await kv.set('domino:datasnaps:A|', '{"leads":{"rows":[{"email":"x@y"}]}}')
    await kv.set('domino:history:A|::auth:true', '{"label":"Jane Doe"}')
    await kv.flush()
    for (const key of ['domino:datasnaps:A|', 'domino:history:A|::auth:true']) {
      const file = JSON.parse(await readFile(join(dir, 'kv', bulkFileName(key)), 'utf-8')) as {
        v?: string
        e?: string
      }
      expect(file.v, key).toBeUndefined()
      expect(typeof file.e, key).toBe('string')
    }
    expect(isSensitiveBulkKey('domino:datasnaps:A|')).toBe(true)
    expect(await open().get('domino:datasnaps:A|')).toBe('{"leads":{"rows":[{"email":"x@y"}]}}')
  })

  it('still reads an old plaintext bulk file, and encrypts it on its next write', async () => {
    const key = 'domino:view:A|::auth:false'
    await mkdir(join(dir, 'kv'), { recursive: true })
    await writeFile(join(dir, 'kv', bulkFileName(key)), JSON.stringify({ k: key, v: 'old' }))
    const kv = open()
    expect(await kv.get(key)).toBe('old')
    await kv.set(key, 'new')
    await kv.flush()
    const file = JSON.parse(await readFile(join(dir, 'kv', bulkFileName(key)), 'utf-8')) as {
      e?: string
    }
    expect(cipher.decrypt(file.e!)).toBe('new')
  })

  it('never overwrites a secure file it could not read, and merges once it can', async () => {
    const secure = join(dir, 'secure-store.json')
    // A directory in its place: every read fails with a non-ENOENT error (a lock).
    await mkdir(secure)
    const errors: string[] = []
    const kv = open({ onError: (key) => errors.push(key) })
    expect(await kv.get('domino:llm-config')).toBeNull()
    await kv.set('domino:token:A|', 'tok')
    await kv.flush()
    expect(errors).toContain('secure-store')
    expect(kv.dirty).toBe(true)
    // The lock goes away: the real file holds the BYOK key.
    await rm(secure, { recursive: true })
    await writeFile(secure, JSON.stringify({ 'domino:llm-config': cipher.encrypt('byok') }))
    expect(await kv.get('domino:llm-config')).toBe('byok')
    await kv.flush()
    const reopened = open()
    expect(await reopened.get('domino:llm-config')).toBe('byok')
    expect(await reopened.get('domino:token:A|')).toBe('tok')
  })

  it('removes keys from memory and disk', async () => {
    const kv = open()
    await kv.set('domino:graph:A|', 'g')
    await kv.set('domino:token:A|', 't')
    await kv.flush()
    await kv.remove('domino:graph:A|')
    await kv.remove('domino:token:A|')
    await kv.flush()
    const reopened = open()
    expect(await reopened.get('domino:graph:A|')).toBeNull()
    expect(await reopened.get('domino:token:A|')).toBeNull()
    expect(await reopened.entries()).toEqual([])
  })

  it('migrates bulk keys out of an old all-in-one secure file', async () => {
    await writeFile(
      join(dir, 'secure-store.json'),
      JSON.stringify(
        {
          'domino:llm-config': cipher.encrypt('{"apiKey":"k"}'),
          'domino:screens:A|': cipher.encrypt('[1,2]'),
          'domino:recents': 'plain:[]'
        },
        null,
        2
      )
    )
    const kv = open()
    expect(await kv.get('domino:screens:A|')).toBe('[1,2]')
    await kv.flush()
    const secure = JSON.parse(await readFile(join(dir, 'secure-store.json'), 'utf-8')) as object
    expect(Object.keys(secure)).toEqual(['domino:llm-config'])
    const reopened = open()
    expect(await reopened.get('domino:screens:A|')).toBe('[1,2]')
    expect(await reopened.get('domino:recents')).toBe('[]')
    expect(await reopened.get('domino:llm-config')).toBe('{"apiKey":"k"}')
  })

  it('sets a corrupt secure file aside and keeps working', async () => {
    await writeFile(join(dir, 'secure-store.json'), '{broken')
    const kv = open()
    expect(await kv.get('domino:llm-config')).toBeNull()
    await kv.set('domino:llm-config', 'fresh')
    await kv.flush()
    const names = await readdir(dir)
    expect(names.some((n) => n.startsWith('secure-store.corrupt-'))).toBe(true)
    expect(await open().get('domino:llm-config')).toBe('fresh')
  })

  it('getMany and entries cover both stores', async () => {
    const kv = open()
    await kv.set('domino:token:A|', 'tok')
    await kv.set('domino:feeds:A|', '[]')
    expect(await kv.getMany(['domino:token:A|', 'domino:feeds:A|', 'nope'])).toEqual([
      'tok',
      '[]',
      null
    ])
    expect((await kv.entries()).map(([k]) => k).sort()).toEqual([
      'domino:feeds:A|',
      'domino:token:A|'
    ])
  })

  it('reports write failures', async () => {
    const errors: string[] = []
    // a FILE where the bulk directory should be makes every bulk write fail
    await writeFile(join(dir, 'kv'), 'not a dir')
    const kv = open({ onError: (key) => errors.push(key) })
    await kv.set('domino:screens:A|', 'x')
    await kv.flush()
    expect(errors.length).toBeGreaterThan(0)
    expect(kv.dirty).toBe(true) // kept for a retry
  })

  it('classifies secrets', () => {
    expect(isSecretKey('domino:llm-config')).toBe(true)
    expect(isSecretKey('domino:llm-config:A|')).toBe(true)
    expect(isSecretKey('domino:token:A|')).toBe(true)
    expect(isSecretKey('domino:screens:A|')).toBe(false)
  })
})
