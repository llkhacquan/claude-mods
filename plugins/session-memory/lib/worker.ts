import type { Item, Ref } from './memory-types.ts'
import { buildPrompt, parseOps } from './reconcile-prompt.ts'
import { isHeadless, sliceRecords, type TranscriptRecord } from './slicer.ts'
import { buildSplitPrompt, parseSplit } from './split-prompt.ts'
import { applyOps, applySplit, canSplit, loadGroup, nodesOver, saveGroup, splitInput, type GroupState, type Processed, type StoreIO } from './store.ts'

export type Trigger = 'idle' | 'compact' | 'end' | 'sweep'

export type Completion = { text: string; inTokens: number; outTokens: number } | { error: string }

export type WorkerDeps = {
  io: StoreIO
  size(path: string): Promise<number | null>
  readRecords(from: number): Promise<TranscriptRecord[]>
  complete(system: string, user: string, maxTokens: number): Promise<Completion>
  locked<T>(fn: () => Promise<T>): Promise<T | null>
  callsLeft(): Promise<number>
  spend(c: { inTokens: number; outTokens: number }): Promise<void>
  log(msg: string): void
}

export type Job = { sid: string; dir: string; group: string; repo: string; trigger: Trigger; loaded: string[]; date: string }

export type Stop = 'done' | 'too-big' | 'headless' | 'wait' | 'cap' | 'model' | 'busy'

export type Outcome = { stop: Stop; slices: number; calls: number; warn?: string }

export const WARN_BYTES = 3.5 * 1024 * 1024
export const MAX_BYTES = 4 * 1024 * 1024
export const SLICE_CHARS = 40_000
export const MIN_HUMAN_TURNS = 3
export const CANDIDATES = 30
export const RECONCILE_TOKENS = 8_000
export const SPLIT_TOKENS = 4_000

const GROUP_FILES = ['items.jsonl', 'nodes.json', 'processed.jsonl']

export const cursorOf = (state: GroupState, sid: string): number =>
  state.processed.filter(p => p.sid === sid).reduce((max, p) => Math.max(max, p.to), 0)

const words = (s: string): Set<string> => new Set(s.toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) ?? [])

export function candidatesFor(sliceText: string, items: Iterable<Item>, max = CANDIDATES): Item[] {
  const seen = words(sliceText)
  const scored: { item: Item; score: number }[] = []
  for (const item of items) {
    if (item.dead) continue
    let score = 0
    for (const w of words(item.text)) if (seen.has(w)) score++
    if (score > 0) scored.push({ item, score })
  }
  return scored.sort((a, b) => b.score - a.score || b.item.last.localeCompare(a.item.last)).slice(0, max).map(s => s.item)
}

export async function sizeGuard(deps: WorkerDeps, dir: string): Promise<{ over?: string; warn?: string }> {
  let warn: string | undefined
  for (const name of GROUP_FILES) {
    const bytes = await deps.size(`${dir}/${name}`)
    if (bytes === null) continue
    if (bytes > MAX_BYTES) return { over: name }
    if (bytes > WARN_BYTES) warn = name
  }
  return { warn }
}

export async function processSession(deps: WorkerDeps, job: Job): Promise<Outcome> {
  const out: Outcome = { stop: 'done', slices: 0, calls: 0 }
  const guard = await sizeGuard(deps, job.dir)
  if (guard.over) return { ...out, stop: 'too-big', warn: guard.over }
  out.warn = guard.warn

  let state = await loadGroup(deps.io, job.dir)
  const from = cursorOf(state, job.sid)
  const records = await deps.readRecords(from)
  if (!records.length) return out

  const save = async (slice: Processed, apply?: (s: GroupState) => { state: GroupState; newRefs: Ref[] }) => {
    const r = await deps.locked(async () => {
      const fresh = await loadGroup(deps.io, job.dir)
      if (fresh.processed.some(p => p.sid === slice.sid && p.from <= slice.from && slice.to <= p.to)) return fresh
      const applied = apply ? apply(fresh) : { state: fresh, newRefs: [] }
      await saveGroup(deps.io, job.dir, applied.state, applied.newRefs, slice)
      return { ...applied.state, processed: [...applied.state.processed, slice] }
    })
    if (r === null) return false
    state = r
    return true
  }

  if (from === 0 && isHeadless(records)) {
    if (!(await save({ sid: job.sid, from: 0, to: records.length }))) return { ...out, stop: 'busy' }
    return { ...out, stop: 'headless' }
  }

  let pos = 0
  while (pos < records.length) {
    const s = sliceRecords(records, pos, SLICE_CHARS)
    const slice: Processed = { sid: job.sid, from: from + pos, to: from + s.toIndex }
    const atEnd = s.toIndex >= records.length
    if (job.trigger === 'idle' && atEnd && s.humanTurns < MIN_HUMAN_TURNS) return { ...out, stop: 'wait' }

    if (s.lines.length) {
      if ((await deps.callsLeft()) <= 0) return { ...out, stop: 'cap' }
      const text = s.lines.map((l, i) => `[L${i + 1}] ${l}`).join('\n')
      const ctx = { group: job.group, repo: job.repo, nodes: state.nodes, candidates: candidatesFor(text, state.items.values()), loaded: job.loaded }
      const { system, user } = buildPrompt(text, ctx)
      const res = await deps.complete(system, user, RECONCILE_TOKENS)
      out.calls++
      if ('error' in res) {
        deps.log(`reconcile ${job.sid} ${slice.from}-${slice.to}: ${res.error}`)
        return { ...out, stop: 'model' }
      }
      await deps.spend(res)
      const { ops, errors } = parseOps(res.text, ctx)
      for (const e of errors) deps.log(`reconcile ${job.sid} ${slice.from}-${slice.to}: ${e}`)
      const ok = await save(slice, fresh => {
        const r = applyOps(fresh, ops, { sid: job.sid, date: job.date })
        for (const sk of r.skipped) deps.log(`skip op ${sk.op.op}: ${sk.reason}`)
        return r
      })
      if (!ok) return { ...out, stop: 'busy' }
    } else if (!(await save(slice))) {
      return { ...out, stop: 'busy' }
    }
    out.slices++
    pos = s.toIndex
  }

  out.calls += await splitOver(deps, job, state)
  return out
}

async function splitOver(deps: WorkerDeps, job: Job, state: GroupState): Promise<number> {
  let calls = 0
  for (const node of nodesOver(state)) {
    if (!canSplit(state, node) || (await deps.callsLeft()) <= 0) continue
    const { system, user } = buildSplitPrompt(splitInput(state, node))
    const res = await deps.complete(system, user, SPLIT_TOKENS)
    calls++
    if ('error' in res) {
      deps.log(`split ${node}: ${res.error}`)
      continue
    }
    await deps.spend(res)
    await deps.locked(async () => {
      const fresh = await loadGroup(deps.io, job.dir)
      if (!nodesOver(fresh).includes(node) || !canSplit(fresh, node)) return
      const input = splitInput(fresh, node)
      const parsed = parseSplit(res.text, input, new Set(fresh.nodes.map(n => n.id)))
      if ('error' in parsed) {
        deps.log(`split ${node}: ${parsed.error}`)
        return
      }
      await saveGroup(deps.io, job.dir, applySplit(fresh, node, parsed.groups).state, [])
    })
  }
  return calls
}
