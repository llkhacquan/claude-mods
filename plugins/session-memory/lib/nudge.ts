import type { Item } from './memory-types.ts'
import { redact } from './slicer.ts'
import type { GroupState } from './store.ts'

export const JEV_URL = 'https://openrouter.ai/api/v1/systemone'
const MIN_SHARED = 2
const MAX_DF = 8
const MAX_CANDIDATES = 3
const CONTEXT_MAX = 3000

const STOP = new Set(
  'this that with from have will been were what when where which there their them they then than into also just only some more most such each other about after before because while should would could does done make made need want like using used uses true false null none file files line lines code test tests text item items node nodes user users agent session sessions claude model run runs call calls time first last next same still back'.split(' '),
)

export const nudgeTerms = (s: string): Set<string> =>
  new Set((s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._/-]*[\p{L}\p{N}]/gu) ?? []).filter(t => t.length >= 4 && !/^\d+$/.test(t) && !STOP.has(t)))

export type Candidate = { item: Item; shared: string[] }
export type NudgeSkip = { sid: string; topics: Set<string> }

export function nudgeCandidates(state: GroupState, text: string, skip: NudgeSkip): Candidate[] {
  const live = [...state.items.values()].filter(it => !it.dead)
  const titles = new Map(state.nodes.map(n => [n.id, n.title]))
  const termsOf = new Map(live.map(it => [it.id, nudgeTerms(`${it.text} ${titles.get(it.node) ?? ''}`)]))
  const df = new Map<string, number>()
  for (const ts of termsOf.values()) for (const t of ts) df.set(t, (df.get(t) ?? 0) + 1)
  const seen = nudgeTerms(text)
  const out: Candidate[] = []
  for (const it of live) {
    if (skip.topics.has(it.node) || Object.values(it.voters).some(v => v.includes(skip.sid))) continue
    const shared = [...(termsOf.get(it.id) ?? [])].filter(t => seen.has(t) && (df.get(t) ?? 0) <= MAX_DF)
    if (shared.length >= MIN_SHARED) out.push({ item: it, shared })
  }
  return out.sort((a, b) => b.shared.length - a.shared.length).slice(0, MAX_CANDIDATES)
}

export function jevBody(model: string, context: string, item: Item): string {
  return JSON.stringify({
    model,
    state: { context: redact(context).slice(0, CONTEXT_MAX), memory_item: item.text },
    questions: {
      v: {
        type: 'choice',
        instructions: 'An AI coding assistant just wrote or received `context`. `memory_item` is a note saved from an earlier session. Should the assistant be told to look this note up now?',
        criteria: {
          YES: 'the note is about the same specific system, decision, bug or task the context is working on, so it could change or inform the next step',
          NO: 'the note only shares some words, or is about a different system or task',
        },
      },
    },
  })
}

export function jevYes(body: string): number | null {
  try {
    const p = (JSON.parse(body) as { answers?: { v?: { probabilities?: { YES?: unknown } } } }).answers?.v?.probabilities?.YES
    return typeof p === 'number' ? p : null
  } catch {
    return null
  }
}

export function nudgeText(c: Candidate, ids: string[]): string {
  return `session-memory: earlier sessions saved notes that look relevant here (topic ${c.item.node}: ${ids.join(', ')}). Call memory_search with "${c.shared.slice(0, 4).join(' ')}" before you go on.`
}
