import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { StoreSearchResponse, StoreSearchResult } from '../../types'
import { findWorkshopContentPath, STEAM_APP_ID } from '../paths'
import { getSecrets } from '../secrets'

const execFileAsync = promisify(execFile)

export async function searchSteamWorkshop(query: string): Promise<StoreSearchResponse> {
  const key = getSecrets().steamWebApiKey
  const manualUrl = `https://steamcommunity.com/workshop/browse/?appid=${STEAM_APP_ID}&searchtext=${encodeURIComponent(query)}&browsesort=textsearch&section=readytouseitems`

  if (!key) {
    return {
      ok: false,
      results: [],
      needsKey: true,
      error:
        'Steam Web API key required for in-app Workshop search. Get one at https://steamcommunity.com/dev/apikey (or set STEAM_WEB_API_KEY).',
      manualUrl,
    }
  }

  const q = query.trim()
  if (!q) return { ok: false, results: [], error: 'Enter a search term.', manualUrl }

  try {
    const params = new URLSearchParams({
      key,
      appid: STEAM_APP_ID,
      creator_appid: STEAM_APP_ID,
      query_type: '1',
      cursor: '*',
      numperpage: '20',
      search_text: q,
      return_short_description: 'true',
      return_metadata: 'true',
      return_previews: 'true',
    })
    const url = `https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/?${params}`
    const res = await fetch(url)
    if (!res.ok) {
      return {
        ok: false,
        results: [],
        error: `Steam Workshop search failed (${res.status}).`,
        manualUrl,
      }
    }
    const data = (await res.json()) as {
      response?: {
        publishedfiledetails?: Array<{
          publishedfileid: string
          title?: string
          short_description?: string
          file_description?: string
          preview_url?: string
          subscriptions?: number
        }>
      }
    }
    const details = data.response?.publishedfiledetails || []
    const results: StoreSearchResult[] = details.map((item) => ({
      store: 'steam',
      id: item.publishedfileid,
      name: item.title || item.publishedfileid,
      summary: (item.short_description || item.file_description || '')
        .replace(/<[^>]+>/g, '')
        .slice(0, 280),
      url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${item.publishedfileid}`,
      downloads: item.subscriptions,
      imageUrl: item.preview_url,
      canDownloadInApp: false,
      note: 'Subscribe via Steam; then use “Import Workshop” to copy into the vault/Modules.',
    }))
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

export async function openSteamWorkshopItem(publishedFileId: string): Promise<void> {
  const uri = `steam://url/CommunityFilePage/${publishedFileId}`
  await execFileAsync('cmd', ['/c', `start ${uri}`], { windowsHide: true })
}

export function getWorkshopPathInfo(): {
  path: string | null
  note: string
} {
  const p = findWorkshopContentPath()
  return {
    path: p,
    note: p
      ? 'Workshop downloads land here after you subscribe in Steam. Import copies them into the app vault.'
      : 'Workshop content folder not found yet. Subscribe to an item in Steam first.',
  }
}
