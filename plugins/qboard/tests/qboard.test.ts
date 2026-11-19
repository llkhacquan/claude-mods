import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Board } from '../types'
import { asksInChat, draftPreview } from '../hooks/core'
import { DESKTOP_PANE_GOLDEN } from './desktop-pane-golden'
import { TERMINAL_PANE_GOLDEN } from './terminal-pane-golden'

const SID = 'sess-1'
const EMPTY_BOARD: Board = { session: '', next: 1, items: [] }
const fileOf = (sid: string) => `/home/q/.local/state/qboard/${sid}.json`
const FILE = fileOf(SID)

function harness(on: On, seed?: Board, opts: { sid?: string; env?: Record<string, string>; files?: Record<string, string>; mtimes?: Record<string, number>; listedGone?: string[]; submitGate?: Promise<void>; dropSubmit?: { reason?: string }; existsLog?: string[] } = {}) {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}))
  if (seed) files.set(FILE, JSON.stringify(seed))
  const seen: { text: string; context?: readonly string[] }[] = []
  const env: Record<string, string> = { HOME: '/home/q', ...opts.env }
  const sid = { value: opts.sid ?? SID }
  const wipedKeys = new Set<string>()
  const wiped = {
    get value() {
      return wipedKeys.size > 0
    },
    set value(v: boolean) {
      if (v) ['board', 'queued'].forEach(k => wipedKeys.add(k))
      else wipedKeys.clear()
    },
  }
  on('env.get', ($, e) => ({ value: env[e.name] }))
  on('session.id', () => ({ value: sid.value }))
  on('session.cwd', () => ({ value: '/work' }))
  const panes = new Map<string, { isShown: boolean }>()
  const opens: { id: string; focus?: true; columns?: number }[] = []
  on('ui.panes', () => ({ value: [...panes].map(([id, p]) => ({ id, title: id, isShown: p.isShown, isFocused: false, isPlaced: p.isShown })) }))
  on('ui.open', ($, e) => {
    opens.push({ id: e.id, focus: e.focus, columns: e.columns })
    panes.set(e.id, { isShown: true })
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    panes.delete(e.id)
    return { value: undefined }
  })
  const opened: string[][] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('state.get', async ($, e, next) => {
    const r = await next(e)
    if (!wipedKeys.has(e.key) || !r.value) return r
    return { value: { ...r.value, value: e.key === 'board' ? EMPTY_BOARD : {} } }
  })
  on('state.set', ($, e, next) => {
    wipedKeys.delete(e.key)
    return next(e)
  })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__qboard__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => (opts.existsLog?.push(e.path), { value: files.has(e.path) || [...files.keys()].some(k => k.startsWith(`${e.path}/`)) }))
  on('fs.list', ($, e) => ({
    value: [...(opts.listedGone ?? []), ...files.keys()]
      .filter(k => k.startsWith(`${e.path}/`))
      .map(k => ({ name: k.slice(e.path.length + 1), kind: 'file' as const, size: 0, mtimeMs: opts.mtimes?.[k] ?? Date.now(), isLink: false })),
  }))
  on('process.run', ($, e) => {
    if (e.argv[0] === 'rm') files.delete(e.argv.at(-1)!)
    if (e.argv[0] === 'open') opened.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  const logs: string[] = []
  on('ui.log', ($, e) => (logs.push(e.text), { value: undefined }))
  on('prompt.submit', async ($, e) => {
    await opts.submitGate
    if (opts.dropSubmit?.reason) return { drop: opts.dropSubmit.reason }
    seen.push({ text: e.text, context: e.context })
    return { text: e.text, context: e.context }
  })
  const board = (id = SID) => JSON.parse(files.get(fileOf(id)) ?? 'null') as Board
  return { board, seen, sid, wiped, files, opened, panes, opens, logs }
}

const RUN = { command: 'qboard', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const
const start = ($: Engine) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
const ask = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__qboard__ask', ...input })
const type = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

test('ask gives increasing ids and saves the board', async ($, on) => {
  const { board } = harness(on)
  await start($)
  const first = await ask($, { text: 'Writer?', options: ['CLI', 'mod tool'], lean: 2 })
  const second = await ask($, { text: 'Pane layout?' })
  expect(first.result).toBe('Q1 is on the board. Options: Q1.1 CLI, Q1.2 mod tool. In chat write only "Q1 on board" and your lean.')
  expect(second.result).toBe('Q2 is on the board. In chat write only "Q2 on board" and your lean.')
  expect(board()).toMatchObject({ session: SID, next: 3, items: [{ id: 'Q1', lean: 2, status: 'open' }, { id: 'Q2', status: 'open' }] })
})

test('ask refuses a lean outside the options', async ($, on) => {
  harness(on)
  await start($)
  const r = await ask($, { text: 'Writer?', options: ['CLI'], lean: 2 })
  expect(r).toMatchObject({ isError: true, text: 'qboard: lean must point at one of the options.' })
})

test('a resumed session keeps counting from the saved board', async ($, on) => {
  const { board } = harness(on, { session: SID, next: 7, items: [] })
  await start($)
  await ask($, { text: 'Kinds?' })
  expect(board().items[0]!.id).toBe('Q7')
})

test('an option answer marks the question and tells the model', async ($, on) => {
  const { board, seen } = harness(on)
  await start($)
  await ask($, { text: 'Writer?', options: ['CLI', 'mod tool'] })
  await type($, 'Q1 2')
  expect(board().items[0]).toMatchObject({ status: 'answered', answer: { option: 2 } })
  expect(seen.at(-1)!.context).toEqual(['qboard: Q1 "Writer?" answered: option 2 "mod tool".'])
})

test('one prompt answers several questions', async ($, on) => {
  const { board } = harness(on)
  await start($)
  await ask($, { text: 'A?', options: ['x', 'y'] })
  await ask($, { text: 'B?', options: ['x', 'y'] })
  await type($, 'Q1.2, Q2 1 and go')
  expect(board().items.map(q => q.status)).toEqual(['open', 'open'])
  await type($, 'Q1.2 and Q2 1')
  expect(board().items.map(q => q.answer?.option)).toEqual([2, 1])
})

test('an option pick followed by more words goes to claude, the pane label still answers', async ($, on) => {
  const { board, seen } = harness(on)
  await start($)
  await ask($, { text: 'A?', options: ['x', 'y', 'z'] })
  await ask($, { text: 'B?', options: ['Push both', 'Hold'] })
  await type($, 'Q1 2 looks risky, why not 3?')
  expect(board().items[0]).toMatchObject({ status: 'open', thread: [{ who: 'user', text: '2 looks risky, why not 3?' }] })
  expect(seen.at(-1)!.context![0]).toContain('qboard: the user wrote about Q1 "A?": "2 looks risky, why not 3?". The card is still open.')
  await type($, 'Q2 2 (Hold)')
  expect(board().items[1]).toMatchObject({ status: 'answered', answer: { option: 2 } })
  await type($, 'not Q1 3')
  expect(board().items[0]).toMatchObject({ status: 'open' })
  expect(seen.at(-1)!.context).toBeUndefined()
  await type($, 'Q1 3 is fine, Q2 1')
  expect(board().items[0]).toMatchObject({ status: 'open' })
  expect(board().items[0]!.thread).toHaveLength(2)
  expect(seen.at(-1)!.context).toEqual([
    'qboard: Q2 is already answered, left unchanged. If the user meant to change the answer, call mcp__qboard__answer.',
    expect.stringContaining('qboard: the user wrote about Q1 "A?": "3 is fine, Q2 1".'),
  ])
  await type($, 'Q1 3.')
  expect(board().items[0]).toMatchObject({ status: 'answered', answer: { option: 3 } })
})

test('a bare number answers the oldest open question', async ($, on) => {
  const { board, seen } = harness(on)
  await start($)
  await ask($, { text: 'A?', options: ['x', 'y'] })
  await ask($, { text: 'B?', options: ['x', 'y'] })
  await type($, 'Q1 1')
  await type($, '2')
  expect(board().items[1]).toMatchObject({ status: 'answered', answer: { option: 2 } })
  expect(seen.at(-1)!.context![0]).toContain('bare "2" read as the oldest open question')
})

test('free text after an id goes to claude and leaves the card open', async ($, on) => {
  const { board, seen } = harness(on)
  await start($)
  await ask($, { text: 'Pane layout?' })
  await type($, 'Q1 dock right, band on top')
  expect(board().items[0]).toMatchObject({ status: 'open', thread: [{ who: 'user', text: 'dock right, band on top' }] })
  expect(board().items[0]!.answer).toBeUndefined()
  expect(seen.at(-1)!.context).toEqual([
    'qboard: the user wrote about Q1 "Pane layout?": "dock right, band on top". The card is still open. If it answers Q1, record it with mcp__qboard__answer (option if it names one, else text); if it asks about Q1, reply with mcp__qboard__explain; if it changes the question, use mcp__qboard__edit.',
  ])
  await $.tool.call({ tool: 'mcp__qboard__answer', id: 'Q1', text: 'dock right, band on top' })
  expect(board().items[0]).toMatchObject({ status: 'answered', answer: { text: 'dock right, band on top' } })
})

test('option refs and a bare digit still answer, a ? line is still a follow-up', async ($, on) => {
  const { board, seen } = harness(on)
  await start($)
  await ask($, { text: 'A?', options: ['x', 'y'] })
  await ask($, { text: 'B?', options: ['x', 'y'] })
  await ask($, { text: 'C?', options: ['x', 'y'] })
  await type($, 'Q7 ? why')
  expect(seen.at(-1)!.context![0]).toContain('Q7 is not on the board')
  await type($, 'Q3 ? why')
  expect(board().items[2]).toMatchObject({ status: 'open', thread: [{ who: 'user', text: 'why' }] })
  expect(seen.at(-1)!.context![0]).toContain('the user asks about Q3')
  await type($, 'Q2 2')
  await type($, '1')
  expect(board().items.map(q => q.answer?.option)).toEqual([1, 2, undefined])
})

test('an unknown id is reported, an ordinary prompt passes untouched', async ($, on) => {
  const { seen } = harness(on)
  await start($)
  await ask($, { text: 'A?', options: ['x', 'y'] })
  await type($, 'Q9 1')
  expect(seen.at(-1)!.context).toEqual(['qboard: Q9 is not on the board.'])
  await type($, 'run the tests please')
  expect(seen.at(-1)!.context).toBeUndefined()
})

test('close takes a question off and a closed one cannot be answered', async ($, on) => {
  const { board, seen } = harness(on)
  await start($)
  await ask($, { text: 'A?', options: ['x', 'y'] })
  await ask($, { text: 'B?', options: ['x', 'y'] })
  const r = await $.tool.call({ tool: 'mcp__qboard__close', id: 'Q1', reason: 'moot' })
  expect(r.result).toBe('Q1 closed.')
  await type($, 'Q1 1')
  expect(board().items[0]).toMatchObject({ status: 'closed', closed: { reason: 'moot' } })
  expect(seen.at(-1)!.context).toEqual(['qboard: Q1 is closed, left unchanged.'])
})

test('a question that starts with an id stays open and reaches claude whole', async ($, on) => {
  const { board, seen } = harness(on)
  await start($)
  await ask($, { text: 'A?', options: ['x', 'y'] })
  await ask($, { text: 'B?', options: ['x', 'y'] })
  await type($, 'Q2 well, might qboard just send a noti to the model?\nit is resolved?')
  expect(board().items[1]).toMatchObject({ status: 'open' })
  expect(seen.at(-1)!.context![0]).toContain('"well, might qboard just send a noti to the model?\nit is resolved?". The card is still open.')
})

test('claude marks a loosely typed answer with the answer tool', async ($, on) => {
  const { board, seen } = harness(on)
  await start($)
  await ask($, { text: 'A?', options: ['x', 'y'] })
  await type($, 'q 1 .2')
  expect(seen.at(-1)!.context).toBeUndefined()
  const r = await $.tool.call({ tool: 'mcp__qboard__answer', id: 'Q1', option: 2 })
  expect(r.result).toBe('Q1 answered: option 2 "y".')
  expect(board().items[0]).toMatchObject({ status: 'answered', answer: { option: 2 } })
  const bad = await $.tool.call({ tool: 'mcp__qboard__answer', id: 'Q1', option: 3 })
  expect(bad).toMatchObject({ isError: true, text: 'qboard: Q1 has no option 3.' })
})

const PASTED = `TASK-201 is done and checked: #74 merged as 9e2b4c67, it is on master, and the tracker says Done. The flaky parser test is fixed. The lint hook fired on the rebase, which pulled in other people's code, so those are not my comments.

Now 2 workers are busy, TASK-168 and TASK-157, so 3 spots are free.

Q3. Which tickets start now?
- Q3.1 TASK-186 + TASK-173
- Q3.2 TASK-186 only
- Q3.3 TASK-186 + TASK-176
- Q3.4 None now

Lean Q3.1. Reason: few PRs are open now, which is the right time for the big TASK-173 refactor. TASK-186 is small and touches only a script. TASK-176 can wait and go out with the next release, so the build is signed once.

✻ Churned for 34s · done 12:13 AM

❯ you should explain each ticket => then ask me should we do it... => at least explain few lines
  i mean i do not know which ticket just by the number...
  => save this to rules
=> btw, => this is a good usecase we should note somewhere`

async function threeQuestions($: Engine) {
  await ask($, { text: 'A?', options: ['x', 'y'] })
  await ask($, { text: 'B?', options: ['x', 'y'] })
  await ask($, { text: 'Push?', options: ['Push both', 'Push api only', 'Hold', 'Later'] })
}

test('a pasted option list does not re-answer an answered question', async ($, on) => {
  const { board, seen } = harness(on)
  await start($)
  await threeQuestions($)
  await $.tool.call({ tool: 'mcp__qboard__answer', id: 'Q3', text: 'squash,fixup similar commits to 1 unit first' })
  await type($, PASTED)
  expect(board().items[2]!.answer).toMatchObject({ text: 'squash,fixup similar commits to 1 unit first' })
  expect(board().items[2]!.answer!.option).toBeUndefined()
  expect(seen.at(-1)!.context).toEqual([
    'qboard: Q3 is already answered, left unchanged. If the user meant to change the answer, call mcp__qboard__answer.',
  ])
})

test('a pasted option list does not answer an open question', async ($, on) => {
  const { board, seen } = harness(on)
  await start($)
  await threeQuestions($)
  await type($, PASTED)
  expect(board().items[2]).toMatchObject({ status: 'open' })
  expect(seen.at(-1)!.context).toEqual([
    'qboard: Q3 is named with several options, read as a pasted list, left open.',
  ])
})

test('a pasted question heading is not a free-text answer', async ($, on) => {
  const { board, seen } = harness(on)
  await start($)
  await threeQuestions($)
  await type($, 'Q3. Which tickets start now?')
  expect(board().items[2]).toMatchObject({ status: 'open' })
  expect(seen.at(-1)!.context![0]).toContain('"Q3. ..." read as a pasted heading')
})

test('free text that starts with a digit is not read as an option', async ($, on) => {
  const { board, seen } = harness(on)
  await start($)
  await ask($, { text: 'How many workers?' })
  await type($, 'Q1 30 minutes of each')
  expect(board().items[0]).toMatchObject({ status: 'open' })
  expect(seen.at(-1)!.context![0]).toContain('"30 minutes of each". The card is still open.')
})

test('ids of 10 and more are never read as a lower id plus an option', async ($, on) => {
  const { board } = harness(on, { session: SID, next: 1, items: [] })
  await start($)
  for (let i = 0; i < 12; i++) await ask($, { text: `Q${i + 1}?`, options: ['x', 'y'] })
  await type($, 'Q12 use postgres')
  expect(board().items[0]).toMatchObject({ status: 'open' })
  expect(board().items[0]!.thread).toBeUndefined()
  expect(board().items[11]).toMatchObject({ status: 'open', thread: [{ who: 'user', text: 'use postgres' }] })
  await type($, 'Q11.2')
  expect(board().items[0]).toMatchObject({ status: 'open' })
  expect(board().items[10]!.answer).toMatchObject({ option: 2 })
})

test('a pasted chat line with the lean does not answer', async ($, on) => {
  const { board, seen } = harness(on)
  await start($)
  await threeQuestions($)
  await type($, 'Q3 on board. Lean Q3.1: fewer open PRs now.')
  expect(board().items[2]).toMatchObject({ status: 'open' })
  expect(seen.at(-1)!.context).toEqual(['qboard: "Q3 on board" read as pasted chat text, Q3 left open.'])
})

test('free text to an answered question is left unchanged', async ($, on) => {
  const { board, seen } = harness(on)
  await start($)
  await ask($, { text: 'A?', options: ['x', 'y'] })
  await type($, 'Q1 1')
  await type($, 'Q1 dock left instead')
  expect(board().items[0]!.answer).toMatchObject({ option: 1 })
  expect(seen.at(-1)!.context![0]).toContain('Q1 is already answered, left unchanged')
})

test('a typed answer to an answered question goes through the answer tool', async ($, on) => {
  const { board, seen } = harness(on)
  await start($)
  await ask($, { text: 'A?', options: ['x', 'y'] })
  await type($, 'Q1 1')
  await type($, 'Q1 2')
  expect(board().items[0]!.answer).toMatchObject({ option: 1 })
  expect(seen.at(-1)!.context![0]).toContain('Q1 is already answered, left unchanged')
  await $.tool.call({ tool: 'mcp__qboard__answer', id: 'Q1', option: 2 })
  expect(board().items[0]!.answer).toMatchObject({ option: 2 })
})

const PANE = {
  plugin: 'qboard',
  component: 'Pane',
  requestId: 'qboard',
  surface: 'terminal',
  props: { title: 'qboard', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('the pane lists open questions and a press answers through the prompt', async ($, on) => {
  const { board, seen } = harness(on)
  await start($)
  await ask($, { text: 'Writer?', options: ['CLI', 'mod tool'], lean: 2 })
  await ask($, { text: 'Layout?' })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /2 open/ }))?.text).toBe('2 open')
  expect(await ui.find({ type: 'Text', text: '*' })).toBeDefined()
  await ui.press({ key: 'Q1-2' })
  expect(seen.at(-1)!.text).toBe('Q1 2 (mod tool)')
  expect(board().items[0]).toMatchObject({ status: 'answered', answer: { option: 2 } })
  expect((await ui.find({ type: 'Text', text: /1 open/ }))?.text).toBe('1 open')
  await ui.unmount()
})

