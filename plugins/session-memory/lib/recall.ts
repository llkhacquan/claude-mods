import type { Item, Node, Ref } from './memory-types.ts'
import type { GroupState } from './store.ts'

export const DESCRIPTION_CAP = 4000
export const SEARCH_MAX = 20
export const TOPICS_MAX = 15

const HEADER = (group: string) =>
  `Session memory for group ${group}: decisions, rules, root causes and gotchas mined from past sessions. ` +
  'Item lines: [id] text  refs=N (you N, agent N) last=MM-DD. Before answering about past work, setup or a decision, ' +
  'call memory_search with key words, or memory_open on a topic below; memory_refs shows the quotes behind an item.'

const day = (date: string) => date.slice(5)
const counted = (it: Item) => it.refs.user + it.refs.agent

export function itemLine(it: Item): string {
  const conflicts = it.conflicts_with.length ? ` [conflict ${it.conflicts_with.join(', ')}]` : ''
  return `[${it.id}] ${it.text}  refs=${counted(it)} (you ${it.refs.user}, agent ${it.refs.agent}) last=${day(it.last)}${conflicts}`
}

const live = (state: GroupState) => [...state.items.values()].filter(it => !it.dead)
const rank = (a: Item, b: Item) => counted(b) - counted(a) || b.last.localeCompare(a.last)

function ancestors(nodes: Node[], id: string): Node[] {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const out: Node[] = []
  for (let n = byId.get(id); n && out.length <= nodes.length; n = n.parent ? byId.get(n.parent) : undefined) out.push(n)
  return out
}

const inRepo = (nodes: Node[], it: Item, repo: string) =>
  !!repo && (!!it.repos?.includes(repo) || ancestors(nodes, it.node).some(n => n.title === repo || n.id.split('/').pop() === repo))

function topicLines(state: GroupState): string[] {
  const stats = new Map<string, { items: number; refs: number; last: string }>()
  for (const it of live(state)) {
    const s = stats.get(it.node) ?? { items: 0, refs: 0, last: '' }
    stats.set(it.node, { items: s.items + 1, refs: s.refs + counted(it), last: it.last > s.last ? it.last : s.last })
  }
  return [...stats]
    .sort((a, b) => b[1].refs - a[1].refs || b[1].last.localeCompare(a[1].last))
    .slice(0, TOPICS_MAX)
    .map(([id, s]) => `- ${id} (${s.items} items, ${s.refs} refs, ${day(s.last)})`)
}

export function buildL0(state: GroupState, repo: string, intro: string, cap = DESCRIPTION_CAP): { text: string; loaded: string[] } {
  const items = live(state).sort((a, b) => Number(inRepo(state.nodes, b, repo)) - Number(inRepo(state.nodes, a, repo)) || rank(a, b))
  const topics = topicLines(state)
  const head = [intro, HEADER(state.group), items.length ? `Top items${repo ? ` (${repo} first)` : ''}:` : 'No items yet.']
  const tail = topics.length ? ['Topics:', ...topics] : []
  const lines: string[] = []
  const loaded: string[] = []
  let size = [...head, ...tail].join('\n').length
  for (const it of items) {
    const line = `- ${itemLine(it)}`
    if (size + line.length + 1 > cap) break
    lines.push(line)
    loaded.push(it.id)
    size += line.length + 1
  }
  return { text: [...head, ...lines, ...tail].join('\n'), loaded }
}

export function openNode(state: GroupState, id: string): { text: string; items: string[] } {
  const node = state.nodes.find(n => n.id === id)
  if (!node) return { text: `no node ${id}. Nodes: ${state.nodes.map(n => n.id).join(', ')}`, items: [] }
  const children = state.nodes.filter(n => n.parent === id)
  const items = live(state).filter(it => it.node === id).sort(rank)
  const kids = children.map(c => {
    const own = live(state).filter(it => it.node === c.id)
    return `- ${c.id}: ${c.title} (${own.length} items, ${own.reduce((n, it) => n + counted(it), 0)} refs)`
  })
  const parts = [`${node.id}: ${node.title}`]
  if (kids.length) parts.push('Subtopics:', ...kids)
  if (items.length) parts.push('Items:', ...items.map(it => `- ${itemLine(it)}`))
  if (!kids.length && !items.length) parts.push('Empty.')
  return { text: parts.join('\n'), items: items.map(it => it.id) }
}

const terms = (q: string) => [...new Set(q.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu) ?? [])].filter(t => t.length >= 2)

export function searchItems(state: GroupState, query: string, max = SEARCH_MAX): { text: string; items: string[] } {
  const qs = terms(query)
  if (!qs.length) return { text: 'empty query', items: [] }
  const titles = new Map(state.nodes.map(n => [n.id, `${n.id} ${n.title}`.toLowerCase()]))
  const hits = live(state)
    .map(it => {
      const hay = `${it.text} ${titles.get(it.node) ?? it.node}`.toLowerCase()
      return { it, score: qs.filter(q => hay.includes(q)).length }
    })
    .filter(h => h.score > 0)
    .sort((a, b) => b.score - a.score || rank(a.it, b.it))
    .slice(0, max)
  if (!hits.length) return { text: `no items match "${query}"`, items: [] }
  return { text: hits.map(h => `- ${h.it.node} ${itemLine(h.it)}`).join('\n'), items: hits.map(h => h.it.id) }
}

export function refsText(state: GroupState, id: string, refs: Ref[]): string {
  const it = state.items.get(id)
  if (!it || it.dead) return `no item ${id}`
  const rows = refs.map(r => `- ${r.date} ${r.echo ? 'echo' : r.by}${r.stance === 'against' ? ' against' : ''}: "${r.quote}"`)
  return [itemLine(it), ...(rows.length ? rows : ['no refs'])].join('\n')
}
