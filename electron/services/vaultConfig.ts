import fs from 'node:fs'
import path from 'node:path'

/** User-facing vault root (contains `modules\`). Default: E:\Modunary */
export const DEFAULT_VAULT_ROOT = 'E:\\Modunary'

let configuredVaultRoot: string | null = null

export function setConfiguredVaultRoot(root: string | null): void {
  const trimmed = typeof root === 'string' ? root.trim() : ''
  configuredVaultRoot = trimmed ? path.normalize(trimmed) : null
}

export function getConfiguredVaultRoot(): string | null {
  return configuredVaultRoot
}

/** Prefer E:\Modunary when E: exists; else caller supplies AppData fallback. */
export function resolveDefaultVaultRoot(appDataVaultFallback: string): string {
  try {
    if (fs.existsSync('E:\\')) return DEFAULT_VAULT_ROOT
  } catch {
    // ignore
  }
  return appDataVaultFallback
}

export function vaultModulesDir(vaultRoot: string): string {
  return path.join(vaultRoot, 'modules')
}

export function legacyAppDataVaultModules(appDataRoot: string): string {
  return path.join(appDataRoot, 'vault', 'modules')
}