test('the desktop pane draws plain labels and no terminal key hints', async ($, on) => {
  harness(on, undefined, { files: { '/work/a.md': 'x' } })
  await start($)
  await ask($, { text: 'Writer? see /work/a.md', options: ['CLI', 'mod tool'], lean: 2 })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Button', key: 'Q1-more' }))?.text).toBe('Explain more')
  expect((await ui.find({ type: 'Button', key: 'Q1-ask' }))?.text).toBe('Ask')
  expect((await ui.find({ type: 'Button', key: 'Q1-file-1' }))?.text).toBe('Open a.md')
  expect((await ui.find({ type: 'Button', key: 'Q1-2' }))?.text).toBe('Q1.2  mod tool  (recommended)')
  expect((await ui.find({ type: 'Button', key: 'Q1-1' }))?.text).toBe('Q1.1  CLI')
  expect(await ui.find({ type: 'Text', text: /ctrl\+x tab|\[/ })).toBeUndefined()
  await ui.unmount()
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Button', key: 'open-pane' }))?.text).toBe('Open board')
  await band.unmount()
})

test('a dot with spaces still picks the option', async ($, on) => {
  const { board } = harness(on)
  await start($)
  await ask($, { text: 'A?', options: ['x', 'y'] })
  await ask($, { text: 'B?' })
  await type($, 'q1. 2')
  expect(board().items[0]!.answer).toMatchObject({ option: 2 })
  await type($, 'q2. 1\n[Image #1] btw the lean render wrong')
  expect(board().items[1]).toMatchObject({ status: 'open', thread: [{ who: 'user', text: '1\n[Image #1] btw the lean render wrong' }] })
})

test('option notes are saved and shown under their options', async ($, on) => {
  const { board } = harness(on)
  await start($)
  await ask($, { text: 'Push?', options: ['Push both', 'Hold'], notes: ['api and web', ''], lean: 1 })
  expect(board().items[0]).toMatchObject({ notes: ['api and web', ''] })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: 'api and web' })).toBeDefined()
  await ui.unmount()
})

