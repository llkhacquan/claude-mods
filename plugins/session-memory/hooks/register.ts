import type { EngineInterface, Register, Timer } from 'claude-code'
import { buildAutogroupPrompt, parseAutogroup, README_CHARS, type GroupInfo } from '../lib/autogroup-prompt.ts'
import { formatRule, groupNames, groupOfPath, groupOfProjectDir, isTmp, isTmpDir, mangle, mergeRules, OTHER, parseGroups, repoOfPath, ruleOfPath, SKIP, type GroupRule } from '../lib/groups.ts'
import { BUSY, withLock, type LockFs } from '../lib/lock.ts'
import { JEV_URL, jevBody, jevYes, nudgeCandidates, nudgeText } from '../lib/nudge.ts'
import { parseJsonl, redact, type TranscriptRecord } from '../lib/slicer.ts'
import { buildL0, openNode, refsText, SEARCH_MAX, searchItems } from '../lib/recall.ts'
import { forget, loadGroup, loadRefs, saveGroup, type StoreIO } from '../lib/store.ts'
import { processSession, type Outcome, type Trigger, type WorkerDeps } from '../lib/worker.ts'

type $ = EngineInterface
type Options = { model: string; dailyCalls: number; sweepMax: number; autoGroups: boolean; jevKey: string; jevModel: string; nudgeMin: number }
type Spender = Trigger | 'autogroup'
type Usage = { calls: number; in: number; out: number; sweep?: number }
type Seen = Record<string, { size: number; mtimeMs: number }>
type Pending = Record<string, string>
type SweepStop = 'all' | 'max' | 'cap' | 'model'

const IDLE_MS = 10 * 60_000
const DEBOUNCE_MS = 30 * 60_000
const SWEEP_IDLE_MS = 30 * 60_000
const MODEL_TIMEOUT_MS = 180_000
const AUTOGROUP_MAX_TOKENS = 300
const TOPICS_IN_PROMPT = 8
const USAGE_DAYS = 14
const MAX_FAILS = 3
const CLAIM_STALE_MS = 2 * 60 * 60_000
const NUDGE_WAIT_MS = 2_000
const JEV_MAX_PER_SESSION = 200
const TOOL = 'mcp__session-memory__'
const OPEN_INTRO = 'Open a session-memory topic node: lists its subtopics and items. A group or repo node id is valid.'
const EVENTS_MAX_BYTES = 1024 * 1024
const APPEND_ROTATE = 'f=$2; mkdir -p "${f%/*}"; if [ -f "$f" ] && [ "$(wc -c < "$f")" -gt "$3" ]; then mv -f "$f.2" "$f.3" 2>/dev/null; mv -f "$f.1" "$f.2" 2>/dev/null; mv -f "$f" "$f.1"; fi; printf "%s\\n" "$1" >> "$f"'

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

async function today($: $): Promise<string> {
  return new Date(await $.clock.now()).toISOString().slice(0, 10)
}

