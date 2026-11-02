import { describe, expect, test } from 'bun:test'
import type { Item, ReconcileContext } from './memory-types.ts'
import { buildPrompt, parseOps } from './reconcile-prompt.ts'

const item = (id: string, node: string, text: string): Item => ({
  id,
  node,
  text,
  type: 'rule',
  refs: { user: 1, agent: 0, against: 0, echo: 0 },
  voters: { user: ['s1'], agent: [], against: [], echo: [] },
  first: '2026-10-01',
  last: '2026-10-02',
  conflicts_with: [],
  dead: false,
})

const ctx: ReconcileContext = {
  group: 'be',
  repo: 'svc',
  nodes: [
    { id: 'be', parent: null, title: 'be' },
    { id: 'be/svc', parent: 'be', title: 'svc' },
    { id: 'be/svc/release', parent: 'be/svc', title: 'release' },
  ],
  candidates: [item('i-1', 'be/svc/release', 'PRs merge only after CI green'), item('i-2', 'be/svc', 'Deploy needs a manual migration')],
  loaded: ['i-2'],
}

const ref = (over: Record<string, unknown> = {}) => ({ lines: ['L3'], by: 'user', stance: 'for', quote: 'merge only when green', ...over })
const wrap = (ops: unknown[]) => JSON.stringify({ ops })

describe('buildPrompt', () => {
  const { system, user } = buildPrompt('[L1] [user] hi', ctx)

  test('lists every candidate id with its text', () => {
    expect(user).toContain('i-1 | be/svc/release | rule | PRs merge only after CI green')
    expect(user).toContain('i-2 | be/svc')
  })

  test('lists every node id with parent and title', () => {
    expect(user).toContain('be/svc/release | be/svc | release')
    expect(user).toContain('be | - | be')
  })

  test('lists loaded ids and the slice text', () => {
    expect(user).toContain('LOADED: i-2')
    expect(user).toContain('[L1] [user] hi')
  })

  test('system prompt names every op kind and demands JSON only', () => {
    for (const k of ['ref', 'new', 'new-node', 'conflict', 'echo', 'confirm', 'reject']) expect(system).toContain(`"op":"${k}"`)
    expect(system).toContain('Output JSON only')
  })

  test('empty context renders placeholders', () => {
    const p = buildPrompt('x', { ...ctx, candidates: [], loaded: [] })
    expect(p.user).toContain('CANDIDATES:\n(none)')
    expect(p.user).toContain('LOADED: (none)')
  })
})