test('ask refuses more notes than options', async ($, on) => {
  harness(on)
  await start($)
  const r = await ask($, { text: 'A?', options: ['x'], notes: ['a', 'b'] })
  expect(r).toMatchObject({ isError: true, text: 'qboard: notes must not outnumber the options.' })
})

test('a board file saved before notes still loads and renders', async ($, on) => {
  const old: Board = {
    session: SID,
    next: 2,
    items: [{ kind: 'q', id: 'Q1', text: 'Writer?', options: ['CLI', 'mod tool'], lean: 2, status: 'open', at: '2026-11-17T00:00:00Z' }],
  }
  harness(on, old)
  await start($)
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /1 open/ }))?.text).toBe('1 open')
  expect(await ui.find({ type: 'Button', key: 'Q1-2' })).toBeDefined()
  await ui.unmount()
})

test('explain more and a ? question are follow-ups, never answers', async ($, on) => {
  const { board, seen } = harness(on)
  await start($)
  await ask($, { text: 'Push?', options: ['Push both', 'Hold'] })
  await type($, 'Q1 explain more')
  expect(board().items[0]).toMatchObject({ status: 'open' })
  expect(seen.at(-1)!.context).toEqual([
    'qboard: the user wants Q1 "Push?" explained more. Reply with mcp__qboard__explain for Q1 (or rewrite the question with mcp__qboard__edit if it was unclear), then write only "Q1 explained on board" in chat.',
  ])
  await type($, 'Q1 ? why not Q1.2 now')
  expect(board().items[0]).toMatchObject({
    status: 'open',
    thread: [
      { who: 'user', text: 'explain more' },
      { who: 'user', text: 'why not Q1.2 now' },
    ],
  })
  expect(seen.at(-1)!.context![0]).toContain('the user asks about Q1 "Push?": "why not Q1.2 now"')
})

test('explain adds the reply to the thread and the pane shows both sides', async ($, on) => {
  const { board } = harness(on)
  await start($)
  await ask($, { text: 'Push?', options: ['Push both', 'Hold'] })
  await type($, 'Q1 ? what breaks if we hold')
  const r = await $.tool.call({ tool: 'mcp__qboard__explain', id: 'Q1', text: 'Nothing breaks; the fix just ships later.' })
  expect(r.result).toBe('Q1 thread updated. In chat write only "Q1 explained on board".')
  expect(board().items[0]!.thread!.map(t => t.who)).toEqual(['user', 'claude'])
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: 'what breaks if we hold' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Nothing breaks; the fix just ships later.' })).toBeDefined()
  await ui.unmount()
})

