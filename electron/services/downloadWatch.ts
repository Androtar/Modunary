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
export type DownloadWatchStats = {
  phase: 'waiting' | 'downloading' | 'settling' | 'ready'
  name?: string
  bytes: number
  /** Known total when available (Electron getTotalBytes / Content-Length); 0 = unknown. */
  totalBytes: number
  indeterminate: boolean
  message: string
}

export async function waitForNewDownload(options: {
  sinceMs: number
  timeoutMs?: number
  settleMs?: number
  pollMs?: number
  /** Prefer names containing any of these tokens (mod id / name fragments). */
  nameHints?: string[]
  signal?: { cancelled: boolean; skipped: boolean }
  onProgress?: (message: string) => void
  /** Rich download progress for Collection status bar. */
  onStats?: (stats: DownloadWatchStats) => void
  /** Optional expected total from Electron download item / API. */
  getExpectedTotalBytes?: () => number
  /** Optional live received bytes from Electron download item. */
  getLiveBytes?: () => { path?: string | null; name?: string; received: number; total: number } | null
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

  const waitMsg =
    `Waiting for a new ZIP in ${dir}. Use Slow Download in the Nexus window (complete timer/CAPTCHA yourself).`
  options.onProgress?.(waitMsg)
  options.onStats?.({
    phase: 'waiting',
    bytes: 0,
    totalBytes: 0,
    indeterminate: true,
    message: waitMsg,
  })

  const started = Date.now()
  let lastSize = -1
  let stableSince = 0
  let peakPartialSize = 0

  while (Date.now() - started < timeoutMs) {
    if (options.signal?.cancelled) return { ok: false, error: 'Collection install cancelled.' }
    if (options.signal?.skipped) return { ok: false, skipped: true, error: 'Skipped.' }

    const live = options.getLiveBytes?.() || null
    const expected =
      (live && live.total > 0 ? live.total : 0) ||
      Math.max(0, options.getExpectedTotalBytes?.() || 0)

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
    let partialBytes = 0
    let partialName: string | undefined
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!isPartial(name)) continue
        partialPresent = true
        try {
          const st = fs.statSync(path.join(dir, name))
          if (st.size >= partialBytes) {
            partialBytes = st.size
            partialName = name
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    if (live && live.received > partialBytes) {
      partialBytes = live.received
      if (live.name) partialName = live.name
      if (live.received > 0) partialPresent = true
    }
    if (partialBytes > peakPartialSize) peakPartialSize = partialBytes

    const report = (
      phase: DownloadWatchStats['phase'],
      message: string,
      bytes: number,
      totalBytes: number,
      name?: string,
    ) => {
      options.onProgress?.(message)
      const indeterminate = !(totalBytes > 0 && bytes >= 0)
      options.onStats?.({
        phase,
        name,
        bytes,
        totalBytes: totalBytes > 0 ? totalBytes : 0,
        indeterminate,
        message,
      })
    }

    if (pick) {
      if (pick.size === lastSize && pick.size > 0 && !partialPresent) {
        if (!stableSince) stableSince = Date.now()
        if (Date.now() - stableSince >= settleMs) {
          const msg = `Download ready: ${pick.name}`
          report('ready', msg, pick.size, expected > 0 ? expected : pick.size, pick.name)
          return { ok: true, file: pick }
        }
        report(
          'settling',
          `Finishing ${pick.name}…`,
          pick.size,
          expected > 0 ? expected : pick.size,
          pick.name,
        )
      } else {
        lastSize = pick.size
        stableSince = 0
        const bytes = Math.max(pick.size, partialBytes, live?.received || 0)
        const msg = partialPresent
          ? `Downloading ${pick.name}…`
          : `Saw ${pick.name} (${formatBytes(bytes)}) — waiting for file to finish…`
        report('downloading', msg, bytes, expected, pick.name)
      }
    } else if (partialPresent || (live && live.received > 0)) {
      const bytes = Math.max(partialBytes, live?.received || 0, peakPartialSize)
      const name = partialName || live?.name || 'archive'
      report('downloading', `Downloading ${name}…`, bytes, expected, name)
    } else {
      report('waiting', waitMsg, 0, expected, undefined)
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

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
