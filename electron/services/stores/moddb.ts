import type { StoreSearchResponse, StoreSearchResult } from '../../types'
import { getSecrets } from '../secrets'

/**
 * ModDB has no official public API. We support:
 * - Manual/browser search links
 * - Optional credential storage for a future/session-based scraper
 * - Lightweight HTML search scrape (best-effort; may break if ModDB markup changes)
 */
export async function searchModdb(query: string): Promise<StoreSearchResponse> {
  const q = query.trim()
  const manualUrl = `https://www.moddb.com/games/mount-blade-ii-bannerlord/mods?filter=t&kw=${encodeURIComponent(q)}`

  if (!q) {
    return { ok: false, results: [], error: 'Enter a search term.', manualUrl }
  }

  const secrets = getSecrets()
  const loginNote =
    secrets.moddbUsername && secrets.moddbPassword
      ? 'ModDB credentials are stored for future authenticated flows; search uses public pages.'
      : 'Optional ModDB username/password can be stored in Settings (no official API — used only if we add session scrape later).'

  try {
    const url = `https://www.moddb.com/games/mount-blade-ii-bannerlord/mods?filter=t&kw=${encodeURIComponent(q)}`
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'BannerlordModProfiles/0.2',
        Accept: 'text/html',
      },
    })
    if (!res.ok) {
      return {
        ok: false,
        results: [],
        error: `ModDB page fetch failed (${res.status}). Use Open on ModDB.`,
        manualUrl,
      }
    }
    const html = await res.text()
    const results: StoreSearchResult[] = []
    // Best-effort: anchors to /mods/...
    const re =
      /<a[^>]+href="(https:\/\/www\.moddb\.com\/mods\/[^"]+|\/mods\/[^"]+)"[^>]*>([^<]{2,120})<\/a>/gi
    const seen = new Set<string>()
    for (const match of html.matchAll(re)) {
      let href = match[1]
      const name = match[2].trim()
      if (!name || name.toLowerCase() === 'mods') continue
      if (href.startsWith('/')) href = `https://www.moddb.com${href}`
      if (seen.has(href)) continue
      seen.add(href)
      const id = href.split('/').filter(Boolean).pop() || href
      results.push({
        store: 'moddb',
        id,
        name,
        summary: 'ModDB listing (scraped). Download manually; then Install from ZIP/folder.',
        url: href,
        canDownloadInApp: false,
        note: 'No official ModDB API. Install via browser download + Import ZIP.',
      })
      if (results.length >= 20) break
    }

    return {
      ok: true,
      results,
      manualUrl,
      error: results.length ? loginNote : `No scraped results. ${loginNote}`,
    }
  } catch (err) {
    return {
      ok: false,
      results: [],
      error: `${err instanceof Error ? err.message : String(err)}. ${loginNote}`,
      manualUrl,
    }
  }
}