test('explain and edit are denied on an answered or closed question, allowed on an open one', async ($, on) => {
  const { board } = harness(on)
  await start($)
  await ask($, { text: 'A?', options: ['x', 'y'] })
  await ask($, { text: 'B?', options: ['x', 'y'] })
  await ask($, { text: 'C?', options: ['x', 'y'] })
  await $.tool.call({ tool: 'mcp__qboard__answer', id: 'Q1', option: 1 })
  await $.tool.call({ tool: 'mcp__qboard__close', id: 'Q2' })
  const done = (id: string, status: string) => `qboard: ${id} is ${status} (done); the user no longer sees its thread. Ask a new question with mcp__qboard__ask.`
  for (const [id, status] of [['Q1', 'answered'], ['Q2', 'closed']] as const) {
    const ex = await $.tool.call({ tool: 'mcp__qboard__explain', id, text: 'hi' })
    expect(ex).toMatchObject({ isError: true, text: done(id, status) })
    const ed = await $.tool.call({ tool: 'mcp__qboard__edit', id, text: 'new?' })
    expect(ed).toMatchObject({ isError: true, text: done(id, status) })
  }
  expect(board().items[0]).toMatchObject({ text: 'A?', status: 'answered', answer: { option: 1 } })
  expect(board().items[0]!.thread).toBeUndefined()
  const ok = await $.tool.call({ tool: 'mcp__qboard__explain', id: 'Q3', text: 'hi' })
  expect(ok.result).toContain('Q3 thread updated')
  const ed = await $.tool.call({ tool: 'mcp__qboard__edit', id: 'Q3', text: 'C2?' })
  expect(ed.result).toBe('Q3 updated.')
})

test('a follow-up on an answered question writes no thread and points at ask', async ($, on) => {
  const { board, seen } = harness(on)
  await start($)
  await ask($, { text: 'A?', options: ['x', 'y'] })
  await type($, 'Q1 2')
  await type($, 'Q1 ? why not 1')
  expect(board().items[0]!.thread).toBeUndefined()
  expect(seen.at(-1)!.context).toEqual(['qboard: Q1 is answered (done), left unchanged. Answer the user in chat, or ask a new question with mcp__qboard__ask.'])
})

test('the pane buttons send explain more and the typed question', async ($, on) => {
  const { board, seen } = harness(on)
  await start($)
  await ask($, { text: 'Push?', options: ['Push both', 'Hold'] })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'Q1-more' })
  expect(seen.at(-1)!.text).toBe('Q1 explain more')
  await ui.input({ key: 'Q1-input', text: 'why hold', kind: 'change' })
  await ui.press({ key: 'Q1-ask' })
  expect(seen.at(-1)!.text).toBe('Q1 ? why hold')
  expect(board().items[0]).toMatchObject({
    status: 'open',
    thread: [
      { who: 'user', text: 'explain more' },
      { who: 'user', text: 'why hold' },
    ],
  })
  await ui.unmount()
})

test('explain more waits for the reply: a second press sends nothing until claude explains', async ($, on) => {
  const { seen } = harness(on)
  await start($)
  await ask($, { text: 'Push?', options: ['Push both', 'Hold'] })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'Q1-more' })
  expect(await ui.find({ type: 'Button', key: 'Q1-more' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /waiting for claude/ })).toBeDefined()
  expect(seen.filter(s => s.text === 'Q1 explain more')).toHaveLength(1)
  await $.tool.call({ tool: 'mcp__qboard__explain', id: 'Q1', text: 'Hold ships the fix later.' })
  await ui.press({ key: 'Q1-more' })
  expect(seen.filter(s => s.text === 'Q1 explain more')).toHaveLength(2)
  await ui.unmount()
})

async function turnEnd($: Engine, clock: ReturnType<typeof mock.clock>) {
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(0)
}

test('a dropped press is queued and sent once at the next turn end', async ($, on) => {
  const drop = { reason: 'a Stop stands' as string | undefined }
  const { board, seen } = harness(on, undefined, { dropSubmit: drop })
  const clock = mock.clock(on)
  const filled: string[] = []
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  await start($)
  await ask($, { text: 'Push?', options: ['Push both', 'Hold'] })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'Q1-more' })
  await ui.press({ key: 'Q1-2' })
  expect(filled).toEqual([])
  expect(board().items[0]).toMatchObject({ status: 'open' })
  expect(board().items[0]).not.toHaveProperty('thread')
  expect(await ui.find({ type: 'Text', text: /Q1 2 +\(queued, sends after the turn\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Q1 explain more \(queued/ })).toBeDefined()
  drop.reason = undefined
  await turnEnd($, clock)
  await turnEnd($, clock)
  expect(seen.map(s => s.text)).toEqual(['Q1 explain more', 'Q1 2 (Hold)'])
  expect(board().items[0]).toMatchObject({ status: 'answered', answer: { option: 2 } })
  expect(board().items[0]!.thread).toHaveLength(1)
  expect(filled).toEqual([])
  await ui.unmount()
})

test('a press still dropped after five tries falls back to filling the prompt', async ($, on) => {
  const { board } = harness(on, undefined, { dropSubmit: { reason: 'blocked by a hook' } })
  const clock = mock.clock(on)
  const filled: string[] = []
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  await start($)
  await ask($, { text: 'Push?', options: ['Push both', 'Hold'] })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'Q1-1' })
  for (let i = 0; i < 3; i++) await turnEnd($, clock)
  expect(filled).toEqual([])
  await turnEnd($, clock)
  expect(filled).toEqual(['Q1 1'])
  await turnEnd($, clock)
  expect(filled).toEqual(['Q1 1'])
  expect(board().items[0]).toMatchObject({ status: 'open' })
  expect(await ui.find({ type: 'Button', key: 'Q1-1' })).toBeDefined()
  await ui.unmount()
})

test('a text answer filled into the prompt still answers when sent, typed text does not', async ($, on) => {
  const { board } = harness(on)
  const filled: string[] = []
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  await start($)
  await ask($, { text: 'Workers?', options: ['one', 'two'] })
  await ask($, { text: 'Dock?' })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'mode' })
  await ui.input({ key: 'Q1-input', text: '2 workers\nfor now' })
  expect(filled).toEqual(['Q1 2 workers\nfor now'])
  await type($, 'Q2 qboard')
  await type($, 'Q1 2 workers\nfor now')
  expect(board().items[0]).toMatchObject({ status: 'answered', answer: { text: '2 workers\nfor now' } })
  expect(board().items[1]).toMatchObject({ status: 'open' })
  await ui.unmount()
})

test('a queued follow-up hides [ask], so a second one cannot replace it', async ($, on) => {
  harness(on, undefined, { dropSubmit: { reason: 'a Stop stands' } })
  await start($)
  await ask($, { text: 'Push?', options: ['Push both', 'Hold'] })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'Q1-more' })
  expect(await ui.find({ type: 'Button', key: 'Q1-ask' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'Q1-1' })).toBeDefined()
  await ui.unmount()
})

test('a queued answer survives /clear and is sent at the next turn end', async ($, on) => {
  const clock = mock.clock(on)
  const drop = { reason: 'a Stop stands' as string | undefined }
  const h = harness(on, undefined, { dropSubmit: drop })
  await start($)
  await ask($, { text: 'Push?', options: ['Push both', 'Hold'] })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'Q1-2' })
  await ui.unmount()
  await switchSession($, clock, h, 'clear', 'sess-2')
  drop.reason = undefined
  await turnEnd($, clock)
  expect(h.seen.map(s => s.text)).toEqual(['Q1 2 (Hold)'])
  expect(h.board('sess-2').items[0]).toMatchObject({ status: 'answered', answer: { option: 2 } })
})

