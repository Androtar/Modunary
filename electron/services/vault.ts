import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { OFFICIAL_MODULE_IDS, type ModEntry, type ModProfile } from '../types'
import { ensureAppDirs, getVaultPath } from './paths'

const OFFICIAL = new Set<string>(OFFICIAL_MODULE_IDS)

export function isOfficialModule(idOrFolder: string): boolean {
  return OFFICIAL.has(idOrFolder)
}

export function vaultModulePath(folderName: string): string {
  return path.join(getVaultPath(), folderName)
}

function isBannerlordRunning(): boolean {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-Process -Name 'Bannerlord','Bannerlord.Native','TaleWorlds.MountAndBlade.Launcher','Bannerlord.BLSE.Launcher','Bannerlord.BLSE.LauncherEx' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName",
      ],
      { windowsHide: true, encoding: 'utf8', timeout: 4000 },
    )
    return out.trim().length > 0
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
    /privilege is not held/i.test(raw) ||
    code === 'EPERM' ||
    /\b1314\b/.test(raw)
  const busy =
    /being used by another process|EBUSY|resource busy|locked/i.test(raw) ||
    code === 'EBUSY' ||
    code === 'EACCES'

  if (privilege) {
    return new Error(
      `${action} failed for "${target}": Windows blocked creating a symbolic link (common with Vortex-deployed mods). Modunary now copies real files instead — if this persists, remove leftover symlinks under Modules or set vault deploy mode to Copy. Details: ${raw}`,
    )
  }
  if (busy || isBannerlordRunning()) {
    return new Error(
      `${action} failed for "${target}": folder looks locked${isBannerlordRunning() ? ' (Bannerlord/launcher is running)' : ''}. Close Bannerlord and the launcher, then Activate again. Details: ${raw}`,
    )
  }
  return new Error(`${action} failed for "${target}": ${raw}`)
}

function rmrf(target: string): void {
  if (!fs.existsSync(target)) return
  try {
    fs.rmSync(target, { recursive: true, force: true })
  } catch (err) {
    throw formatFsError(err, 'Remove', target)
  }
}

/**
 * Copy a module tree into the vault (or Modules) while dereferencing symlinks.
 * Vortex deploys mods as file symlinks into Modules; Node's fs.cpSync tries to
 * recreate those symlinks and fails without SeCreateSymbolicLinkPrivilege.
 * We always materialize real files/directories so vault deploy works without admin.
 */
function copyDir(src: string, dest: string): void {
  const walk = (from: string, to: string): void => {
    let st: fs.Stats
    try {
      st = fs.lstatSync(from)
    } catch (err) {
      throw formatFsError(err, 'Read', from)
    }

    if (st.isSymbolicLink()) {
      let targetStat: fs.Stats
      try {
        targetStat = fs.statSync(from) // follow
      } catch (err) {
        throw formatFsError(
          err,
          'Follow symlink',
          `${from} (broken Vortex/Steam link?)`,
        )
      }
      if (targetStat.isDirectory()) {
        fs.mkdirSync(to, { recursive: true })
        for (const name of fs.readdirSync(from)) {
          walk(path.join(from, name), path.join(to, name))
        }
        return
      }
      fs.mkdirSync(path.dirname(to), { recursive: true })
      try {
        fs.copyFileSync(from, to) // reads through the symlink
      } catch (err) {
        throw formatFsError(err, 'Copy file', to)
      }
      return
    }

    if (st.isDirectory()) {
      fs.mkdirSync(to, { recursive: true })
      for (const name of fs.readdirSync(from)) {
        walk(path.join(from, name), path.join(to, name))
      }
      return
    }

    if (st.isFile()) {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      try {
        fs.copyFileSync(from, to)
      } catch (err) {
        throw formatFsError(err, 'Copy file', to)
      }
      return
    }

    // Ignore sockets/FIFOs/etc.
  }

  try {
    walk(src, dest)
  } catch (err) {
    if (err instanceof Error && /failed for/i.test(err.message)) throw err
    throw formatFsError(err, 'Copy', dest)
  }
}

