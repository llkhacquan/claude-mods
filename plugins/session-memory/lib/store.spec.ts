import { describe, expect, test } from 'bun:test'
import type { Op, RefInput } from './memory-types.ts'
import { applyOps, forget, isProcessed, loadGroup, loadRefs, nodesOver, saveGroup, type GroupState, type StoreIO } from './store.ts'

const DIR = '/mem/payments'

function fakeIO(): StoreIO & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    read: async (p) => files.get(p) ?? null,
    write: async (p, d) => void files.set(p, d),
    list: async (dir) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)).filter((n) => !n.includes('/')),
  }
}

const rows = (io: { files: Map<string, string> }, path: string) => (io.files.get(path) ?? '').trim().split('\n').filter(Boolean)

const ref = (over: Partial<RefInput> = {}): RefInput => ({ lines: ['L1'], by: 'user', stance: 'for', quote: 'q', ...over })
const ctx = (sid = 's1', date = '2026-01-10') => ({ sid, date })
const newItem = (text = 'ledger writes go through the outbox', over: Partial<RefInput> = {}): Op => ({ op: 'new', node: 'payments', text, type: 'rule', ref: ref(over) })

const empty = () => loadGroup(fakeIO(), DIR)
const bareState = (): GroupState => ({
  group: 'payments',
  nodes: [{ id: 'payments', parent: null, title: 'payments' }],
  items: new Map(),
  processed: [],
})

describe('loadGroup', () => {
  test('creates the root node named after the group dir', async () => {
    const s = await empty()
    expect(s.group).toBe('payments')
    expect(s.nodes).toEqual([{ id: 'payments', parent: null, title: 'payments' }])
    expect(s.items.size).toBe(0)
  })

  test('latest items.jsonl line per id wins', async () => {
    const io = fakeIO()
    const s0 = await loadGroup(io, DIR)
    const { state } = applyOps(s0, [newItem()], ctx())
    await saveGroup(io, DIR, state, [])
    io.files.set(`${DIR}/items.jsonl`, `${io.files.get(`${DIR}/items.jsonl`)}${JSON.stringify({ ...state.items.get('i-1'), text: 'newer' })}\n`)
    const s = await loadGroup(io, DIR)
    expect(s.items.get('i-1')?.text).toBe('newer')
  })

  test('malformed jsonl line throws with path and line', async () => {
    const io = fakeIO()
    io.files.set(`${DIR}/items.jsonl`, '{bad\n')
    await expect(loadGroup(io, DIR)).rejects.toThrow('items.jsonl:1')
  })

  test('loading never reads the refs shards', async () => {
    const io = fakeIO()
    const a = applyOps(await loadGroup(io, DIR), [newItem()], ctx())
    await saveGroup(io, DIR, a.state, a.newRefs)
    io.files.set(`${DIR}/refs/2026-01.jsonl`, '{bad\n')
    expect((await loadGroup(io, DIR)).items.get('i-1')!.refs.user).toBe(1)
  })
})

