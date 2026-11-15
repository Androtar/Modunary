import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { OFFICIAL_MODULE_IDS, type ModEntry, type ModProfile } from '../types'
import { ensureAppDirs, getVaultPath } from './paths'
import { assertEnoughSpace } from './vaultMigrate'

const execFileAsync = promisify(execFile)
const OFFICIAL = new Set<string>(
  OFFICIAL_MODULE_IDS.map((id) => id.toLowerCase()),
)

export type VaultProgress = (message: string) => void

export function isOfficialModule(idOrFolder: string): boolean {
  return OFFICIAL.has(idOrFolder.trim().toLowerCase())
}

export function vaultModulePath(folderName: string): string {
  return path.join(getVaultPath(), folderName)
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function isBannerlordRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-Process -Name 'Bannerlord','Bannerlord.Native','TaleWorlds.MountAndBlade.Launcher','Bannerlord.BLSE.Launcher','Bannerlord.BLSE.LauncherEx' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName",
      ],
      { windowsHide: true, timeout: 4000 },
    )
    return String(stdout).trim().length > 0
  } catch {
    return false
  }
}

function formatFsError(err: unknown, action: string, target: string): Error {
  const raw = err instanceof Error ? err.message : String(err)
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: string }).code || '')
      : ''
  const privilege =
    /privilege is not held/i.test(raw) || code === 'EPERM' || /\b1314\b/.test(raw)
  const busy =
    /being used by another process|EBUSY|resource busy|locked/i.test(raw) ||
    code === 'EBUSY' ||
    code === 'EACCES'

  if (privilege) {
    return new Error(
      `${action} failed for "${target}": Windows blocked creating a symbolic link (common with Vortex-deployed mods). Modunary copies real files instead — if this persists, remove leftover symlinks under Modules or set vault deploy mode to Copy. Details: ${raw}`,
    )
  }
  if (busy) {
    return new Error(
      `${action} failed for "${target}": folder looks locked. Close Bannerlord and the launcher, then Activate again. Details: ${raw}`,
    )
  }
  return new Error(`${action} failed for "${target}": ${raw}`)
}

async function rmrf(target: string): Promise<void> {
  try {
    await fsp.rm(target, { recursive: true, force: true })
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === 'ENOENT'
    ) {
      return
    }
    throw formatFsError(err, 'Remove', target)
  }
}

/**
 * Copy a module tree while dereferencing symlinks (Vortex-safe).
 * Yields the event loop periodically so Electron UI/IPC stay responsive.
 */
async function copyDir(
  src: string,
  dest: string,
  onProgress?: VaultProgress,
  label?: string,
): Promise<void> {
  let ops = 0
  const tick = async () => {
    ops += 1
    if (ops % 24 === 0) {
      if (label && ops % 120 === 0) onProgress?.(`Copying ${label}… (${ops} items)`)
      await yieldEventLoop()
    }
  }

  const walk = async (from: string, to: string): Promise<void> => {
    let st: fs.Stats
    try {
      st = await fsp.lstat(from)
    } catch (err) {
      throw formatFsError(err, 'Read', from)
    }

    if (st.isSymbolicLink()) {
      let targetStat: fs.Stats
      try {
        targetStat = await fsp.stat(from)
      } catch (err) {
        throw formatFsError(err, 'Follow symlink', `${from} (broken Vortex/Steam link?)`)
      }
      if (targetStat.isDirectory()) {
        await fsp.mkdir(to, { recursive: true })
        const names = await fsp.readdir(from)
        for (const name of names) {
          await walk(path.join(from, name), path.join(to, name))
        }
        await tick()
        return
      }
      await fsp.mkdir(path.dirname(to), { recursive: true })
      try {
        await fsp.copyFile(from, to)
      } catch (err) {
        throw formatFsError(err, 'Copy file', to)
      }
      await tick()
      return
    }

    if (st.isDirectory()) {
      await fsp.mkdir(to, { recursive: true })
      const names = await fsp.readdir(from)
      for (const name of names) {
        await walk(path.join(from, name), path.join(to, name))
      }
      await tick()
      return
    }

    if (st.isFile()) {
      await fsp.mkdir(path.dirname(to), { recursive: true })
      try {
        await fsp.copyFile(from, to)
      } catch (err) {
        throw formatFsError(err, 'Copy file', to)
      }
      await tick()
    }
  }

  try {
    await walk(src, dest)
  } catch (err) {
    if (err instanceof Error && /failed for/i.test(err.message)) throw err
    throw formatFsError(err, 'Copy', dest)
  }
}

