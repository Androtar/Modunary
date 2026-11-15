import fs from 'node:fs'
import path from 'node:path'
import { XMLParser } from 'fast-xml-parser'
import { OFFICIAL_MODULE_IDS, type DiscoveredMod, type GameDiscovery } from '../types'
import { detectBlse } from './launch'
import {
  findSteamAppManifest,
  findSteamExe,
  resolvePaths,
} from './paths'

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
})

const OFFICIAL = new Set<string>(OFFICIAL_MODULE_IDS.map((id) => id.toLowerCase()))

function textOf(node: unknown): string {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node === 'object' && node !== null && '#text' in node) {
    return String((node as { '#text': string })['#text'] ?? '')
  }
  return ''
}

function attrOrText(node: unknown): string {
  if (node == null) return ''
  if (typeof node === 'object' && node !== null && '@_value' in node) {
    return String((node as { '@_value'?: string })['@_value'] ?? '')
  }
  return textOf(node)
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
    const id = attrOrText(root.Id) || attrOrText(root.Name)
    const name = attrOrText(root.Name) || id
    const version = attrOrText(root.Version) || 'unknown'
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
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
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
      official: OFFICIAL.has(meta.id.toLowerCase()) || OFFICIAL.has(folder.toLowerCase()),
    })
  }

  return mods.sort((a, b) => a.name.localeCompare(b.name))
}

function normalizeVersion(v: string): string {
  return v.replace(/^v/i, '').split('.').slice(0, 3).join('.')
}

function versionTuple(v: string): number[] {
  return normalizeVersion(v)
    .split('.')
    .map((p) => Number.parseInt(p, 10) || 0)
}

/** Return true if a is strictly newer than b (loose semver major.minor.patch). */
function isNewerVersion(a: string, b: string): boolean {
  const aa = versionTuple(a)
  const bb = versionTuple(b)
  for (let i = 0; i < 3; i += 1) {
    const x = aa[i] ?? 0
    const y = bb[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/**
 * Detect installed Bannerlord version.
 * After Steam validate/beta switch, package_info.txt often lags while
 * Modules/Native/SubModule.xml already reflects the new build — prefer the
 * newer of the two so Activate settle does not hang on a stale 1.3.x string.
 */
export function detectGameVersion(installPath: string | null): string | null {
  if (!installPath) return null

  let fromPackage: string | null = null
  const packageInfo = path.join(installPath, 'package_info.txt')
  if (fs.existsSync(packageInfo)) {
    const text = fs.readFileSync(packageInfo, 'utf8')
    const env = text.match(/Environment:\s*PC@v([\d.]+)/i)
    if (env) fromPackage = normalizeVersion(env[1])
  }

  let fromNative: string | null = null
  const nativeSub = path.join(installPath, 'Modules', 'Native', 'SubModule.xml')
  if (fs.existsSync(nativeSub)) {
    const meta = parseSubModuleXml(nativeSub)
    if (meta?.version) fromNative = normalizeVersion(meta.version)
  }

  if (fromPackage && fromNative) {
    if (fromPackage === fromNative) return fromPackage
    // Prefer the newer signal — typically Native after a finished Steam update/validate.
    return isNewerVersion(fromNative, fromPackage) ? fromNative : fromPackage
  }
  return fromNative || fromPackage
}

export function readSteamBetaBranch(manifestPath: string | null): string | null {
  if (!manifestPath || !fs.existsSync(manifestPath)) return null
  const text = fs.readFileSync(manifestPath, 'utf8')
  // Prefer MountedConfig (what Steam actually has mounted) over UserConfig.
  const mounted = text.match(
    /"MountedConfig"\s*\{[\s\S]*?"BetaKey"\s+"([^"]*)"/i,
  )
  if (mounted) return mounted[1]
  const user = text.match(/"UserConfig"\s*\{[\s\S]*?"BetaKey"\s+"([^"]*)"/i)
  if (user) return user[1]
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
    warnings.push(
      'Documents Bannerlord folder not found yet (will be created on activate if needed).',
    )
  }
  if (paths.launcherDataPath && !fs.existsSync(paths.launcherDataPath)) {
    warnings.push(
      'LauncherData.xml not found — create a profile after launching the game once, or capture after first run.',
    )
  }

  const mods = paths.modulesPath ? discoverMods(paths.modulesPath) : []
  const manifest = findSteamAppManifest(paths.gameInstallPath)
  const blse = detectBlse(paths.gameInstallPath)

  return {
    installPath: paths.gameInstallPath,
    modulesPath: paths.modulesPath,
    documentsPath: paths.documentsPath,
    launcherDataPath: paths.launcherDataPath,
    detectedGameVersion: detectGameVersion(paths.gameInstallPath),
    steamAppManifestPath: manifest,
    steamBetaBranch: readSteamBetaBranch(manifest),
    steamExePath: findSteamExe(),
    blse,
    mods,
    warnings,
  }
}
