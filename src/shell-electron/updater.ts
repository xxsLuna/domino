import { app, net } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { isNewer, RELEASES_REPO as REPO, RELEASES_URL } from '@core/version'

/**
 * Self-update from GitHub Releases: check on launch, then download the
 * platform's installer, swap it in, and relaunch.
 *
 * Not electron-updater: its macOS path goes through Squirrel.Mac, which only
 * accepts updates for Developer-ID-signed apps, and these builds are unsigned.
 * Every platform here uses the plain release assets CI already publishes:
 *   macOS   domino-<v>-<arch>-mac.zip   unzip, swap the .app after quitting, reopen
 *   Windows domino-<v>-win-<arch>.exe   silent NSIS install, which relaunches
 *   Linux   domino-<v>.AppImage         replace the running AppImage, relaunch
 *           domino_<v>_amd64.deb        pkexec dpkg -i (system password prompt)
 */

export { RELEASES_URL }

interface Asset {
  name: string
  browser_download_url: string
  size: number
  /** "sha256:<hex>" — GitHub computes it for release assets. */
  digest?: string | null
}

export interface UpdateInfo {
  current: string
  version: string
  notes: string
  url: string
  assetName: string
  size: number
}

export type UpdateProgress =
  { phase: 'download'; received: number; total: number } | { phase: 'install' }

function pickAsset(assets: Asset[]): Asset | undefined {
  const by = (suffix: string): Asset | undefined => assets.find((a) => a.name.endsWith(suffix))
  switch (process.platform) {
    case 'darwin':
      return by(`-${process.arch}-mac.zip`)
    case 'win32':
      return by(`-win-${process.arch}.exe`) ?? by('.exe')
    case 'linux':
      return process.env.APPIMAGE ? by('.AppImage') : by('_amd64.deb')
    default:
      return undefined
  }
}

let pending: { info: UpdateInfo; asset: Asset } | null = null

/** GitHub release assets live on github.com / *.githubusercontent.com — nowhere else. */
function trustedDownloadHost(hostname: string): boolean {
  return (
    hostname === 'github.com' ||
    hostname.endsWith('.github.com') ||
    hostname === 'githubusercontent.com' ||
    hostname.endsWith('.githubusercontent.com')
  )
}

/** Latest release newer than this build that has an asset for this platform. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  // Dev builds report the package version but aren't installed anywhere to replace.
  if (!app.isPackaged && !process.env.DOMINO_UPDATE_CHECK) return null
  const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': `domino/${app.getVersion()}` },
    signal: AbortSignal.timeout(15_000)
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status}`)
  const release = (await res.json()) as {
    tag_name: string
    body?: string
    html_url: string
    draft?: boolean
    prerelease?: boolean
    assets: Asset[]
  }
  if (release.draft || release.prerelease) return null
  const version = release.tag_name.replace(/^v/i, '')
  if (!isNewer(version, app.getVersion())) return null
  const asset = pickAsset(release.assets)
  if (!asset) return null
  const info: UpdateInfo = {
    current: app.getVersion(),
    version,
    notes: release.body ?? '',
    url: release.html_url,
    assetName: asset.name,
    size: asset.size
  }
  pending = { info, asset }
  return info
}

/** GitHub asset digests are "sha256:<64 hex>"; anything else isn't verifiable. */
const SHA256_DIGEST_RE = /^sha256:([0-9a-f]{64})$/i