describe('applyOps single ops', () => {
  test('new creates i-1 under the node with first ref counted', async () => {
    const r = applyOps(await empty(), [newItem()], ctx())
    const it = r.state.items.get('i-1')!
    expect(it).toMatchObject({ node: 'payments', refs: { user: 1, agent: 0, against: 0, echo: 0 }, first: '2026-01-10', last: '2026-01-10', dead: false })
    expect(r.newRefs).toHaveLength(1)
    expect(r.newRefs[0]).toMatchObject({ item: 'i-1', sid: 's1', date: '2026-01-10', echo: false })
    expect(r.changedItems.map((i) => i.id)).toEqual(['i-1'])
  })

  test('new under unknown node throws', async () => {
    expect(() => applyOps(bareState(), [{ ...(newItem() as Extract<Op, { op: 'new' }>), node: 'nope' }], ctx())).toThrow('unknown node: nope')
  })

  test('new uses the next free number', async () => {
    const a = applyOps(await empty(), [newItem('a'), newItem('b')], ctx())
    const b = applyOps(a.state, [newItem('c')], ctx('s2'))
    expect([...b.state.items.keys()]).toEqual(['i-1', 'i-2', 'i-3'])
  })

  test('ref by agent bumps agent only and moves last', async () => {
    const a = applyOps(await empty(), [newItem()], ctx())
    const r = applyOps(a.state, [{ op: 'ref', item: 'i-1', ref: ref({ by: 'agent' }) }], ctx('s2', '2026-02-01'))
    expect(r.state.items.get('i-1')).toMatchObject({ refs: { user: 1, agent: 1, against: 0, echo: 0 }, first: '2026-01-10', last: '2026-02-01' })
  })

  test('records each repo whose session referenced the item, once', async () => {
    const a = applyOps(await empty(), [newItem()], { ...ctx(), repo: 'api' })
    const b = applyOps(a.state, [{ op: 'ref', item: 'i-1', ref: ref() }], { ...ctx('s2'), repo: 'web' })
    const c = applyOps(b.state, [{ op: 'ref', item: 'i-1', ref: ref() }], { ...ctx('s3'), repo: 'api' })
    expect(c.state.items.get('i-1')?.repos).toEqual(['api', 'web'])
    expect(a.state.items.get('i-1')?.repos).toEqual(['api'])
  })

  test('ref to unknown item is skipped with a reason', async () => {
    const r = applyOps(await empty(), [{ op: 'ref', item: 'i-9', ref: ref() }], ctx())
    expect(r.skipped).toHaveLength(1)
    expect(r.newRefs).toEqual([])
  })

  test('new-node adds a child once', async () => {
    const op: Op = { op: 'new-node', parent: 'payments', id: 'payments/ledger', title: 'Ledger' }
    const a = applyOps(await empty(), [op, op], ctx())
    expect(a.state.nodes.filter((n) => n.id === 'payments/ledger')).toEqual([{ id: 'payments/ledger', parent: 'payments', title: 'Ledger' }])
  })

  test('new-node under unknown parent throws', async () => {
    expect(() => applyOps(bareState(), [{ op: 'new-node', parent: 'nope', id: 'x', title: 'X' }], ctx())).toThrow('unknown node: nope')
  })

  test('echo bumps echo only, never user or agent', async () => {
    const a = applyOps(await empty(), [newItem()], ctx())
    const r = applyOps(a.state, [{ op: 'echo', item: 'i-1', ref: ref({ by: 'agent' }) }], ctx('s2'))
    expect(r.state.items.get('i-1')!.refs).toEqual({ user: 1, agent: 0, against: 0, echo: 1 })
    expect(r.newRefs[0].echo).toBe(true)
  })

  test('echo by user is dropped into skipped', async () => {
    const a = applyOps(await empty(), [newItem()], ctx())
    const r = applyOps(a.state, [{ op: 'echo', item: 'i-1', ref: ref({ by: 'user' }) }], ctx('s2'))
    expect(r.skipped).toHaveLength(1)
    expect(r.newRefs).toEqual([])
    expect(r.state.items.get('i-1')!.refs.echo).toBe(0)
  })

  test('confirm adds a for ref and reject adds an against ref', async () => {
    const a = applyOps(await empty(), [newItem()], ctx())
    const c = applyOps(a.state, [{ op: 'confirm', item: 'i-1', ref: ref({ stance: 'against' }) }], ctx('s2'))
    expect(c.newRefs[0].stance).toBe('for')
    expect(c.state.items.get('i-1')!.refs).toMatchObject({ user: 2, against: 0 })
    const r = applyOps(c.state, [{ op: 'reject', item: 'i-1', ref: ref({ stance: 'for' }) }], ctx('s3'))
    expect(r.newRefs[0].stance).toBe('against')
    expect(r.state.items.get('i-1')!.refs).toMatchObject({ user: 2, against: 1 })
  })

  test('confirm and reject by agent are skipped', async () => {
    const a = applyOps(await empty(), [newItem()], ctx())
    const r = applyOps(a.state, [{ op: 'confirm', item: 'i-1', ref: ref({ by: 'agent' }) }, { op: 'reject', item: 'i-1', ref: ref({ by: 'agent' }) }], ctx('s2'))
    expect(r.skipped).toHaveLength(2)
    expect(r.newRefs).toEqual([])
  })

  test('applyOps leaves the input state untouched', async () => {
    const a = applyOps(await empty(), [newItem()], ctx())
    const before = JSON.stringify([...a.state.items.values()])
    applyOps(a.state, [{ op: 'ref', item: 'i-1', ref: ref({ lines: ['L9'] }) }], ctx('s2'))
    expect(JSON.stringify([...a.state.items.values()])).toBe(before)
  })
})

