import { MAX_DEPTH, type By, type ItemType, type Op, type ReconcileContext, type RefInput, type Stance } from './memory-types.ts'
import { redact } from './slicer.ts'

const ITEM_TYPES: ItemType[] = ['rule', 'decision', 'cause', 'gotcha', 'state', 'reference']
const QUOTE_MAX = 300

const SYSTEM = `You maintain a durable memory tree for a coding agent. You get one transcript slice and the current memory state. In ONE pass, extract what is worth remembering in FUTURE sessions, then decide for each piece how it relates to the existing memory.

Transcript lines are numbered [L<n>]. Tags: [user] human prompt, [assistant] agent reply, [cmd] slash command, [compact] earlier summary, [tool] tool call one-liner, [tool-error] failing tool output.

What to extract:
- decisions the human made, preferences, corrections of the agent
- root causes proven by evidence, measured numbers, gotchas, environment quirks
- project state that is not in code or git (plans parked, things deleted, ownership)
Skip: anything derivable from reading code or git history, guesses ("maybe", "I think"), routine steps, and anything reversed later in the slice (keep only the final state). Return no ops when nothing qualifies.
Session-local state ("this PR is pending", "commit X is not pushed", "next step is Y", "waiting on review") => skip, unless it is a lasting fact about the system.

Write each item as the lasting rule or lesson, not the story. Drop PR numbers, ticket ids, commit SHAs, branch names, and dates from item text; they may stay in the quote. Good: "PRs merge only after CI is green, review is clean, and a human approves". Bad: "PR #12 merges after CI is green and ABC-9 is Done".
One item per rule. Before writing "new", compare against EVERY candidate. If a candidate states the same rule in other words or with other examples, emit "ref" to it. Same rule, different PR or wording => ref, never new.

Item types: rule (how work must be done), decision (a choice and its reason), cause (proven root cause), gotcha (surprising behavior or quirk), state (current project state), reference (where something lives).

Memory state comes in the user message:
- NODES: the topic tree, one per line as "id | parent | title".
- CANDIDATES: existing items, one per line as "id | node | type | text".
- LOADED: item ids the agent was already shown in this session.

Match by MEANING, never by wording. The same rule is often stated under different names in different sessions; if a candidate says the same thing, use "ref" on it, never "new".

Ops (one JSON object each):
- {"op":"ref","item":"<candidate id>","ref":R} same information as a candidate: add one more supporting reference.
- {"op":"new","node":"<node id>","text":"...","type":"<type>","ref":R} new information. text is one self-contained sentence or two. node must be an existing node, or one created by an earlier new-node op in this list.
- {"op":"new-node","parent":"<node id>","id":"<new id>","title":"..."} create a topic. Reuse an existing node whose title fits; create one only when none does. Put it under the repo node (title or id equals the repo) or under the group root. Nesting may go at most ${MAX_DEPTH} levels below the group root. Use a lowercase path-like id such as "<parent id>/<slug>".
- {"op":"conflict","with":"<candidate id>","node":"<node id>","text":"...","type":"<type>","ref":R} new information that contradicts a candidate (the world or the human's decision changed). Conflict means it says the opposite, not another wording: a second wording or a detail of the same rule is "ref".
- {"op":"echo","item":"<loaded id>","ref":R} the agent restated an item whose id is in LOADED. by must be "agent". Never use echo for the human.
- {"op":"confirm","item":"<loaded id>","ref":R} the agent stated a LOADED item and the human accepted it (OK, go, yes).
- {"op":"reject","item":"<loaded id>","ref":R} the agent stated a LOADED item and the human rejected or corrected it. When the human also gave the corrected fact, add a "conflict" op for it.

R = {"lines":["L12","L13"],"by":"user|agent","stance":"for|against","quote":"..."}
- by = "user" when the human said or decided it, "agent" when only the agent concluded it. A human restating an item is always by "user", never an echo.
- stance = "against" only for reject and conflict-style corrections, otherwise "for".
- lines = the line ids that support it. quote = exact words from those lines, at most ${QUOTE_MAX} characters, no secrets.
- Every op that carries R needs it filled in completely.

Output JSON only, no prose, no code fence: {"ops":[...]}`

export function buildPrompt(sliceText: string, ctx: ReconcileContext): { system: string; user: string } {
  const nodes = ctx.nodes.map(n => `${n.id} | ${n.parent ?? '-'} | ${n.title}`).join('\n') || '(none)'
  const candidates = ctx.candidates.map(i => `${i.id} | ${i.node} | ${i.type} | ${oneLine(i.text)}`).join('\n') || '(none)'
  const loaded = ctx.loaded.join(', ') || '(none)'
  const user = `GROUP: ${ctx.group}
REPO: ${ctx.repo}

NODES:
${nodes}

CANDIDATES:
${candidates}

LOADED: ${loaded}

TRANSCRIPT SLICE:
${sliceText}`
  return { system: SYSTEM, user }
}

