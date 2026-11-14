import { createWriteStream } from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseSubModuleXml } from './discovery'
import { ensureAppDirs, resolvePaths } from './paths'
import { getStoreSnapshot } from './profiles'
import { ensureInVault } from './vault'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

export type ImportedModule = {
  folderName: string
  id: string
  name: string
  version: string
}

export type ImportArchiveResult = {
  ok: boolean
  modules: ImportedModule[]
  error?: string
  /** BLSE is a game bin overlay, not a Modules/ SubModule. */
  kind?: 'module' | 'blse'
}

function isArchivePath(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return lower.endsWith('.zip') || lower.endsWith('.7z') || lower.endsWith('.rar')
}

function resolveSevenZa(): string | null {
  try {
    const bin = require('7zip-bin') as { path7za?: string }
    if (bin.path7za && fs.existsSync(bin.path7za)) return bin.path7za
  } catch {
    // ignore
  }
  const candidates = [
    path.join(process.cwd(), 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
    path.join(process.resourcesPath || '', '7za.exe'),
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files\\7-Zip\\7za.exe',
  ]
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  return null
}

/**
 * Extract .zip / .7z / .rar into destDir.
 * Prefers bundled portable 7za (7zip-bin); falls back to Expand-Archive for .zip only.
 */
async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true })
  const lower = archivePath.toLowerCase()
  const sevenZa = resolveSevenZa()

  if (sevenZa) {
    // x = extract with full paths; -y = yes on all; -aoa = overwrite all
    await execFileAsync(sevenZa, ['x', archivePath, `-o${destDir}`, '-y', '-aoa'], {
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    })
    return
  }

  if (lower.endsWith('.zip')) {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
      ],
      { windowsHide: true },
    )
    return
  }

  throw new Error(
    `Cannot extract ${path.extname(archivePath) || 'archive'}: bundled 7za missing. Reinstall Modunary dependencies (7zip-bin).`,
  )
}

function findModuleRoots(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return
    if (fs.existsSync(path.join(dir, 'SubModule.xml'))) {
      found.push(dir)
      return
    }
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1)
    }
  }
  walk(root, 0)
  return found
}

function findBlseBinRoot(root: string): string | null {
  const walk = (dir: string, depth: number): string | null => {
    if (depth > 5) return null
    const win64 = path.join(dir, 'bin', 'Win64_Shipping_Client')
    const gd = path.join(dir, 'bin', 'Gaming.Desktop.x64_Shipping_Client')
    const hasBlse = (base: string) =>
      fs.existsSync(path.join(base, 'Bannerlord.BLSE.Launcher.exe')) ||
      fs.existsSync(path.join(base, 'Bannerlord.BLSE.LauncherEx.exe')) ||
      fs.existsSync(path.join(base, 'Bannerlord.BLSE.Standalone.exe'))
    if (hasBlse(win64) || hasBlse(gd)) return dir
    // Archive may already be the bin folder parent or the Win64 folder itself
    if (
      path.basename(dir).toLowerCase().includes('win64') &&
      (fs.existsSync(path.join(dir, 'Bannerlord.BLSE.Launcher.exe')) ||
        fs.existsSync(path.join(dir, 'Bannerlord.BLSE.LauncherEx.exe')))
    ) {
      return path.dirname(path.dirname(dir)) // .../bin/Win64 -> game-root-like
    }
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const hit = walk(path.join(dir, e.name), depth + 1)
      if (hit) return hit
    }
    return null
  }
  return walk(root, 0)
}

function copyDirMerge(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDirMerge(from, to)
    else fs.copyFileSync(from, to)
  }
}

/** Install BLSE launcher binaries into the Bannerlord game install (bin overlay). */
function installBlseOverlay(extractedRoot: string): { ok: boolean; error?: string } {
  const store = getStoreSnapshot()
  const gameInstall = resolvePaths(store.gameInstallPath, store.documentsPath).gameInstallPath
  if (!gameInstall || !fs.existsSync(gameInstall)) {
    return {
      ok: false,
      error: 'BLSE archive extracted, but Bannerlord install path is not set. Set it in Paths & version.',
    }
  }
  const blseRoot = findBlseBinRoot(extractedRoot)
  if (!blseRoot) {
    return { ok: false, error: 'BLSE files not found inside archive.' }
  }
  const srcBin = path.join(blseRoot, 'bin')
  if (!fs.existsSync(srcBin)) {
    // Extracted layout is already Win64_Shipping_Client contents
    const destWin = path.join(gameInstall, 'bin', 'Win64_Shipping_Client')
    fs.mkdirSync(destWin, { recursive: true })
    copyDirMerge(blseRoot, destWin)
  } else {
    copyDirMerge(srcBin, path.join(gameInstall, 'bin'))
  }
  return { ok: true }
}