test('a queued answer to a question answered meanwhile is not sent', async ($, on) => {
  const drop = { reason: 'a Stop stands' as string | undefined }
  const { seen } = harness(on, undefined, { dropSubmit: drop })
  const clock = mock.clock(on)
  await start($)
  await ask($, { text: 'Push?', options: ['Push both', 'Hold'] })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'Q1-1' })
  drop.reason = undefined
  await type($, 'Q1 2')
  await turnEnd($, clock)
  expect(seen.map(s => s.text)).toEqual(['Q1 2'])
  await ui.unmount()
})

test('an edit that answers explain more ends the wait', async ($, on) => {
  const { board } = harness(on)
  await start($)
  await ask($, { text: 'Push?', options: ['Push both', 'Hold'] })
  await type($, 'Q1 explain more')
  await $.tool.call({ tool: 'mcp__qboard__edit', id: 'Q1', text: 'Push both repos now, or hold until Monday?' })
  expect(board().items[0]!.thread!.map(t => t.who)).toEqual(['user', 'claude'])
  await $.tool.call({ tool: 'mcp__qboard__edit', id: 'Q1', text: 'Push both now?' })
  expect(board().items[0]!.thread).toHaveLength(2)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Button', key: 'Q1-more' })).toBeDefined()
  await ui.unmount()
})

test('a reply that never comes stops blocking explain more after a while', async ($, on) => {
  const at = new Date(Date.now() - 10 * 60_000).toISOString()
  harness(on, {
    session: SID,
    next: 2,
    items: [{ kind: 'q', id: 'Q1', text: 'Push?', status: 'open', at, thread: [{ who: 'user', text: 'explain more', at }] }],
  } as Board)
  await start($)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Button', key: 'Q1-more' })).toBeDefined()
  await ui.unmount()
})