function isJunctionOrSymlink(target: string): boolean {
  try {
    const st = fs.lstatSync(target)
    return st.isSymbolicLink()
  } catch {
    return false
  }
}

/** True when a module folder contains nested file/dir symlinks (Vortex-style). */
function treeHasSymlinks(root: string, maxFiles = 80): boolean {
  let seen = 0
  const stack = [root]
  while (stack.length && seen < maxFiles) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
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
  }
  return false
}

/** Ensure a module folder from Modules (or elsewhere) is stored in the vault. */
export function ensureInVault(sourceDir: string, folderName: string): string {
  ensureAppDirs()
  const dest = vaultModulePath(folderName)
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Cannot vault missing folder: ${sourceDir}`)
  }
  if (fs.existsSync(dest)) {
    // Refresh if source is a real directory (not already a junction pointing at vault).
    if (!isJunctionOrSymlink(sourceDir)) {
      // Keep existing vault copy; only overwrite if vault looks empty.
      const hasSub = fs.existsSync(path.join(dest, 'SubModule.xml'))
      if (!hasSub) {
        rmrf(dest)
        copyDir(sourceDir, dest)
      }
    }
    return dest
  }
  copyDir(sourceDir, dest)
  return dest
}

function createJunction(linkPath: string, targetPath: string): void {
  // Windows directory junction — no admin required (unlike file symlinks).
  try {
    execFileSync(
      'cmd',
      ['/c', 'mklink', '/J', linkPath, targetPath],
      { windowsHide: true, encoding: 'utf8' },
    )
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Could not create directory junction for "${linkPath}" → "${targetPath}". ` +
        `Junctions normally work without admin; falling back to copy. (${detail})`,
    )
  }
}

export function deployFromVault(
  modulesDir: string,
  folderName: string,
  mode: 'junction' | 'copy',
): void {
  const vaultDir = vaultModulePath(folderName)
  if (!fs.existsSync(vaultDir)) {
    throw new Error(`Vault missing module "${folderName}". Import or install it first.`)
  }
  const dest = path.join(modulesDir, folderName)
  if (fs.existsSync(dest)) {
    // Already deployed (junction or real). Leave alone if points at vault or has SubModule.
    if (isJunctionOrSymlink(dest) || fs.existsSync(path.join(dest, 'SubModule.xml'))) {
      return
    }
    rmrf(dest)
  }

  if (mode === 'junction') {
    try {
      createJunction(dest, vaultDir)
      return
    } catch {
      // Fallback to copy if junction fails.
    }
  }
  copyDir(vaultDir, dest)
}

/**
 * Park a non-official module currently living under Modules into the vault,
 * then remove it from Modules so another profile can deploy a clean set.
 */
export function parkModuleToVault(modulesDir: string, folderName: string): void {
  if (isOfficialModule(folderName)) return
  const src = path.join(modulesDir, folderName)
  if (!fs.existsSync(src)) return

  if (isJunctionOrSymlink(src)) {
    // Junction/symlink at module root: vault already has content (or will via other path); just unlink.
    try {
      fs.rmSync(src, { force: true })
    } catch (err) {
      throw formatFsError(err, 'Unlink module', src)
    }
    return
  }

  ensureInVault(src, folderName)
  rmrf(src)
}

export interface VaultDeployResult {
  deployed: string[]
  parked: string[]
  warnings: string[]
  notes: string[]
}

/**
 * Deploy the profile's module set into Modules via vault.
 * Official modules are never moved. Non-profile community mods are parked to vault.
 */