function vaultRoots(roots: string[]): ImportedModule[] {
  const modules: ImportedModule[] = []
  for (const root of roots) {
    const meta = parseSubModuleXml(path.join(root, 'SubModule.xml'))
    const folderName = path.basename(root)
    ensureInVault(root, folderName)
    modules.push({
      folderName,
      id: meta?.id || folderName,
      name: meta?.name || folderName,
      version: meta?.version || 'unknown',
    })
  }
  return modules
}

export async function importZipToVault(archivePath: string): Promise<ImportArchiveResult> {
  ensureAppDirs()
  if (!fs.existsSync(archivePath)) {
    return { ok: false, modules: [], error: 'Archive not found.' }
  }
  if (!isArchivePath(archivePath)) {
    return {
      ok: false,
      modules: [],
      error: `Unsupported archive type (${path.extname(archivePath) || 'unknown'}). Use .zip, .7z, or .rar.`,
    }
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-mod-'))
  try {
    await extractArchive(archivePath, tmp)
    const roots = findModuleRoots(tmp)
    if (roots.length > 0) {
      return { ok: true, modules: vaultRoots(roots), kind: 'module' }
    }

    // BLSE and similar: bin overlay with Bannerlord.BLSE.*.exe, no SubModule.xml
    if (findBlseBinRoot(tmp)) {
      const blse = installBlseOverlay(tmp)
      if (!blse.ok) return { ok: false, modules: [], error: blse.error, kind: 'blse' }
      // Not a Modules/ SubModule — installed into game bin/. Caller may set requiresBlse.
      return { ok: true, kind: 'blse', modules: [] }
    }

    return {
      ok: false,
      modules: [],
      error:
        'No SubModule.xml found inside the archive (and it is not a BLSE bin overlay).',
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      modules: [],
      error: msg.includes('Expand-Archive')
        ? `Archive extract failed (zip-only tool cannot open this file). ${msg}`
        : msg,
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

export async function importFolderToVault(folderPath: string): Promise<{
  ok: boolean
  modules: ImportedModule[]
  error?: string
}> {
  ensureAppDirs()
  if (!fs.existsSync(folderPath)) return { ok: false, modules: [], error: 'Folder not found.' }
  const roots = findModuleRoots(folderPath)
  if (roots.length === 0) {
    return { ok: false, modules: [], error: 'No SubModule.xml found in folder.' }
  }
  return { ok: true, modules: vaultRoots(roots) }
}

export async function downloadUrlToVault(
  url: string,
  suggestedName: string,
): Promise<ImportArchiveResult> {
  ensureAppDirs()
  const extGuess = (() => {
    try {
      const u = new URL(url)
      const p = u.pathname.toLowerCase()
      if (p.endsWith('.7z')) return '.7z'
      if (p.endsWith('.rar')) return '.rar'
      if (p.endsWith('.zip')) return '.zip'
    } catch {
      // ignore
    }
    return '.zip'
  })()
  const tmpZip = path.join(
    os.tmpdir(),
    `${suggestedName.replace(/[^\w.-]+/g, '_')}-${Date.now()}${extGuess}`,
  )
  try {
    const res = await fetch(url)
    if (!res.ok || !res.body) {
      return { ok: false, modules: [], error: `Download failed (${res.status}).` }
    }
    const nodeStream = Readable.fromWeb(res.body as import('stream/web').ReadableStream)
    await pipeline(nodeStream, createWriteStream(tmpZip))
    return await importZipToVault(tmpZip)
  } catch (err) {
    return { ok: false, modules: [], error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip)
  }
}

export function importWorkshopFolder(workshopItemDir: string): {
  ok: boolean
  modules: ImportedModule[]
  error?: string
} {
  if (!fs.existsSync(workshopItemDir)) {
    return {
      ok: false,
      modules: [],
      error: 'Workshop item folder not found. Subscribe in Steam first.',
    }
  }
  for (const c of [workshopItemDir, path.join(workshopItemDir, 'Modules')]) {
    if (!fs.existsSync(c)) continue
    const roots = findModuleRoots(c)
    if (roots.length === 0) continue
    return { ok: true, modules: vaultRoots(roots) }
  }
  return { ok: false, modules: [], error: 'No SubModule.xml under workshop item.' }
}