async function dirs($: $) {
  const home = (await $.env.get('HOME')) ?? ''
  const state = `${(await $.env.get('XDG_STATE_HOME')) || `${home}/.local/state`}/session-memory`
  const config = `${(await $.env.get('XDG_CONFIG_HOME')) || `${home}/.config`}/session-memory`
  const projects = `${(await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`}/projects`
  return { home, state, config, projects }
}

async function emit($: $, ev: string, fields: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date(await $.clock.now()).toISOString(), by: await $.session.id(), ev, ...fields })
  $.ui.log(`session-memory: ${line}`, { to: 'debug' })
  const r = await $.process.run(['sh', '-c', APPEND_ROTATE, 'sh', line, `${(await dirs($)).state}/events.jsonl`, String(EVENTS_MAX_BYTES)])
  if (r.exitCode !== 0) $.ui.log(`session-memory: events.jsonl: ${r.stderr.trim()}`, { to: 'debug' })
}

function fail($: $, trigger: string, e: unknown, fields: Record<string, unknown> = {}) {
  return emit($, 'fail', { trigger, ...fields, error: e instanceof Error ? e.message : String(e) }).catch(() => undefined)
}

async function readRules($: $, file: string, home: string): Promise<GroupRule[]> {
  return (await $.fs.exists(file)) ? parseGroups(String(await $.fs.read(file)), home) : []
}

async function loadRules($: $): Promise<GroupRule[]> {
  const { home, config, state } = await dirs($)
  return mergeRules(await readRules($, `${config}/groups.txt`, home), await readRules($, `${state}/groups.auto.txt`, home))
}

function storeIO($: $): StoreIO {
  return {
    read: async p => ((await $.fs.exists(p)) ? String(await $.fs.read(p)) : null),
    write: async (p, data) => {
      const tmp = `${p}.tmp`
      await $.fs.write(tmp, data)
      const r = await $.process.run(['mv', '-f', tmp, p])
      if (r.exitCode !== 0) throw new Error(`mv ${tmp}: ${r.stderr.trim()}`)
    },
    list: async dir => ((await $.fs.exists(dir)) ? (await $.fs.list(dir)).map(e => e.name) : []),
  }
}

async function readRecords($: $, path: string, from: number): Promise<TranscriptRecord[]> {
  const stream = $.process.spawn({ argv: ['tail', '-n', `+${from + 1}`, path] })
  let text = ''
  for await (const c of stream) if (c.stream === 'stdout') text += c.text
  const end = await stream.result
  if (end.code !== 0) throw new Error(`tail ${path}: exit ${end.code ?? end.signal}`)
  return parseJsonl(text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1))
}

async function callsLeft($: $, opts: Options, trigger: Spender): Promise<number> {
  const cur = (await usage($))[await today($)]
  const total = opts.dailyCalls - (cur?.calls ?? 0)
  if (trigger !== 'sweep') return total
  return Math.min(total, Math.floor(opts.dailyCalls / 3) - (cur?.sweep ?? 0))
}

async function usage($: $): Promise<Record<string, Usage>> {
  return ((await $.store.get('usage')) as Record<string, Usage> | undefined) ?? {}
}

async function addUsage($: $, add: (cur: Usage) => Usage) {
  const all = await usage($)
  const day = await today($)
  all[day] = add(all[day] ?? { calls: 0, in: 0, out: 0 })
  const keep = Object.keys(all).sort().slice(-USAGE_DAYS)
  await $.store.set('usage', Object.fromEntries(keep.map(k => [k, all[k]])))
}

function reserve($: $, trigger: Spender) {
  return addUsage($, cur => ({ ...cur, calls: cur.calls + 1, sweep: (cur.sweep ?? 0) + (trigger === 'sweep' ? 1 : 0) }))
}

function spend($: $, inTokens: number, outTokens: number) {
  return addUsage($, cur => ({ ...cur, in: cur.in + inTokens, out: cur.out + outTokens }))
}

async function mkdirp($: $, dir: string) {
  const r = await $.process.run(['mkdir', '-p', dir])
  if (r.exitCode !== 0) throw new Error(`mkdir ${dir}: ${r.stderr.trim()}`)
}

function lockFs($: $): LockFs {
  return {
    mkdir: async p => {
      const r = await $.process.run(['mkdir', p])
      if (r.exitCode === 0) return true
      if (/exists/i.test(r.stderr)) return false
      throw new Error(`mkdir ${p}: ${r.stderr.trim()}`)
    },
    rmdir: async p => void (await $.process.run(['rm', '-rf', p])),
    mtime: async p => ((await $.fs.exists(p)) ? (await $.fs.stat(p)).mtimeMs : null),
    readOwner: async p => ((await $.fs.exists(`${p}/owner`)) ? String(await $.fs.read(`${p}/owner`)) : null),
    writeOwner: (p, token) => $.fs.write(`${p}/owner`, token),
    now: () => Date.now(),
    sleep: ms => $.clock.sleep(ms),
  }
}

async function complete($: $, opts: Options, system: string, prompt: string, maxTokens: number) {
  const t0 = await $.clock.now()
  const r = await $.model.complete({ model: opts.model, system, prompt, maxTokens, timeoutMs: MODEL_TIMEOUT_MS })
  const ms = (await $.clock.now()) - t0
  if (r.isAnswered) return { text: r.text, inTokens: r.usage.input_tokens, outTokens: r.usage.output_tokens, ms }
  return { error: 'status' in r ? `${r.reason} ${r.status ?? ''} ${r.error}` : r.reason, ms }
}

function workerDeps($: $, opts: Options, trigger: Trigger, path: string, groupDir: string): WorkerDeps {
  const io = storeIO($)
  return {
    io,
    size: async p => ((await $.fs.exists(p)) ? (await $.fs.stat(p)).size : null),
    readRecords: from => readRecords($, path, from),
    complete: (system, prompt, maxTokens) => complete($, opts, system, prompt, maxTokens),
    locked: async fn => {
      await mkdirp($, groupDir)
      const r = await withLock(
        lockFs($),
        `${groupDir}/.lock`,
        fn,
        { onStale: ageMs => emit($, 'lock-stale', { dir: groupDir, ageMs }) },
      )
      return r === BUSY ? null : r
    },
    callsLeft: () => callsLeft($, opts, trigger),
    reserve: () => reserve($, trigger),
    spend: c => spend($, c.inTokens, c.outTokens),
    event: (ev, fields) => emit($, ev, fields),
  }
}

function report($: $, group: string, trigger: Trigger, out: Outcome) {
  if (out.stop === 'cap') {
    if (trigger !== 'sweep') $.ui.status('memory: daily cap')
  } else if (out.stop === 'too-big') $.ui.status(`memory: ${group}/${out.warn} over 4 MiB, not loaded`)
  else if (out.stop === 'model') $.ui.status('memory: model error, will retry')
  else if (out.warn) $.ui.status(`memory: ${group}/${out.warn} near 4 MiB`)
  else if (out.calls > 0) $.ui.status(undefined)
}

async function runJob($: $, opts: Options, job: { sid: string; path: string; group: string; repo: string; trigger: Trigger; loaded?: string[] }): Promise<Outcome | null> {
  if (job.group === SKIP) return null
  const { state } = await dirs($)
  const dir = `${state}/${job.group}`
  const t0 = await $.clock.now()
  const out = await processSession(workerDeps($, opts, job.trigger, job.path, dir), { sid: job.sid, dir, group: job.group, repo: job.repo, trigger: job.trigger, loaded: job.loaded ?? [], date: await today($) })
  await emit($, 'job', { trigger: job.trigger, sid: job.sid, group: job.group, repo: job.repo, ...out, ms: (await $.clock.now()) - t0 })
  report($, job.group, job.trigger, out)
  return out
}

async function transcriptPath($: $, projects: string, cwd: string, sid: string): Promise<string | null> {
  const direct = `${projects}/${mangle(cwd)}/${sid}.jsonl`
  if (await $.fs.exists(direct)) return direct
  for (const d of await $.fs.list(projects)) {
    const p = `${projects}/${d.name}/${sid}.jsonl`
    if (d.kind === 'dir' && (await $.fs.exists(p))) return p
  }
  return null
}

async function sweep($: $, opts: Options, group: string, ownSid: string, max = opts.sweepMax) {
  const { projects } = await dirs($)
  const rules = await loadRules($)
  const pending = ((await $.store.get('pending')) as Pending | undefined) ?? {}
  const seen = ((await $.store.get('seen')) as Seen | undefined) ?? {}
  const now = await $.clock.now()

  const work: { sid: string; path: string; dir: string; mtimeMs: number; size: number }[] = []
  for (const d of await $.fs.list(projects)) {
    if (d.kind !== 'dir' || isTmpDir(d.name) || groupOfProjectDir(rules, d.name) !== group) continue
    for (const f of await $.fs.list(`${projects}/${d.name}`)) {
      if (f.kind !== 'file' || !f.name.endsWith('.jsonl')) continue
      const sid = f.name.slice(0, -'.jsonl'.length)
      if (sid === ownSid) continue
      const path = `${projects}/${d.name}/${f.name}`
      const st = await $.fs.stat(path)
      const old = seen[sid]
      if (old && old.size === st.size && old.mtimeMs === st.mtimeMs) continue
      if (!pending[sid] && now - st.mtimeMs < SWEEP_IDLE_MS) continue
      work.push({ sid, path, dir: d.name, mtimeMs: st.mtimeMs, size: st.size })
    }
  }
  work.sort((a, b) => Number(!pending[b.sid]) - Number(!pending[a.sid]) || a.mtimeMs - b.mtimeMs)

  const picked = work.slice(0, max)
  let done = 0
  let stop: SweepStop = work.length > picked.length ? 'max' : 'all'
  for (const w of picked) {
    const rule = rules.filter(r => w.dir === mangle(r.root) || w.dir.startsWith(`${mangle(r.root)}-`)).sort((a, b) => b.root.length - a.root.length)[0]
    let out: Outcome | null | typeof BUSY
    try {
      out = await claim($, w.sid, () => runJob($, opts, { sid: w.sid, path: w.path, group, repo: rule ? repoOfPath(rules, rule.root) : '', trigger: 'sweep' }))
    } catch (e) {
      await fail($, 'sweep', e, { sid: w.sid, group, path: w.path })
      if (await countFailure($, w.sid, group)) await markSeen($, w.sid, { size: w.size, mtimeMs: w.mtimeMs })
      continue
    }
    if (out === BUSY) {
      await emit($, 'skip', { trigger: 'sweep', sid: w.sid, why: 'claimed' })
      continue
    }
    if (out?.stop === 'cap') {
      stop = 'cap'
      break
    }
    if (out?.stop === 'model') {
      stop = 'model'
      if (!(await countFailure($, w.sid, group))) break
    } else if (!out || !['done', 'headless'].includes(out.stop)) continue
    else {
      done++
      await clearFailure($, w.sid)
    }
    await markSeen($, w.sid, { size: w.size, mtimeMs: w.mtimeMs })
    if (stop === 'model') break
  }
  await emit($, 'sweep', { group, found: work.length, picked: picked.length, done, stop })
  return { done, stop }
}

async function claim<T>($: $, sid: string, fn: () => Promise<T>): Promise<T | typeof BUSY> {
  const dir = `${(await dirs($)).state}/claims`
  await mkdirp($, dir)
  return withLock(lockFs($), `${dir}/${sid}`, fn, { waitMs: 0, staleMs: CLAIM_STALE_MS })
}

async function markSeen($: $, sid: string, entry: Seen[string]) {
  const seen = ((await $.store.get('seen')) as Seen | undefined) ?? {}
  await $.store.set('seen', { ...seen, [sid]: entry })
  const pending = ((await $.store.get('pending')) as Pending | undefined) ?? {}
  if (!(sid in pending)) return
  delete pending[sid]
  await $.store.set('pending', pending)
}

async function clearFailure($: $, sid: string) {
  const fails = ((await $.store.get('fails')) as Record<string, number> | undefined) ?? {}
  if (!(sid in fails)) return
  delete fails[sid]
  await $.store.set('fails', fails)
}

async function countFailure($: $, sid: string, group: string): Promise<boolean> {
  const fails = ((await $.store.get('fails')) as Record<string, number> | undefined) ?? {}
  const n = (fails[sid] ?? 0) + 1
  const giveUp = n >= MAX_FAILS
  if (giveUp) delete fails[sid]
  else fails[sid] = n
  await $.store.set('fails', fails)
  if (giveUp) await emit($, 'give-up', { sid, group, fails: n })
  return giveUp
}

type Live = { opts: Options; active: boolean; cwd: string; group: string; grouped: boolean; repo: string; loaded: Set<string>; timer?: Timer; lastRun: Map<string, number>; chain: Promise<unknown>; nudged: Set<string>; searched: Set<string>; pending: string[]; jevCalls: number }

function queue<T>(live: Live, fn: () => Promise<T>): Promise<T> {
  const next = live.chain.then(fn, fn)
  live.chain = next.catch(() => undefined)
  return next
}

async function ownJob($: $, live: Live, trigger: Trigger, sid?: string) {
  const id = sid ?? (await $.session.id())
  const now = await $.clock.now()
  if (trigger === 'idle' && now - (live.lastRun.get(id) ?? 0) < DEBOUNCE_MS) return emit($, 'skip', { trigger, sid: id, why: 'debounce' })
  const rules = await loadRules($)
  const group = isTmp(live.cwd) ? SKIP : groupOfPath(rules, live.cwd)
  if (group === SKIP) return emit($, 'skip', { trigger, sid: id, why: 'group skip' })
  const path = await transcriptPath($, (await dirs($)).projects, live.cwd, id)
  if (!path) return emit($, 'skip', { trigger, sid: id, why: 'no transcript' })
  const out = await runJob($, live.opts, { sid: id, path, group, repo: repoOfPath(rules, live.cwd), trigger, loaded: [...live.loaded] })
  if (!out || out.calls === 0) return
  live.lastRun.set(id, now)
  if (trigger !== 'end') await registerTools($, live)
}

function runOwn($: $, live: Live, trigger: Trigger, sid?: string) {
  return queue(live, () => ownJob($, live, trigger, sid)).catch(e => fail($, trigger, e, { sid, group: live.group, cwd: live.cwd }))
}

async function groupState($: $, group: string) {
  return loadGroup(storeIO($), `${(await dirs($)).state}/${group}`)
}

async function registerTools($: $, live: Live) {
  const l0 = buildL0(await groupState($, live.group), live.repo, OPEN_INTRO)
  for (const id of l0.loaded) live.loaded.add(id)
  const str = (name: string, about: string) => ({ type: 'object', properties: { [name]: { type: 'string', description: about } }, required: [name] })
  await $.tool.register({ name: 'memory_open', description: l0.text, inputSchema: str('node', 'node id, e.g. the group name'), isDeferred: false })
  await $.tool.register({ name: 'memory_search', description: `Keyword search over every session-memory item of group ${live.group}; returns the best ${SEARCH_MAX} item lines.`, inputSchema: str('query', 'key words'), isDeferred: false })
  await $.tool.register({ name: 'memory_refs', description: 'Show the session quotes behind one session-memory item id.', inputSchema: str('item', 'item id like i-12'), isDeferred: false })
  await emit($, 'tools', { group: live.group, repo: live.repo, l0Chars: l0.text.length, l0Items: l0.loaded.length })
}

async function recall($: $, live: Live, tool: string, arg: string) {
  const state = await groupState($, live.group)
  const r =
    tool === 'memory_open'
      ? openNode(state, arg)
      : tool === 'memory_search'
        ? searchItems(state, arg)
        : { text: refsText(state, arg, await loadRefs(storeIO($), `${(await dirs($)).state}/${live.group}`, arg)), items: state.items.has(arg) ? [arg] : [] }
  for (const id of r.items) {
    live.loaded.add(id)
    const node = state.items.get(id)?.node
    if (node) live.searched.add(node)
  }
  if (tool === 'memory_open') live.searched.add(arg)
  await emit($, 'recall', { tool, arg, items: r.items, chars: r.text.length })
  return { result: r.text }
}

async function judge($: $, live: Live, text: string, src: 'user' | 'assistant'): Promise<string | null> {
  if (!live.active || !live.grouped || live.group === SKIP || !live.opts.jevKey || live.jevCalls >= JEV_MAX_PER_SESSION) return null
  const state = await groupState($, live.group)
  const cands = nudgeCandidates(state, text, { sid: await $.session.id(), topics: new Set([...live.nudged, ...live.searched]) })
  const top = cands[0]
  if (!top) return null
  const topic = top.item.node
  const ids = cands.filter(c => c.item.node === topic).map(c => c.item.id)
  live.jevCalls++
  const t0 = await $.clock.now()
  try {
    const res = await $.http.fetch(JEV_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${live.opts.jevKey}` },
      body: jevBody(live.opts.jevModel, text, top.item),
    })
    const p = res.ok ? jevYes(res.text) : null
    const sent = p !== null && p >= live.opts.nudgeMin && !live.nudged.has(topic)
    if (sent) live.nudged.add(topic)
    await emit($, 'nudge', { src, topic, items: ids, shared: top.shared, p, sent, ms: (await $.clock.now()) - t0, ...(res.ok ? {} : { status: res.status }) })
    return sent ? nudgeText(top, ids) : null
  } catch (e) {
    await emit($, 'nudge', { src, topic, items: ids, sent: false, error: redact(String(e)).slice(0, 300), ms: (await $.clock.now()) - t0 })
    return null
  }
}

