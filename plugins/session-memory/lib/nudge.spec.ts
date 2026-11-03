import { describe, expect, test } from 'bun:test'
import type { Item, Node } from './memory-types.ts'
import { jevBody, jevYes, nudgeCandidates, nudgeText } from './nudge.ts'
import type { GroupState } from './store.ts'

const item = (id: string, node: string, text: string, over: Partial<Item> = {}): Item => ({
  id,
  node,
  text,
  type: 'gotcha',
  refs: { user: 1, agent: 0, against: 0, echo: 0 },
  voters: { user: ['old'], agent: [], against: [], echo: [] },
  first: '2026-11-01',
  last: '2026-11-01',
  conflicts_with: [],
  dead: false,
  ...over,
})

const nodes: Node[] = [
  { id: 'be', parent: null, title: 'be' },
  { id: 'be/hsm', parent: 'be', title: 'YubiHSM connector host' },
  { id: 'be/web', parent: 'be', title: 'web build' },
]
const hsm = item('i-1', 'be/hsm', 'GKE pods cannot reach the yubihsm connector on the mac mini over cloudflared')
const web = item('i-2', 'be/web', 'the web build caches node_modules between runs')
const state = (items: Item[]): GroupState => ({ group: 'be', nodes, items: new Map(items.map(i => [i.id, i])), processed: [] }) as unknown as GroupState
const skip = (over: Partial<{ sid: string; topics: Set<string> }> = {}) => ({ sid: 's1', topics: new Set<string>(), ...over })

describe('nudgeCandidates', () => {
  const text = 'Why can the GKE pod not reach the yubihsm connector?'

  test('an item sharing two rare terms is a candidate, one sharing none is not', () => {
    const c = nudgeCandidates(state([hsm, web]), text, skip())
    expect(c.map(x => x.item.id)).toEqual(['i-1'])
    expect(c[0]!.shared).toEqual(expect.arrayContaining(['yubihsm', 'connector']))
  })

  test('one shared term is not enough', () => {
    expect(nudgeCandidates(state([hsm]), 'the connector is down', skip())).toEqual([])
  })

  test('skips dead items, items this session voted on, and topics already nudged or searched', () => {
    expect(nudgeCandidates(state([{ ...hsm, dead: true }]), text, skip())).toEqual([])
    expect(nudgeCandidates(state([{ ...hsm, voters: { user: [], agent: ['s1'], against: [], echo: [] } }]), text, skip())).toEqual([])
    expect(nudgeCandidates(state([hsm]), text, skip({ topics: new Set(['be/hsm']) }))).toEqual([])
  })

  test('a term most items carry does not count as shared', () => {
    const many = Array.from({ length: 9 }, (_, i) => item(`i-${i + 10}`, 'be/web', `connector yubihsm note ${i}`))
    expect(nudgeCandidates(state([hsm, ...many]), 'yubihsm connector', skip())).toEqual([])
  })
})

describe('jev', () => {
  test('the request carries the context and the item text', () => {
    const b = JSON.parse(jevBody('jev-1.13', 'ctx text', hsm))
    expect(b.model).toBe('jev-1.13')
    expect(b.state).toEqual({ context: 'ctx text', memory_item: hsm.text })
    expect(Object.keys(b.questions.v.criteria)).toEqual(['YES', 'NO'])
  })

  test('reads the YES probability, null on anything else', () => {
    expect(jevYes(JSON.stringify({ answers: { v: { choice: 'YES', probabilities: { YES: 0.91, NO: 0.09 } } } }))).toBe(0.91)
    expect(jevYes(JSON.stringify({ error: { message: 'bad key' } }))).toBeNull()
    expect(jevYes('not json')).toBeNull()
  })
})

test('the nudge names the topic, the items and a ready query', () => {
  const text = nudgeText({ item: hsm, shared: ['yubihsm', 'connector'] }, ['i-1', 'i-7'])
  expect(text).toContain('topic be/hsm: i-1, i-7')
  expect(text).toContain('memory_search with "yubihsm connector"')
})
