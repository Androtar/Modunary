import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function downloadsDir(): string {
  return path.join(os.homedir(), 'Downloads')
}

function isZipLike(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.zip') || lower.endsWith('.7z') || lower.endsWith('.rar')
}

function isPartial(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower.endsWith('.crdownload') ||
    lower.endsWith('.tmp') ||
    lower.endsWith('.part') ||
    lower.endsWith('.download') ||
    lower.includes('.crdownload')
  )
}

export type WatchedDownload = {
  path: string
  name: string
  size: number
  mtimeMs: number
}

/** Snapshot of zip-like files currently in Downloads. */
export function listDownloadArchives(dir = downloadsDir()): WatchedDownload[] {
  if (!fs.existsSync(dir)) return []
  const out: WatchedDownload[] = []
  for (const name of fs.readdirSync(dir)) {
    if (isPartial(name) || !isZipLike(name)) continue
    const full = path.join(dir, name)
    try {
      const st = fs.statSync(full)
      if (!st.isFile()) continue
      out.push({ path: full, name, size: st.size, mtimeMs: st.mtimeMs })
    } catch {
      // ignore
    }
  }
  return out
}

/**
 * Wait for a new archive to appear in Downloads after `sinceMs`, then wait until size is stable.
 * Does not click Slow Download / CAPTCHA — user completes that in the browser.
 */
export async function waitForNewDownload(options: {
  sinceMs: number
  timeoutMs?: number
  settleMs?: number
  pollMs?: number
  /** Prefer names containing any of these tokens (mod id / name fragments). */
  nameHints?: string[]
  signal?: { cancelled: boolean; skipped: boolean }
  onProgress?: (message: string) => void
}): Promise<{ ok: boolean; file?: WatchedDownload; error?: string; skipped?: boolean }> {
  const dir = downloadsDir()
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000
  const settleMs = options.settleMs ?? 2500
  const pollMs = options.pollMs ?? 1000
  const baseline = new Set(
    listDownloadArchives(dir)
      .filter((f) => f.mtimeMs < options.sinceMs - 500)
      .map((f) => f.path),
  )
  // Also ignore files that already existed at start even if mtime is weird
  for (const f of listDownloadArchives(dir)) {
    if (f.mtimeMs <= options.sinceMs) baseline.add(f.path)
  }

  options.onProgress?.(
    `Waiting for a new ZIP in ${dir}. Use Slow Download in the Nexus window (complete timer/CAPTCHA yourself).`,
  )

  const started = Date.now()
  let lastSize = -1
  let stableSince = 0

  while (Date.now() - started < timeoutMs) {
    if (options.signal?.cancelled) return { ok: false, error: 'Collection install cancelled.' }
    if (options.signal?.skipped) return { ok: false, skipped: true, error: 'Skipped.' }

    const archives = listDownloadArchives(dir).filter((f) => f.mtimeMs >= options.sinceMs - 1000)
    const newcomers = archives.filter((f) => !baseline.has(f.path))

    let pick: WatchedDownload | null = null
    if (newcomers.length) {
      const hints = (options.nameHints || []).map((h) => h.toLowerCase()).filter(Boolean)
      const scored = newcomers
        .map((f) => {
          const n = f.name.toLowerCase()
          const score = hints.reduce((s, h) => (h && n.includes(h) ? s + 1 : s), 0)
          return { f, score }
        })
        .sort((a, b) => b.score - a.score || b.f.mtimeMs - a.f.mtimeMs)
      pick = scored[0]?.f || null
    }

    // Still downloading?
    let partialPresent = false
    try {
      for (const name of fs.readdirSync(dir)) {
        if (isPartial(name)) {
          partialPresent = true
          break
        }
      }
    } catch {
      // ignore
    }

    if (pick) {
      if (pick.size === lastSize && pick.size > 0 && !partialPresent) {
        if (!stableSince) stableSince = Date.now()
        if (Date.now() - stableSince >= settleMs) {
          options.onProgress?.(`Download ready: ${pick.name}`)
          return { ok: true, file: pick }
        }
      } else {
        lastSize = pick.size
        stableSince = 0
        options.onProgress?.(
          partialPresent
            ? `Downloading ${pick.name}…`
            : `Saw ${pick.name} (${Math.round(pick.size / 1024)} KB) — waiting for file to finish…`,
        )
      }
    } else if (partialPresent) {
      options.onProgress?.('Browser download in progress…')
    }

    await new Promise((r) => setTimeout(r, pollMs))
  }

  return {
    ok: false,
    error: `Timed out waiting for a new ZIP in ${dir}. Skip or Retry after Slow Download finishes.`,
  }
}

export function getDownloadsPath(): string {
  return downloadsDir()
}