describe('conflict', () => {
  test('creates a new item and links both items', async () => {
    const a = applyOps(await empty(), [newItem('merge needs a human go-ahead')], ctx())
    const r = applyOps(a.state, [{ op: 'conflict', with: 'i-1', node: 'payments', text: 'merge on green CI alone', type: 'rule', ref: ref() }], ctx('s2'))
    expect(r.state.items.get('i-2')!.conflicts_with).toEqual(['i-1'])
    expect(r.state.items.get('i-1')!.conflicts_with).toEqual(['i-2'])
    expect(r.changedItems.map((i) => i.id).sort()).toEqual(['i-1', 'i-2'])
  })

  test('conflict with unknown item is skipped and creates nothing', async () => {
    const r = applyOps(await empty(), [{ op: 'conflict', with: 'i-9', node: 'payments', text: 't', type: 'rule', ref: ref() }], ctx())
    expect(r.skipped).toHaveLength(1)
    expect(r.state.items.size).toBe(0)
  })
})

describe('idempotence', () => {
  const ops: Op[] = [
    { op: 'new-node', parent: 'payments', id: 'payments/ledger', title: 'Ledger' },
    newItem('a'),
    { op: 'conflict', with: 'i-1', node: 'payments', text: 'b', type: 'rule', ref: ref({ lines: ['L2'] }) },
    { op: 'ref', item: 'i-1', ref: ref({ lines: ['L3'] }) },
    { op: 'echo', item: 'i-1', ref: ref({ by: 'agent', lines: ['L4'] }) },
    { op: 'confirm', item: 'i-1', ref: ref({ lines: ['L5'] }) },
    { op: 'reject', item: 'i-2', ref: ref({ lines: ['L6'] }) },
  ]

  test('rerunning the same ops with the same sid changes nothing', async () => {
    const first = applyOps(await empty(), ops, ctx())
    const again = applyOps(first.state, ops, ctx())
    expect(again.changedItems).toEqual([])
    expect(again.state.items.size).toBe(first.state.items.size)
    expect(again.state.nodes).toEqual(first.state.nodes)
    expect(JSON.stringify([...again.state.items.values()])).toBe(JSON.stringify([...first.state.items.values()]))
  })

  test('same ops twice in one call count once', async () => {
    const r = applyOps(await empty(), [newItem(), newItem()], ctx())
    expect(r.state.items.size).toBe(1)
    expect(r.state.items.get('i-1')!.refs.user).toBe(1)
  })

  test('rerun survives a save and load between runs', async () => {
    const io = fakeIO()
    const first = applyOps(await loadGroup(io, DIR), ops, ctx())
    await saveGroup(io, DIR, first.state, first.newRefs)
    const shard = `${DIR}/refs/2026-01.jsonl`
    const before = io.files.get(shard)
    const again = applyOps(await loadGroup(io, DIR), ops, ctx())
    expect(again.changedItems).toEqual([])
    await saveGroup(io, DIR, again.state, again.newRefs)
    expect(io.files.get(shard)).toBe(before)
  })

  test('5 refs from 5 sids end as 1 item with refs.user=5', async () => {
    let s = await empty()
    for (let i = 1; i <= 5; i++) s = applyOps(s, [newItem()], ctx(`s${i}`, `2026-01-0${i}`)).state
    expect(s.items.size).toBe(1)
    expect(s.items.get('i-1')).toMatchObject({ refs: { user: 5 }, first: '2026-01-01', last: '2026-01-05' })
  })
})

