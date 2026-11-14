import { safeStorage } from 'electron'
import fs from 'node:fs'
import type { SecretsStatus } from '../types'
import {
  ensureAppDirs,
  getSecretsPath,
  getSecretsPlainFallbackPath,
} from './paths'

export interface AppSecrets {
  nexusApiKey?: string
  nexusAppId?: string
  steamWebApiKey?: string
  moddbUsername?: string
  moddbPassword?: string
}

function encryptionAvailable(): boolean {
  try {
    // Prefer async API when present; fall back for older Electron.
    const anyStore = safeStorage as unknown as {
      isAsyncEncryptionAvailable?: () => boolean
      isEncryptionAvailable?: () => boolean
    }
    if (typeof anyStore.isAsyncEncryptionAvailable === 'function') {
      return Boolean(anyStore.isAsyncEncryptionAvailable())
    }
    if (typeof anyStore.isEncryptionAvailable === 'function') {
      return Boolean(anyStore.isEncryptionAvailable())
    }
  } catch {
    return false
  }
  return false
}

function readRaw(): AppSecrets {
  ensureAppDirs()
  const encPath = getSecretsPath()
  const plainPath = getSecretsPlainFallbackPath()

  try {
    if (fs.existsSync(encPath) && encryptionAvailable()) {
      const buf = fs.readFileSync(encPath)
      const json = safeStorage.decryptString(buf)
      return JSON.parse(json) as AppSecrets
    }
  } catch {
    // fall through
  }

  try {
    if (fs.existsSync(plainPath)) {
      return JSON.parse(fs.readFileSync(plainPath, 'utf8')) as AppSecrets
    }
  } catch {
    // ignore
  }

  return {}
}

function writeRaw(secrets: AppSecrets): void {
  ensureAppDirs()
  const json = JSON.stringify(secrets, null, 2)
  if (encryptionAvailable()) {
    const enc = safeStorage.encryptString(json)
    fs.writeFileSync(getSecretsPath(), enc)
    // Remove plaintext fallback if we upgraded to encrypted.
    const plain = getSecretsPlainFallbackPath()
    if (fs.existsSync(plain)) fs.unlinkSync(plain)
    return
  }
  fs.writeFileSync(getSecretsPlainFallbackPath(), json, 'utf8')
}

export function getSecrets(): AppSecrets {
  const stored = readRaw()
  return {
    nexusApiKey: stored.nexusApiKey || process.env.NEXUS_API_KEY || undefined,
    nexusAppId: stored.nexusAppId || process.env.NEXUS_APP_ID || undefined,
    steamWebApiKey: stored.steamWebApiKey || process.env.STEAM_WEB_API_KEY || undefined,
    moddbUsername: stored.moddbUsername || process.env.MODDB_USERNAME || undefined,
    moddbPassword: stored.moddbPassword || process.env.MODDB_PASSWORD || undefined,
  }
}

export function setSecrets(patch: Partial<AppSecrets>): SecretsStatus {
  const current = readRaw()
  const next: AppSecrets = { ...current }
  for (const [key, value] of Object.entries(patch) as [keyof AppSecrets, string | undefined][]) {
    if (value === undefined) continue
    const trimmed = value.trim()
    if (!trimmed) {
      delete next[key]
    } else {
      next[key] = trimmed
    }
  }
  writeRaw(next)
  return getSecretsStatus()
}

export function getSecretsStatus(): SecretsStatus {
  const s = getSecrets()
  return {
    nexusApiKeySet: Boolean(s.nexusApiKey),
    steamWebApiKeySet: Boolean(s.steamWebApiKey),
    moddbUsernameSet: Boolean(s.moddbUsername),
    moddbPasswordSet: Boolean(s.moddbPassword),
    nexusAppIdSet: Boolean(s.nexusAppId),
    hooks: {
      secretsFile: encryptionAvailable()
        ? getSecretsPath()
        : getSecretsPlainFallbackPath(),
      envNexus: 'NEXUS_API_KEY',
      envSteam: 'STEAM_WEB_API_KEY',
      envModdbUser: 'MODDB_USERNAME',
      envModdbPass: 'MODDB_PASSWORD',
      envNexusAppId: 'NEXUS_APP_ID',
    },
  }
}
