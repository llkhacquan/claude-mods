import { MAX_CHILDREN, MAX_DEPTH, type Item, type Node, type Op, type Ref, type RefInput, type SplitGroup } from './memory-types.ts'

type Bucket = keyof Item['refs']

export type StoreIO = {
  read(path: string): Promise<string | null>
  write(path: string, data: string): Promise<void>
  list(dir: string): Promise<string[]>
}

export type GroupState = {
  group: string
  nodes: Node[]
  items: Map<string, Item>
  processed: Processed[]
}

export type Processed = { sid: string; from: number; to: number }

export type ApplyContext = { sid: string; date: string; repo?: string }
export type Skipped = { op: Op; reason: string }
export type ApplyResult = { state: GroupState; newRefs: Ref[]; changedItems: Item[]; skipped: Skipped[] }

const ITEM_ID = /^i-(\d+)$/

const paths = (dir: string) => ({
  nodes: `${dir}/nodes.json`,
  items: `${dir}/items.jsonl`,
  refs: `${dir}/refs`,
  processed: `${dir}/processed.jsonl`,
})

const refShard = (dir: string, date: string) => `${paths(dir).refs}/${date.slice(0, 7)}.jsonl`

export const refKey = (r: Pick<Ref, 'item' | 'sid' | 'lines'>): string => `${r.item}|${r.sid}|${r.lines.join(',')}`

export const bucketOf = (r: Pick<Ref, 'by' | 'stance' | 'echo'>): Bucket =>
  r.echo ? 'echo' : r.by === 'agent' ? 'agent' : r.stance === 'against' ? 'against' : 'user'

export const isProcessed = (state: GroupState, sid: string, from: number, to: number): boolean =>
  state.processed.some((p) => p.sid === sid && p.from <= from && to <= p.to)

function parseJsonl<T>(path: string, text: string | null): T[] {
  if (!text) return []
  const out: T[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as T)
    } catch (e) {
      throw new Error(`${path}:${i + 1}: invalid JSON line (${(e as Error).message})`)
    }
  }
  return out
}

export async function loadGroup(io: StoreIO, dir: string): Promise<GroupState> {
  const p = paths(dir)
  const group = dir.replace(/\/+$/, '').split('/').pop() as string
  const nodesText = await io.read(p.nodes)
  let nodes: Node[] = []
  if (nodesText) {
    try {
      nodes = JSON.parse(nodesText) as Node[]
    } catch (e) {
      throw new Error(`${p.nodes}: invalid JSON (${(e as Error).message})`)
    }
  }
  if (!nodes.some((n) => n.id === group)) nodes = [{ id: group, parent: null, title: group }, ...nodes]

  const items = new Map<string, Item>()
  for (const it of parseJsonl<Item>(p.items, await io.read(p.items))) items.set(it.id, it)

  const processed = parseJsonl<Processed>(p.processed, await io.read(p.processed))

  return { group, nodes, items, processed }
}

