import { createWriteStream } from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import { app } from 'electron'
import { parseSubModuleXml } from './discovery'
import { ensureAppDirs, resolvePaths } from './paths'
import { getStoreSnapshot } from './profiles'
import { ensureInVault } from './vault'

const requireFromHere = createRequire(import.meta.url)

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
  /** Which extractor ran (for diagnostics). */
  extractor?: string
}

function isArchivePath(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return lower.endsWith('.zip') || lower.endsWith('.7z') || lower.endsWith('.rar')
}

/**
 * Resolve portable 7za.exe. Never uses Expand-Archive / PowerShell.
 * Searches package export, paths relative to this module / app root, then common installs.
 */
function resolveSevenZa(): string {
  const tried: string[] = []
  const consider = (p: string | null | undefined): string | null => {
    if (!p) return null
    tried.push(p)
    try {
      if (fs.existsSync(p)) return p
    } catch {
      // ignore
    }
    return null
  }

  try {
    const bin = requireFromHere('7zip-bin') as { path7za?: string }
    const hit = consider(bin.path7za)
    if (hit) return hit
  } catch {
    // continue
  }

  const here = path.dirname(fileURLToPath(import.meta.url)) // …/dist-electron or …/electron/services
  let appRoot: string | null = null
  try {
    if (app?.isReady?.() || app?.getAppPath) appRoot = app.getAppPath()
  } catch {
    // app may be unavailable in unit contexts
  }

  const relCandidates = [
    path.join(here, '..', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
    path.join(here, '..', '..', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
    path.join(here, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
    appRoot ? path.join(appRoot, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe') : null,
    path.join(process.cwd(), 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
    path.join(process.resourcesPath || '', '7za.exe'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files\\7-Zip\\7za.exe',
  ]
  for (const c of relCandidates) {
    const hit = consider(c)
    if (hit) return hit
  }

  throw new Error(
    `7za.exe not found (required for .zip/.7z/.rar). Tried: ${tried.slice(0, 8).join(' | ')}`,
  )
}

/**
 * Extract .zip / .7z / .rar with bundled portable 7za only.
 * Expand-Archive is never used (cannot open .7z).
 */
async function extractArchive(
  archivePath: string,
  destDir: string,
  onProgress?: (percent: number | null, detail: string) => void,
): Promise<string> {
  fs.mkdirSync(destDir, { recursive: true })
  const sevenZa = resolveSevenZa()
  onProgress?.(null, 'Extracting archive…')
  // x = extract with full paths; -y = yes; -aoa = overwrite all; -bsp1 = progress on stdout
  await new Promise<void>((resolve, reject) => {
    const child = spawn(sevenZa, ['x', archivePath, `-o${destDir}`, '-y', '-aoa', '-bsp1'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    const onChunk = (buf: Buffer) => {
      const text = buf.toString('utf8')
      // 7za progress lines often look like "  34%" or include "%"
      const m = text.match(/(\d{1,3})\s*%/)
      if (m) {
        const pct = Math.max(0, Math.min(99, Number(m[1])))
        onProgress?.(pct, `Extracting… ${pct}%`)
      }
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', (buf: Buffer) => {
      stderr += buf.toString('utf8')
      onChunk(buf)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`7za extract failed (code ${code}): ${stderr.slice(0, 240)}`))
    })
  })
  onProgress?.(100, 'Extract complete')
  return sevenZa
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

export async function importZipToVault(
  archivePath: string,
  options?: {
    onProgress?: (update: {
      step: 'extract' | 'import'
      percent: number | null
      detail: string
    }) => void
  },
): Promise<ImportArchiveResult> {
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
    const sevenZa = await extractArchive(archivePath, tmp, (percent, detail) => {
      options?.onProgress?.({ step: 'extract', percent, detail })
    })
    const extractor = `7za:${sevenZa}`
    options?.onProgress?.({ step: 'import', percent: 70, detail: 'Scanning modules…' })
    const roots = findModuleRoots(tmp)
    if (roots.length > 0) {
      options?.onProgress?.({ step: 'import', percent: 85, detail: 'Copying into vault…' })
      const modules = vaultRoots(roots)
      options?.onProgress?.({ step: 'import', percent: 100, detail: 'Import complete' })
      return { ok: true, modules, kind: 'module', extractor }
    }

    // BLSE and similar: bin overlay with Bannerlord.BLSE.*.exe, no SubModule.xml
    if (findBlseBinRoot(tmp)) {
      options?.onProgress?.({ step: 'import', percent: 85, detail: 'Installing BLSE overlay…' })
      const blse = installBlseOverlay(tmp)
      if (!blse.ok) return { ok: false, modules: [], error: blse.error, kind: 'blse', extractor }
      options?.onProgress?.({ step: 'import', percent: 100, detail: 'BLSE installed' })
      // Not a Modules/ SubModule — installed into game bin/. Caller may set requiresBlse.
      return { ok: true, kind: 'blse', modules: [], extractor }
    }

    return {
      ok: false,
      modules: [],
      extractor,
      error:
        'No SubModule.xml found inside the archive (and it is not a BLSE bin overlay).',
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      modules: [],
      error: msg,
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
