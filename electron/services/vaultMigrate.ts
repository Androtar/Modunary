import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  getAppDataRoot,
  getLegacyVaultModulesPath,
  getVaultPath,
  getVaultRoot,
} from './paths'

const execFileAsync = promisify(execFile)

export type VaultMigrateProgress = (message: string) => void

export interface VaultMigrateResult {
  migrated: boolean
  skipped: boolean
  notes: string[]
  from: string | null
  to: string
}

function dirFolderCount(root: string): number {
  if (!fs.existsSync(root)) return 0
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).length
  } catch {
    return 0
  }
}

async function folderBytes(root: string): Promise<number> {
  let total = 0
  const stack = [root]
  while (stack.length) {
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
      else if (e.isFile()) {
        try {
          total += (await fsp.stat(full)).size
        } catch {
          // ignore
        }
      }
    }
  }
  return total
}

export async function getFreeBytesForPath(targetPath: string): Promise<number | null> {
  try {
    // Node 18.15+ / 20+: statfs
    const st = await (fsp as typeof fsp & {
      statfs?: (p: string) => Promise<{ bavail: number; bsize: number }>
    }).statfs?.(path.parse(targetPath).root)
    if (st) return Number(st.bavail) * Number(st.bsize)
  } catch {
    // fall through
  }
  try {
    const drive = path.parse(targetPath).root.replace(/\\/g, '').replace(':', '')
    if (!drive) return null
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `(Get-PSDrive -Name '${drive}').Free`,
      ],
      { windowsHide: true, encoding: 'utf8', timeout: 8000 },
    )
    const n = Number.parseInt(stdout.trim(), 10)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

export async function assertEnoughSpace(
  targetPath: string,
  needBytes: number,
  label: string,
): Promise<void> {
  const free = await getFreeBytesForPath(targetPath)
  if (free == null) return
  const margin = 512 * 1024 * 1024
  if (free < needBytes + margin) {
    const needGb = (needBytes / 1024 / 1024 / 1024).toFixed(1)
    const freeGb = (free / 1024 / 1024 / 1024).toFixed(1)
    throw new Error(
      `Not enough free space on ${path.parse(targetPath).root} for ${label}: need ~${needGb} GB, free ${freeGb} GB.`,
    )
  }
}

/**
 * Copy legacy %APPDATA%\modunary\vault\modules → current vault modules dir when needed.
 * Cross-volume safe (robocopy). Removes legacy AppData vault after verify.
 */
export async function migrateLegacyVaultIfNeeded(
  onProgress?: VaultMigrateProgress,
): Promise<VaultMigrateResult> {
  const notes: string[] = []
  const legacy = getLegacyVaultModulesPath()
  const dest = getVaultPath()
  const root = getVaultRoot()

  if (!fs.existsSync(legacy)) {
    return { migrated: false, skipped: true, notes: ['No legacy AppData vault to migrate.'], from: null, to: dest }
  }

  const same =
    path.resolve(legacy).toLowerCase() === path.resolve(dest).toLowerCase()
  if (same) {
    return {
      migrated: false,
      skipped: true,
      notes: ['Vault already uses the AppData location.'],
      from: legacy,
      to: dest,
    }
  }

  const legacyCount = dirFolderCount(legacy)
  if (legacyCount === 0) {
    notes.push('Legacy vault folder empty; removing.')
    try {
      await fsp.rm(path.join(getAppDataRoot(), 'vault'), { recursive: true, force: true })
    } catch {
      // ignore
    }
    return { migrated: false, skipped: true, notes, from: legacy, to: dest }
  }

  const destCount = dirFolderCount(dest)
  if (destCount >= legacyCount && destCount > 0) {
    notes.push(
      `Destination already has ${destCount} module folder(s); removing leftover AppData vault.`,
    )
    onProgress?.('Cleaning leftover AppData vault…')
    try {
      await fsp.rm(path.join(getAppDataRoot(), 'vault'), { recursive: true, force: true })
    } catch (err) {
      notes.push(
        `Could not remove AppData vault: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return { migrated: false, skipped: true, notes, from: legacy, to: dest }
  }

  const bytes = await folderBytes(legacy)
  onProgress?.(
    `Checking free space for vault migrate (${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB)…`,
  )
  await assertEnoughSpace(dest, bytes, 'vault migrate')

  await fsp.mkdir(dest, { recursive: true })
  onProgress?.(`Migrating vault ${legacy} → ${dest}…`)

  try {
    await execFileAsync(
      'robocopy',
      [legacy, dest, '/E', '/COPY:DAT', '/R:1', '/W:1', '/MT:8', '/NFL', '/NDL', '/NP'],
      { windowsHide: true, timeout: 60 * 60 * 1000 },
    )
  } catch (err) {
    // robocopy exit codes 0–7 are success; execFile treats non-zero as error
    const code =
      err && typeof err === 'object' && 'code' in err
        ? Number((err as { code?: number }).code)
        : NaN
    if (!Number.isFinite(code) || code >= 8) {
      throw new Error(
        `Vault migrate robocopy failed (${String(err instanceof Error ? err.message : err)}).`,
      )
    }
  }

  const afterCount = dirFolderCount(dest)
  if (afterCount < Math.max(1, Math.floor(legacyCount * 0.9))) {
    throw new Error(
      `Vault migrate verify failed: source had ${legacyCount} folders, dest has ${afterCount}.`,
    )
  }

  onProgress?.('Removing AppData vault to free C:…')
  try {
    await fsp.rm(path.join(getAppDataRoot(), 'vault'), { recursive: true, force: true })
    notes.push(`Removed legacy vault at ${path.join(getAppDataRoot(), 'vault')}`)
  } catch (err) {
    notes.push(
      `Migrated to ${dest}, but could not delete AppData vault: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  notes.push(`Migrated ${afterCount} module folder(s) to ${root} (modules under ${dest}).`)
  return { migrated: true, skipped: false, notes, from: legacy, to: dest }
}