const jsonl = (rows: unknown[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join('')

// write order: processed line last, so a crash before it leaves the slice unmarked and a retry only adds proof rows
export async function saveGroup(io: StoreIO, dir: string, state: GroupState, newRefs: Ref[], slice?: Processed): Promise<void> {
  const p = paths(dir)
  await io.write(p.items, jsonl([...state.items.values()]))

  const byShard = new Map<string, Ref[]>()
  for (const r of newRefs) {
    const shard = refShard(dir, r.date)
    byShard.set(shard, [...(byShard.get(shard) ?? []), r])
  }
  for (const [shard, rows] of byShard) {
    const old = parseJsonl<Ref>(shard, await io.read(shard))
    const seen = new Set(old.map(refKey))
    const fresh: Ref[] = []
    for (const r of rows) {
      if (seen.has(refKey(r))) continue
      seen.add(refKey(r))
      fresh.push(r)
    }
    if (fresh.length) await io.write(shard, jsonl([...old, ...fresh]))
  }

  await io.write(p.nodes, `${JSON.stringify(state.nodes, null, 2)}\n`)
  if (slice) await io.write(p.processed, jsonl([...state.processed, slice]))
}

export async function loadRefs(io: StoreIO, dir: string, itemId: string): Promise<Ref[]> {
  const out: Ref[] = []
  for (const name of (await io.list(paths(dir).refs)).filter((n) => n.endsWith('.jsonl')).sort()) {
    const shard = `${paths(dir).refs}/${name}`
    out.push(...parseJsonl<Ref>(shard, await io.read(shard)).filter((r) => r.item === itemId))
  }
  return out
}

function nextItemNumber(items: Map<string, Item>): number {
  let max = 0
  for (const id of items.keys()) {
    const m = ITEM_ID.exec(id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

export function applyOps(state: GroupState, ops: Op[], ctx: ApplyContext): ApplyResult {
  const items = new Map(state.items)
  const refKeys = new Set<string>()
  const nodes = [...state.nodes]
  const touched = new Set<string>()
  const newRefs: Ref[] = []
  const skipped: Skipped[] = []
  let counter = nextItemNumber(items)

  const edit = (id: string): Item => {
    const cur = items.get(id) as Item
    if (touched.has(id)) return cur
    const voters = { user: [...cur.voters.user], agent: [...cur.voters.agent], against: [...cur.voters.against], echo: [...cur.voters.echo] }
    const copy: Item = { ...cur, refs: { ...cur.refs }, voters, conflicts_with: [...cur.conflicts_with] }
    items.set(id, copy)
    touched.add(id)
    return copy
  }

  const requireNode = (id: string) => {
    if (!nodes.some((n) => n.id === id)) throw new Error(`unknown node: ${id}`)
  }

  const attach = (item: Item, ref: Omit<Ref, 'item' | 'sid' | 'date'>) => {
    const full: Ref = { item: item.id, sid: ctx.sid, date: ctx.date, ...ref }
    const key = refKey(full)
    if (refKeys.has(key)) return
    refKeys.add(key)
    newRefs.push(full)
    if (ctx.date > item.last) item.last = ctx.date
    if (ctx.repo && !item.repos?.includes(ctx.repo)) item.repos = [...(item.repos ?? []), ctx.repo]
    const bucket = bucketOf(full)
    if (bucket === 'user') item.dead = false
    if (item.voters[bucket].includes(ctx.sid)) return
    item.voters[bucket].push(ctx.sid)
    item.refs[bucket] += 1
  }

  const create = (node: string, text: string, type: Item['type']): Item => {
    const id = `i-${counter++}`
    const item: Item = {
      id,
      node,
      text,
      type,
      refs: { user: 0, agent: 0, against: 0, echo: 0 },
      voters: { user: [], agent: [], against: [], echo: [] },
      first: ctx.date,
      last: ctx.date,
      conflicts_with: [],
      dead: false,
    }
    items.set(id, item)
    touched.add(id)
    return item
  }

  const findLive = (node: string, text: string): Item | undefined => {
    for (const it of items.values()) if (it.node === node && !it.dead && it.text === text) return it
    return undefined
  }

  const link = (a: string, b: string) => {
    const ea = edit(a)
    if (!ea.conflicts_with.includes(b)) ea.conflicts_with.push(b)
    const eb = edit(b)
    if (!eb.conflicts_with.includes(a)) eb.conflicts_with.push(a)
  }

  const skip = (op: Op, reason: string) => skipped.push({ op, reason })
  const support = (ref: RefInput) => ({ ...ref, stance: 'for' as const, echo: false })

  for (const op of ops) {
    switch (op.op) {
      case 'ref': {
        if (!items.has(op.item)) {
          skip(op, `unknown item: ${op.item}`)
          break
        }
        attach(edit(op.item), support(op.ref))
        break
      }
      case 'new': {
        requireNode(op.node)
        const existing = findLive(op.node, op.text)
        if (existing) {
          attach(edit(existing.id), support(op.ref))
          break
        }
        attach(create(op.node, op.text, op.type), support(op.ref))
        break
      }
      case 'new-node': {
        if (nodes.some((n) => n.id === op.id)) break
        requireNode(op.parent)
        nodes.push({ id: op.id, parent: op.parent, title: op.title })
        break
      }
      case 'conflict': {
        if (!items.has(op.with)) {
          skip(op, `unknown item: ${op.with}`)
          break
        }
        requireNode(op.node)
        const item = findLive(op.node, op.text) ?? create(op.node, op.text, op.type)
        if (item.id === op.with) {
          skip(op, 'item cannot conflict with itself')
          break
        }
        attach(edit(item.id), support(op.ref))
        link(item.id, op.with)
        break
      }
      case 'echo': {
        if (op.ref.by === 'user') {
          skip(op, 'a user ref is never an echo')
          break
        }
        if (!items.has(op.item)) {
          skip(op, `unknown item: ${op.item}`)
          break
        }
        attach(edit(op.item), { ...op.ref, stance: 'for', echo: true })
        break
      }
      case 'confirm':
      case 'reject': {
        if (op.ref.by !== 'user') {
          skip(op, `${op.op} needs a user ref`)
          break
        }
        if (!items.has(op.item)) {
          skip(op, `unknown item: ${op.item}`)
          break
        }
        attach(edit(op.item), { ...op.ref, stance: op.op === 'confirm' ? 'for' : 'against', echo: false })
        break
      }
    }
  }

  return {
    state: { group: state.group, nodes, items, processed: state.processed },
    newRefs,
    changedItems: [...touched]
      .map((id) => items.get(id) as Item)
      .filter((it) => JSON.stringify(it) !== JSON.stringify(state.items.get(it.id))),
    skipped,
  }
}

export function depthOf(nodes: Node[], id: string): number {
  const parent = new Map(nodes.map((n) => [n.id, n.parent]))
  let depth = 0
  for (let cur = parent.get(id); cur != null && depth <= nodes.length; cur = parent.get(cur)) depth++
  return depth
}

export function heightOf(nodes: Node[], id: string): number {
  const kids = nodes.filter((n) => n.parent === id)
  return kids.length ? 1 + Math.max(...kids.map((k) => heightOf(nodes, k.id))) : 0
}

export const canSplit = (state: GroupState, node: string): boolean => depthOf(state.nodes, node) < MAX_DEPTH

export type SplitInput = {
  node: string
  items: Item[]
  movable: { node: Node; children: number }[]
  fixed: number
}

export function splitInput(state: GroupState, node: string): SplitInput {
  const groupDepth = depthOf(state.nodes, node) + 1
  const items = [...state.items.values()].filter((it) => it.node === node && !it.dead)
  const movable: SplitInput['movable'] = []
  let fixed = 0
  for (const child of state.nodes.filter((n) => n.parent === node)) {
    if (groupDepth + 1 + heightOf(state.nodes, child.id) > MAX_DEPTH) fixed++
    else movable.push({ node: child, children: state.nodes.filter((n) => n.parent === child.id).length + [...state.items.values()].filter((it) => it.node === child.id && !it.dead).length })
  }
  return { node, items, movable, fixed }
}

export function applySplit(state: GroupState, node: string, groups: SplitGroup[]): { state: GroupState; changedItems: Item[] } {
  const input = splitInput(state, node)
  const itemIds = new Set(input.items.map((it) => it.id))
  const nodeIds = new Set(input.movable.map((m) => m.node.id))
  const owner = new Map<string, string>()
  for (const g of groups) {
    if (state.nodes.some((n) => n.id === g.id)) throw new Error(`node exists: ${g.id}`)
    for (const m of g.members) {
      if (!itemIds.has(m) && !nodeIds.has(m)) throw new Error(`not a movable child of ${node}: ${m}`)
      owner.set(m, g.id)
    }
  }

  const nodes = [...state.nodes.map((n) => (owner.has(n.id) ? { ...n, parent: owner.get(n.id) as string } : n)), ...groups.map((g) => ({ id: g.id, parent: node, title: g.title }))]
  const items = new Map(state.items)
  const changedItems: Item[] = []
  for (const id of itemIds) {
    const to = owner.get(id)
    if (!to) continue
    const moved = { ...(items.get(id) as Item), node: to }
    items.set(id, moved)
    changedItems.push(moved)
  }
  return { state: { ...state, nodes, items }, changedItems }
}

export function nodesOver(state: GroupState, max = MAX_CHILDREN): string[] {
  const counts = new Map<string, number>()
  const bump = (id: string | null) => {
    if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  for (const n of state.nodes) bump(n.parent)
  for (const it of state.items.values()) if (!it.dead) bump(it.node)
  return [...counts].filter(([, c]) => c > max).map(([id]) => id)
}

export function forget(state: GroupState, itemId: string): GroupState {
  const cur = state.items.get(itemId)
  if (!cur) throw new Error(`unknown item: ${itemId}`)
  const items = new Map(state.items)
  items.set(itemId, { ...cur, dead: true })
  return { ...state, items }
}