describe('parseOps', () => {
  test('accepts a plain JSON object', () => {
    const r = parseOps(wrap([{ op: 'ref', item: 'i-1', ref: ref() }]), ctx)
    expect(r.errors).toEqual([])
    expect(r.ops).toHaveLength(1)
  })

  test('accepts a json code fence', () => {
    const r = parseOps('```json\n' + wrap([{ op: 'ref', item: 'i-1', ref: ref() }]) + '\n```', ctx)
    expect(r.ops).toHaveLength(1)
  })

  test('accepts leading prose before the object', () => {
    const r = parseOps('Here you go:\n' + wrap([{ op: 'ref', item: 'i-1', ref: ref() }]) + '\nDone.', ctx)
    expect(r.ops).toHaveLength(1)
  })

  test('bad JSON gives an error and no ops without throwing', () => {
    const r = parseOps('{"ops":[{', ctx)
    expect(r.ops).toEqual([])
    expect(r.errors).toHaveLength(1)
  })

  test('a secret the model copies into an item or quote is redacted', () => {
    const r = parseOps(wrap([{ op: 'new', node: 'be/svc', type: 'rule', text: 'staging uses DB_PASSWORD=hunter2hunter2', ref: ref({ quote: 'export API_TOKEN=abcdefghijkl' }) }]), ctx)
    expect(r.ops).toEqual([{ op: 'new', node: 'be/svc', type: 'rule', text: 'staging uses DB_PASSWORD=[redacted]', ref: { lines: ['L3'], by: 'user', stance: 'for', quote: 'export API_TOKEN=[redacted]' } }])
  })

  test('empty ops list is valid and quiet', () => {
    expect(parseOps('{"ops":[]}', ctx)).toEqual({ ops: [], errors: [] })
  })

  test('unknown item id is dropped into errors', () => {
    const r = parseOps(wrap([{ op: 'ref', item: 'i-99', ref: ref() }, { op: 'ref', item: 'i-1', ref: ref() }]), ctx)
    expect(r.ops).toHaveLength(1)
    expect(r.errors[0]).toContain('unknown item i-99')
  })

  test('echo by user is dropped', () => {
    const r = parseOps(wrap([{ op: 'echo', item: 'i-2', ref: ref({ by: 'user' }) }]), ctx)
    expect(r.ops).toEqual([])
    expect(r.errors[0]).toContain('echo by user')
  })

  test('echo by agent on a loaded item is kept', () => {
    const r = parseOps(wrap([{ op: 'echo', item: 'i-2', ref: ref({ by: 'agent' }) }]), ctx)
    expect(r.ops).toHaveLength(1)
  })

  test('agent ref on a loaded item becomes an echo', () => {
    const r = parseOps(wrap([{ op: 'ref', item: 'i-2', ref: ref({ by: 'agent' }) }]), ctx)
    expect(r.ops.map(o => o.op)).toEqual(['echo'])
  })

  test('user ref on a loaded item stays a ref', () => {
    const r = parseOps(wrap([{ op: 'ref', item: 'i-2', ref: ref() }]), ctx)
    expect(r.ops.map(o => o.op)).toEqual(['ref'])
  })

  test('agent ref on an unloaded item stays a ref', () => {
    const r = parseOps(wrap([{ op: 'ref', item: 'i-1', ref: ref({ by: 'agent' }) }]), ctx)
    expect(r.ops.map(o => o.op)).toEqual(['ref'])
  })

  test('system prompt tells the model to generalize and to ref repeats', () => {
    const { system } = buildPrompt('x', ctx)
    expect(system).toContain('never new')
    expect(system).toContain('Drop PR numbers')
    expect(system).toContain('Session-local state')
  })

  test('echo on an item that was not loaded is dropped', () => {
    const r = parseOps(wrap([{ op: 'echo', item: 'i-1', ref: ref({ by: 'agent' }) }]), ctx)
    expect(r.ops).toEqual([])
  })

  test('confirm and reject force stance and need by user', () => {
    const r = parseOps(
      wrap([
        { op: 'confirm', item: 'i-2', ref: ref({ stance: 'against' }) },
        { op: 'reject', item: 'i-2', ref: ref({ stance: 'for' }) },
        { op: 'confirm', item: 'i-2', ref: ref({ by: 'agent' }) },
      ]),
      ctx,
    )
    expect(r.ops.map(o => (o.op === 'confirm' || o.op === 'reject' ? o.ref.stance : null))).toEqual(['for', 'against'])
    expect(r.errors).toHaveLength(1)
  })

  test('new-node then new under it is accepted', () => {
    const r = parseOps(
      wrap([
        { op: 'new-node', parent: 'be/svc', id: 'be/svc/ci', title: 'ci' },
        { op: 'new', node: 'be/svc/ci', text: 'CI runs on push', type: 'state', ref: ref() },
      ]),
      ctx,
    )
    expect(r.errors).toEqual([])
    expect(r.ops.map(o => o.op)).toEqual(['new-node', 'new'])
  })

  test('new under a node that was never created is dropped', () => {
    const r = parseOps(wrap([{ op: 'new', node: 'be/svc/ci', text: 't', type: 'state', ref: ref() }]), ctx)
    expect(r.ops).toEqual([])
    expect(r.errors[0]).toContain('unknown node')
  })

  test('new-node deeper than 3 below the root is dropped', () => {
    const r = parseOps(
      wrap([
        { op: 'new-node', parent: 'be/svc/release', id: 'a', title: 'a' },
        { op: 'new-node', parent: 'a', id: 'b', title: 'b' },
      ]),
      ctx,
    )
    expect(r.ops.map(o => o.op)).toEqual(['new-node'])
    expect(r.errors[0]).toContain('depth')
  })

  test('conflict needs a known item and a valid type', () => {
    const r = parseOps(
      wrap([
        { op: 'conflict', with: 'i-1', node: 'be/svc', text: 'now squash only', type: 'rule', ref: ref() },
        { op: 'conflict', with: 'i-9', node: 'be/svc', text: 'x', type: 'rule', ref: ref() },
        { op: 'conflict', with: 'i-1', node: 'be/svc', text: 'x', type: 'nonsense', ref: ref() },
      ]),
      ctx,
    )
    expect(r.ops).toHaveLength(1)
    expect(r.errors).toHaveLength(2)
  })

  test('ref without lines or quote is dropped', () => {
    const r = parseOps(wrap([{ op: 'ref', item: 'i-1', ref: ref({ lines: [] }) }, { op: 'ref', item: 'i-1', ref: ref({ quote: '' }) }]), ctx)
    expect(r.ops).toEqual([])
    expect(r.errors).toHaveLength(2)
  })

  test('quote is cut to 300 chars', () => {
    const r = parseOps(wrap([{ op: 'ref', item: 'i-1', ref: ref({ quote: 'q'.repeat(500) }) }]), ctx)
    expect((r.ops[0] as { ref: { quote: string } }).ref.quote).toHaveLength(300)
  })

  test('non-object entries and unknown kinds are errors, valid ones survive', () => {
    const r = parseOps(wrap([null, 5, { op: 'wat' }, { op: 'ref', item: 'i-1', ref: ref() }]), ctx)
    expect(r.ops).toHaveLength(1)
    expect(r.errors).toHaveLength(3)
  })
})
