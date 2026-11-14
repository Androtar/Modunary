/**
 * Live check: run compiled dist steamBusy if present is hard from CJS.
 * Inline the process-hint fix verification + manifest idle expectations.
 */
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

const STEAM_APP_ID = '261550'
const steamapps = 'D:\\Program Files (x86)\\Steam\\steamapps'

function dirHasFiles(root, depth = 0) {
  if (!fs.existsSync(root) || depth > 4) return false
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.isFile()) return true
    if (e.isDirectory() && dirHasFiles(path.join(root, e.name), depth + 1)) return true
  }
  return false
}

async function processHintFixed() {
  const { stdout } = await execFileAsync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(steam|steamwebhelper|steamerrorreporter)\\.exe$' -and $_.CommandLine } | Select-Object -ExpandProperty CommandLine",
    ],
    { windowsHide: true, timeout: 4000, maxBuffer: 2 * 1024 * 1024 },
  )
  const needles = [
    `steam://validate/${STEAM_APP_ID}`,
    `validate/${STEAM_APP_ID}`,
    `downloading\\${STEAM_APP_ID}`,
    `downloading/${STEAM_APP_ID}`,
  ]
  const hits = []
  for (const line of stdout.split(/\r?\n/)) {
    const cmd = line.trim()
    if (!cmd) continue
    if (/powershell|modunary|BannerlordModApp|electron\.exe/i.test(cmd)) continue
    if (needles.some((n) => cmd.toLowerCase().includes(n.toLowerCase()))) hits.push(cmd.slice(0, 120))
  }
  return hits
}

async function main() {
  const acf = path.join(steamapps, 'appmanifest_261550.acf')
  const text = fs.readFileSync(acf, 'utf8')
  const flags = (text.match(/"StateFlags"\s+"(\d+)"/) || [])[1]
  const bytesTo = (text.match(/"BytesToDownload"\s+"(\d+)"/) || [])[1]
  const dl = path.join(steamapps, 'downloading', STEAM_APP_ID)
  const temp = path.join(steamapps, 'temp', STEAM_APP_ID)
  const hits = await processHintFixed()
  const busy =
    flags !== '4' ||
    (Number(bytesTo) > 0) ||
    dirHasFiles(dl) ||
    dirHasFiles(temp) ||
    hits.length > 0
  console.log(
    JSON.stringify(
      {
        StateFlags: flags,
        BytesToDownload: bytesTo,
        downloadingHasFiles: dirHasFiles(dl),
        tempHasFiles: dirHasFiles(temp),
        processHits: hits.length,
        expectBusy: busy,
        expectButtonsEnabled: !busy,
      },
      null,
      2,
    ),
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