function isJunctionOrSymlinkSync(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink()
  } catch {
    return false
  }
}

async function isJunctionOrSymlink(target: string): Promise<boolean> {
  try {
    return (await fsp.lstat(target)).isSymbolicLink()
  } catch {
    return false
  }
}

async function treeHasSymlinks(root: string, maxFiles = 80): Promise<boolean> {
  let seen = 0
  const stack = [root]
  while (stack.length && seen < maxFiles) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      seen += 1
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) return true
      if (entry.isDirectory()) stack.push(full)
      if (seen >= maxFiles) break
    }
    await yieldEventLoop()
  }
  return false
}

async function roughDirBytes(root: string, maxFiles = 400): Promise<number> {
  let total = 0
  let seen = 0
  const stack = [root]
  while (stack.length && seen < maxFiles) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile() || e.isSymbolicLink()) {
        try {
          total += (await fsp.stat(full)).size
          seen += 1
        } catch {
          // ignore
        }
      }
      if (seen >= maxFiles) break
    }
  }
  // If we hit the cap, scale up conservatively.
  if (seen >= maxFiles) total = Math.floor(total * 1.5)
  return total
}

/** Ensure a module folder from Modules (or elsewhere) is stored in the vault. */
export async function ensureInVault(
  sourceDir: string,
  folderName: string,
  onProgress?: VaultProgress,
): Promise<string> {
  ensureAppDirs()
  const dest = vaultModulePath(folderName)
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Cannot vault missing folder: ${sourceDir}`)
  }
  if (fs.existsSync(dest)) {
    if (!(await isJunctionOrSymlink(sourceDir))) {
      const hasSub = fs.existsSync(path.join(dest, 'SubModule.xml'))
      if (!hasSub) {
        const need = await roughDirBytes(sourceDir)
        await assertEnoughSpace(dest, need, `vault "${folderName}"`)
        await rmrf(dest)
        await copyDir(sourceDir, dest, onProgress, folderName)
      }
    }
    return dest
  }
  const need = await roughDirBytes(sourceDir)
  await assertEnoughSpace(dest, need, `vault "${folderName}"`)
  onProgress?.(`Importing ${folderName} into vault…`)
  await copyDir(sourceDir, dest, onProgress, folderName)
  return dest
}

async function createJunction(linkPath: string, targetPath: string): Promise<void> {
  try {
    await execFileAsync('cmd', ['/c', 'mklink', '/J', linkPath, targetPath], {
      windowsHide: true,
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Could not create directory junction for "${linkPath}" → "${targetPath}". Junctions normally work without admin; falling back to copy. (${detail})`,
    )
  }
}

export async function deployFromVault(
  modulesDir: string,
  folderName: string,
  mode: 'junction' | 'copy',
  onProgress?: VaultProgress,
): Promise<void> {
  const vaultDir = vaultModulePath(folderName)
  if (!fs.existsSync(vaultDir)) {
    throw new Error(`Vault missing module "${folderName}". Import or install it first.`)
  }
  const dest = path.join(modulesDir, folderName)
  if (fs.existsSync(dest)) {
    if (
      (await isJunctionOrSymlink(dest)) ||
      fs.existsSync(path.join(dest, 'SubModule.xml'))
    ) {
      return
    }
    await rmrf(dest)
  }

  if (mode === 'junction') {
    try {
      await createJunction(dest, vaultDir)
      return
    } catch {
      // Fallback to copy
    }
  }
  const need = await roughDirBytes(vaultDir)
  await assertEnoughSpace(dest, need, `deploy "${folderName}"`)
  onProgress?.(`Deploying ${folderName}…`)
  await copyDir(vaultDir, dest, onProgress, folderName)
}

export async function parkModuleToVault(
  modulesDir: string,
  folderName: string,
  onProgress?: VaultProgress,
): Promise<void> {
  if (isOfficialModule(folderName)) return
  const src = path.join(modulesDir, folderName)
  if (!fs.existsSync(src)) return

  if (await isJunctionOrSymlink(src)) {
    try {
      await fsp.rm(src, { force: true })
    } catch (err) {
      throw formatFsError(err, 'Unlink module', src)
    }
    return
  }

  await ensureInVault(src, folderName, onProgress)
  onProgress?.(`Parking ${folderName} from Modules…`)
  await rmrf(src)
}

