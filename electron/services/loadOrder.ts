import fs from 'node:fs'
import path from 'node:path'
import { XMLParser } from 'fast-xml-parser'
import { OFFICIAL_MODULE_IDS, type ModEntry } from '../types'

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) =>
    ['DependedModule', 'DependedModuleMetadata', 'ModuleCategory'].includes(name),
})

const OFFICIAL_ORDER = [...OFFICIAL_MODULE_IDS]

export interface ModuleDependencyInfo {
  id: string
  folderName: string
  name: string
  dependsOn: string[]
  /** Modules that must load before this one (from DependedModuleMetadata order=LoadBeforeThis). */
  loadBeforeThis: string[]
  /** Modules that must load after this one. */
  loadAfterThis: string[]
}

function attrOrText(node: unknown): string {
  if (node == null) return ''
  if (typeof node === 'object' && node !== null && '@_value' in node) {
    return String((node as { '@_value'?: string })['@_value'] ?? '')
  }
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node === 'object' && node !== null && '#text' in node) {
    return String((node as { '#text': string })['#text'] ?? '')
  }
  return ''
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

export function parseModuleDependencies(subModulePath: string): ModuleDependencyInfo | null {
  try {
    const raw = fs.readFileSync(subModulePath, 'utf8')
    const doc = xmlParser.parse(raw)
    const root = doc?.ModuleInfo ?? doc?.Module ?? doc
    if (!root) return null
    const id = attrOrText(root.Id) || attrOrText(root.Name)
    const name = attrOrText(root.Name) || id
    if (!id) return null

    const dependsOn: string[] = []
    for (const dep of asArray(root.DependedModules?.DependedModule)) {
      const depId =
        attrOrText(dep) ||
        (typeof dep === 'object' && dep ? attrOrText((dep as { Id?: unknown }).Id) : '') ||
        (typeof dep === 'object' && dep && '@_Id' in dep
          ? String((dep as { '@_Id': string })['@_Id'])
          : '')
      // Attribute form: <DependedModule Id="X" />
      const fromAttr =
        typeof dep === 'object' && dep && '@_Id' in dep
          ? String((dep as { '@_Id': string })['@_Id'])
          : ''
      const resolved = fromAttr || depId
      if (resolved) dependsOn.push(resolved)
    }

    const loadBeforeThis: string[] = []
    const loadAfterThis: string[] = []
    for (const meta of asArray(root.DependedModuleMetadatas?.DependedModuleMetadata)) {
      if (!meta || typeof meta !== 'object') continue
      const mid =
        '@_id' in meta
          ? String((meta as { '@_id': string })['@_id'])
          : attrOrText((meta as { id?: unknown }).id)
      const order =
        '@_order' in meta
          ? String((meta as { '@_order': string })['@_order'])
          : attrOrText((meta as { order?: unknown }).order)
      if (!mid) continue
      if (/LoadBeforeThis/i.test(order)) loadBeforeThis.push(mid)
      if (/LoadAfterThis/i.test(order)) loadAfterThis.push(mid)
    }

    return {
      id,
      folderName: path.basename(path.dirname(subModulePath)),
      name,
      dependsOn,
      loadBeforeThis,
      loadAfterThis,
    }
  } catch {
    return null
  }
}

export function scanModuleDependencies(
  modulesDir: string | null,
  mods: ModEntry[],
): ModuleDependencyInfo[] {
  const byId = new Map<string, ModuleDependencyInfo>()

  if (modulesDir && fs.existsSync(modulesDir)) {
    for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const sub = path.join(modulesDir, entry.name, 'SubModule.xml')
      if (!fs.existsSync(sub)) continue
      const info = parseModuleDependencies(sub)
      if (info) byId.set(info.id, info)
    }
  }

  // Ensure profile mods appear even if not currently deployed.
  for (const m of mods) {
    if (byId.has(m.id)) continue
    const candidateDirs = [
      modulesDir ? path.join(modulesDir, m.folderName, 'SubModule.xml') : null,
    ].filter(Boolean) as string[]
    let found: ModuleDependencyInfo | null = null
    for (const sub of candidateDirs) {
      if (fs.existsSync(sub)) {
        found = parseModuleDependencies(sub)
        break
      }
    }
    byId.set(
      m.id,
      found || {
        id: m.id,
        folderName: m.folderName,
        name: m.name,
        dependsOn: [],
        loadBeforeThis: [],
        loadAfterThis: [],
      },
    )
  }

  return [...byId.values()]
}

