import fs from 'node:fs'
import path from 'node:path'
import { XMLParser } from 'fast-xml-parser'
import type { DiscoveredMod, GameDiscovery } from '../types'
import {
  findSteamAppManifest,
  resolvePaths,
} from './paths'

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
})

function textOf(node: unknown): string {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node === 'object' && node !== null && '#text' in node) {
    return String((node as { '#text': string })['#text'] ?? '')
  }
  return ''
}

export function parseSubModuleXml(filePath: string): {
  id: string
  name: string
  version: string
} | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const doc = xmlParser.parse(raw)
    const root = doc?.ModuleInfo ?? doc?.Module ?? doc
    if (!root) return null
    const id = textOf(root.Id) || textOf(root.Name)
    const name = textOf(root.Name) || id
    const version = textOf(root.Version) || 'unknown'
    if (!id) return null
    return { id, name, version }
  } catch {
    return null
  }
}

export function discoverMods(modulesDir: string): DiscoveredMod[] {
  if (!fs.existsSync(modulesDir)) return []
  const entries = fs.readdirSync(modulesDir, { withFileTypes: true })
  const mods: DiscoveredMod[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const folder = entry.name
    const sub = path.join(modulesDir, folder, 'SubModule.xml')
    if (!fs.existsSync(sub)) continue
    const meta = parseSubModuleXml(sub)
    if (!meta) continue
    mods.push({
      id: meta.id,
      folderName: folder,
      name: meta.name,
      version: meta.version,
      path: path.join(modulesDir, folder),
    })
  }

  return mods.sort((a, b) => a.name.localeCompare(b.name))
}

export function detectGameVersion(installPath: string | null): string | null {
  if (!installPath) return null

  const packageInfo = path.join(installPath, 'package_info.txt')
  if (fs.existsSync(packageInfo)) {
    const text = fs.readFileSync(packageInfo, 'utf8')
    const env = text.match(/Environment:\s*PC@v([\d.]+)/i)
    if (env) return env[1]
  }

  const nativeSub = path.join(installPath, 'Modules', 'Native', 'SubModule.xml')
  if (fs.existsSync(nativeSub)) {
    const meta = parseSubModuleXml(nativeSub)
    if (meta?.version) {
      return meta.version.replace(/^v/i, '').split('.').slice(0, 3).join('.')
    }
  }
  return null
}

export function readSteamBetaBranch(manifestPath: string | null): string | null {
  if (!manifestPath || !fs.existsSync(manifestPath)) return null
  const text = fs.readFileSync(manifestPath, 'utf8')
  const match = text.match(/"BetaKey"\s+"([^"]*)"/)
  return match ? match[1] : null
}

export function discoverGame(
  gameInstallOverride: string | null,
  documentsOverride: string | null,
): GameDiscovery {
  const warnings: string[] = []
  const paths = resolvePaths(gameInstallOverride, documentsOverride)

  if (!paths.gameInstallPath) {
    warnings.push('Bannerlord install not found. Set the game path in Settings.')
  }
  if (!paths.documentsPath || !fs.existsSync(paths.documentsPath)) {
    warnings.push('Documents Bannerlord folder not found yet (will be created on activate if needed).')
  }
  if (paths.launcherDataPath && !fs.existsSync(paths.launcherDataPath)) {
    warnings.push('LauncherData.xml not found — create a profile after launching the game once, or capture after first run.')
  }

  const mods = paths.modulesPath ? discoverMods(paths.modulesPath) : []
  const manifest = findSteamAppManifest(paths.gameInstallPath)

  return {
    installPath: paths.gameInstallPath,
    modulesPath: paths.modulesPath,
    documentsPath: paths.documentsPath,
    launcherDataPath: paths.launcherDataPath,
    detectedGameVersion: detectGameVersion(paths.gameInstallPath),
    steamAppManifestPath: manifest,
    steamBetaBranch: readSteamBetaBranch(manifest),
    mods,
    warnings,
  }
}