export interface VaultDeployResult {
  deployed: string[]
  parked: string[]
  warnings: string[]
  notes: string[]
}

async function junctionTarget(linkPath: string): Promise<string | null> {
  try {
    if (!(await isJunctionOrSymlink(linkPath))) return null
    return await fsp.readlink(linkPath)
  } catch {
    return null
  }
}

/**
 * Restore official modules that were wrongly parked into the vault
 * (e.g. SandBox when casing did not match OFFICIAL_MODULE_IDS).
 * Prefer a real directory copy for official modules (Steam owns them).
 */
async function restoreOfficialFromVault(
  modulesDir: string,
  onProgress?: VaultProgress,
): Promise<string[]> {
  const restored: string[] = []
  // Prefer canonical Bannerlord folder names.
  const candidates = ['SandBox', 'SandBoxCore', 'Native', 'StoryMode', 'CustomBattle', 'BirthAndDeath']
  for (const folder of candidates) {
    if (!isOfficialModule(folder)) continue
    const dest = path.join(modulesDir, folder)
    const vaultDir = vaultModulePath(folder)
    if (fs.existsSync(dest)) continue
    if (!fs.existsSync(vaultDir)) continue
    onProgress?.(`Restoring official module ${folder} from vault…`)
    try {
      await copyDir(vaultDir, dest, onProgress, folder)
      restored.push(folder)
    } catch (err) {
      // Fall back to junction if copy fails (still better than missing SandBox).
      try {
        await createJunction(dest, vaultDir)
        restored.push(folder)
      } catch {
        throw err
      }
    }
    await yieldEventLoop()
  }
  return restored
}

