import { createWriteStream } from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseSubModuleXml } from './discovery'
import { ensureAppDirs } from './paths'
import { ensureInVault } from './vault'

const execFileAsync = promisify(execFile)

export type ImportedModule = {
  folderName: string
  id: string
  name: string
  version: string
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true })
  await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ],
    { windowsHide: true },
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

export async function importZipToVault(zipPath: string): Promise<{
  ok: boolean
  modules: ImportedModule[]
  error?: string
}> {
  ensureAppDirs()
  if (!fs.existsSync(zipPath)) return { ok: false, modules: [], error: 'ZIP not found.' }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-mod-'))
  try {
    await extractZip(zipPath, tmp)
    const roots = findModuleRoots(tmp)
    if (roots.length === 0) {
      return { ok: false, modules: [], error: 'No SubModule.xml found inside the archive.' }
    }
    return { ok: true, modules: vaultRoots(roots) }
  } catch (err) {
    return { ok: false, modules: [], error: err instanceof Error ? err.message : String(err) }
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
): Promise<{
  ok: boolean
  modules: ImportedModule[]
  error?: string
}> {
  ensureAppDirs()
  const tmpZip = path.join(
    os.tmpdir(),
    `${suggestedName.replace(/[^\w.-]+/g, '_')}-${Date.now()}.zip`,
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
