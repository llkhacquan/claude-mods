import { describe, expect, test } from 'bun:test'
import type { Item, Node } from './memory-types.ts'
import { buildSplitPrompt, parseSplit } from './split-prompt.ts'
import { applySplit, canSplit, loadGroup, nodesOver, saveGroup, splitInput, type GroupState, type StoreIO } from './store.ts'

const item = (n: number, node = 'payments', dead = false): Item => ({
  id: `i-${n}`,
  node,
  text: `entry ${n}`,
  type: 'rule',
  refs: { user: 1, agent: 0, against: 0, echo: 0 },
  voters: { user: ['s1'], agent: [], against: [], echo: [] },
  first: '2026-01-01',
  last: '2026-01-01',
  conflicts_with: [],
  dead,
})

const state = (items: Item[], extra: Node[] = []): GroupState => ({
  group: 'payments',
  nodes: [{ id: 'payments', parent: null, title: 'payments' }, ...extra],
  items: new Map(items.map((it) => [it.id, it])),
  processed: [],
})

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `i-${from + i}`)
const over = () => state(Array.from({ length: 32 }, (_, i) => item(i + 1)), [{ id: 'payments/ledger', parent: 'payments', title: 'Ledger' }])
const nodeIds = (s: GroupState) => new Set(s.nodes.map((n) => n.id))
const groups = (...gs: { id: string; members: string[] }[]) => JSON.stringify({ groups: gs.map((g) => ({ title: 'T', ...g })) })
const goodSplit = () => groups({ id: 'payments/a', members: range(1, 16) }, { id: 'payments/b', members: [...range(17, 32), 'payments/ledger'] })

describe('buildSplitPrompt', () => {
  test('lists live items and movable nodes, not dead items', () => {
    const s = over()
    s.items.set('i-99', item(99, 'payments', true))
    const { user } = buildSplitPrompt(splitInput(s, 'payments'))
    expect(user).toContain('i-1 | rule | entry 1')
    expect(user).toContain('payments/ledger | Ledger | 0')
    expect(user).toContain('FIXED: 0')
    expect(user).not.toContain('i-99')
  })
})

describe('parseSplit', () => {
  const s = over()
  const input = splitInput(s, 'payments')

  test('accepts a valid split, fenced or not', () => {
    for (const raw of [goodSplit(), `\`\`\`json\n${goodSplit()}\n\`\`\``]) {
      const r = parseSplit(raw, input, nodeIds(s))
      expect('groups' in r && r.groups.map((g) => g.id)).toEqual(['payments/a', 'payments/b'])
    }
  })

  test.each([
    ['garbage', 'no groups here', 'no parsable'],
    ['one group', groups({ id: 'payments/a', members: range(1, 32) }), '1 groups'],
    ['seven groups', groups(...Array.from({ length: 7 }, (_, i) => ({ id: `payments/g${i}`, members: [`i-${i + 1}`] }))), '7 groups'],
    ['existing node id', groups({ id: 'payments/ledger', members: range(1, 16) }, { id: 'payments/b', members: range(17, 32) }), 'already exists'],
    ['duplicate group id', groups({ id: 'payments/a', members: range(1, 16) }, { id: 'payments/a', members: range(17, 32) }), 'already exists'],
    ['unknown member', groups({ id: 'payments/a', members: ['i-500'] }, { id: 'payments/b', members: range(1, 32) }), 'not a movable child'],
    ['member twice', groups({ id: 'payments/a', members: range(1, 16) }, { id: 'payments/b', members: range(16, 32) }), 'in two groups'],
    ['still over max', groups({ id: 'payments/a', members: ['i-1'] }, { id: 'payments/b', members: ['i-2'] }), 'children left'],
  ])('rejects %s', (_n: string, raw: string, want: string) => {
    const r = parseSplit(raw, input, nodeIds(s))
    expect('error' in r && r.error).toContain(want)
  })
})

describe('applySplit', () => {
  test('moves items and nodes, keeps ids, clears nodesOver', () => {
    const s = over()
    const parsed = parseSplit(goodSplit(), splitInput(s, 'payments'), nodeIds(s))
    if (!('groups' in parsed)) throw new Error(parsed.error)
    const r = applySplit(s, 'payments', parsed.groups)
    expect(r.state.items.get('i-1')!.node).toBe('payments/a')
    expect(r.state.items.get('i-32')!.node).toBe('payments/b')
    expect(r.state.nodes.find((n) => n.id === 'payments/ledger')!.parent).toBe('payments/b')
    expect(r.changedItems).toHaveLength(32)
    expect(nodesOver(r.state)).toEqual([])
    expect(s.items.get('i-1')!.node).toBe('payments')
  })

  test('throws on a member that is not a movable child', () => {
    expect(() => applySplit(over(), 'payments', [{ id: 'payments/a', title: 'A', members: ['i-500'] }])).toThrow('not a movable child')
  })

  test('survives save and load', async () => {
    const files = new Map<string, string>()
    const io: StoreIO = { read: async (p) => files.get(p) ?? null, write: async (p, d) => void files.set(p, d), list: async () => [] }
    const r = applySplit(over(), 'payments', [{ id: 'payments/a', title: 'A', members: range(1, 10) }])
    await saveGroup(io, '/mem/payments', r.state, [])
    const back = await loadGroup(io, '/mem/payments')
    expect(back.nodes).toEqual(r.state.nodes)
    expect(back.items.get('i-3')!.node).toBe('payments/a')
  })
})

describe('depth limits', () => {
  const deep: Node[] = [
    { id: 'payments/x', parent: 'payments', title: 'X' },
    { id: 'payments/x/y', parent: 'payments/x', title: 'Y' },
    { id: 'payments/x/y/z', parent: 'payments/x/y', title: 'Z' },
  ]

  test('a node at max depth cannot split', () => {
    const s = state([], deep)
    expect(canSplit(s, 'payments/x/y/z')).toBe(false)
    expect(canSplit(s, 'payments/x/y')).toBe(true)
  })

  test('a child whose subtree would pass max depth stays fixed', () => {
    const input = splitInput(state([], [...deep, { id: 'payments/leaf', parent: 'payments', title: 'Leaf' }]), 'payments')
    expect(input.movable.map((m) => m.node.id)).toEqual(['payments/leaf'])
    expect(input.fixed).toBe(1)
  })
})