export async function deployProfileVault(
  modulesDir: string,
  profile: ModProfile,
  onProgress?: VaultProgress,
): Promise<VaultDeployResult> {
  ensureAppDirs()
  const warnings: string[] = []
  const notes: string[] = []
  const deployed: string[] = []
  const parked: string[] = []
  const mode = profile.settings.vaultDeployMode || 'junction'

  if (!fs.existsSync(modulesDir)) {
    throw new Error(`Modules directory missing: ${modulesDir}`)
  }

  if (await isBannerlordRunning()) {
    throw new Error(
      'Cannot Activate while Bannerlord or its launcher is running — close the game first so Modules folders are not locked.',
    )
  }

  const wantedFolders = new Set(
    profile.mods
      .filter((m) => !isOfficialModule(m.id) && !isOfficialModule(m.folderName))
      .map((m) => m.folderName),
  )

  notes.push(`Vault modules path: ${getVaultPath()}`)

  try {
    const restored = await restoreOfficialFromVault(modulesDir, onProgress)
    if (restored.length) {
      notes.push(`Restored official module(s) from vault: ${restored.join(', ')}.`)
    }
  } catch (err) {
    warnings.push(
      `Official module restore failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (!fs.existsSync(path.join(modulesDir, 'SandBox'))) {
    warnings.push(
      'Official SandBox module is missing from Modules. Singleplayer will not work until it is restored (Activate will try vault restore; otherwise run Steam verify).',
    )
  }

  const existing = await fsp.readdir(modulesDir, { withFileTypes: true })
  let vortexStyle = 0
  let idx = 0
  for (const entry of existing) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const folder = entry.name
    if (isOfficialModule(folder)) continue
    const full = path.join(modulesDir, folder)
    const hasSub =
      fs.existsSync(path.join(full, 'SubModule.xml')) ||
      (await isJunctionOrSymlink(full))
    if (!hasSub && !(await treeHasSymlinks(full))) continue
    idx += 1
    onProgress?.(`Vaulting Modules (${idx})… ${folder}`)
    try {
      if (await treeHasSymlinks(full)) vortexStyle += 1
      if (!(await isJunctionOrSymlink(full))) {
        await ensureInVault(full, folder, onProgress)
      }
    } catch (err) {
      warnings.push(
        `Could not vault "${folder}": ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    await yieldEventLoop()
  }
  if (vortexStyle > 0) {
    notes.push(
      `Detected ${vortexStyle} Vortex-style symlink module(s); copied real files into the vault (no admin symlink privilege required).`,
    )
  }

  for (const entry of await fsp.readdir(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const folder = entry.name
    if (isOfficialModule(folder)) continue
    if (wantedFolders.has(folder)) continue
    try {
      onProgress?.(`Parking ${folder}…`)
      await parkModuleToVault(modulesDir, folder, onProgress)
      parked.push(folder)
    } catch (err) {
      warnings.push(
        `Could not park "${folder}": ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    await yieldEventLoop()
  }

  for (const folder of wantedFolders) {
    const dest = path.join(modulesDir, folder)
    const vaultDir = vaultModulePath(folder)
    try {
      if (fs.existsSync(dest) && !(await isJunctionOrSymlink(dest))) {
        await ensureInVault(dest, folder, onProgress)
      }
      if (!fs.existsSync(vaultDir)) {
        warnings.push(`Profile wants "${folder}" but it is not in the vault or Modules.`)
        continue
      }

      const needsDeploy = async (): Promise<boolean> => {
        if (!fs.existsSync(dest)) return true
        if (await isJunctionOrSymlink(dest)) {
          const target = await junctionTarget(dest)
          const normVault = path.resolve(vaultDir).toLowerCase()
          const normTarget = target ? path.resolve(target).toLowerCase() : ''
          if (normTarget && normTarget !== normVault) return true
          // Junction already points at vault — good.
          return false
        }
        if (await treeHasSymlinks(dest)) return true
        // Real directory with SubModule already present — leave alone.
        return !fs.existsSync(path.join(dest, 'SubModule.xml'))
      }

      if (await needsDeploy()) {
        if (fs.existsSync(dest)) await rmrf(dest)
        onProgress?.(`Deploying ${folder}…`)
        await deployFromVault(modulesDir, folder, mode, onProgress)
      }
      if (!fs.existsSync(dest)) {
        warnings.push(`Deploy failed for "${folder}": not present under Modules after deploy.`)
        continue
      }
      deployed.push(folder)
    } catch (err) {
      warnings.push(
        `Deploy failed for "${folder}": ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    await yieldEventLoop()
  }

  notes.push(
    `Vault deploy (${mode}): ${deployed.length} module(s) present, parked ${parked.length}.`,
  )
  return { deployed, parked, warnings, notes }
}

export async function importModulesIntoVault(
  modulesDir: string,
  onProgress?: VaultProgress,
): Promise<{ imported: string[]; skipped: string[]; warnings: string[] }> {
  ensureAppDirs()
  const imported: string[] = []
  const skipped: string[] = []
  const warnings: string[] = []
  if (!fs.existsSync(modulesDir)) return { imported, skipped, warnings }

  const entries = await fsp.readdir(modulesDir, { withFileTypes: true })
  let i = 0
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const folder = entry.name
    if (isOfficialModule(folder)) {
      skipped.push(folder)
      continue
    }
    const full = path.join(modulesDir, folder)
    const hasSub =
      fs.existsSync(path.join(full, 'SubModule.xml')) ||
      (await isJunctionOrSymlink(full))
    if (!hasSub && !(await treeHasSymlinks(full))) {
      skipped.push(folder)
      continue
    }
    if (await isJunctionOrSymlink(full)) {
      skipped.push(folder)
      continue
    }
    i += 1
    onProgress?.(`Importing to vault (${i}/${entries.length})… ${folder}`)
    try {
      await ensureInVault(full, folder, onProgress)
      imported.push(folder)
    } catch (err) {
      warnings.push(
        `Import vault failed for "${folder}": ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    await yieldEventLoop()
  }
  return { imported, skipped, warnings }
}

export function listVaultModules(): string[] {
  ensureAppDirs()
  const root = getVaultPath()
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'SubModule.xml')))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b))
}

export function resolveProfileModFolders(mods: ModEntry[]): string[] {
  return mods
    .filter((m) => !isOfficialModule(m.id) && !isOfficialModule(m.folderName))
    .map((m) => m.folderName)
}

/** Sync helper kept for callers that only need a boolean without await. */
export function isJunctionOrSymlinkPath(target: string): boolean {
  return isJunctionOrSymlinkSync(target)
}