async function judgeWithin($: $, live: Live, text: string): Promise<string | null> {
  const judged = judge($, live, text, 'user').catch(() => null)
  const late = Symbol('late')
  const first = await Promise.race([judged, $.clock.sleep(NUDGE_WAIT_MS).then(() => late)])
  if (typeof first !== 'symbol') return first
  void judged.then(n => void (n && live.pending.push(n)))
  return null
}

async function forgetItem($: $, live: Live, id: string): Promise<string> {
  if (!live.grouped) return 'session-memory: still finding this session\'s memory group, try again in a minute.'
  if (live.group === SKIP) return 'session-memory: this session has no memory group.'
  if (!id) return 'Usage: /memory-forget <item-id>, e.g. /memory-forget i-12'
  const dir = `${(await dirs($)).state}/${live.group}`
  const io = storeIO($)
  await mkdirp($, dir)
  const r = await withLock(lockFs($), `${dir}/.lock`, async () => {
    const state = await loadGroup(io, dir)
    const it = state.items.get(id)
    if (!it || it.dead) return null
    await saveGroup(io, dir, forget(state, id), [])
    return it.text
  })
  if (r === BUSY) return 'session-memory: the group is busy, try again in a minute.'
  if (r === null) return `No live item ${id} in group ${live.group}.`
  await emit($, 'forget', { group: live.group, item: id })
  await registerTools($, live)
  return `Forgot ${id}: ${r}\nA later user ref brings it back.`
}

