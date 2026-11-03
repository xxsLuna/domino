import type { UiSpec } from '../spec'

/**
 * Background builds in flight, by key (`page:<id>` for a planned/nav page,
 * `click:<cacheKey>` for a predicted button destination).
 *
 * A build can be ADOPTED: the user taps the very page (or button) it is
 * building, so instead of cancelling it and starting the same generation
 * from scratch, the live lane takes it over — its previews stream on screen
 * and its result is finalized as the tap's answer. If the user leaves before
 * it lands, the adoption is released and the build finishes as an ordinary
 * background build (merged silently). Exactly one of the two settles it.
 */

export type BuildKind = 'page' | 'click'

/** What a finished build hands its settler: the final spec (null: failed/cancelled). */
export interface BuildResult {
  spec: UiSpec | null
  /** Endpoint → shape hash the spec was built from (ScreenStore deps). */
  deps: Record<string, string>
}

/** Handles a finished build; returns true when it took care of the result. */
export type BuildSettler = (result: BuildResult) => boolean

export interface Adoption {
  /** Streaming previews of the adopted build. */
  onPreview: (spec: UiSpec) => void
  /** Final result; return false to hand it back to the background settle. */
  onSettle: BuildSettler
}

export interface PregenBuild {
  key: string
  kind: BuildKind
  /** Page id (page builds) or destination-less click target (click builds). */
  target: string
  controller: AbortController
  /** Latest streamed preview — what an adoption shows first. */
  preview: UiSpec | null
  adoption: Adoption | null
  /** Settles once the build ended and its result was handled. */
  done: Promise<void>
}

export const pageBuildKey = (pageId: string): string => `page:${pageId}`
export const clickBuildKey = (cacheKey: string): string => `click:${cacheKey}`

export class PregenBuilds {
  private builds = new Map<string, PregenBuild>()

  get size(): number {
    return this.builds.size
  }

  get(key: string): PregenBuild | undefined {
    return this.builds.get(key)
  }

  has(key: string): boolean {
    return this.builds.has(key)
  }

  keys(): string[] {
    return [...this.builds.keys()]
  }

  /**
   * Start a build. `run` streams it (report previews through `preview`) and
   * resolves with the result; `background` settles a result nobody adopted.
   * A key already building returns the running build instead.
   */
  start(
    key: string,
    kind: BuildKind,
    target: string,
    run: (build: PregenBuild, preview: (spec: UiSpec) => void) => Promise<BuildResult>,
    background: BuildSettler
  ): PregenBuild {
    const existing = this.builds.get(key)
    if (existing) return existing
    let resolveDone: () => void = () => {}
    const build: PregenBuild = {
      key,
      kind,
      target,
      controller: new AbortController(),
      preview: null,
      adoption: null,
      done: new Promise<void>((r) => (resolveDone = r))
    }
    this.builds.set(key, build)
    const preview = (spec: UiSpec): void => {
      build.preview = spec
      build.adoption?.onPreview(spec)
    }
    const settle = (result: BuildResult): void => {
      if (this.builds.get(key) === build) this.builds.delete(key)
      const adopted = build.adoption
      build.adoption = null
      try {
        if (!adopted || !adopted.onSettle(result)) background(result)
      } finally {
        resolveDone()
      }
    }
    void run(build, preview).then(settle, () => settle({ spec: null, deps: {} }))
    return build
  }

  /** Hand a running build to the live lane; null when it is not running. */
  adopt(key: string, adoption: Adoption): PregenBuild | null {
    const build = this.builds.get(key)
    if (!build || build.controller.signal.aborted) return null
    build.adoption = adoption
    return build
  }

  /** The adopter left (superseded, navigated away): the build finishes in the background. */
  release(build: PregenBuild, adoption: Adoption): void {
    if (build.adoption === adoption) build.adoption = null
  }

  /** Cancel every build (rebuild, sign-in/out, unmount). */
  cancelAll(): void {
    for (const build of this.builds.values()) build.controller.abort()
    this.builds.clear()
  }
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight. Workers
 * pull the next item as they finish; `stop()` is checked before each pull.
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  stop: () => boolean = () => false
): Promise<void> {
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length && !stop()) {
      const item = items[next++]
      try {
        await worker(item)
      } catch {
        /* one failed item must not stop the others */
      }
    }
  }
  const lanes = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(Array.from({ length: lanes }, lane))
}
