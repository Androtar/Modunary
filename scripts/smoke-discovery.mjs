import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'

const GAME_FOLDER = 'Mount & Blade II Bannerlord'

function readSteamPath() {
  try {
    const out = execSync('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath', {
      encoding: 'utf8',
    })
    const match = out.match(/SteamPath\s+REG_SZ\s+(.+)/i)
    return match ? match[1].trim().replace(/\//g, '\\') : null
  } catch {
    return null
  }
}

function parseLibs(steamRoot) {
  const vdfPath = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf')
  const libs = new Set([steamRoot])
  if (!fs.existsSync(vdfPath)) return [...libs]
  const text = fs.readFileSync(vdfPath, 'utf8')
  for (const match of text.matchAll(/"path"\s+"([^"]+)"/g)) {
    libs.add(match[1].replace(/\\\\/g, '\\'))
  }
  return [...libs]
}

const candidates = []
const reg = readSteamPath()
if (reg) candidates.push(reg)
candidates.push(
  'C:\\Program Files (x86)\\Steam',
  'D:\\SteamLibrary',
  'E:\\SteamLibrary',
)

const roots = new Set()
for (const c of candidates) {
  if (c && fs.existsSync(c)) {
    for (const lib of parseLibs(c)) {
      if (fs.existsSync(lib)) roots.add(lib)
    }
  }
}

let install = null
for (const lib of roots) {
  const cand = path.join(lib, 'steamapps', 'common', GAME_FOLDER)
  if (fs.existsSync(cand) && fs.existsSync(path.join(cand, 'Modules'))) {
    install = cand
    break
  }
}

const docs = path.join(os.homedir(), 'Documents', 'Mount and Blade II Bannerlord')
const modules = install ? path.join(install, 'Modules') : null
const launcher = path.join(docs, 'Configs', 'LauncherData.xml')
const modCount =
  modules && fs.existsSync(modules)
    ? fs
        .readdirSync(modules, { withFileTypes: true })
        .filter(
          (d) =>
            d.isDirectory() &&
            fs.existsSync(path.join(modules, d.name, 'SubModule.xml')),
        ).length
    : 0

console.log(
  JSON.stringify(
    {
      steamReg: reg,
      libraries: [...roots],
      install,
      modules,
      docsExists: fs.existsSync(docs),
      launcherExists: fs.existsSync(launcher),
      modCount,
    },
    null,
    2,
  ),
)
