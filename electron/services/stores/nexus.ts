import type { StoreSearchResponse, StoreSearchResult } from '../../types'
import { getSecrets } from '../secrets'

const NEXUS_BASE = 'https://api.nexusmods.com/v1'
const GAME = 'mountandblade2bannerlord'
const APP_NAME = 'Modunary'
const APP_VERSION = '0.3.0'

function headers(apiKey: string): Record<string, string> {
  return {
    apikey: apiKey,
    Accept: 'application/json',
    'Application-Name': APP_NAME,
    'Application-Version': APP_VERSION,
    'User-Agent': `${APP_NAME}/${APP_VERSION}`,
  }
}

export async function validateNexusKey(): Promise<{
  ok: boolean
  name?: string
  isPremium?: boolean
  error?: string
}> {
  const key = getSecrets().nexusApiKey
  if (!key) return { ok: false, error: 'Nexus API key not set.' }
  try {
    const res = await fetch(`${NEXUS_BASE}/users/validate.json`, { headers: headers(key) })
    if (!res.ok) return { ok: false, error: `Nexus validate failed (${res.status}).` }
    const data = (await res.json()) as { name?: string; is_premium?: boolean }
    return { ok: true, name: data.name, isPremium: Boolean(data.is_premium) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function searchNexus(query: string): Promise<StoreSearchResponse> {
  const key = getSecrets().nexusApiKey
  const manualUrl = `https://www.nexusmods.com/mountandblade2bannerlord/search/?search_filename=${encodeURIComponent(query)}`
  if (!key) {
    return {
      ok: false,
      results: [],
      needsKey: true,
      error:
        'Nexus API key required. Create one at Nexus → Site preferences → API keys (or set NEXUS_API_KEY).',
      manualUrl,
    }
  }

  const q = query.trim()
  if (!q) {
    return { ok: false, results: [], error: 'Enter a search term.', manualUrl }
  }

  try {
    // v1 updated feed + client filter (reliable without GraphQL schema churn)
    const res = await fetch(`${NEXUS_BASE}/games/${GAME}/mods/updated.json?period=1m`, {
      headers: headers(key),
    })
    if (!res.ok) {
      return {
        ok: false,
        results: [],
        error: `Nexus search failed (${res.status}).`,
        manualUrl,
      }
    }

    const updated = (await res.json()) as Array<{ mod_id: number }>
    const ids = updated.slice(0, 40).map((m) => m.mod_id)
    const results: StoreSearchResult[] = []
    const needle = q.toLowerCase()

    // Fetch details in small batches
    for (const id of ids) {
      try {
        const detailRes = await fetch(`${NEXUS_BASE}/games/${GAME}/mods/${id}.json`, {
          headers: headers(key),
        })
        if (!detailRes.ok) continue
        const mod = (await detailRes.json()) as {
          name?: string
          summary?: string
          author?: string
          mod_id?: number
          picture_url?: string
          mod_downloads?: number
        }
        const name = mod.name || `Mod ${id}`
        const summary = (mod.summary || '').replace(/<[^>]+>/g, '')
        if (
          !name.toLowerCase().includes(needle) &&
          !summary.toLowerCase().includes(needle) &&
          !(mod.author || '').toLowerCase().includes(needle)
        ) {
          continue
        }
        results.push({
          store: 'nexus',
          id: String(mod.mod_id ?? id),
          name,
          summary: summary.slice(0, 280),
          author: mod.author,
          url: `https://www.nexusmods.com/mountandblade2bannerlord/mods/${id}`,
          downloads: mod.mod_downloads,
          imageUrl: mod.picture_url,
          canDownloadInApp: true,
          note: 'Download requires Nexus Premium for CDN links; free accounts open the mod page.',
        })
      } catch {
        // continue
      }
      if (results.length >= 20) break
    }

    // Also try exact name search via games endpoint fallback: open manual if empty
    if (results.length === 0) {
      return {
        ok: true,
        results: [],
        error:
          'No matches in recent updates feed. Use Open on Nexus for full search, or refine the query.',
        manualUrl,
      }
    }

    return { ok: true, results, manualUrl }
  } catch (err) {
    return {
      ok: false,
      results: [],
      error: err instanceof Error ? err.message : String(err),
      manualUrl,
    }
  }
}

export async function getNexusDownloadLink(
  modId: string,
  fileId: string,
): Promise<{ ok: boolean; url?: string; error?: string; needsPremium?: boolean }> {
  const key = getSecrets().nexusApiKey
  if (!key) return { ok: false, error: 'Nexus API key not set.' }

  const status = await validateNexusKey()
  if (!status.ok) return { ok: false, error: status.error }
  if (!status.isPremium) {
    return {
      ok: false,
      needsPremium: true,
      error:
        'Nexus Premium is required for automated CDN download links. Open the mod page to download manually.',
    }
  }

  try {
    const res = await fetch(
      `${NEXUS_BASE}/games/${GAME}/mods/${modId}/files/${fileId}/download_link.json`,
      { headers: headers(key) },
    )
    if (!res.ok) {
      return { ok: false, error: `Download link failed (${res.status}).` }
    }
    const data = (await res.json()) as Array<{ URI?: string }>
    const url = data?.[0]?.URI
    if (!url) return { ok: false, error: 'No download URI returned.' }
    return { ok: true, url }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function listNexusFiles(
  modId: string,
): Promise<{ ok: boolean; files: Array<{ id: number; name: string; version: string }>; error?: string }> {
  const key = getSecrets().nexusApiKey
  if (!key) return { ok: false, files: [], error: 'Nexus API key not set.' }
  try {
    const res = await fetch(`${NEXUS_BASE}/games/${GAME}/mods/${modId}/files.json`, {
      headers: headers(key),
    })
    if (!res.ok) return { ok: false, files: [], error: `Files list failed (${res.status}).` }
    const data = (await res.json()) as {
      files?: Array<{ file_id: number; name: string; version: string; category_name?: string }>
    }
    const files = (data.files || [])
      .filter((f) => (f.category_name || '').toLowerCase() !== 'archived')
      .map((f) => ({ id: f.file_id, name: f.name, version: f.version }))
    return { ok: true, files }
  } catch (err) {
    return { ok: false, files: [], error: err instanceof Error ? err.message : String(err) }
  }
}
