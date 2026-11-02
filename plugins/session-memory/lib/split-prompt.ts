import { MAX_CHILDREN, type SplitGroup } from './memory-types.ts'
import type { SplitInput } from './store.ts'

const MIN_GROUPS = 2
const MAX_GROUPS = 6

const SYSTEM = `You keep a memory topic tree readable. One topic has too many direct children. Group them into ${MIN_GROUPS}-${MAX_GROUPS} sub-topics by meaning.

The user message gives the topic and its movable children:
- NODES: child topics, one per line as "id | title | <number of entries inside>".
- ITEMS: memory entries, one per line as "id | type | text".

Rules:
- Never more than ${MAX_GROUPS} sub-topics. If you find more themes, merge the closest ones until ${MAX_GROUPS} or fewer remain. A sub-topic may hold more than ${MAX_CHILDREN} children; it is split again later.
- Each sub-topic gets a short title (2-4 words) and an id "<topic id>/<slug>" with a lowercase slug.
- A child goes into at most one sub-topic. Children you do not list stay directly under the topic. Do not make an "other" or "misc" sub-topic; leave such children unlisted.
- After grouping, the topic may keep at most ${MAX_CHILDREN} direct children in total: sub-topics + unlisted children + FIXED.
- Use only ids from NODES and ITEMS.

Output JSON only, no prose, no code fence: {"groups":[{"id":"...","title":"...","members":["<id>", ...]}]}`

export function buildSplitPrompt(input: SplitInput): { system: string; user: string } {
  const nodes = input.movable.map((m) => `${m.node.id} | ${m.node.title} | ${m.children}`).join('\n') || '(none)'
  const items = input.items.map((it) => `${it.id} | ${it.type} | ${it.text.replace(/\s+/g, ' ').trim()}`).join('\n') || '(none)'
  return { system: SYSTEM, user: `TOPIC: ${input.node}\nFIXED: ${input.fixed}\n\nNODES:\n${nodes}\n\nITEMS:\n${items}` }
}

export function parseSplit(raw: string, input: SplitInput, nodeIds: Set<string>): { groups: SplitGroup[] } | { error: string } {
  const list = extractGroups(raw)
  if (!list) return { error: 'no parsable {"groups":[...]} JSON in model output' }
  if (list.length < MIN_GROUPS || list.length > MAX_GROUPS) return { error: `${list.length} groups, want ${MIN_GROUPS}-${MAX_GROUPS}` }

  const children = new Set([...input.items.map((it) => it.id), ...input.movable.map((m) => m.node.id)])
  const seenIds = new Set<string>()
  const taken = new Set<string>()
  const groups: SplitGroup[] = []

  for (const [i, g] of list.entries()) {
    if (typeof g !== 'object' || g === null) return { error: `group ${i}: not an object` }
    const { id, title, members } = g as Record<string, unknown>
    if (typeof id !== 'string' || !id.trim()) return { error: `group ${i}: missing id` }
    if (nodeIds.has(id) || seenIds.has(id)) return { error: `group ${i}: node id ${id} already exists` }
    if (typeof title !== 'string' || !title.trim()) return { error: `group ${i}: missing title` }
    if (!Array.isArray(members) || members.length === 0) return { error: `group ${i}: no members` }
    for (const m of members) {
      if (typeof m !== 'string' || !children.has(m)) return { error: `group ${i}: ${String(m)} is not a movable child of ${input.node}` }
      if (taken.has(m)) return { error: `group ${i}: ${m} is in two groups` }
      taken.add(m)
    }
    seenIds.add(id)
    groups.push({ id, title: title.trim(), members: members as string[] })
  }

  const left = groups.length + (children.size - taken.size) + input.fixed
  if (left > MAX_CHILDREN) return { error: `${left} children left under ${input.node}, max ${MAX_CHILDREN}` }
  return { groups }
}

function extractGroups(raw: string): unknown[] | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  const tries = [fence?.[1], raw, first >= 0 && last > first ? raw.slice(first, last + 1) : undefined]
  for (const t of tries) {
    if (!t) continue
    try {
      const v = JSON.parse(t.trim())
      if (v && Array.isArray(v.groups)) return v.groups
    } catch {
      continue
    }
  }
  return null
}
