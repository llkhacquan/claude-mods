import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { ModelCompleteResult, On } from 'claude-code'

const HOME = '/home/u'
const PROJECTS = `${HOME}/.claude/projects`
const STATE = `${HOME}/.local/state/session-memory`
const CWD = '/work/api'
const SID = 'own-session'
const MIN = 60_000
const USAGE = { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const line = (type: 'user' | 'assistant', text: string) =>
  JSON.stringify(type === 'user' ? { type, entrypoint: 'cli', cwd: CWD, message: { role: 'user', content: text } } : { type, message: { role: 'assistant', content: [{ type: 'text', text }] } })
const transcript = (turns: number, tag = 'q') =>
  Array.from({ length: turns }, (_, i) => `${line('user', `${tag} ${i} about deploys`)}\n${line('assistant', `answer ${i}`)}\n`).join('')

const opsFor = (text: string) =>
  JSON.stringify({ ops: [{ op: 'new', node: 'be', text, type: 'rule', ref: { lines: ['L1'], by: 'user', stance: 'for', quote: 'about deploys' } }] })

function harness(on: On, opts: { files?: Record<string, string>; mtimes?: Record<string, number>; now?: number; git?: Record<string, string>; modelDown?: boolean; dirs?: string[] } = {}) {
  const clock = mock.clock(on, { now: opts.now ?? 100 * 24 * 60 * MIN })
  mock.env(on, { HOME })
  const files = new Map<string, string>(Object.entries({ [`${HOME}/.config/session-memory/groups.txt`]: `be ${CWD}\n`, ...opts.files }))
  const dirs = new Set<string>(opts.dirs)
  const mtimes = opts.mtimes ?? {}
  const store = new Map<string, unknown>()
  const prompts: string[] = []
  const statuses: (string | undefined)[] = []
  const answers: string[] = []
  const tools = new Map<string, string>()
  const git: string[] = []
  const model: { down: boolean; hold?: Promise<void> } = { down: opts.modelDown ?? false }
  const under = (dir: string) => [...files.keys()].filter(p => p.startsWith(`${dir}/`)).map(p => p.slice(dir.length + 1))

  on('session.id', () => ({ value: SID }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.compact', ($, e) => ({ messages: e.messages }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('tool.register', ($, e) => {
    tools.set(e.name, e.description)
    return { value: { tool: `mcp__session-memory__${e.name}` } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || dirs.has(e.path) || under(e.path).length > 0 }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`missing ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', ($, e) => ({ value: { kind: files.has(e.path) ? ('file' as const) : ('dir' as const), size: (files.get(e.path) ?? '').length, mtimeMs: mtimes[e.path] ?? 0, isLink: false } }))
  on('fs.list', ($, e) => {
    const seen = new Map<string, 'file' | 'dir'>()
    for (const rest of under(e.path ?? '')) {
      const [head, ...tail] = rest.split('/')
      seen.set(head as string, tail.length ? 'dir' : 'file')
    }
    return { value: [...seen].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', ($, e) => {
    const [cmd, ...args] = e.argv
    let exitCode = 0
    let stderr = ''
    if (cmd === 'mkdir' && args[0] === '-p') dirs.add(args[1] as string)
    else if (cmd === 'mkdir') {
      const dir = args[0] as string
      if (dirs.has(dir)) [exitCode, stderr] = [1, `mkdir: ${dir}: File exists`]
      else (dirs.add(dir), (mtimes[dir] = Date.now()))
    } else if (cmd === 'rm') {
      dirs.delete(args[1] as string)
      for (const f of under(args[1] as string)) files.delete(`${args[1]}/${f}`)
    }
    else if (cmd === 'sh') files.set(args[4] as string, `${files.get(args[4] as string) ?? ''}${args[3]}\n`)
    else if (cmd === 'git') {
      git.push(args[1] as string)
      const common = opts.git?.[args[1] as string]
      return { value: { exitCode: common ? 0 : 128, stdout: common ? `${common}\n` : '', stderr: common ? '' : 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    } else if (cmd === 'mv') {
      files.set(args[2] as string, files.get(args[1] as string) ?? '')
      files.delete(args[1] as string)
    }
    return { value: { exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* ($, e) {
    const from = Number((e.argv[2] as string).slice(1)) - 1
    const text = (files.get(e.argv[3] as string) ?? '').split('\n').slice(from).join('\n')
    if (text.startsWith('UNREADABLE')) return { value: { code: 1, signal: null } }
    if (text) yield { stream: 'stdout' as const, text }
    return { value: { code: 0, signal: null } }
  })
  on('model.complete', async ($, e) => {
    prompts.push(String(e.prompt))
    await model.hold
    if (model.down) return { value: { isAnswered: false, reason: 'timeout' } as ModelCompleteResult }
    return { value: { isAnswered: true, text: answers.shift() ?? '{"ops":[]}', usage: USAGE } as ModelCompleteResult }
  })

  const events = () => (files.get(`${STATE}/events.jsonl`) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const items = (group = 'be') => (files.get(`${STATE}/${group}/items.jsonl`) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))
  return { clock, files, store, prompts, statuses, answers, items, events, tools, git, model }
}

const own = (dir = '-work-api') => `${PROJECTS}/${dir}/${SID}.jsonl`

async function start($: Engine, isInteractive = true, cwd = CWD) {
  await $.session.start({ surface: isInteractive ? 'terminal' : null, isInteractive, cwd })
}

async function turn($: Engine, agentId?: string) {
  await $.turn.start({ text: 'go', turnId: 't1', ...(agentId ? { agentId } : {}) })
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer', ...(agentId ? { agentId } : {}) })
}

test('a main turn left idle 10 minutes mines the transcript into the group', async ($, on) => {
  const h = harness(on, { files: { [own()]: transcript(3) } })
  h.answers.push(opsFor('deploys need a human go'))
  await start($)
  await turn($)
  await h.clock.advance(9 * MIN)
  expect(h.prompts).toHaveLength(0)
  await h.clock.advance(1 * MIN)
  expect(h.prompts).toHaveLength(1)
  expect(h.items().map(i => i.text)).toEqual(['deploys need a human go'])
  expect(h.files.get(`${STATE}/be/processed.jsonl`)).toBe(`${JSON.stringify({ sid: SID, from: 0, to: 6 })}\n`)
  expect([...h.files.keys()].some(p => p.endsWith('.tmp'))).toBe(false)
})

test('the events log tells why a run did or did not happen and what it cost', async ($, on) => {
  const h = harness(on, { files: { [own()]: transcript(3) } })
  h.answers.push(opsFor('deploys need a human go'))
  await start($)
  await turn($)
  await h.clock.advance(10 * MIN)
  await turn($)
  await h.clock.advance(10 * MIN)
  const evs = h.events().map(({ ts, ...rest }) => rest)
  expect(evs.map(e => e.ev)).toEqual(['start', 'tools', 'sweep', 'slice', 'job', 'tools', 'skip'])
  expect(evs[0]).toEqual({ by: SID, ev: 'start', cwd: CWD, group: 'be', model: 'sonnet', dailyCalls: 150, sweepMax: 10, autoGroups: true, jevModel: 'jev-1.13', nudgeMin: 0.8, jev: false })
  expect(evs[3]).toMatchObject({ ev: 'slice', sid: SID, from: 0, to: 6, turns: 3, in: 900, out: 40, ops: { new: 1 }, skipped: [], errors: [] })
  expect(evs[4]).toMatchObject({ ev: 'job', trigger: 'idle', sid: SID, group: 'be', stop: 'done', slices: 1, calls: 1 })
  expect(evs[6]).toEqual({ by: SID, ev: 'skip', trigger: 'idle', sid: SID, why: 'debounce' })
})

test('the mined items reach the model through L0 and the three memory tools', async ($, on) => {
  const h = harness(on, { files: { [own()]: transcript(3) } })
  h.answers.push(opsFor('deploys need a human go'))
  await start($)
  await h.clock.settle()
  expect(h.tools.get('memory_open')).toContain('No items yet.')

  await turn($)
  await h.clock.advance(10 * MIN)
  expect(h.tools.get('memory_open')).toContain('[i-1] deploys need a human go  refs=1 (you 1, agent 0)')

  const call = async (name: string, arg: Record<string, string>) =>
    String(((await $.tool.call({ tool: `mcp__session-memory__${name}`, ...arg } as never)) as { result: unknown }).result)
  expect(await call('memory_search', { query: 'human deploys' })).toContain('[i-1] deploys need a human go')
  expect(await call('memory_open', { node: 'be' })).toContain('be: be')
  expect(await call('memory_refs', { item: 'i-1' })).toContain('user: "about deploys"')
  expect(h.events().filter(e => e.ev === 'recall').map(e => [e.tool, e.items])).toEqual([
    ['memory_search', ['i-1']],
    ['memory_open', ['i-1']],
    ['memory_refs', ['i-1']],
  ])
})

test('a last line still being written is left for the next run', async ($, on) => {
  const full = transcript(3)
  const h = harness(on, { files: { [own()]: `${full}${line('user', 'cut off').slice(0, 30)}` } })
  await start($)
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] })
  await h.clock.settle()
  expect(h.files.get(`${STATE}/be/processed.jsonl`)).toBe(`${JSON.stringify({ sid: SID, from: 0, to: 6 })}\n`)

  h.files.set(own(), `${full}${line('user', 'cut off')}\n`)
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] })
  await h.clock.settle()
  expect(h.prompts.at(-1)).toContain('cut off')
})

test('sweepMax 0 turns the start sweep off', { options: { sweepMax: 0 } }, async ($, on) => {
  const now = 100 * 24 * 60 * MIN
  const old = `${PROJECTS}/-work-api/old.jsonl`
  const h = harness(on, { now, files: { [old]: transcript(1, 'old') }, mtimes: { [old]: now - 60 * MIN } })
  await start($)
  await h.clock.settle()
  expect(h.prompts).toHaveLength(0)
})

test('the sweep stops at a third of dailyCalls and leaves the rest for live runs', { options: { dailyCalls: 3 } }, async ($, on) => {
  const now = 100 * 24 * 60 * MIN
  const a = `${PROJECTS}/-work-api/a.jsonl`
  const b = `${PROJECTS}/-work-api/b.jsonl`
  const h = harness(on, { now, files: { [a]: transcript(1, 'a'), [b]: transcript(1, 'b'), [own()]: transcript(3) }, mtimes: { [a]: now - 90 * MIN, [b]: now - 60 * MIN } })
  await start($)
  await h.clock.settle()
  expect(h.prompts).toHaveLength(1)
  expect(h.prompts[0]).toContain('a 0')
  expect(h.statuses).not.toContain('memory: daily cap')

  await turn($)
  await h.clock.advance(10 * MIN)
  expect(h.prompts).toHaveLength(2)
  expect(h.prompts[1]).toContain('q 0')
  expect(Object.values(h.store.get('usage') as object)).toEqual([{ calls: 2, in: 1800, out: 80, sweep: 1 }])
})

test('a failing model stops the sweep at the first transcript and gives it up after 3 tries', async ($, on) => {
  const now = 100 * 24 * 60 * MIN
  const a = `${PROJECTS}/-work-api/a.jsonl`
  const b = `${PROJECTS}/-work-api/b.jsonl`
  const h = harness(on, { now, modelDown: true, files: { [a]: transcript(1, 'a'), [b]: transcript(1, 'b') }, mtimes: { [a]: now - 90 * MIN, [b]: now - 60 * MIN } })
  for (let i = 1; i <= 3; i++) {
    await start($)
    await h.clock.settle()
    expect(h.prompts).toHaveLength(i)
  }
  expect(h.prompts.every(p => p.includes('a 0'))).toBe(true)
  expect(h.events().filter(e => e.ev === 'sweep').map(e => e.stop)).toEqual(['model', 'model', 'model'])
  expect(h.events().find(e => e.ev === 'give-up')).toMatchObject({ sid: 'a', group: 'be', fails: 3 })
  expect(Object.keys(h.store.get('seen') as object)).toEqual(['a'])
  expect(Object.values(h.store.get('usage') as object)).toEqual([{ calls: 3, in: 0, out: 0, sweep: 3 }])
  await start($)
  await h.clock.settle()
  expect(h.prompts.at(-1)).toContain('b 0')
})

test('the sweep skips a transcript another session has claimed', async ($, on) => {
  const now = 100 * 24 * 60 * MIN
  const a = `${PROJECTS}/-work-api/a.jsonl`
  const b = `${PROJECTS}/-work-api/b.jsonl`
  const held = `${STATE}/claims/a`
  const h = harness(on, { now, dirs: [held], files: { [a]: transcript(1, 'a'), [b]: transcript(1, 'b') }, mtimes: { [a]: now - 90 * MIN, [b]: now - 60 * MIN, [held]: Date.now() } })
  await start($)
  await h.clock.settle()
  expect(h.prompts).toHaveLength(1)
  expect(h.prompts[0]).toContain('b 0')
  expect(h.events().find(e => e.ev === 'skip')).toMatchObject({ trigger: 'sweep', sid: 'a', why: 'claimed' })
  expect(Object.keys(h.store.get('seen') as object)).toEqual(['b'])
})

test('a transcript that throws is logged with its path and the sweep goes on', async ($, on) => {
  const now = 100 * 24 * 60 * MIN
  const a = `${PROJECTS}/-work-api/a.jsonl`
  const b = `${PROJECTS}/-work-api/b.jsonl`
  const h = harness(on, { now, files: { [a]: 'UNREADABLE', [b]: transcript(1, 'b') }, mtimes: { [a]: now - 90 * MIN, [b]: now - 60 * MIN } })
  await start($)
  await h.clock.settle()
  expect(h.events().find(e => e.ev === 'fail')).toMatchObject({ trigger: 'sweep', sid: 'a', group: 'be', path: a, error: `tail ${a}: exit 1` })
  expect(h.prompts).toHaveLength(1)
  expect(h.prompts[0]).toContain('b 0')
  expect(h.store.get('fails')).toEqual({ a: 1 })
})

test('a subagent turn does not arm the idle timer', async ($, on) => {
  const h = harness(on, { files: { [own()]: transcript(3) } })
  await start($)
  await turn($, 'agent-1')
  await h.clock.advance(15 * MIN)
  expect(h.prompts).toHaveLength(0)
})

test('a new turn cancels the idle timer', async ($, on) => {
  const h = harness(on, { files: { [own()]: transcript(3) } })
  await start($)
  await turn($)
  await h.clock.advance(5 * MIN)
  await $.turn.start({ text: 'more', turnId: 't2' })
  await h.clock.advance(10 * MIN)
  expect(h.prompts).toHaveLength(0)
})

test('a second idle within 30 minutes does not run again', async ($, on) => {
  const h = harness(on, { files: { [own()]: transcript(3) } })
  await start($)
  await turn($)
  await h.clock.advance(10 * MIN)
  h.files.set(own(), transcript(3) + transcript(3, 'later'))
  await turn($)
  await h.clock.advance(10 * MIN)
  expect(h.prompts).toHaveLength(1)
})

test('compaction runs once without waiting for a timer', async ($, on) => {
  const h = harness(on, { files: { [own()]: transcript(1) } })
  await start($)
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] })
  await h.clock.settle()
  expect(h.prompts).toHaveLength(1)
})

test('an exit only marks the session pending', async ($, on) => {
  const h = harness(on, { files: { [own()]: transcript(1) } })
  await start($)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: SID, resume: { id: SID } })
  expect(h.prompts).toHaveLength(0)
  expect(h.store.get('pending')).toEqual({ [SID]: CWD })
})

test('a /clear processes the ended session at once', async ($, on) => {
  const h = harness(on, { files: { [own()]: transcript(1) } })
  await start($)
  await $.session.end({ reason: 'clear', sessionId: SID, resume: { id: SID } })
  await h.clock.settle()
  expect(h.prompts).toHaveLength(1)
})

test('the next session sweeps a pending session even while it looks young', async ($, on) => {
  const now = 100 * 24 * 60 * MIN
  const ended = `${PROJECTS}/-work-api/ended.jsonl`
  const h = harness(on, { now, files: { [ended]: transcript(1, 'ended') }, mtimes: { [ended]: now - MIN } })
  h.store.set('pending', { ended: CWD })
  await start($)
  await h.clock.settle()
  expect(h.prompts).toHaveLength(1)
  expect(h.store.get('pending')).toEqual({})
})

test('a new session sweeps idle transcripts of its own group only', async ($, on) => {
  const now = 100 * 24 * 60 * MIN
  const old = `${PROJECTS}/-work-api-worktree-x/old.jsonl`
  const young = `${PROJECTS}/-work-api/young.jsonl`
  const elsewhere = `${PROJECTS}/-work-web/web.jsonl`
  const h = harness(on, {
    now,
    files: { [old]: transcript(1, 'old'), [young]: transcript(1, 'young'), [elsewhere]: transcript(1, 'web') },
    mtimes: { [old]: now - 60 * MIN, [young]: now - 5 * MIN, [elsewhere]: now - 60 * MIN },
  })
  await start($)
  await h.clock.settle()
  expect(h.prompts).toHaveLength(1)
  expect(h.prompts[0]).toContain('old 0')
  expect(h.store.get('seen')).toEqual({ old: { size: transcript(1, 'old').length, mtimeMs: now - 60 * MIN } })

  await start($)
  await h.clock.settle()
  expect(h.prompts).toHaveLength(1)
})

test('a headless session is left alone', async ($, on) => {
  const h = harness(on, { files: { [own()]: transcript(3) } })
  await start($, false)
  await turn($)
  await h.clock.advance(15 * MIN)
  await $.session.end({ reason: 'other', sessionId: SID, resume: { id: SID } })
  expect(h.prompts).toHaveLength(0)
  expect(h.store.get('pending')).toBe(undefined)
})

const NEW_REPO = '/work/billing'
const AUTO = `${STATE}/groups.auto.txt`

test('a git repo in no group is filed once by the model, then read from groups.auto.txt', async ($, on) => {
  const h = harness(on, { git: { [`${NEW_REPO}/worktree/fix`]: `${NEW_REPO}/.git` }, files: { [`${NEW_REPO}/README.md`]: '# billing\ninvoices service' } })
  h.answers.push(JSON.stringify({ action: 'join', group: 'be' }))
  await start($, true, `${NEW_REPO}/worktree/fix`)
  await h.clock.settle()
  expect(h.prompts).toHaveLength(1)
  expect(h.prompts[0]).toContain('ROOT: /work/billing')
  expect(h.prompts[0]).toContain('invoices service')
  expect(h.prompts[0]).toContain('- be\n  repos: api')
  expect(h.files.get(AUTO)).toBe('be /work/billing\n')
  expect(h.statuses).toContain('memory: billing -> be (auto)')
  expect(h.events().find(e => e.ev === 'autogroup')).toMatchObject({ root: NEW_REPO, action: 'join', group: 'be', written: 'written' })
  expect(h.events().find(e => e.ev === 'start')).toMatchObject({ group: 'be' })
  expect(Object.values(h.store.get('usage') as object)).toEqual([{ calls: 1, in: 900, out: 40, sweep: 0 }])

  await start($, true, NEW_REPO)
  await h.clock.settle()
  expect(h.prompts).toHaveLength(1)
  expect(h.git).toHaveLength(1)
})

test('an "other" answer is cached so the root costs one call ever', async ($, on) => {
  const h = harness(on, { git: { [NEW_REPO]: `${NEW_REPO}/.git` } })
  h.answers.push('{"action":"other"}')
  await start($, true, NEW_REPO)
  await h.clock.settle()
  expect(h.files.get(AUTO)).toBe('other /work/billing\n')
  expect(h.events().find(e => e.ev === 'autogroup')).toMatchObject({ group: 'other', why: 'model said other' })
  await start($, true, NEW_REPO)
  await h.clock.settle()
  expect(h.prompts).toHaveLength(1)
})

test('a garbled answer writes nothing, so the next session asks again', async ($, on) => {
  const h = harness(on, { git: { [NEW_REPO]: `${NEW_REPO}/.git` } })
  h.answers.push('not json')
  await start($, true, NEW_REPO)
  await h.clock.settle()
  expect(h.files.has(AUTO)).toBe(false)
  expect(h.events().find(e => e.ev === 'autogroup')).toMatchObject({ root: NEW_REPO, error: 'garbled reply: no parsable JSON' })
  expect(h.statuses).not.toContain('memory: billing -> other (auto)')
  await start($, true, NEW_REPO)
  await h.clock.settle()
  expect(h.prompts).toHaveLength(2)
})

test('a user rule beats an auto rule inside its root, even a longer one', async ($, on) => {
  const h = harness(on, { files: { [AUTO]: 'web /work/billing  # sites\n', [`${HOME}/.config/session-memory/groups.txt`]: 'be /work\n' } })
  await start($, true, NEW_REPO)
  await h.clock.settle()
  expect(h.events().find(e => e.ev === 'start')).toMatchObject({ group: 'be' })
})

test('a model error writes nothing, so the next session asks again', async ($, on) => {
  const h = harness(on, { git: { [NEW_REPO]: `${NEW_REPO}/.git` }, modelDown: true })
  await start($, true, NEW_REPO)
  await h.clock.settle()
  expect(h.files.has(AUTO)).toBe(false)
  expect(h.events().find(e => e.ev === 'autogroup')).toMatchObject({ root: NEW_REPO, error: 'timeout' })
  await start($, true, NEW_REPO)
  await h.clock.settle()
  expect(h.prompts).toHaveLength(2)
})

test('a dir outside git makes no call', async ($, on) => {
  const h = harness(on)
  await start($, true, '/work/notes')
  await h.clock.settle()
  expect(h.prompts).toHaveLength(0)
  expect(h.files.has(AUTO)).toBe(false)
})

test('autoGroups false never asks the model', { options: { autoGroups: false } }, async ($, on) => {
  const h = harness(on, { git: { [NEW_REPO]: `${NEW_REPO}/.git` } })
  await start($, true, NEW_REPO)
  await h.clock.settle()
  expect(h.git).toHaveLength(0)
  expect(h.prompts).toHaveLength(0)
})

test('a session under the macOS temp dir is never mined', async ($, on) => {
  const cwd = '/private/var/folders/ab/T/TestGate1/001'
  const h = harness(on, { files: { [own(`-private-var-folders-ab-T-TestGate1-001`)]: transcript(3) } })
  await start($, true, cwd)
  await turn($)
  await h.clock.advance(15 * MIN)
  expect(h.prompts).toHaveLength(0)
  expect(h.events()).toEqual([])
})

test('past the daily cap an unlisted repo stays other and the next session asks', { options: { dailyCalls: 0 } }, async ($, on) => {
  const h = harness(on, { git: { [NEW_REPO]: `${NEW_REPO}/.git` } })
  await start($, true, NEW_REPO)
  await h.clock.settle()
  expect(h.prompts).toHaveLength(0)
  expect(h.files.has(AUTO)).toBe(false)
  expect(h.events().find(e => e.ev === 'skip')).toMatchObject({ trigger: 'autogroup', root: NEW_REPO, why: 'cap' })
  expect(h.events().find(e => e.ev === 'start')).toMatchObject({ group: 'other' })
})

test('an idle run that made no call does not hold off the next idle run', async ($, on) => {
  const h = harness(on, { files: { [own()]: transcript(2) } })
  await start($)
  await turn($)
  await h.clock.advance(10 * MIN)
  expect(h.prompts).toHaveLength(0)
  h.files.set(own(), transcript(2) + transcript(1, 'third'))
  await turn($)
  await h.clock.advance(10 * MIN)
  expect(h.prompts).toHaveLength(1)
})

test('/memory-forget hides an item from L0 and the tools', async ($, on) => {
  const h = harness(on, { files: { [own()]: transcript(3) } })
  h.answers.push(opsFor('deploys need a human go'))
  await start($)
  await turn($)
  await h.clock.advance(10 * MIN)
  const forget = async (args: string) => String(((await $.command.run({ command: 'memory-forget', args } as never)) as { text?: string }).text)
  expect(await forget('i-1')).toContain('Forgot i-1: deploys need a human go')
  expect(h.items()[0]).toMatchObject({ id: 'i-1', dead: true })
  expect(h.tools.get('memory_open')).toContain('No items yet.')
  const search = String(((await $.tool.call({ tool: 'mcp__session-memory__memory_search', query: 'deploys' } as never)) as { result: unknown }).result)
  expect(search).not.toContain('i-1')
  expect(await forget('i-1')).toBe('No live item i-1 in group be.')
  expect(await forget('')).toContain('Usage')
})

test('/memory-forget waits for the group while autogroup is still asking the model', async ($, on) => {
  const h = harness(on, { git: { [NEW_REPO]: `${NEW_REPO}/.git` } })
  let release = () => {}
  h.model.hold = new Promise(r => (release = r))
  h.answers.push(JSON.stringify({ action: 'join', group: 'be' }))
  await start($, true, NEW_REPO)
  const forget = async (args: string) => String(((await $.command.run({ command: 'memory-forget', args } as never)) as { text?: string }).text)
  expect(await forget('i-9')).toContain('still finding')
  release()
  await h.clock.settle()
  expect(await forget('i-9')).toBe('No live item i-9 in group be.')
})

const backfillFixture = (on: On) => {
  const now = 100 * 24 * 60 * MIN
  const be = `${PROJECTS}/-work-api/be1.jsonl`
  const ai = `${PROJECTS}/-work-tools/ai1.jsonl`
  const other = `${PROJECTS}/-work-misc/other1.jsonl`
  return harness(on, {
    now,
    files: { [`${HOME}/.config/session-memory/groups.txt`]: `be ${CWD}\nai /work/tools\n`, [be]: transcript(1, 'be'), [ai]: transcript(1, 'ai'), [other]: transcript(1, 'other') },
    mtimes: { [be]: now - 60 * MIN, [ai]: now - 60 * MIN, [other]: now - 60 * MIN },
  })
}
const backfillCmd = async ($: Engine) => String(((await $.command.run({ command: 'memory-backfill', args: '' } as never)) as { text?: string }).text)

test('/memory-backfill mines idle transcripts of every group, other included', { options: { sweepMax: 0 } }, async ($, on) => {
  const h = backfillFixture(on)
  await start($)
  await h.clock.settle()
  expect(h.prompts).toHaveLength(0)
  expect(await backfillCmd($)).toContain('backfill started')
  await h.clock.settle()
  expect(h.prompts.map(p => p.match(/(be|ai|other) 0/)?.[1]).sort()).toEqual(['ai', 'be', 'other'])
  expect(h.events().find(e => e.ev === 'backfill')).toMatchObject({ done: { be: 1, ai: 1, other: 1 } })
})

test('a reply with no ops JSON leaves the transcript for a later sweep', async ($, on) => {
  const now = 100 * 24 * 60 * MIN
  const a = `${PROJECTS}/-work-api/a.jsonl`
  const h = harness(on, { now, files: { [a]: transcript(1, 'a') }, mtimes: { [a]: now - 90 * MIN } })
  h.answers.push('Nothing here worth keeping.')
  await start($)
  await h.clock.settle()
  expect(h.files.has(`${STATE}/be/processed.jsonl`)).toBe(false)
  expect(h.events().find(e => e.ev === 'model-error')).toMatchObject({ kind: 'parse', sid: 'a' })
  await start($)
  await h.clock.settle()
  expect(h.files.get(`${STATE}/be/processed.jsonl`)).toBe(`${JSON.stringify({ sid: 'a', from: 0, to: 2 })}\n`)
})

test('/memory-backfill stops at the first failing model call', { options: { sweepMax: 0 } }, async ($, on) => {
  const h = backfillFixture(on)
  await start($)
  await h.clock.settle()
  h.model.down = true
  await backfillCmd($)
  await h.clock.settle()
  expect(h.prompts).toHaveLength(1)
  expect(h.events().find(e => e.ev === 'backfill')).toMatchObject({ done: { be: 0 } })
})

test('/memory-backfill stops at the sweep share of dailyCalls', { options: { sweepMax: 0, dailyCalls: 6 } }, async ($, on) => {
  const h = backfillFixture(on)
  await start($)
  await backfillCmd($)
  await h.clock.settle()
  expect(h.prompts).toHaveLength(2)
  expect(await backfillCmd($)).toContain('used up')
})

const HSM_ITEM = { id: 'i-1', node: 'be', text: 'GKE pods cannot reach the yubihsm connector on the mac mini', type: 'gotcha', refs: { user: 1, agent: 0, against: 0, echo: 0 }, voters: { user: ['older'], agent: [], against: [], echo: [] }, first: '2026-11-01', last: '2026-11-01', conflicts_with: [], dead: false }

function nudgeFixture(on: On, pYes: number) {
  const h = harness(on, { files: { [`${STATE}/be/items.jsonl`]: `${JSON.stringify(HSM_ITEM)}\n`, [`${STATE}/be/nodes.json`]: JSON.stringify([{ id: 'be', parent: null, title: 'be' }]) } })
  const jev: string[] = []
  on('http.fetch', ($, e) => {
    jev.push(String(e.init?.body ?? ''))
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers: { v: { choice: pYes >= 0.5 ? 'YES' : 'NO', probabilities: { YES: pYes, NO: 1 - pYes } } } }) } }
  })
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: STEP_ANSWER.text, toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return { h, jev }
}

const STEP_ANSWER = { text: '' }
const submit = async ($: Engine, text: string) => (await $.prompt.submit({ text } as never)) as { context?: string[] }
const bash = async ($: Engine) => (await $.tool.call({ tool: 'Bash', command: 'ls' } as never)) as { context?: string[] }
async function step($: Engine, answer: string) {
  STEP_ANSWER.text = answer
  const s = $.turn.step({ turnId: 't1', index: 0, model: 'sonnet', messageCount: 1 } as never)
  for await (const _ of s);
  await s.result
}

test('a prompt that matches an item Jev calls relevant gets a memory_search nudge', { options: { jevKey: 'sk-or-test-secret' } }, async ($, on) => {
  const { h, jev } = nudgeFixture(on, 0.93)
  await start($)
  await h.clock.settle()
  const r = await submit($, 'why can the GKE pod not reach the yubihsm connector?')
  expect(r.context?.[0]).toContain('topic be: i-1')
  expect(jev).toHaveLength(1)
  expect(JSON.parse(jev[0]!).state.memory_item).toBe(HSM_ITEM.text)
  expect(h.events().find(e => e.ev === 'nudge')).toMatchObject({ src: 'user', topic: 'be', p: 0.93, sent: true })
  expect((await submit($, 'yubihsm connector again')).context).toBeUndefined()
  expect(h.files.get(`${STATE}/events.jsonl`)).not.toContain('sk-or-test-secret')
  expect(h.events().find(e => e.ev === 'start')).toMatchObject({ jev: true })
})

test('a match Jev calls unrelated sends nothing but is logged', { options: { jevKey: 'sk-or-test-secret' } }, async ($, on) => {
  const { h } = nudgeFixture(on, 0.2)
  await start($)
  await h.clock.settle()
  expect((await submit($, 'why can the GKE pod not reach the yubihsm connector?')).context).toBeUndefined()
  expect(h.events().find(e => e.ev === 'nudge')).toMatchObject({ p: 0.2, sent: false })
})

test('a match in the model text rides on the next tool result, once', { options: { jevKey: 'sk-or-test-secret' } }, async ($, on) => {
  const { h } = nudgeFixture(on, 0.93)
  await start($)
  await h.clock.settle()
  await step($, 'Checking whether the yubihsm connector is reachable from GKE.')
  await h.clock.settle()
  expect((await bash($)).context?.[0]).toContain('memory_search')
  expect((await bash($)).context).toBeUndefined()
  expect(h.events().find(e => e.ev === 'nudge')).toMatchObject({ src: 'assistant', sent: true })
})

test('no jevKey means no nudge and no Jev call', async ($, on) => {
  const { h, jev } = nudgeFixture(on, 0.93)
  await start($)
  await h.clock.settle()
  expect((await submit($, 'why can the GKE pod not reach the yubihsm connector?')).context).toBeUndefined()
  expect(jev).toHaveLength(0)
})
