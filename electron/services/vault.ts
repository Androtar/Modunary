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

function rmrf(target: string): void {
  if (!fs.existsSync(target)) return
  fs.rmSync(target, { recursive: true, force: true })
}

function copyDir(src: string, dest: string): void {
  fs.cpSync(src, dest, { recursive: true, force: true })
}

function isJunctionOrSymlink(target: string): boolean {
  try {
    const st = fs.lstatSync(target)
    return st.isSymbolicLink()
  } catch {
    return false
  }
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
  // Windows directory junction — no admin required.
  execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, targetPath], {
    windowsHide: true,
    stdio: 'ignore',
  })
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
      // Fallback to copy if junction fails (e.g. cross-volume issues are rare for junctions).
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
    // Junction: vault already has content; just unlink.
    fs.rmSync(src, { force: true })
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

  const wantedFolders = new Set(
    profile.mods
      .filter((m) => !isOfficialModule(m.id) && !isOfficialModule(m.folderName))
      .map((m) => m.folderName),
  )

  // First: vault anything currently in Modules that we may park later.
  const existing = fs.readdirSync(modulesDir, { withFileTypes: true })
  for (const entry of existing) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const folder = entry.name
    if (isOfficialModule(folder)) continue
    const full = path.join(modulesDir, folder)
    if (!fs.existsSync(path.join(full, 'SubModule.xml')) && !isJunctionOrSymlink(full)) {
      continue
    }
    try {
      if (!isJunctionOrSymlink(full)) {
        ensureInVault(full, folder)
      }
    } catch (err) {
      warnings.push(
        `Could not vault "${folder}": ${err instanceof Error ? err.message : String(err)}`,
      )
    }
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
export function importModulesIntoVault(modulesDir: string): { imported: string[]; skipped: string[] } {
  ensureAppDirs()
  const imported: string[] = []
  const skipped: string[] = []
  if (!fs.existsSync(modulesDir)) return { imported, skipped }

  for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const folder = entry.name
    if (isOfficialModule(folder)) {
      skipped.push(folder)
      continue
    }
    const full = path.join(modulesDir, folder)
    if (!fs.existsSync(path.join(full, 'SubModule.xml'))) {
      skipped.push(folder)
      continue
    }
    if (isJunctionOrSymlink(full)) {
      skipped.push(folder)
      continue
    }
    ensureInVault(full, folder)
    imported.push(folder)
  }
  return { imported, skipped }
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
