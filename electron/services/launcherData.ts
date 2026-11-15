import fs from 'node:fs'
import path from 'node:path'
import { XMLBuilder, XMLParser } from 'fast-xml-parser'
import type { ModEntry } from '../types'
import { OFFICIAL_MODULE_IDS } from '../types'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  // Keep empty nodes so we can round-trip launcher extras when possible.
  isArray: (name) =>
    ['UserModData', 'DLLCheckData'].includes(name),
})

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  format: true,
  indentBy: '  ',
  suppressEmptyNode: false,
})

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

export interface ParsedLauncherMod {
  id: string
  lastKnownVersion: string
  isSelected: boolean
}

export function readLauncherData(filePath: string): ParsedLauncherMod[] {
  if (!fs.existsSync(filePath)) return []
  const raw = fs.readFileSync(filePath, 'utf8')
  const doc = parser.parse(raw)
  const modDatas = doc?.UserData?.SingleplayerData?.ModDatas?.UserModData
  return asArray(modDatas).map((m: Record<string, unknown>, index) => ({
    id: String(m.Id ?? `unknown-${index}`),
    lastKnownVersion: String(m.LastKnownVersion ?? ''),
    isSelected: String(m.IsSelected).toLowerCase() === 'true',
  }))
}

export function modsFromLauncherData(
  launcherMods: ParsedLauncherMod[],
  discoveredById: Map<string, { folderName: string; name: string; version: string }>,
): ModEntry[] {
  return launcherMods.map((m, order) => {
    const disc = discoveredById.get(m.id)
    return {
      id: m.id,
      folderName: disc?.folderName ?? m.id,
      name: disc?.name ?? m.id,
      version: m.lastKnownVersion || disc?.version || 'unknown',
      enabled: m.isSelected,
      order,
    }
  })
}

/** Official load order for singleplayer (Multiplayer omitted). */
const SP_OFFICIAL_ORDER = [
  'Native',
  'SandBoxCore',
  'SandBox',
  'Sandbox',
  'StoryMode',
  'CustomBattle',
  'BirthAndDeath',
] as const

/**
 * Merge official Modules present on disk ahead of profile community mods so the
 * Bannerlord launcher always has Native/SandBox/etc. selected for singleplayer.
 */
export function buildActivateLauncherMods(
  profileMods: ModEntry[],
  modulesDir: string | null,
): ModEntry[] {
  const official: ModEntry[] = []
  const seen = new Set<string>()
  if (modulesDir && fs.existsSync(modulesDir)) {
    for (const id of SP_OFFICIAL_ORDER) {
      const folder = path.join(modulesDir, id)
      if (!fs.existsSync(folder)) continue
      const key = id.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      official.push({
        id,
        folderName: id,
        name: id,
        version: '0.0.0',
        enabled: true,
        order: official.length,
      })
    }
  }

  const community = [...profileMods]
    .filter((m) => !OFFICIAL_MODULE_IDS.map((x) => x.toLowerCase()).includes(m.id.toLowerCase()))
    .filter((m) => !seen.has(m.folderName.toLowerCase()))
    .sort((a, b) => a.order - b.order)
    .map((m, i) => ({ ...m, order: official.length + i }))

  return [...official, ...community]
}

function toUserModData(mods: ModEntry[]) {
  const ordered = [...mods].sort((a, b) => a.order - b.order)
  return ordered.map((m) => ({
    Id: m.id,
    LastKnownVersion: m.version.startsWith('v') ? m.version : `v${m.version}`,
    IsSelected: m.enabled ? 'true' : 'false',
  }))
}

function buildMinimalDocument(mods: ModEntry[]) {
  return {
    UserData: {
      '@_xmlns:xsd': 'http://www.w3.org/2001/XMLSchema',
      '@_xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      GameType: 'Singleplayer',
      SingleplayerData: {
        ModDatas: {
          UserModData: toUserModData(mods),
        },
      },
      MultiplayerData: {
        ModDatas: {},
      },
    },
  }
}

/**
 * Write launcher mod selection/order for singleplayer Activate.
 * Always forces GameType=Singleplayer — leaving Multiplayer makes the vanilla
 * launcher show only Native/Multiplayer.
 */
export function writeLauncherData(filePath: string, mods: ModEntry[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })

  const userModData = toUserModData(mods)
  if (userModData.length === 0) {
    throw new Error('Refusing to write LauncherData.xml with zero modules.')
  }

  let doc: Record<string, unknown>
  if (fs.existsSync(filePath)) {
    try {
      doc = parser.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>
      const userData = (doc.UserData ?? {}) as Record<string, unknown>
      const single = (userData.SingleplayerData ?? {}) as Record<string, unknown>
      single.ModDatas = { UserModData: userModData }
      userData.SingleplayerData = single
      // Critical: never leave GameType=Multiplayer after a profile Activate.
      userData.GameType = 'Singleplayer'
      doc.UserData = userData
    } catch {
      doc = buildMinimalDocument(mods)
    }
  } else {
    doc = buildMinimalDocument(mods)
  }

  const xmlBody = builder.build(doc)
  const xml = `<?xml version="1.0" encoding="utf-8"?>\n${xmlBody}`
  fs.writeFileSync(filePath, xml, 'utf8')
}

export function backupLauncherData(filePath: string, backupsDir: string, label: string): string | null {
  if (!fs.existsSync(filePath)) return null
  fs.mkdirSync(backupsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safe = label.replace(/[<>:"/\\|?*]/g, '_').slice(0, 40)
  const dest = path.join(backupsDir, `LauncherData-${safe}-${stamp}.xml`)
  fs.copyFileSync(filePath, dest)
  return dest
}