export function deployProfileVault(
  modulesDir: string,
  profile: ModProfile,
): VaultDeployResult {
  ensureAppDirs()
  const warnings: string[] = []
  const notes: string[] = []
  const deployed: string[] = []
  const parked: string[] = []
  const mode = profile.settings.vaultDeployMode || 'junction'

  if (!fs.existsSync(modulesDir)) {
    throw new Error(`Modules directory missing: ${modulesDir}`)
  }

  if (isBannerlordRunning()) {
    throw new Error(
      'Cannot Activate while Bannerlord or its launcher is running — close the game first so Modules folders are not locked.',
    )
  }

  const wantedFolders = new Set(
    profile.mods
      .filter((m) => !isOfficialModule(m.id) && !isOfficialModule(m.folderName))
      .map((m) => m.folderName),
  )

  // First: vault anything currently in Modules that we may park later.
  const existing = fs.readdirSync(modulesDir, { withFileTypes: true })
  let vortexStyle = 0
  for (const entry of existing) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const folder = entry.name
    if (isOfficialModule(folder)) continue
    const full = path.join(modulesDir, folder)
    if (!fs.existsSync(path.join(full, 'SubModule.xml')) && !isJunctionOrSymlink(full)) {
      // Vortex may symlink only SubModule.xml — still a module if the link exists.
      if (!treeHasSymlinks(full)) continue
    }
    try {
      if (treeHasSymlinks(full)) vortexStyle += 1
      if (!isJunctionOrSymlink(full)) {
        ensureInVault(full, folder)
      }
    } catch (err) {
      warnings.push(
        `Could not vault "${folder}": ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  if (vortexStyle > 0) {
    notes.push(
      `Detected ${vortexStyle} Vortex-style symlink module(s) under Modules; copied real files into the vault (no admin symlink privilege required).`,
    )
  }

  // Park mods not in this profile.
  for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const folder = entry.name
    if (isOfficialModule(folder)) continue
    if (wantedFolders.has(folder)) continue
    try {
      parkModuleToVault(modulesDir, folder)
      parked.push(folder)
    } catch (err) {
      warnings.push(
        `Could not park "${folder}": ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // Deploy wanted mods from vault (or leave if already present as real dir — vault it first).
  for (const folder of wantedFolders) {
    const dest = path.join(modulesDir, folder)
    const vaultDir = vaultModulePath(folder)
    try {
      if (fs.existsSync(dest) && !isJunctionOrSymlink(dest)) {
        ensureInVault(dest, folder)
      }
      if (!fs.existsSync(vaultDir)) {
        warnings.push(`Profile wants "${folder}" but it is not in the vault or Modules.`)
        continue
      }
      if (!fs.existsSync(dest)) {
        deployFromVault(modulesDir, folder, mode)
      } else if (!isJunctionOrSymlink(dest) && treeHasSymlinks(dest)) {
        // Replace Vortex symlink forest with a vault junction/copy so the game sees real files
        // and future activates do not re-hit symlink privilege errors.
        rmrf(dest)
        deployFromVault(modulesDir, folder, mode)
      }
      deployed.push(folder)
    } catch (err) {
      warnings.push(
        `Deploy failed for "${folder}": ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  notes.push(
    `Vault deploy (${mode}): ${deployed.length} module(s) present, parked ${parked.length}.`,
  )
  notes.push(`Vault root: ${getVaultPath()}`)
  return { deployed, parked, warnings, notes }
}

/** Snapshot current Modules community mods into the vault (without parking). */
export function importModulesIntoVault(modulesDir: string): {
  imported: string[]
  skipped: string[]
  warnings: string[]
} {
  ensureAppDirs()
  const imported: string[] = []
  const skipped: string[] = []
  const warnings: string[] = []
  if (!fs.existsSync(modulesDir)) return { imported, skipped, warnings }

  for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const folder = entry.name
    if (isOfficialModule(folder)) {
      skipped.push(folder)
      continue
    }
    const full = path.join(modulesDir, folder)
    const hasSub =
      fs.existsSync(path.join(full, 'SubModule.xml')) || isJunctionOrSymlink(full)
    if (!hasSub && !treeHasSymlinks(full)) {
      skipped.push(folder)
      continue
    }
    if (isJunctionOrSymlink(full)) {
      skipped.push(folder)
      continue
    }
    try {
      ensureInVault(full, folder)
      imported.push(folder)
    } catch (err) {
      warnings.push(
        `Import vault failed for "${folder}": ${err instanceof Error ? err.message : String(err)}`,
      )
    }
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
