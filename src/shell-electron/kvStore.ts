import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The main-process key/value store behind the renderer's `secure` bridge.
 *
 * It used to be ONE encrypted JSON file that every get re-read and every set
 * re-read, re-encrypted, pretty-printed and rewrote — with screens, views,
 * history and graphs all inside, a few MB of disk + DPAPI work per tap, every
 * op queued behind the last. Now:
 *
 * - Everything lives in memory after one lazy load; gets never touch disk.
 * - Secrets (BYOK keys, per-domino LLM overrides, auth tokens) stay in the
 *   encrypted `secure-store.json`, written compactly on a short debounce.
 * - Everything else is bulk: one small file per key under `kv/`, written on
 *   its own debounce, so a history write rewrites only the history. Every
 *   bulk value is encrypted whenever the OS cipher is available — views,
 *   history and page blobs embed records, and [data] / API snapshots are
 *   private response bodies; before the split they all lived in the
 *   encrypted file. Per-key files keep that cheap. Older plaintext files
 *   still load and are re-encrypted on their next write.
 * - Existing installs migrate on first load: bulk keys move out of the
 *   secure file once.
 * - A corrupt secure file is copied aside (`secure-store.corrupt-<ts>.json`)
 *   and the store starts empty instead of refusing every write forever.
 * - A secure file that exists but can't be READ (EBUSY / EPERM from an
 *   antivirus or backup lock, EACCES) is never overwritten from an empty
 *   start: every write first re-reads it and merges what is on disk under
 *   the in-memory secrets; while it stays unreadable, secret writes wait.
 * - Write failures are reported through `onError` (the renderer surfaces
 *   them); `flush()` writes everything pending — call it before quitting.
 */

export interface Cipher {
  available(): boolean
  /** plain → base64 ciphertext */
  encrypt(value: string): string
  /** base64 ciphertext → plain (throws when it can't) */
  decrypt(stored: string): string
}

export interface KvStoreOptions {
  /** userData directory. */
  dir: string
  cipher: Cipher
  /** Write debounce; default 250ms. */
  debounceMs?: number
  onError?: (key: string, err: Error) => void
  log?: (message: string) => void
}

/** Keys that must stay in the encrypted single file. */
export function isSecretKey(key: string): boolean {
  return (
    key === 'domino:llm-config' ||
    key.startsWith('domino:llm-config:') ||
    key.startsWith('domino:token:')
  )
}

/**
 * Bulk keys whose values are private response data: [api] bodies, [data]
 * source bodies (the same kind of data), session variables and feeds. Every
 * bulk value is encrypted when the cipher is available (see writeBulk); this
 * names the ones that hold response bodies by design.
 */
export function isSensitiveBulkKey(key: string): boolean {
  return (
    key.startsWith('domino:apisnaps:') ||
    key.startsWith('domino:datasnaps:') ||
    key.startsWith('domino:sessionvars:') ||
    key.startsWith('domino:feeds:')
  )
}

const SECURE_FILE = 'secure-store.json'
const BULK_DIR = 'kv'

/** One bulk file per key; the name is a hash so any key is a safe filename. */
export function bulkFileName(key: string): string {
  return `${createHash('sha1').update(key).digest('hex')}.json`
}

interface BulkFile {
  k: string
  /** plain value */
  v?: string
  /** encrypted value (base64), for sensitive keys */
  e?: string
}

