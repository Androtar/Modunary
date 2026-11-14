import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const t0 = Date.now()
try {
  const out = execSync('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath', {
    encoding: 'utf8',
    timeout: 5000,
  })
  console.log('reg_ms', Date.now() - t0, out.trim().slice(0, 120))
} catch (e) {
  console.log('reg_err', e instanceof Error ? e.message : e)
}

const modules =
  'D:\\Program Files (x86)\\Steam\\steamapps\\common\\Mount & Blade II Bannerlord\\Modules'
const t1 = Date.now()
let n = 0
if (fs.existsSync(modules)) {
  for (const d of fs.readdirSync(modules, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const sub = path.join(modules, d.name, 'SubModule.xml')
    if (fs.existsSync(sub)) {
      fs.readFileSync(sub, 'utf8')
      n++
    }
  }
}
console.log('mods_read', n, 'ms', Date.now() - t1)

const store = path.join(os.homedir(), 'AppData', 'Roaming', 'bannerlord-mod-profiles', 'store.json')
console.log('store_exists', fs.existsSync(store), store)
if (fs.existsSync(store)) console.log('store_bytes', fs.statSync(store).size)

const preload = 'E:\\BannerlordModApp\\dist-electron\\preload.mjs'
console.log('preload_exists', fs.existsSync(preload))
if (fs.existsSync(preload)) {
  console.log('preload_head', fs.readFileSync(preload, 'utf8').slice(0, 200))
}