/**
 * Topological load order: official modules in TW order first, then community mods
 * respecting DependedModules / LoadBeforeThis / LoadAfterThis.
 */
export function computeLoadOrder(
  mods: ModEntry[],
  deps: ModuleDependencyInfo[],
): { orderedIds: string[]; warnings: string[]; notes: string[] } {
  const warnings: string[] = []
  const notes: string[] = [
    'Order uses SubModule DependedModules + DependedModuleMetadata (LoadBeforeThis / LoadAfterThis).',
    'Official modules are pinned to TaleWorlds’ usual sequence when present.',
  ]

  const depById = new Map(deps.map((d) => [d.id, d]))
  const ids = mods.map((m) => m.id)
  const idSet = new Set(ids)

  // Edge: A -> B means A must come before B.
  const before = new Map<string, Set<string>>()
  const ensure = (id: string) => {
    if (!before.has(id)) before.set(id, new Set())
  }
  for (const id of ids) ensure(id)

  const addEdge = (earlier: string, later: string) => {
    if (!idSet.has(earlier) || !idSet.has(later) || earlier === later) return
    ensure(earlier)
    ensure(later)
    before.get(later)!.add(earlier)
  }

  // Official relative order
  for (let i = 0; i < OFFICIAL_ORDER.length; i++) {
    for (let j = i + 1; j < OFFICIAL_ORDER.length; j++) {
      addEdge(OFFICIAL_ORDER[i], OFFICIAL_ORDER[j])
    }
  }

  for (const info of deps) {
    if (!idSet.has(info.id)) continue
    for (const d of info.dependsOn) addEdge(d, info.id)
    for (const d of info.loadBeforeThis) addEdge(d, info.id)
    for (const d of info.loadAfterThis) addEdge(info.id, d)
  }

  // Kahn topological sort; missing deps warn but don't block.
  const indeg = new Map<string, number>()
  for (const id of ids) indeg.set(id, 0)
  for (const [later, earlierSet] of before) {
    for (const earlier of earlierSet) {
      if (!idSet.has(earlier)) {
        warnings.push(`Missing dependency "${earlier}" required before "${later}".`)
        continue
      }
      indeg.set(later, (indeg.get(later) || 0) + 1)
    }
  }

  const ready = ids
    .filter((id) => (indeg.get(id) || 0) === 0)
    .sort((a, b) => {
      const oa = OFFICIAL_ORDER.indexOf(a as (typeof OFFICIAL_ORDER)[number])
      const ob = OFFICIAL_ORDER.indexOf(b as (typeof OFFICIAL_ORDER)[number])
      if (oa >= 0 || ob >= 0) return (oa >= 0 ? oa : 999) - (ob >= 0 ? ob : 999)
      const na = depById.get(a)?.name || a
      const nb = depById.get(b)?.name || b
      return na.localeCompare(nb)
    })

  const ordered: string[] = []
  while (ready.length) {
    const id = ready.shift()!
    ordered.push(id)
    for (const [later, earlierSet] of before) {
      if (!earlierSet.has(id)) continue
      earlierSet.delete(id)
      indeg.set(later, (indeg.get(later) || 1) - 1)
      if (indeg.get(later) === 0) {
        ready.push(later)
        ready.sort((a, b) => {
          const oa = OFFICIAL_ORDER.indexOf(a as (typeof OFFICIAL_ORDER)[number])
          const ob = OFFICIAL_ORDER.indexOf(b as (typeof OFFICIAL_ORDER)[number])
          if (oa >= 0 || ob >= 0) return (oa >= 0 ? oa : 999) - (ob >= 0 ? ob : 999)
          return (depById.get(a)?.name || a).localeCompare(depById.get(b)?.name || b)
        })
      }
    }
  }

  if (ordered.length < ids.length) {
    const leftover = ids.filter((id) => !ordered.includes(id))
    warnings.push(
      `Dependency cycle or unresolved order for: ${leftover.join(', ')}. Appended at end.`,
    )
    ordered.push(...leftover)
  }

  notes.push(`Sorted ${ordered.length} module(s).`)
  return { orderedIds: ordered, warnings, notes }
}