/** Stream an asset to disk, reporting progress and checking GitHub's digest. */
async function download(
  asset: Asset,
  dest: string,
  onProgress: (p: UpdateProgress) => void
): Promise<void> {
  // The artifact gets executed (Windows exe, pkexec dpkg on Linux) — verify
  // where it comes from and its checksum, or refuse to install at all.
  let downloadUrl: URL
  try {
    downloadUrl = new URL(asset.browser_download_url)
  } catch {
    throw new Error('update asset has an invalid download URL')
  }
  if (downloadUrl.protocol !== 'https:' || !trustedDownloadHost(downloadUrl.hostname)) {
    throw new Error(`refusing to download an update from ${downloadUrl.hostname}`)
  }
  const digest = asset.digest ? SHA256_DIGEST_RE.exec(asset.digest) : null
  if (!digest) {
    throw new Error('this release provides no sha256 checksum — refusing to install an unverified update')
  }
  const expected = digest[1].toLowerCase()

  // Headers must arrive promptly; the body itself may legitimately take
  // minutes, but a connection that stops producing bytes must not hang the
  // install forever.
  let headTimer: ReturnType<typeof setTimeout> | undefined
  const headDeadline = new Promise<never>((_, reject) => {
    headTimer = setTimeout(() => reject(new Error('timed out waiting for the download to start')), 30_000)
    headTimer.unref?.()
  })
  let res: Response
  try {
    res = await Promise.race([net.fetch(downloadUrl.href), headDeadline])
  } finally {
    if (headTimer) clearTimeout(headTimer)
  }
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || asset.size
  // Never write much more than the release says the asset weighs (disk-fill guard).
  const limit = Math.max(asset.size, total) + 1_048_576
  const hash = createHash('sha256')
  const out = createWriteStream(dest)
  const reader = res.body.getReader()
  let received = 0
  let lastReport = 0
  const readWithIdleTimeout = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const idle = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('download stalled')), 60_000)
      timer.unref?.()
    })
    try {
      return await Promise.race([reader.read(), idle])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  try {
    for (;;) {
      const { done, value } = await readWithIdleTimeout()
      if (done) break
      hash.update(value)
      received += value.length
      if (received > limit) {
        await reader.cancel().catch(() => {})
        throw new Error('update download exceeded the expected size')
      }
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
      const now = Date.now()
      if (now - lastReport > 150) {
        lastReport = now
        onProgress({ phase: 'download', received, total })
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => {})
    await rm(dest, { force: true })
    throw err
  } finally {
    await new Promise<void>((r, j) => out.end((err?: Error | null) => (err ? j(err) : r())))
  }
  onProgress({ phase: 'download', received, total })
  if (hash.digest('hex') !== expected) {
    await rm(dest, { force: true })
    throw new Error('downloaded file failed its checksum')
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: 'ignore' })
    p.on('error', fail)
    p.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} exited with ${code}`))))
  })
}

/** Waits for this process to exit, swaps the bundle (rolling back on failure), reopens it. */
const MAC_SWAP_SCRIPT = `
while kill -0 "$DOMINO_PID" 2>/dev/null; do sleep 0.2; done
OLD="$DOMINO_APP.update-old"
rm -rf "$OLD"
if mv "$DOMINO_APP" "$OLD"; then
  if mv "$DOMINO_NEW" "$DOMINO_APP"; then rm -rf "$OLD"; else mv "$OLD" "$DOMINO_APP"; fi
fi
rm -rf "$DOMINO_TMP"
open "$DOMINO_APP"
`

async function installMac(zip: string, dir: string): Promise<void> {
  const bundle = resolve(app.getPath('exe'), '../../..')
  if (!bundle.endsWith('.app')) throw new Error('domino is not running from an .app bundle')
  if (bundle.includes('/AppTranslocation/')) {
    throw new Error('Move domino to the Applications folder first, then update again.')
  }
  const unpacked = join(dir, 'unpacked')
  await run('/usr/bin/ditto', ['-x', '-k', zip, unpacked])
  const newApp = (await readdir(unpacked)).find((n) => n.endsWith('.app'))
  if (!newApp) throw new Error('the update archive has no .app')
  spawn('/bin/sh', ['-c', MAC_SWAP_SCRIPT], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      DOMINO_PID: String(process.pid),
      DOMINO_APP: bundle,
      DOMINO_NEW: join(unpacked, newApp),
      DOMINO_TMP: dir
    }
  }).unref()
  app.quit()
}

function installWindows(installer: string): void {
  // electron-builder's NSIS installer: silent, closes the running app, relaunches it.
  spawn(installer, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
  app.quit()
}

async function installLinux(file: string, assetName: string): Promise<void> {
  const appImage = process.env.APPIMAGE
  if (appImage && assetName.endsWith('.AppImage')) {
    await chmod(file, 0o755)
    await rename(file, appImage) // same directory, so an atomic replace
    app.relaunch({ execPath: appImage, args: process.argv.slice(1) })
    app.exit(0)
    return
  }
  await run('pkexec', ['dpkg', '-i', file])
  app.relaunch()
  app.exit(0)
}

/** Download the update found by the last check, install it, and relaunch. */
export async function installUpdate(onProgress: (p: UpdateProgress) => void): Promise<void> {
  if (!pending) throw new Error('no update to install — check again')
  const { asset } = pending
  // An AppImage is downloaded next to itself so the final rename stays on one filesystem.
  const appImage =
    process.platform === 'linux' && asset.name.endsWith('.AppImage')
      ? process.env.APPIMAGE
      : undefined
  const dir = appImage ? dirname(appImage) : await mkdtemp(join(tmpdir(), 'domino-update-'))
  const file = join(dir, appImage ? `.${asset.name}.download` : asset.name)
  await download(asset, file, onProgress)
  onProgress({ phase: 'install' })
  if (process.platform === 'darwin') await installMac(file, dir)
  else if (process.platform === 'win32') installWindows(file)
  else await installLinux(file, asset.name)
}
