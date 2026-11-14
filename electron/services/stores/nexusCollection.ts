import { getSecrets } from '../secrets'

const GRAPHQL = 'https://api.nexusmods.com/v2/graphql'
const GAME = 'mountandblade2bannerlord'
const APP_NAME = 'Modunary'
const APP_VERSION = '0.3.0'

export type NexusCollectionMod = {
  modId: number
  fileId: number
  name: string
  version: string
  optional: boolean
  author?: string
  url: string
}

export type NexusCollectionInfo = {
  slug: string
  domain: string
  name: string
  revision: number
  summary?: string
  url: string
  mods: NexusCollectionMod[]
  source: 'graphql' | 'scrape'
  notes: string[]
}

export function parseCollectionUrl(input: string): {
  domain: string
  slug: string
  revision: number | null
} | null {
  const raw = input.trim()
  if (!raw) return null

  // Bare slug
  if (/^[a-z0-9][a-z0-9_-]*$/i.test(raw) && !raw.includes('/')) {
    return { domain: GAME, slug: raw, revision: null }
  }

  let url: URL
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`)
  } catch {
    return null
  }

  const path = url.pathname.replace(/\/+/g, '/')
  // /mountandblade2bannerlord/collections/slug[/revisions/N]
  // /games/mountandblade2bannerlord/collections/slug
  const m = path.match(
    /(?:\/games)?\/([a-z0-9]+)\/collections\/([a-z0-9][a-z0-9_-]*)(?:\/revisions?\/(\d+))?/i,
  )
  if (!m) return null
  return {
    domain: m[1].toLowerCase(),
    slug: m[2],
    revision: m[3] ? Number.parseInt(m[3], 10) : null,
  }
}

async function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
  operationName: string,
): Promise<{ data?: T; error?: string }> {
  const key = getSecrets().nexusApiKey
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Application-Name': APP_NAME,
    'Application-Version': APP_VERSION,
    'User-Agent': `${APP_NAME}/${APP_VERSION}`,
  }
  if (key) headers.apikey = key

  try {
    const res = await fetch(GRAPHQL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables, operationName }),
    })
    if (!res.ok) {
      return { error: `GraphQL HTTP ${res.status}` }
    }
    const body = (await res.json()) as {
      data?: T
      errors?: Array<{ message?: string }>
    }
    if (body.errors?.length) {
      return { error: body.errors.map((e) => e.message || 'GraphQL error').join('; ') }
    }
    return { data: body.data }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

type GqlRevision = {
  collectionRevision?: {
    revisionNumber?: number
    revision?: number
    collection?: { name?: string; summary?: string; slug?: string }
    modFiles?: Array<{
      fileId?: number
      optional?: boolean
      file?: {
        fileId?: number
        name?: string
        version?: string
        mod?: {
          modId?: number
          name?: string
          author?: string
          version?: string
          game?: { domainName?: string }
        }
      }
    }>
  }
}

const REVISION_QUERY = `
query CollectionRevisionMods($revision: Int, $slug: String!, $viewAdultContent: Boolean, $domainName: String) {
  collectionRevision(revision: $revision, slug: $slug, viewAdultContent: $viewAdultContent, domainName: $domainName) {
    revisionNumber
    revision
    collection { name summary slug }
    modFiles {
      fileId
      optional
      file {
        fileId
        name
        version
        mod {
          modId
          name
          author
          version
          game { domainName }
        }
      }
    }
  }
}`

async function resolveViaGraphql(
  domain: string,
  slug: string,
  revision: number | null,
): Promise<{ info?: NexusCollectionInfo; error?: string }> {
  const result = await graphql<GqlRevision>(
    REVISION_QUERY,
    {
      slug,
      revision: revision ?? null,
      viewAdultContent: true,
      domainName: domain,
    },
    'CollectionRevisionMods',
  )
  if (result.error || !result.data?.collectionRevision) {
    return { error: result.error || 'Collection revision not found via GraphQL.' }
  }
  const rev = result.data.collectionRevision
  const revNum = rev.revisionNumber ?? rev.revision ?? revision ?? 0
  const mods: NexusCollectionMod[] = []
  for (const entry of rev.modFiles || []) {
    const file = entry.file
    const mod = file?.mod
    const modId = mod?.modId
    const fileId = entry.fileId ?? file?.fileId
    if (!modId || !fileId) continue
    const domainName = mod.game?.domainName || domain
    mods.push({
      modId,
      fileId,
      name: mod.name || file?.name || `Mod ${modId}`,
      version: file?.version || mod.version || 'unknown',
      optional: Boolean(entry.optional),
      author: mod.author,
      url: `https://www.nexusmods.com/${domainName}/mods/${modId}?tab=files`,
    })
  }
  return {
    info: {
      slug,
      domain,
      name: rev.collection?.name || slug,
      revision: revNum,
      summary: rev.collection?.summary,
      url: `https://next.nexusmods.com/${domain}/collections/${slug}`,
      mods,
      source: 'graphql',
      notes: getSecrets().nexusApiKey
        ? ['Resolved via Nexus GraphQL (API key present).']
        : ['Resolved via Nexus GraphQL (public; API key optional for Collections list).'],
    },
  }
}