test('a typed answer stays on the card, dim, while it is being sent', async ($, on) => {
  let release!: () => void
  const { board } = harness(on, undefined, { submitGate: new Promise<void>(r => (release = r)) })
  await start($)
  await ask($, { text: 'Push?', options: ['Push both', 'Hold'] })
  const ui = await $.ui.mount(PANE)
  void ui.input({ key: 'Q1-input', text: 'hold until Monday' })
  expect(await ui.find({ type: 'Text', text: /hold until Monday {2}\(sending\.\.\.\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Input', key: 'Q1-input' })).toBeUndefined()
  release()
  expect(await ui.find({ type: 'Text', text: 'all answered' })).toBeDefined()
  expect(board().items[0]).toMatchObject({ status: 'answered', answer: { text: 'hold until Monday' } })
  await ui.unmount()
})

test('edit rewrites a question in place and new options reset notes and lean', async ($, on) => {
  const { board } = harness(on)
  await start($)
  await ask($, { text: 'Push?', options: ['Push both', 'Hold'], notes: ['both repos', ''], lean: 1 })
  const r = await $.tool.call({ tool: 'mcp__qboard__edit', id: 'Q1', text: 'Push api and web now?' })
  expect(r.result).toBe('Q1 updated.')
  expect(board().items[0]).toMatchObject({ id: 'Q1', text: 'Push api and web now?', notes: ['both repos', ''], lean: 1 })
  await $.tool.call({ tool: 'mcp__qboard__edit', id: 'Q1', options: ['Push both', 'Push api only', 'Hold'] })
  expect(board().items[0]!.options).toEqual(['Push both', 'Push api only', 'Hold'])
  expect(board().items[0]).not.toHaveProperty('notes')
  expect(board().items[0]).not.toHaveProperty('lean')
  const bad = await $.tool.call({ tool: 'mcp__qboard__edit', id: 'Q1', lean: 4 })
  expect(bad).toMatchObject({ isError: true, text: 'qboard: lean must point at one of the options.' })
})

test('a follow-up with words after it is still a follow-up, the lines after it are answers', async ($, on) => {
  const { board, seen } = harness(on)
  await start($)
  await ask($, { text: 'A?', options: ['x', 'y'] })
  await ask($, { text: 'B?', options: ['x', 'y'] })
  await type($, 'Q1: explain more please')
  expect(board().items[0]).toMatchObject({ status: 'open' })
  expect(seen.at(-1)!.context![0]).toContain('the user wants Q1 "A?" explained more')
  await type($, 'Q1 ? why x\nQ2 1')
  expect(board().items[0]).toMatchObject({
    status: 'open',
    thread: [
      { who: 'user', text: 'explain more' },
      { who: 'user', text: 'why x' },
    ],
  })
  expect(board().items[1]).toMatchObject({ status: 'answered', answer: { option: 1 } })
  expect(seen.at(-1)!.context).toHaveLength(2)
})

test('explain and edit refuse ids that are not on the board or closed', async ($, on) => {
  harness(on)
  await start($)
  await ask($, { text: 'A?', options: ['x', 'y'] })
  await $.tool.call({ tool: 'mcp__qboard__close', id: 'Q1' })
  for (const id of ['Q1', 'Q9']) {
    expect(await $.tool.call({ tool: 'mcp__qboard__explain', id, text: 'hi' })).toMatchObject({ isError: true })
    expect(await $.tool.call({ tool: 'mcp__qboard__edit', id, text: 'B?' })).toMatchObject({ isError: true })
  }
})

test('Enter in the box answers and clears it, [ask] with an empty box sends nothing', async ($, on) => {
  const { board, seen } = harness(on)
  await start($)
  await ask($, { text: 'Layout?' })
  await ask($, { text: 'B?' })
  const ui = await $.ui.mount(PANE)
  const before = seen.length
  await ui.press({ key: 'Q1-ask' })
  expect(seen.length).toBe(before)
  await ui.input({ key: 'Q1-input', text: 'dock right', kind: 'change' })
  await ui.input({ key: 'Q1-input', text: 'dock right' })
  expect(seen.at(-1)!.text).toBe('Q1 dock right')
  expect(board().items[0]).toMatchObject({ status: 'answered', answer: { text: 'dock right' } })
  await ui.press({ key: 'Q2-ask' })
  expect(seen.length).toBe(before + 1)
  await ui.unmount()
})

test('a picked option shows as picked and no option can be pressed until the send returns', async ($, on) => {
  let release!: () => void
  const { board, seen } = harness(on, undefined, { submitGate: new Promise<void>(r => (release = r)) })
  await start($)
  await ask($, { text: 'Push?', options: ['Push both', 'Hold'] })
  const ui = await $.ui.mount(PANE)
  void ui.press({ key: 'Q1-2' })
  void ui.press({ key: 'Q1-2' })
  expect(await ui.find({ type: 'Text', text: '\u2713 Q1.2 Hold' })).toBeDefined()
  expect(await ui.find({ type: 'Input', key: 'Q1-input' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'Q1-1' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'Q1-2' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Q1.1 Push both' })).toBeDefined()
  release()
  expect(await ui.find({ type: 'Text', text: 'all answered' })).toBeDefined()
  expect(board().items[0]).toMatchObject({ status: 'answered', answer: { option: 2 } })
  expect(seen.filter(s => s.text.startsWith('Q1 2'))).toHaveLength(1)
  await ui.unmount()
})

test('the text box takes newlines from the start and grows with the draft, up to six rows', async ($, on) => {
  const { board } = harness(on)
  await start($)
  await ask($, { text: 'Push?', options: ['Push both', 'Hold'] })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Input', key: 'Q1-input' }))?.props.rows).toBe(2)
  await ui.input({ key: 'Q1-input', text: 'hold\nuntil Monday\nthen push', kind: 'change' })
  expect((await ui.find({ type: 'Input', key: 'Q1-input' }))?.props.rows).toBe(3)
  await ui.input({ key: 'Q1-input', text: 'a\nb\nc\nd\ne\nf\ng\nh', kind: 'change' })
  expect((await ui.find({ type: 'Input', key: 'Q1-input' }))?.props.rows).toBe(6)
  await ui.input({ key: 'Q1-input', text: 'hold\nuntil Monday' })
  expect(board().items[0]).toMatchObject({ status: 'answered', answer: { text: 'hold\nuntil Monday' } })
  await ui.unmount()
})

test('the draft preview starts one column past the field and keeps only the tail of a huge draft', () => {
  expect(draftPreview('a'.repeat(36), 60)).toBeUndefined()
  expect(draftPreview('a'.repeat(37), 60)).toBe('a'.repeat(37))
  expect(draftPreview(`short\n${'b'.repeat(37)}`, 60)).toBe(`short\n${'b'.repeat(37)}`)
  expect(draftPreview('a'.repeat(10), 20)).toBeUndefined()
  expect(draftPreview('a'.repeat(11), 20)).toBe('a'.repeat(11))
  const huge = `${'x'.repeat(10)}${'y'.repeat(300)}`
  expect(draftPreview(huge, 60)).toBe(`...${'y'.repeat(213)}`)
})

test('a draft with a line wider than the field is previewed in full above the input', async ($, on) => {
  harness(on)
  await start($)
  await ask($, { text: 'Push?' })
  const ui = await $.ui.mount(PANE)
  const previewed = async (text: string) => JSON.stringify(await ui.drawn()).includes(`{"type":"Text","props":{"dimColor":true},"children":["${text}"]}`)
  const short = 'short\\nlines'
  await ui.input({ key: 'Q1-input', text: 'short\nlines', kind: 'change' })
  expect(await previewed(short)).toBe(false)
  const long = 'word '.repeat(30).trim()
  await ui.input({ key: 'Q1-input', text: long, kind: 'change' })
  expect(await previewed(long)).toBe(true)
  await ui.unmount()
})

test('each existing file named in a question, note or thread gets an open button, a missing one none', async ($, on) => {
  const { opened } = harness(on, undefined, {
    files: { '/work/plans/pr-check/plan.html': '<html>', '/home/q/notes/why.md': '# why', '/work/diagram.svg': '<svg>' },
  })
  await start($)
  await ask($, {
    text: 'Approve plan pr-check (plans/pr-check/plan.html) or see gone.html? Diff plan.html.orig too.',
    options: ['Approve', 'Hold'],
    notes: ['see ~/notes/why.md', 'nothing to read'],
  })
  await type($, 'Q1 ? where is the diagram')
  await $.tool.call({ tool: 'mcp__qboard__explain', id: 'Q1', text: 'In ./sub/../diagram.svg, read it first.' })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: 'Approve plan pr-check (plans/pr-check/plan.html) or see gone.html? Diff plan.html.orig too.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'see ~/notes/why.md' })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'Q1-file-1' }))?.text).toBe('[\uf15b plan.html]')
  expect((await ui.find({ type: 'Button', key: 'Q1-file-2' }))?.text).toBe('[\uf15b why.md]')
  expect((await ui.find({ type: 'Button', key: 'Q1-file-3' }))?.text).toBe('[\uf15b diagram.svg]')
  expect(await ui.find({ type: 'Button', key: 'Q1-file-4' })).toBeUndefined()
  await ui.press({ key: 'Q1-file-1' })
  await ui.press({ key: 'Q1-file-3' })
  expect(opened).toEqual([['open', '/work/plans/pr-check/plan.html'], ['open', '/work/diagram.svg']])
  await ui.unmount()
})

test('a question with no existing file has no open button, a longer name is not the file inside it', async ($, on) => {
  harness(on, undefined, { files: { '/work/plan.md': '# plan' } })
  await start($)
  await ask($, { text: 'Ship plan.html, notes.md and plan.md.orig?', options: ['Yes', 'No'] })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Button', key: 'Q1-file-1' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Ship plan.html, notes.md and plan.md.orig?' })).toBeDefined()
  await ui.unmount()
})

test('one button per file however it is written, two files of one name show the path as written', async ($, on) => {
  const { opened } = harness(on, undefined, {
    files: { '/work/a/plan.html': '<html>', '/work/b/plan.html': '<html>', '/work/diagram.svg': '<svg>' },
  })
  await start($)
  await ask($, { text: 'Merge a/plan.html into b/plan.html? See ./diagram.svg and /work/diagram.svg.', options: ['Yes', 'No'] })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Button', key: 'Q1-file-1' }))?.text).toBe('[ a/plan.html]')
  expect((await ui.find({ type: 'Button', key: 'Q1-file-2' }))?.text).toBe('[ b/plan.html]')
  expect((await ui.find({ type: 'Button', key: 'Q1-file-3' }))?.text).toBe('[ diagram.svg]')
  expect(await ui.find({ type: 'Button', key: 'Q1-file-4' })).toBeUndefined()
  await ui.press({ key: 'Q1-file-2' })
  expect(opened).toEqual([['open', '/work/b/plan.html']])
  await ui.unmount()
})

test('fill mode puts a follow-up in the prompt box and leaves the thread to the hook', async ($, on) => {
  const { board } = harness(on)
  const filled: string[] = []
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  await start($)
  await ask($, { text: 'A?', options: ['x', 'y'] })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'mode' })
  await ui.input({ key: 'Q1-input', text: 'why x', kind: 'change' })
  await ui.press({ key: 'Q1-ask' })
  expect(filled).toEqual(['Q1 ? why x'])
  expect(board().items[0]!.thread).toBeUndefined()
  await ui.unmount()
})

test('a board file saved before threads still loads and renders', async ($, on) => {
  harness(on, { session: SID, next: 2, items: [{ kind: 'q', id: 'Q1', text: 'A?', options: ['x', 'y'], status: 'open', at: '2026-11-17T00:00:00Z' }] })
  await start($)
  const r = await $.tool.call({ tool: 'mcp__qboard__explain', id: 'Q1', text: 'x is safer.' })
  expect(r.result).toContain('Q1 thread updated')
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: 'x is safer.' })).toBeDefined()
  await ui.unmount()
})

const BAND = {
  plugin: 'qboard',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 80, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const

type Switch = { sid: { value: string }; wiped: { value: boolean } }

async function switchSession($: Engine, clock: ReturnType<typeof mock.clock>, h: Switch, reason: 'clear' | 'resume', to: string) {
  const { sid, wiped } = h
  const from = sid.value
  await $.session.end({ reason, sessionId: from, resume: { id: from } })
  wiped.value = true
  await clock.advance(300)
  sid.value = to
  await clock.advance(200)
}

test('/clear carries the open questions to the new session and the band shows them at once', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  await start($)
  await ask($, { text: 'A?', options: ['x', 'y'] })
  await switchSession($, clock, h, 'clear', 'sess-2')
  expect(h.board('sess-2')).toMatchObject({ session: 'sess-2', next: 2, items: [{ id: 'Q1', status: 'open' }] })
  const band = await $.ui.mount(BAND)
  expect((await band.find({ type: 'Text', text: /open:/ }))?.text).toBe('1 open:')
  await band.unmount()
})