describe('votes per session', () => {
  test('same sid citing other lines keeps the proof row but adds no vote', async () => {
    const a = applyOps(await empty(), [newItem()], ctx())
    const r = applyOps(a.state, [{ op: 'ref', item: 'i-1', ref: ref({ lines: ['L7', 'L8'] }) }], ctx())
    expect(r.newRefs).toHaveLength(1)
    expect(r.state.items.get('i-1')!.refs).toEqual({ user: 1, agent: 0, against: 0, echo: 0 })
  })

  test('one sid can vote once in each bucket', async () => {
    const a = applyOps(await empty(), [newItem()], ctx())
    const r = applyOps(
      a.state,
      [
        { op: 'reject', item: 'i-1', ref: ref({ lines: ['L2'] }) },
        { op: 'ref', item: 'i-1', ref: ref({ by: 'agent', lines: ['L3'] }) },
        { op: 'echo', item: 'i-1', ref: ref({ by: 'agent', lines: ['L4'] }) },
        { op: 'ref', item: 'i-1', ref: ref({ by: 'agent', lines: ['L5'] }) },
      ],
      ctx(),
    )
    expect(r.state.items.get('i-1')!.refs).toEqual({ user: 1, agent: 1, against: 1, echo: 1 })
  })

  test('a user ref with stance against on ref, new or conflict is stored as for', async () => {
    const a = applyOps(await empty(), [newItem('a', { stance: 'against' })], ctx())
    const r = applyOps(a.state, [{ op: 'conflict', with: 'i-1', node: 'payments', text: 'b', type: 'rule', ref: ref({ stance: 'against', lines: ['L2'] }) }], ctx('s2'))
    expect([...a.newRefs, ...r.newRefs].map((x) => x.stance)).toEqual(['for', 'for'])
    expect(r.state.items.get('i-2')!.refs).toMatchObject({ user: 1, against: 0 })
  })

  test('votes survive save and load', async () => {
    const io = fakeIO()
    const a = applyOps(await loadGroup(io, DIR), [newItem()], ctx())
    await saveGroup(io, DIR, a.state, a.newRefs)
    const b = applyOps(await loadGroup(io, DIR), [{ op: 'ref', item: 'i-1', ref: ref({ lines: ['L9'] }) }], ctx())
    expect(b.newRefs).toHaveLength(1)
    expect(b.state.items.get('i-1')!.refs.user).toBe(1)
  })
})

describe('processed slices', () => {
  const marked = async () => {
    const io = fakeIO()
    const a = applyOps(await loadGroup(io, DIR), [newItem()], ctx())
    await saveGroup(io, DIR, a.state, a.newRefs, { sid: 's1', from: 10, to: 20 })
    return { io, state: await loadGroup(io, DIR) }
  }

  test.each([
    ['exact range', 's1', 10, 20, true],
    ['range inside', 's1', 12, 18, true],
    ['partial overlap', 's1', 15, 25, false],
    ['range after', 's1', 20, 30, false],
    ['other sid', 's2', 10, 20, false],
  ])('%s', async (_n: string, sid: string, from: number, to: number, want: boolean) => {
    expect(isProcessed((await marked()).state, sid, from, to)).toBe(want)
  })

  test('processed line is written after the tree files', async () => {
    const order: string[] = []
    const io = fakeIO()
    const spy: StoreIO = {
      read: io.read,
      write: async (p, d) => (order.push(p.split('/').pop()!), io.write(p, d)),
      list: io.list,
    }
    const a = applyOps(await loadGroup(io, DIR), [newItem()], ctx())
    await saveGroup(spy, DIR, a.state, a.newRefs, { sid: 's1', from: 0, to: 5 })
    expect(order.at(-1)).toBe('processed.jsonl')
  })

  test('save without a slice writes no processed line', async () => {
    const io = fakeIO()
    const a = applyOps(await loadGroup(io, DIR), [newItem()], ctx())
    await saveGroup(io, DIR, a.state, a.newRefs)
    expect(io.files.has(`${DIR}/processed.jsonl`)).toBe(false)
  })
})

describe('forget and revive', () => {
  const setup = async () => {
    const a = applyOps(await empty(), [newItem()], ctx())
    return forget(a.state, 'i-1')
  }

  test('forget marks the item dead', async () => {
    expect((await setup()).items.get('i-1')!.dead).toBe(true)
  })

  test('forget unknown item throws', async () => {
    expect(() => forget(bareState(), 'i-1')).toThrow('unknown item')
  })

  test.each([
    ['ref', (by: 'user' | 'agent'): Op => ({ op: 'ref', item: 'i-1', ref: ref({ by }) })],
    ['confirm', (by: 'user' | 'agent'): Op => ({ op: 'confirm', item: 'i-1', ref: ref({ by }) })],
  ])('user %s revives a dead item', async (_n: string, mk: (by: 'user' | 'agent') => Op) => {
    const r = applyOps(await setup(), [mk('user')], ctx('s2'))
    expect(r.state.items.get('i-1')!.dead).toBe(false)
  })

  test('agent ref does not revive', async () => {
    const r = applyOps(await setup(), [{ op: 'ref', item: 'i-1', ref: ref({ by: 'agent' }) }], ctx('s2'))
    expect(r.state.items.get('i-1')!.dead).toBe(true)
    expect(r.state.items.get('i-1')!.refs.agent).toBe(1)
  })

  test('a dead item is not matched by a new op with the same text', async () => {
    const r = applyOps(await setup(), [newItem()], ctx('s2'))
    expect(r.state.items.size).toBe(2)
  })
})

