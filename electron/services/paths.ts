import { execSync } from 'node:child_process'
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppPaths } from '../types'

const STEAM_APP_ID = '261550'
const GAME_FOLDER = 'Mount & Blade II Bannerlord'
const DOCS_FOLDER = 'Mount and Blade II Bannerlord'

export function getAppDataRoot(): string {
  return path.join(app.getPath('userData'))
}

export function getStorePath(): string {
  return path.join(getAppDataRoot(), 'store.json')
}

export function getBackupsPath(): string {
  return path.join(getAppDataRoot(), 'backups')
}

export function ensureAppDirs(): void {
  fs.mkdirSync(getAppDataRoot(), { recursive: true })
  fs.mkdirSync(getBackupsPath(), { recursive: true })
}

function readSteamPathFromRegistry(): string | null {
  try {
    const out = execSync(
      'reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath',
      { encoding: 'utf8' },
    )
    const match = out.match(/SteamPath\s+REG_SZ\s+(.+)/i)
    return match ? match[1].trim().replace(/\//g, '\\') : null
  } catch {
    return null
  }
}

function parseLibraryFolders(steamRoot: string): string[] {
  const vdfPath = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf')
  if (!fs.existsSync(vdfPath)) return [steamRoot]
  const text = fs.readFileSync(vdfPath, 'utf8')
  const libs = new Set<string>([steamRoot])
  for (const match of text.matchAll(/"path"\s+"([^"]+)"/g)) {
    libs.add(match[1].replace(/\\\\/g, '\\'))
  }
  return [...libs]
}

export function findSteamLibraries(): string[] {
  const candidates: string[] = []
  const reg = readSteamPathFromRegistry()
  if (reg) candidates.push(reg)

  candidates.push(
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
    'D:\\Program Files (x86)\\Steam',
    'D:\\SteamLibrary',
    'E:\\SteamLibrary',
    'F:\\SteamLibrary',
  )

  const roots = new Set<string>()
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      for (const lib of parseLibraryFolders(c)) {
        if (fs.existsSync(lib)) roots.add(lib)
      }
    }
  }
  return [...roots]
}

export function findBannerlordInstall(override?: string | null): string | null {
  if (override && fs.existsSync(override)) return override

  for (const lib of findSteamLibraries()) {
    const candidate = path.join(lib, 'steamapps', 'common', GAME_FOLDER)
    if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, 'Modules'))) {
      return candidate
    }
  }

  // GOG / Xbox / manual common leftovers
  const extras = [
    'C:\\GOG Games\\Mount & Blade II Bannerlord',
    'D:\\GOG Games\\Mount & Blade II Bannerlord',
    path.join(os.homedir(), 'Games', GAME_FOLDER),
  ]
  for (const p of extras) {
    if (fs.existsSync(p) && fs.existsSync(path.join(p, 'Modules'))) return p
  }
  return null
}

export function defaultDocumentsPath(override?: string | null): string | null {
  if (override && fs.existsSync(override)) return override
  const docs = path.join(os.homedir(), 'Documents', DOCS_FOLDER)
  return fs.existsSync(docs) ? docs : docs
}

export function launcherDataPath(documentsPath: string): string {
  return path.join(documentsPath, 'Configs', 'LauncherData.xml')
}

export function modulesPath(installPath: string): string {
  return path.join(installPath, 'Modules')
}

export function findSteamAppManifest(installPath: string | null): string | null {
  if (!installPath) return null
  for (const lib of findSteamLibraries()) {
    const acf = path.join(lib, 'steamapps', `appmanifest_${STEAM_APP_ID}.acf`)
    if (fs.existsSync(acf)) return acf
    // Heuristic: if install is under this library
    if (installPath.toLowerCase().startsWith(path.join(lib, 'steamapps', 'common').toLowerCase())) {
      return fs.existsSync(acf) ? acf : null
    }
  }
  return null
}

export function resolvePaths(
  gameInstallPath: string | null,
  documentsPath: string | null,
): AppPaths {
  const install = findBannerlordInstall(gameInstallPath)
  const docs = defaultDocumentsPath(documentsPath)
  return {
    gameInstallPath: install,
    modulesPath: install ? modulesPath(install) : null,
    documentsPath: docs,
    launcherDataPath: docs ? launcherDataPath(docs) : null,
    storePath: getStorePath(),
    backupsPath: getBackupsPath(),
  }
}

export { STEAM_APP_ID, GAME_FOLDER, DOCS_FOLDER }