test('the pane opens at session start, /qboard toggles it, the band [open] brings it back', async ($, on) => {
  const { panes, opens } = harness(on)
  await start($)
  expect(opens).toEqual([{ id: 'qboard', focus: undefined, columns: 60 }])
  await start($)
  expect(opens).toHaveLength(1)
  await $.command.run(RUN)
  expect(panes.has('qboard')).toBe(false)
  await $.command.run(RUN)
  expect(opens.at(-1)).toEqual({ id: 'qboard', focus: true, columns: 60 })
  panes.set('qboard', { isShown: false })
  await $.command.run(RUN)
  expect(panes.get('qboard')).toEqual({ isShown: true })
  expect(opens.at(-1)).toEqual({ id: 'qboard', focus: true, columns: 60 })
  await $.command.run(RUN)
  await ask($, { text: 'A?', options: ['x', 'y'] })
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'open-pane' })
  expect(panes.has('qboard')).toBe(true)
  await band.unmount()
})

test('a pane the user hid stays hidden when session.start fires again', async ($, on) => {
  const { panes, opens } = harness(on)
  await start($)
  await $.command.run(RUN)
  await start($)
  expect(panes.has('qboard')).toBe(false)
  expect(opens).toHaveLength(1)
})

test('/clear opens the pane again when the engine closed it', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  await start($)
  h.panes.delete('qboard')
  await switchSession($, clock, h, 'clear', 'sess-2')
  expect(h.panes.has('qboard')).toBe(true)
})

test('a pane the user hid comes back after /clear', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  await start($)
  await $.command.run(RUN)
  expect(h.panes.has('qboard')).toBe(false)
  await switchSession($, clock, h, 'clear', 'sess-2')
  expect(h.panes.has('qboard')).toBe(true)
})

test('/resume loads the board of the resumed session without a prompt', async ($, on) => {
  const clock = mock.clock(on)
  const other: Board = { session: 'sess-0', next: 4, items: [{ kind: 'q', id: 'Q3', text: 'C?', status: 'open', at: '2026-11-18T00:00:00Z' }] }
  const h = harness(on, undefined, { files: { [fileOf('sess-0')]: JSON.stringify(other) } })
  await start($)
  await ask($, { text: 'A?' })
  await switchSession($, clock, h, 'resume', 'sess-0')
  const band = await $.ui.mount(BAND)
  expect((await band.find({ type: 'Text', text: /^Q/ }))?.text).toBe('Q3')
  await band.unmount()
})

test('/resume of the current session reloads its board once the id wait runs out', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  await start($)
  await ask($, { text: 'A?' })
  await $.session.end({ reason: 'resume', sessionId: SID, resume: { id: SID } })
  h.wiped.value = true
  await clock.advance(10_000)
  const band = await $.ui.mount(BAND)
  expect((await band.find({ type: 'Text', text: /open:/ }))?.text).toBe('1 open:')
  await band.unmount()
})

test('a prompt that lands before the reload still gets the board /clear carried', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  await start($)
  await ask($, { text: 'A?', options: ['x', 'y'] })
  await $.session.end({ reason: 'clear', sessionId: SID, resume: { id: SID } })
  h.wiped.value = true
  h.sid.value = 'sess-2'
  await type($, 'Q1 2')
  await clock.advance(200)
  expect(h.board('sess-2').items[0]).toMatchObject({ id: 'Q1', status: 'answered', answer: { option: 2 } })
  expect(h.seen.at(-1)!.context).toEqual(['qboard: Q1 "A?" answered: option 2 "y".'])
})

test('/resume into a session with no board does not copy the QBOARD_FROM board', async ($, on) => {
  const clock = mock.clock(on)
  const origin: Board = { session: 'sess-0', next: 3, items: [{ kind: 'q', id: 'Q2', text: 'B?', status: 'open', at: '2026-11-18T00:00:00Z' }] }
  const h = harness(on, undefined, { env: { QBOARD_FROM: 'sess-0' }, files: { [fileOf('sess-0')]: JSON.stringify(origin) } })
  await start($)
  await switchSession($, clock, h, 'resume', 'sess-9')
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /open:/ })).toBeUndefined()
  await band.unmount()
  expect(h.board('sess-9')).toBeNull()
})

test('a handoff to a new process loads the old board named by QBOARD_FROM', async ($, on) => {
  const old: Board = { session: 'sess-0', next: 5, items: [] }
  const { board } = harness(on, undefined, { env: { QBOARD_FROM: 'sess-0' }, files: { [fileOf('sess-0')]: JSON.stringify(old) } })
  await start($)
  await ask($, { text: 'A?' })
  expect(board()).toMatchObject({ session: SID, next: 6, items: [{ id: 'Q5' }] })
  expect(board('sess-0').next).toBe(5)
})

test('the board file of this session wins over QBOARD_FROM', async ($, on) => {
  const { board } = harness(on, { session: SID, next: 9, items: [] }, { env: { QBOARD_FROM: 'sess-0' }, files: { [fileOf('sess-0')]: JSON.stringify({ session: 'sess-0', next: 2, items: [] }) } })
  await start($)
  await ask($, { text: 'A?' })
  expect(board().items[0]!.id).toBe('Q9')
})

const DAY = 86_400_000
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const boardOf = (session: string, status: 'open' | 'answered'): Board => ({
  session,
  next: 2,
  items: [{ kind: 'q', id: 'Q1', text: 'A?', status, at: '2026-01-01T00:00:00Z' }],
})

test('session start deletes old boards and keeps fresh ones and old open questions', async ($, on) => {
  const now = Date.now()
  const old = { idle: uuid(1), open: uuid(2), stale: uuid(3), fresh: uuid(4) }
  const seeded: [string, Board, number][] = [
    [old.idle, boardOf(old.idle, 'answered'), 8 * DAY],
    [old.open, boardOf(old.open, 'open'), 8 * DAY],
    [old.stale, boardOf(old.stale, 'open'), 31 * DAY],
    [old.fresh, boardOf(old.fresh, 'answered'), 1 * DAY],
  ]
  const junk = '/home/q/.local/state/qboard/bench.json'
  const notBoard = fileOf(uuid(6))
  const { files } = harness(on, undefined, {
    files: { ...Object.fromEntries(seeded.map(([id, b]) => [fileOf(id), JSON.stringify(b)])), [junk]: '[]', [notBoard]: '{"x":1}' },
    mtimes: {
      ...Object.fromEntries(seeded.map(([id, , age]) => [fileOf(id), now - age])),
      [junk]: now - 90 * DAY,
      [notBoard]: now - 90 * DAY,
    },
  })
  await start($)
  expect(files.has(fileOf(old.idle))).toBe(false)
  expect(files.has(fileOf(old.stale))).toBe(false)
  expect(files.has(fileOf(old.open))).toBe(true)
  expect(files.has(fileOf(old.fresh))).toBe(true)
  expect(files.has(junk)).toBe(true)
  expect(files.has(notBoard)).toBe(true)
})

test('a board that cannot be read is skipped and the prune goes on', async ($, on) => {
  const gone = fileOf(uuid(7))
  const idle = uuid(8)
  const { files } = harness(on, undefined, {
    files: { [fileOf(idle)]: JSON.stringify(boardOf(idle, 'answered')) },
    mtimes: { [gone]: Date.now() - 8 * DAY, [fileOf(idle)]: Date.now() - 8 * DAY },
    listedGone: [gone],
  })
  await start($)
  expect(files.has(fileOf(idle))).toBe(false)
})

test('session start never deletes the board of the session itself', async ($, on) => {
  const sid = uuid(5)
  const { files } = harness(on, undefined, {
    sid,
    files: { [fileOf(sid)]: JSON.stringify(boardOf(sid, 'answered')) },
    mtimes: { [fileOf(sid)]: Date.now() - 60 * DAY },
  })
  await start($)
  expect(files.has(fileOf(sid))).toBe(true)
})

test('session.start firing again leaves one 60 s tick timer', async ($, on) => {
  const clock = mock.clock(on)
  const existsLog: string[] = []
  harness(on, undefined, { existsLog })
  await start($)
  await ask($, { text: 'see /work/a.md' })
  await start($)
  await start($)
  const ui = await $.ui.mount(PANE)
  existsLog.length = 0
  await clock.advance(60_000)
  expect(existsLog).toEqual(['/work/a.md'])
  await ui.unmount()
})