export class KvStore {
  /** secret key → stored form (`plain:…` or base64 ciphertext). */
  private secrets = new Map<string, string>()
  private readonly secretPlain = new Map<string, string>()
  /** bulk key → plain value. */
  private readonly bulk = new Map<string, string>()
  private loaded: Promise<void> | null = null
  private secretsDirty = false
  /**
   * The secure file exists but could not be read (a lock, a permission
   * error): what is in memory is NOT the whole store, so it must never be
   * written over the file until a re-read succeeds.
   */
  private secretsUnreadable = false
  /** Secrets removed in memory while the file was unreadable — they stay removed on merge. */
  private readonly removedSecrets = new Set<string>()
  /** Bulk keys whose file must be (re)written or deleted. */
  private readonly dirtyBulk = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly opts: KvStoreOptions) {}

  private get securePath(): string {
    return join(this.opts.dir, SECURE_FILE)
  }

  private get bulkDir(): string {
    return join(this.opts.dir, BULK_DIR)
  }

  private load(): Promise<void> {
    if (!this.loaded) this.loaded = this.doLoad()
    return this.loaded
  }

  private async doLoad(): Promise<void> {
    await this.loadBulk()
    await this.loadSecrets()
  }

  private async loadSecrets(): Promise<void> {
    const data = await this.readSecrets()
    if (data) this.absorbSecrets(data)
    if (this.secretsDirty || this.dirtyBulk.size) this.schedule()
  }

  /**
   * Read and parse the secure file. Missing → `{}` (a fresh store). Unreadable
   * → null, with `secretsUnreadable` set. Corrupt → copied aside and `{}`;
   * when even the copy fails it counts as unreadable (never overwritten).
   */
  private async readSecrets(): Promise<Record<string, unknown> | null> {
    let raw: string
    try {
      raw = await readFile(this.securePath, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.secretsUnreadable = false
        return {}
      }
      this.secretsUnreadable = true
      this.opts.log?.(`secure store unreadable: ${(err as Error).message}`)
      return null
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.secretsUnreadable = false
        return parsed as Record<string, unknown>
      }
    } catch {
      /* corrupt — handled below */
    }
    // Keep the bytes (a BYOK key may still be recoverable), start clean.
    const aside = join(this.opts.dir, `secure-store.corrupt-${Date.now()}.json`)
    try {
      await copyFile(this.securePath, aside)
      this.opts.log?.(`secure store was corrupt; kept a copy at ${aside}`)
      this.secretsUnreadable = false
      return {}
    } catch (err) {
      // No copy, no overwrite: the only bytes of the BYOK key stay put.
      this.secretsUnreadable = true
      this.opts.log?.(
        `secure store corrupt and could not be copied aside: ${(err as Error).message}`
      )
      return null
    }
  }

  /**
   * Take the secure file's entries in. Keys already in memory win (they are
   * newer), keys removed in memory stay removed; bulk keys older builds kept
   * there migrate out to their own files.
   */
  private absorbSecrets(data: Record<string, unknown>): void {
    for (const [key, stored] of Object.entries(data)) {
      if (typeof stored !== 'string') continue
      if (isSecretKey(key)) {
        if (!this.secrets.has(key) && !this.removedSecrets.has(key)) this.secrets.set(key, stored)
        continue
      }
      // Migration: bulk data that older builds kept in the secure file.
      const plain = this.decode(stored)
      if (plain !== null && !this.bulk.has(key)) {
        this.bulk.set(key, plain)
        this.dirtyBulk.add(key)
      }
      this.secretsDirty = true
    }
  }

  /** The file was unreadable: try again, merging what is on disk under memory. */
  private async retrySecrets(): Promise<boolean> {
    if (!this.secretsUnreadable) return true
    const data = await this.readSecrets()
    if (!data) return false
    this.absorbSecrets(data)
    this.removedSecrets.clear()
    return true
  }

  private async loadBulk(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.bulkDir)
    } catch {
      return // no bulk directory yet
    }
    await Promise.all(
      names
        .filter((n) => n.endsWith('.json'))
        .map(async (name) => {
          try {
            const parsed = JSON.parse(await readFile(join(this.bulkDir, name), 'utf-8')) as BulkFile
            if (!parsed || typeof parsed.k !== 'string') return
            if (typeof parsed.v === 'string') this.bulk.set(parsed.k, parsed.v)
            else if (typeof parsed.e === 'string') {
              const plain = this.decode(parsed.e)
              if (plain !== null) this.bulk.set(parsed.k, plain)
            }
          } catch {
            /* a torn or foreign file — skip it */
          }
        })
    )
  }

  /** Stored secret form → plain (null when it can't be decrypted). */
  private decode(stored: string): string | null {
    if (stored.startsWith('plain:')) return stored.slice(6)
    if (!this.opts.cipher.available()) return stored
    try {
      return this.opts.cipher.decrypt(stored)
    } catch {
      return null
    }
  }

  private encode(value: string): string {
    return this.opts.cipher.available() ? this.opts.cipher.encrypt(value) : `plain:${value}`
  }

  async get(key: string): Promise<string | null> {
    await this.load()
    if (isSecretKey(key)) {
      const cached = this.secretPlain.get(key)
      if (cached !== undefined) return cached
      // Values reappear once the lock on the file is released.
      if (!this.secrets.has(key) && this.secretsUnreadable) await this.retrySecrets()
      const stored = this.secrets.get(key)
      if (stored === undefined) return null
      const plain = this.decode(stored)
      if (plain !== null) this.secretPlain.set(key, plain)
      return plain
    }
    return this.bulk.get(key) ?? null
  }

  async getMany(keys: string[]): Promise<Array<string | null>> {
    await this.load()
    return Promise.all(keys.map((key) => this.get(key)))
  }

  async set(key: string, value: string): Promise<void> {
    await this.load()
    if (isSecretKey(key)) {
      this.secrets.set(key, this.encode(value))
      this.secretPlain.set(key, value)
      this.removedSecrets.delete(key)
      this.secretsDirty = true
    } else {
      this.bulk.set(key, value)
      this.dirtyBulk.add(key)
    }
    this.schedule()
  }

  async remove(key: string): Promise<void> {
    await this.load()
    if (isSecretKey(key)) {
      if (this.secrets.delete(key)) this.secretsDirty = true
      this.secretPlain.delete(key)
      if (this.secretsUnreadable) {
        this.removedSecrets.add(key)
        this.secretsDirty = true
      }
    } else {
      this.bulk.delete(key)
      this.dirtyBulk.add(key)
    }
    this.schedule()
  }

  async entries(): Promise<Array<[string, string]>> {
    await this.load()
    const out: Array<[string, string]> = []
    for (const key of this.secrets.keys()) {
      const plain = await this.get(key)
      if (plain !== null) out.push([key, plain])
    }
    for (const entry of this.bulk) out.push(entry)
    return out
  }

  /** Anything not yet on disk? */
  get dirty(): boolean {
    return this.secretsDirty || this.dirtyBulk.size > 0
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.opts.debounceMs ?? 250)
    this.timer.unref?.()
  }

  /** Write everything pending; one write pass at a time. */
  flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const run = this.writing.then(() => this.writePending())
    this.writing = run.catch(() => undefined)
    return run
  }

  private async writePending(): Promise<void> {
    await this.load()
    const keys = [...this.dirtyBulk]
    this.dirtyBulk.clear()
    let bulkOk = true
    if (keys.length) {
      try {
        await mkdir(this.bulkDir, { recursive: true })
        bulkOk = (await Promise.all(keys.map((key) => this.writeBulk(key)))).every(Boolean)
      } catch (err) {
        for (const key of keys) this.dirtyBulk.add(key)
        this.report(BULK_DIR, err)
        bulkOk = false
      }
    }
    // Never drop migrated bulk keys from the secure file before they landed
    // in their own files: the secure rewrite waits for a clean bulk pass.
    if (this.secretsDirty && bulkOk) {
      // Never write over a file we could not read: re-read and merge first;
      // still unreadable → keep everything pending and say so.
      if (!(await this.retrySecrets())) {
        this.report('secure-store', new Error('secure store is unreadable; not overwriting it'))
        return
      }
      this.secretsDirty = false
      const data: Record<string, string> = Object.fromEntries(this.secrets)
      try {
        await atomicWrite(this.securePath, JSON.stringify(data))
      } catch (err) {
        this.secretsDirty = true
        this.report('secure-store', err)
      }
    }
  }

  private async writeBulk(key: string): Promise<boolean> {
    const file = join(this.bulkDir, bulkFileName(key))
    const value = this.bulk.get(key)
    try {
      if (value === undefined) {
        await unlink(file).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') throw err
        })
        return true
      }
      // Encrypted whenever the cipher is there (every bulk value may hold
      // records); plain only where the OS offers no cipher at all.
      const body: BulkFile = this.opts.cipher.available()
        ? { k: key, e: this.opts.cipher.encrypt(value) }
        : { k: key, v: value }
      await atomicWrite(file, JSON.stringify(body))
      return true
    } catch (err) {
      this.dirtyBulk.add(key) // retried on the next pass
      this.report(key, err)
      return false
    }
  }

  private report(key: string, err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err))
    this.opts.log?.(`storage write failed for ${key}: ${error.message}`)
    try {
      this.opts.onError?.(key, error)
    } catch {
      /* reporting must not break the store */
    }
  }
}

/** Temp file + rename: a crash never leaves a half-written file; 0600 keeps it this user's. */
async function atomicWrite(dest: string, body: string): Promise<void> {
  const tmp = `${dest}.${process.pid}.tmp`
  await writeFile(tmp, body, { encoding: 'utf-8', mode: 0o600 })
  await rename(tmp, dest)
}