/** Best-effort HTML scrape when GraphQL is unavailable. */
async function resolveViaScrape(
  domain: string,
  slug: string,
): Promise<{ info?: NexusCollectionInfo; error?: string }> {
  const url = `https://next.nexusmods.com/${domain}/collections/${slug}`
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'text/html',
        'User-Agent': `${APP_NAME}/${APP_VERSION}`,
      },
    })
    if (!res.ok) return { error: `Collection page fetch failed (${res.status}).` }
    const html = await res.text()
    const mods: NexusCollectionMod[] = []
    const seen = new Set<number>()
    // Look for /mods/12345 links and nearby titles
    for (const m of html.matchAll(/\/mods\/(\d+)/g)) {
      const modId = Number.parseInt(m[1], 10)
      if (!modId || seen.has(modId)) continue
      seen.add(modId)
      mods.push({
        modId,
        fileId: 0,
        name: `Mod ${modId}`,
        version: 'unknown',
        optional: false,
        url: `https://www.nexusmods.com/${domain}/mods/${modId}?tab=files`,
      })
    }
    if (mods.length === 0) {
      return {
        error:
          'Could not parse collection mods from the page. Paste a Collection URL and ensure GraphQL works, or open the collection in a browser.',
      }
    }
    const title =
      html.match(/<title>([^<]+)<\/title>/i)?.[1]?.replace(/\s*[|·].*$/, '').trim() || slug
    return {
      info: {
        slug,
        domain,
        name: title,
        revision: 0,
        url,
        mods,
        source: 'scrape',
        notes: [
          'Fallback HTML scrape — file IDs unknown; install will open each mod’s Files tab for Slow Download / Premium CDN.',
        ],
      },
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function resolveNexusCollection(input: string): Promise<{
  ok: boolean
  collection?: NexusCollectionInfo
  error?: string
}> {
  const parsed = parseCollectionUrl(input)
  if (!parsed) {
    return {
      ok: false,
      error:
        'Unrecognized Collection URL. Example: https://next.nexusmods.com/mountandblade2bannerlord/collections/<slug>',
    }
  }

  const gql = await resolveViaGraphql(parsed.domain, parsed.slug, parsed.revision)
  if (gql.info?.mods.length) {
    return { ok: true, collection: gql.info }
  }

  const scraped = await resolveViaScrape(parsed.domain, parsed.slug)
  if (scraped.info?.mods.length) {
    if (gql.error) scraped.info.notes.unshift(`GraphQL: ${gql.error}`)
    return { ok: true, collection: scraped.info }
  }

  return {
    ok: false,
    error: gql.error || scraped.error || 'Failed to resolve collection.',
  }
}