test('asksInChat catches a question left in chat and lets a plain report pass', () => {
  expect(asksInChat('Done. Which one do you want?')).toBe(true)
  expect(asksInChat('Two ways:\nWhich layout?\n1. dock right\n2. float')).toBe(true)
  expect(asksInChat('1. dock right\n2. float\nLean 1. Reason: fewer moves.')).toBe(true)
  expect(asksInChat('Tests pass.\n\nUnresolved questions:\n- keep the old flag?')).toBe(true)
  expect(asksInChat('Tests pass.\n\nUnresolved questions: none')).toBe(false)
  expect(asksInChat('Steps done:\n1. built\n2. tested')).toBe(false)
  expect(asksInChat('Q3 on board. Lean 2: smaller diff.')).toBe(false)
  expect(asksInChat('Fixed. Let me know if you want more?')).toBe(false)
  expect(asksInChat('All green, committed.')).toBe(false)
  expect(asksInChat('Fixed the bug. No unresolved questions. Tests pass.')).toBe(false)
  expect(asksInChat('Updated the skill so reports list unresolved questions at the end.')).toBe(false)
  expect(asksInChat('Tests pass.\n\nUnresolved questions: N/A')).toBe(false)
  expect(asksInChat('Done. Tests pass.\n\nHow to run: make test')).toBe(false)
})

const REMINDER = /^qboard reminder:/

async function turn($: Engine, clock: ReturnType<typeof mock.clock>, answer: string, opts: { text?: string; during?: () => Promise<unknown>; isAborted?: boolean } = {}) {
  await $.turn.start({ text: opts.text ?? 'go', turnId: 't' })
  await opts.during?.()
  await $.turn.complete({ answer, durationMs: 1, isAborted: !!opts.isAborted, turnId: 't', reason: opts.isAborted ? 'aborted' : 'answer' })
  await clock.advance(0)
}

test('a turn that ends on a question in chat gets a board reminder', async ($, on) => {
  const { seen } = harness(on)
  const clock = mock.clock(on)
  await start($)
  await turn($, clock, 'Which layout do you want?')
  const sent = seen.filter(s => REMINDER.test(s.text))
  expect(sent).toHaveLength(1)
  expect(sent[0]!.text).toContain('mcp__qboard__ask')
})

test('no reminder after ask or edit in the turn, an abort, a subagent turn, or a plain report', async ($, on) => {
  const { seen } = harness(on)
  const clock = mock.clock(on)
  await start($)
  await turn($, clock, 'Which layout?', { during: () => ask($, { text: 'Layout?', options: ['a', 'b'] }) })
  await turn($, clock, 'Which layout?', { during: () => $.tool.call({ tool: 'mcp__qboard__edit', id: 'Q1', text: 'Pane layout?' }) })
  await turn($, clock, 'Which layout?', { isAborted: true })
  await turn($, clock, 'Committed, tests pass.')
  await $.turn.complete({ answer: 'Which layout?', durationMs: 1, isAborted: false, turnId: 's', reason: 'answer', agentId: 'a1' })
  await clock.advance(0)
  expect(seen.filter(s => REMINDER.test(s.text))).toHaveLength(0)
})

test('the reminder turn itself is never reminded, the next real turn is', async ($, on) => {
  const { seen } = harness(on)
  const clock = mock.clock(on)
  await start($)
  await turn($, clock, 'Which layout?')
  const reminder = seen.filter(s => REMINDER.test(s.text))
  expect(reminder).toHaveLength(1)
  await turn($, clock, 'Which layout?', { text: reminder[0]!.text })
  expect(seen.filter(s => REMINDER.test(s.text))).toHaveLength(1)
  await turn($, clock, 'Which pane?')
  expect(seen.filter(s => REMINDER.test(s.text))).toHaveLength(2)
})

test('a dropped reminder is logged and not retried', async ($, on) => {
  const { seen, logs } = harness(on, undefined, { dropSubmit: { reason: 'a Stop stands' } })
  const clock = mock.clock(on)
  await start($)
  await turn($, clock, 'Which layout?')
  await turn($, clock, 'Committed.')
  expect(seen).toHaveLength(0)
  expect(logs.filter(l => l.includes('question reminder dropped'))).toHaveLength(1)
})

test('a headless session gets no reminder', async ($, on) => {
  const { seen } = harness(on)
  const clock = mock.clock(on)
  await $.session.start({ surface: 'terminal', isInteractive: false, cwd: '/work' })
  await turn($, clock, 'Which layout?')
  expect(seen.filter(s => REMINDER.test(s.text))).toHaveLength(0)
})

const GOLDEN = { terminal: TERMINAL_PANE_GOLDEN, desktop: DESKTOP_PANE_GOLDEN } as const

const paneDump = async (ui: { drawn: () => Promise<unknown> }) =>
  JSON.stringify(await ui.drawn())
    .replace(/"handle":\d+/g, '"handle":H')
    .replace(/"\d+h(\d+m)?"/g, '"AGE"')

for (const surface of ['terminal', 'desktop'] as const) {
  const expectGolden = (tag: string, dump: string) => expect(dump).toBe(GOLDEN[surface][tag] ?? `missing ${tag}`)

  test(`the ${surface} pane draws the same tree across board states`, async ($, on) => {
    const clock = mock.clock(on)
    harness(on, undefined, { files: { '/work/a.md': 'x' } })
    await start($)
    const ui = await $.ui.mount({ ...PANE, surface })
    expectGolden('board-empty', await paneDump(ui))
    await ask($, { text: 'Writer? see /work/a.md', options: ['CLI', 'mod tool'], notes: ['fast', ''], lean: 2 })
    await ask($, { text: 'Layout?' })
    await ask($, { text: 'Gone?' })
    await $.tool.call({ tool: 'mcp__qboard__close', id: 'Q3', reason: 'moot' })
    await $.tool.call({ tool: 'mcp__qboard__explain', id: 'Q2', text: 'because' })
    await clock.advance(2000)
    expectGolden('board-rich', await paneDump(ui))
    await type($, 'Q1 2')
    expectGolden('board-answered', await paneDump(ui))
    await ui.press({ key: 'done' })
    expectGolden('board-done-open', await paneDump(ui))
    await ui.press({ key: 'mode' })
    expectGolden('board-fill-mode', await paneDump(ui))
    await ui.unmount()
  })

  test(`the ${surface} pane draws the same tree for queued cards`, async ($, on) => {
    mock.clock(on)
    harness(on, undefined, { dropSubmit: { reason: 'a Stop stands' } })
    await start($)
    await ask($, { text: 'Push?', options: ['Push both', 'Hold'] })
    await ask($, { text: 'Layout?' })
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'Q1-more' })
    expectGolden('queued-ask', await paneDump(ui))
    await ui.press({ key: 'Q1-2' })
    await ui.input({ key: 'Q2-input', text: 'wide' })
    expectGolden('queued-answers', await paneDump(ui))
    await ui.unmount()
  })

  test(`the ${surface} pane draws the same tree while a send is pending`, async ($, on) => {
    mock.clock(on)
    let release!: () => void
    const submitGate = new Promise<void>(r => (release = r))
    harness(on, undefined, { submitGate })
    await start($)
    await ask($, { text: 'Push?', options: ['Push both', 'Hold'] })
    await ask($, { text: 'Layout?' })
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'Q1-1' })
    await ui.input({ key: 'Q2-input', text: 'wide' })
    expectGolden('pending-picked-and-sending', await paneDump(ui))
    release()
    await ui.unmount()
  })
}