async function backfill($: $, live: Live) {
  const own = await $.session.id()
  const done: Record<string, number> = {}
  for (const group of [...groupNames(await loadRules($)), OTHER]) {
    if ((await callsLeft($, live.opts, 'sweep')) <= 0) break
    const r = await sweep($, live.opts, group, own, Infinity)
    done[group] = r.done
    if (r.stop === 'model') break
  }
  await emit($, 'backfill', { done })
  if (done[live.group]) await registerTools($, live)
  $.ui.status(`memory: backfill mined ${Object.values(done).reduce((a, b) => a + b, 0)} transcripts`)
}

async function startBackfill($: $, live: Live): Promise<string> {
  const left = await callsLeft($, live.opts, 'sweep')
  if (left <= 0) return "session-memory: today's sweep share is used up; run /memory-backfill again tomorrow."
  void queue(live, () => backfill($, live)).catch(async e => {
    await fail($, 'backfill', e)
    $.ui.status('memory: backfill failed, see events.jsonl')
  })
  return `session-memory: backfill started in the background, up to ${left} model calls today (a third of dailyCalls, shared with the start sweep). Run it again on later days to go on.`
}

async function repoRoot($: $, cwd: string): Promise<string | null> {
  const r = await $.process.run(['git', '-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  const common = r.stdout.trim().replace(/\/+$/, '')
  if (r.exitCode !== 0 || !common.startsWith('/')) return null
  return common.slice(0, common.lastIndexOf('/')) || null
}

async function docsHead($: $, root: string): Promise<string> {
  for (const name of ['CLAUDE.md', 'README.md']) {
    const p = `${root}/${name}`
    if (await $.fs.exists(p)) return String(await $.fs.read(p)).slice(0, README_CHARS)
  }
  return ''
}

async function groupInfos($: $, rules: GroupRule[], state: string): Promise<GroupInfo[]> {
  const io = storeIO($)
  const infos: GroupInfo[] = []
  for (const name of groupNames(rules)) {
    const own = rules.filter(r => r.group === name)
    let topics: string[] = []
    try {
      const nodes = JSON.parse((await io.read(`${state}/${name}/nodes.json`)) ?? '[]') as { parent: string | null; title: string }[]
      topics = nodes.filter(n => n.parent === name).map(n => n.title).slice(0, TOPICS_IN_PROMPT)
    } catch {
      topics = []
    }
    infos.push({ name, desc: own.find(r => r.desc)?.desc ?? '', repos: own.map(r => r.root.split('/').pop() ?? ''), topics })
  }
  return infos
}

async function addAutoRule($: $, state: string, home: string, rule: GroupRule): Promise<'written' | 'exists' | 'busy'> {
  const file = `${state}/groups.auto.txt`
  await mkdirp($, state)
  const r = await withLock(lockFs($), `${state}/.groups.lock`, async () => {
    const text = (await $.fs.exists(file)) ? String(await $.fs.read(file)) : ''
    if (parseGroups(text, home).some(x => x.root === rule.root)) return 'exists'
    await storeIO($).write(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${formatRule(rule)}\n`)
    return 'written'
  })
  return r === BUSY ? 'busy' : r
}

async function autoGroup($: $, live: Live) {
  const { home, state } = await dirs($)
  const rules = await loadRules($)
  if (ruleOfPath(rules, live.cwd)) return
  const root = await repoRoot($, live.cwd)
  if (!root || rules.some(r => r.root === root)) return
  const repo = root.split('/').pop() ?? ''
  if ((await callsLeft($, live.opts, 'autogroup')) <= 0) return emit($, 'skip', { trigger: 'autogroup', root, why: 'cap' })
  const names = groupNames(rules)
  const { system, user } = buildAutogroupPrompt({ root, repo, readme: await docsHead($, root), groups: await groupInfos($, rules, state) })
  await reserve($, 'autogroup')
  const c = await complete($, live.opts, system, user, AUTOGROUP_MAX_TOKENS)
  if ('error' in c) return emit($, 'autogroup', { root, error: c.error, ms: c.ms })
  await spend($, c.inTokens, c.outTokens)
  const a = parseAutogroup(c.text, names)
  if ('error' in a) return emit($, 'autogroup', { root, error: `garbled reply: ${a.error}`, in: c.inTokens, out: c.outTokens, ms: c.ms })
  const written = await addAutoRule($, state, home, { group: a.group, root, ...(a.desc ? { desc: a.desc } : {}) })
  await emit($, 'autogroup', { root, action: a.action, group: a.group, ...(a.why ? { why: a.why } : {}), written, in: c.inTokens, out: c.outTokens, ms: c.ms })
  if (written !== 'busy') $.ui.status(`memory: ${repo} -> ${a.group} (auto)`)
}

async function startSweep($: $, live: Live) {
  if (live.opts.autoGroups) await autoGroup($, live).catch(e => fail($, 'autogroup', e, { cwd: live.cwd }))
  const rules = await loadRules($)
  live.group = groupOfPath(rules, live.cwd)
  live.grouped = true
  live.repo = repoOfPath(rules, live.cwd)
  live.loaded = new Set()
  live.nudged = new Set()
  live.searched = new Set()
  live.pending = []
  live.jevCalls = 0
  const { jevKey, ...shown } = live.opts
  await emit($, 'start', { cwd: live.cwd, group: live.group, ...shown, jev: jevKey !== '' })
  if (live.group === SKIP) return
  await registerTools($, live)
  if ((await sweep($, live.opts, live.group, await $.session.id())).done > 0) await registerTools($, live)
}

function armIdle($: $, live: Live) {
  live.timer?.cancel()
  live.timer = $.clock.after(IDLE_MS, () => void runOwn($, live, 'idle'))
}

async function markPending($: $, sid: string, cwd: string) {
  const pending = ((await $.store.get('pending')) as Pending | undefined) ?? {}
  pending[sid] = cwd
  await $.store.set('pending', pending)
}

export const register: Register = (on, options) => {
  const live: Live = {
    opts: {
      model: String(options.model || 'sonnet'),
      dailyCalls: num(options.dailyCalls, 150), sweepMax: num(options.sweepMax, 10), autoGroups: options.autoGroups !== false && options.autoGroups !== 'false',
      jevKey: String(options.jevKey ?? ''),
      jevModel: String(options.jevModel || 'jev-1.13'),
      nudgeMin: num(options.nudgeMin, 0.8),
    },
    active: false,
    cwd: '',
    group: SKIP,
    grouped: false,
    repo: '',
    loaded: new Set(),
    lastRun: new Map(),
    chain: Promise.resolve(),
    nudged: new Set(),
    searched: new Set(),
    pending: [],
    jevCalls: 0,
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    live.active = e.isInteractive && !isTmp(e.cwd)
    live.cwd = e.cwd
    if (live.active) {
      await $.command.register({ name: 'memory-forget', description: 'Hide one session-memory item from recall', argumentHint: '<item-id>' })
      await $.command.register({ name: 'memory-backfill', description: 'Mine old transcripts of every memory group in the background' })
      void queue(live, () => startSweep($, live)).catch(err => ((live.grouped = true), fail($, 'sweep', err, { cwd: live.cwd })))
    }
    return started
  })

  on('command.run', { command: 'memory-backfill' }, $ => startBackfill($, live).then(text => ({ text })))
  on('command.run', { command: 'memory-forget' }, async ($, e) => ({ text: await forgetItem($, live, e.args.trim()) }))

  for (const name of ['memory_open', 'memory_search', 'memory_refs']) {
    const key = { memory_open: 'node', memory_search: 'query', memory_refs: 'item' }[name] as string
    on('tool.call', { tool: `${TOOL}${name}` }, ($, e) => recall($, live, name, String((e as unknown as Record<string, unknown>)[key] ?? '')))
  }

  on('prompt.submit', async ($, e, next) => {
    if (!live.active || e.command || e.isMeta) return next(e)
    const fresh = await judgeWithin($, live, e.text)
    const add = [...live.pending.splice(0), ...(fresh ? [fresh] : [])]
    return next(add.length ? { ...e, context: [...(e.context ?? []), ...add] } : e)
  })

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (live.active && e.agentId === undefined && r?.answer?.trim()) void judge($, live, r.answer, 'assistant').then(n => void (n && live.pending.push(n))).catch(() => undefined)
    return r
  })

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || !live.pending.length || r.deny !== undefined || r.isError) return r
    return { ...r, context: [...(r.context ?? []), ...live.pending.splice(0)] }
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) live.timer?.cancel()
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (live.active && e.agentId === undefined) armIdle($, live)
    return next(e)
  })

  on('session.compact', ($, e, next) => {
    if (live.active && e.agentId === undefined) void runOwn($, live, 'compact')
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    live.timer?.cancel()
    if (live.active) {
      await emit($, 'end', { sid: e.sessionId, reason: e.reason }).catch(() => undefined)
      if (e.reason === 'clear') void runOwn($, live, 'end', e.sessionId)
      else await markPending($, e.sessionId, live.cwd)
    }
    return next(e)
  })
}