export function parseOps(raw: string, ctx: ReconcileContext): { ops: Op[]; errors: string[] } {
  const errors: string[] = []
  const list = extractOpList(raw)
  if (!list) return { ops: [], errors: ['no parsable {"ops":[...]} JSON in model output'] }

  const nodeParent = new Map(ctx.nodes.map(n => [n.id, n.parent]))
  const items = new Set(ctx.candidates.map(i => i.id))
  const loaded = new Set(ctx.loaded)
  const known = (id: unknown) => typeof id === 'string' && (items.has(id) || loaded.has(id))
  const ops: Op[] = []

  list.forEach((entry, idx) => {
    const fail = (why: string) => errors.push(`op ${idx} (${opName(entry)}): ${why}`)
    if (!isObj(entry)) return fail('not an object')

    switch (entry.op) {
      case 'new-node': {
        const { parent, id, title } = entry
        if (!nonEmpty(parent) || !nodeParent.has(parent)) return fail(`unknown parent node ${String(parent)}`)
        if (!nonEmpty(id)) return fail('missing id')
        if (nodeParent.has(id)) return fail(`node id ${id} already exists`)
        if (!nonEmpty(title)) return fail('missing title')
        if (depthBelowRoot(parent, nodeParent) + 1 > MAX_DEPTH) return fail(`depth over ${MAX_DEPTH} under ${parent}`)
        nodeParent.set(id, parent)
        ops.push({ op: 'new-node', parent, id, title: title.trim() })
        return
      }
      case 'new':
      case 'conflict': {
        const { node, text, type } = entry
        if (!nonEmpty(node) || !nodeParent.has(node)) return fail(`unknown node ${String(node)}`)
        if (!nonEmpty(text)) return fail('missing text')
        if (!ITEM_TYPES.includes(type as ItemType)) return fail(`bad type ${String(type)}`)
        const ref = parseRef(entry.ref)
        if (typeof ref === 'string') return fail(ref)
        if (entry.op === 'new') {
          ops.push({ op: 'new', node, text: redact(text.trim()), type: type as ItemType, ref })
          return
        }
        if (!known(entry.with)) return fail(`unknown item ${String(entry.with)}`)
        ops.push({ op: 'conflict', with: entry.with as string, node, text: redact(text.trim()), type: type as ItemType, ref })
        return
      }
      case 'ref':
      case 'echo':
      case 'confirm':
      case 'reject': {
        if (!known(entry.item)) return fail(`unknown item ${String(entry.item)}`)
        const item = entry.item as string
        const ref = parseRef(entry.ref)
        if (typeof ref === 'string') return fail(ref)
        if (entry.op === 'ref') {
          ops.push(ref.by === 'agent' && loaded.has(item) ? { op: 'echo', item, ref } : { op: 'ref', item, ref })
          return
        }
        if (!loaded.has(item)) return fail(`${entry.op} on item ${item} that was not loaded`)
        if (entry.op === 'echo') {
          if (ref.by !== 'agent') return fail('echo by user dropped: a human restating an item is a ref')
          ops.push({ op: 'echo', item, ref })
          return
        }
        if (ref.by !== 'user') return fail(`${entry.op} must be by user`)
        ops.push({ op: entry.op, item, ref: { ...ref, stance: entry.op === 'confirm' ? 'for' : 'against' } })
        return
      }
      default:
        return fail('unknown op kind')
    }
  })

  return { ops, errors }
}

function extractOpList(raw: string): unknown[] | null {
  const candidates: string[] = []
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) candidates.push(fence[1])
  candidates.push(raw)
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1))

  for (const c of candidates) {
    try {
      const v = JSON.parse(c.trim())
      if (Array.isArray(v)) return v
      if (isObj(v) && Array.isArray(v.ops)) return v.ops
    } catch {
      continue
    }
  }
  return null
}

function parseRef(v: unknown): RefInput | string {
  if (!isObj(v)) return 'missing ref'
  if (v.by !== 'user' && v.by !== 'agent') return `bad by ${String(v.by)}`
  const stance: Stance = v.stance === 'against' ? 'against' : 'for'
  const rawLines = Array.isArray(v.lines) ? v.lines : []
  const lines = rawLines.map(l => String(l).trim()).filter(l => /^L\d+$/.test(l))
  if (lines.length === 0) return 'ref.lines needs at least one L<n>'
  if (typeof v.quote !== 'string' || !v.quote.trim()) return 'ref.quote missing'
  return { lines, by: v.by as By, stance, quote: redact(v.quote.trim()).slice(0, QUOTE_MAX) }
}

function depthBelowRoot(id: string, parents: Map<string, string | null>): number {
  let depth = 0
  let cur: string | null | undefined = id
  const seen = new Set<string>()
  while (cur != null && !seen.has(cur)) {
    seen.add(cur)
    const p = parents.get(cur)
    if (p == null) break
    depth++
    cur = p
  }
  return depth
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function opName(v: unknown): string {
  return isObj(v) && typeof v.op === 'string' ? v.op : '?'
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
