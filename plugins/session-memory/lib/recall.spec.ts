import { describe, expect, test } from 'bun:test'
import type { Item, Node, Ref } from './memory-types.ts'
import { buildL0, itemLine, openNode, refsText, searchItems } from './recall.ts'
import type { GroupState } from './store.ts'

const node = (id: string, parent: string | null, title = id.split('/').pop()!): Node => ({ id, parent, title })
const item = (id: string, nodeId: string, text: string, over: Partial<Item> = {}): Item => ({
  id,
  node: nodeId,
  text,
  type: 'rule',
  refs: { user: 1, agent: 0, against: 0, echo: 0 },
  voters: { user: ['s1'], agent: [], against: [], echo: [] },
  first: '2026-10-01',
  last: '2026-10-01',
  conflicts_with: [],
  dead: false,
  ...over,
})

function state(items: Item[]): GroupState {
  return {
    group: 'be',
    nodes: [node('be', null), node('be/api', 'be'), node('be/api/deploy', 'be/api', 'deploy rules'), node('be/web', 'be')],
    items: new Map(items.map(i => [i.id, i])),
    processed: [],
  }
}

const deploy = item('i-1', 'be/api/deploy', 'deploys need a human go', { refs: { user: 3, agent: 2, against: 0, echo: 1 }, last: '2026-10-30' })
const web = item('i-2', 'be/web', 'the web build caches node_modules', { refs: { user: 9, agent: 0, against: 0, echo: 0 } })
const gone = item('i-3', 'be/api/deploy', 'deploys run on friday', { dead: true })

describe('itemLine', () => {
  test('shows counted refs, who gave them, last day and conflicts', () => {
    expect(itemLine({ ...deploy, conflicts_with: ['i-9'] })).toBe('[i-1] deploys need a human go  refs=5 (you 3, agent 2) last=10-30 [conflict i-9]')
  })
})

describe('buildL0', () => {
  test('puts this repo first, lists topics, and reports the loaded items', () => {
    const l0 = buildL0(state([deploy, web, gone]), 'api', 'Open a topic.')
    const lines = l0.text.split('\n')
    expect(lines[0]).toBe('Open a topic.')
    expect(lines.indexOf(`- ${itemLine(deploy)}`)).toBeLessThan(lines.indexOf(`- ${itemLine(web)}`))
    expect(l0.text).not.toContain('friday')
    expect(lines.slice(-3)).toEqual(['Topics:', '- be/web (1 items, 9 refs, 10-01)', '- be/api/deploy (1 items, 5 refs, 10-30)'])
    expect(l0.loaded).toEqual(['i-1', 'i-2'])
  })

  test('an item referenced from this repo comes first even under another topic', () => {
    const fromApi = { ...web, id: 'i-4', refs: { user: 1, agent: 0, against: 0, echo: 0 }, repos: ['api'] }
    const l0 = buildL0(state([web, fromApi]), 'api', 'Open a topic.')
    expect(l0.loaded).toEqual(['i-4', 'i-2'])
  })

  test('drops the lowest-ranked items to stay under the cap', () => {
    const many = Array.from({ length: 200 }, (_, i) => item(`i-${i + 10}`, 'be/web', `rule number ${i} about caching layers and builds`))
    const l0 = buildL0(state(many), 'api', 'Open a topic.')
    expect(l0.text.length).toBeLessThanOrEqual(4000)
    expect(l0.loaded.length).toBeGreaterThan(20)
    expect(l0.loaded.length).toBeLessThan(200)
    expect(l0.text).toContain('Topics:')
  })
})

describe('openNode', () => {
  test('lists subtopics by parent field and the node own items', () => {
    const s = state([deploy, web])
    expect(openNode(s, 'be/api').text).toBe('be/api: api\nSubtopics:\n- be/api/deploy: deploy rules (1 items, 5 refs)')
    expect(openNode(s, 'be/api/deploy')).toEqual({ text: `be/api/deploy: deploy rules\nItems:\n- ${itemLine(deploy)}`, items: ['i-1'] })
  })

  test('an unknown id lists the valid ids', () => {
    expect(openNode(state([]), 'be/nope').text).toBe('no node be/nope. Nodes: be, be/api, be/api/deploy, be/web')
  })
})

describe('searchItems', () => {
  test('matches item text and topic titles, best score first, skips dead items', () => {
    const s = state([deploy, web, gone])
    expect(searchItems(s, 'deploy rules').items).toEqual(['i-1'])
    expect(searchItems(s, 'node_modules build').items).toEqual(['i-2'])
    expect(searchItems(s, 'friday').text).toBe('no items match "friday"')
  })
})

describe('refsText', () => {
  test('lists each quote with day and who said it', () => {
    const refs: Ref[] = [
      { item: 'i-1', sid: 's1', lines: ['L2'], by: 'user', stance: 'for', date: '2026-10-12', quote: 'wait for a human go', echo: false },
      { item: 'i-1', sid: 's2', lines: ['L9'], by: 'agent', stance: 'for', date: '2026-10-30', quote: 'held the deploy', echo: true },
    ]
    expect(refsText(state([deploy]), 'i-1', refs)).toBe(`${itemLine(deploy)}\n- 2026-10-12 user: "wait for a human go"\n- 2026-10-30 echo: "held the deploy"`)
    expect(refsText(state([gone]), 'i-3', [])).toBe('no item i-3')
  })
})