describe('saveGroup round trip', () => {
  test('load after save equals the saved state', async () => {
    const io = fakeIO()
    const r = applyOps(
      await loadGroup(io, DIR),
      [{ op: 'new-node', parent: 'payments', id: 'payments/ledger', title: 'Ledger' }, newItem('a'), { op: 'conflict', with: 'i-1', node: 'payments/ledger', text: 'b', type: 'gotcha', ref: ref({ lines: ['L2'] }) }],
      ctx(),
    )
    await saveGroup(io, DIR, r.state, r.newRefs)
    const loaded = await loadGroup(io, DIR)
    expect(loaded).toEqual(r.state)
  })

  test('refs go to one shard per month and items rewrite in full', async () => {
    const io = fakeIO()
    const a = applyOps(await loadGroup(io, DIR), [newItem()], ctx('s1', '2026-01-10'))
    await saveGroup(io, DIR, a.state, a.newRefs)
    const b = applyOps(await loadGroup(io, DIR), [{ op: 'ref', item: 'i-1', ref: ref({ lines: ['L2'] }) }], ctx('s2', '2026-01-20'))
    await saveGroup(io, DIR, b.state, b.newRefs)
    const c = applyOps(await loadGroup(io, DIR), [{ op: 'ref', item: 'i-1', ref: ref({ lines: ['L3'] }) }], ctx('s3', '2026-02-02'))
    await saveGroup(io, DIR, c.state, c.newRefs)
    expect(rows(io, `${DIR}/refs/2026-01.jsonl`)).toHaveLength(2)
    expect(rows(io, `${DIR}/refs/2026-02.jsonl`)).toHaveLength(1)
    expect(rows(io, `${DIR}/items.jsonl`)).toHaveLength(1)
  })

  test('saving the same refs again adds no rows', async () => {
    const io = fakeIO()
    const a = applyOps(await loadGroup(io, DIR), [newItem()], ctx())
    await saveGroup(io, DIR, a.state, a.newRefs)
    const again = applyOps(await loadGroup(io, DIR), [newItem()], ctx())
    await saveGroup(io, DIR, again.state, again.newRefs)
    expect(rows(io, `${DIR}/refs/2026-01.jsonl`)).toHaveLength(1)
    expect(again.state.items.get('i-1')!.refs.user).toBe(1)
  })

  test('loadRefs returns one item rows across shards in month order', async () => {
    const io = fakeIO()
    let s = await loadGroup(io, DIR)
    for (const [sid, date, op] of [
      ['s1', '2026-02-01', newItem('a')],
      ['s2', '2026-01-05', { op: 'ref', item: 'i-1', ref: ref({ lines: ['L4'] }) } as Op],
      ['s3', '2026-01-06', newItem('b')],
    ] as const) {
      const r = applyOps(s, [op], ctx(sid, date))
      await saveGroup(io, DIR, r.state, r.newRefs)
      s = await loadGroup(io, DIR)
    }
    expect((await loadRefs(io, DIR, 'i-1')).map((r) => r.sid)).toEqual(['s2', 's1'])
  })
})

describe('nodesOver', () => {
  const fill = async (n: number) => {
    let s = await empty()
    const ops: Op[] = Array.from({ length: n }, (_, i) => newItem(`item ${i}`))
    s = applyOps(s, ops, ctx()).state
    return s
  }

  test.each([
    [30, []],
    [31, ['payments']],
  ])('%i live items under a node', async (n: number, want: string[]) => {
    expect(nodesOver(await fill(n))).toEqual(want)
  })

  test('child nodes count with live items and dead items do not', async () => {
    let s = await fill(30)
    s = applyOps(s, [{ op: 'new-node', parent: 'payments', id: 'payments/x', title: 'X' }], ctx()).state
    expect(nodesOver(s)).toEqual(['payments'])
    s = forget(s, 'i-1')
    expect(nodesOver(s)).toEqual([])
  })

  test('custom max', async () => {
    expect(nodesOver(await fill(3), 2)).toEqual(['payments'])
  })
})
