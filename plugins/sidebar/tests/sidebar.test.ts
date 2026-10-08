import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { SPINNER, cellWidth, cometCell, debugFile, feedDir, fit, folderName, jumpKeys, lineText, modelName, perimeterIndex, recapLines, renderCards, statusLook, toCard, usageLine, visibleCards, wrapWords } from '../hooks/register.tsx'
import type { Card } from '../types'

const SID = 'sess-1'
const DIR = '/state/feed'
const NOW = 1000000
const POLL_MS = 2000
const SPIN_MS = 150

const PANE = {
  plugin: 'sidebar',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'sidebar',
  props: { title: 'Sessions', isFocused: true, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const RUN = { command: 'sidebar', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const

function card(patch: Partial<Card>): Card {
  return {
    sessionId: 'other',
    paneId: '',
    cwd: '/work/api',
    branch: 'main',
    status: 'idle',
    asked: false,
    tool: '',
    model: 'claude-opus-5-5',
    contextPercent: 41.6,
    contextTokens: 416000,
    contextWindow: 1000000,
    costUsd: 2.2,
    title: 'Fix login bug',
    recap: [],
    updatedAt: NOW,
    ...patch,
  }
}

function harness(on: On, env: Record<string, string> = {}, stored: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, stored)
  const opened: { id: string; focus?: boolean }[] = []
  on('ui.open', ($, e) => {
    opened.push({ id: e.id, focus: e.focus })
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: opened.map(p => ({ id: p.id, title: 'Sessions', isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.close', ($, e) => {
    opened.splice(0, opened.length, ...opened.filter(p => p.id !== e.id))
    return { value: undefined }
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  mock.env(on, { CLAUDE_SIDEBAR_STATE_DIR: '/state', HOME: '/home/q', ...env })
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const ran: string[][] = []
  const toasts: string[] = []
  let writes = 0
  const put = (path: string, text: string) => {
    files.set(path, text)
    mtimes.set(path, ++writes)
  }
  on('fs.write', ($, e) => {
    put(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || [...files.keys()].some(p => p.startsWith(`${e.path}/`)) }))
  on('fs.read', ($, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.list', ($, e) => ({
    value: [...files.keys()]
      .filter(p => p.startsWith(`${e.path}/`))
      .map(p => ({ name: p.slice((e.path ?? '').length + 1), kind: 'file' as const, size: files.get(p)!.length, mtimeMs: mtimes.get(p) ?? 0, isLink: false })),
  }))
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    const isGit = e.argv[0] === 'git'
    return { value: { exitCode: 0, stdout: isGit ? 'feature/x\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: SID }))
  on('session.start', () => ({ cwd: '/work/web' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', () => ({ text: '' }))
  const own = () => JSON.parse(files.get(`${DIR}/${SID}.json`) ?? 'null')
  const others = (...list: Card[]) => {
    for (const c of list) put(`${DIR}/${c.sessionId}.json`, JSON.stringify(c))
  }
  const tmuxCalls = () => ran.filter(argv => argv[0] === 'tmux')
  return { clock, files, own, others, tmuxCalls, toasts, opened }
}

async function start($: Engine) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/web' })
}

async function paneText($: Engine): Promise<string> {
  const pane = await $.ui.mount(PANE)
  const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text)
  await pane.unmount()
  return texts.join('')
}

function drawn(list: Card[], width: number, ownId = '', spin = 0): string[] {
  return renderCards(list, width, ownId, spin).map(lineText)
}

test('a session publishes its card with no tmux, and a turn moves it from idle to running and back', async ($, on) => {
  const { own } = harness(on)

  await start($)
  expect(own()).toMatchObject({ sessionId: SID, paneId: '', cwd: '/work/web', branch: 'feature/x', status: 'idle' })

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'go test ./...\necho done' })
  expect(own()).toMatchObject({ status: 'running', tool: 'Bash: go test ./...' })

  await $.turn.complete({ turnId: 't1', answer: 'Two ways. Which one do you want?', durationMs: 5, isAborted: false, reason: 'answer' })
  expect(own()).toMatchObject({ status: 'idle', asked: true, tool: '' })
})

test('a session inside tmux records its pane', async ($, on) => {
  const { own } = harness(on, { TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%7' })

  await start($)
  expect(own().paneId).toBe('%7')
})

test('the heartbeat keeps an idle card fresh, and an ended session stops it', async ($, on) => {
  const { own, clock } = harness(on)

  await start($)
  await clock.advance(30000)
  expect(own().updatedAt).toBe(NOW + 30000)

  await $.session.end({ sessionId: SID, reason: 'prompt_input_exit', resume: { id: SID } })
  await clock.advance(30000)
  expect(own()).toMatchObject({ status: 'ended', updatedAt: NOW + 30000 })
})

test('the pane lists live sessions and hides ended and stale ones', async ($, on) => {
  const { others, clock } = harness(on)

  await start($)
  others(
    card({ sessionId: 'live', status: 'running', tool: 'Edit: /work/api/a.go', recap: ['Did: moved the reaper'] }),
    card({ sessionId: 'gone', status: 'ended', title: 'Ended one' }),
    card({ sessionId: 'crashed', title: 'Crashed one', updatedAt: NOW - 200000 }),
  )
  await clock.advance(POLL_MS)

  const text = await paneText($)
  expect(text).toContain('⚡ Edit: /work/api/a.go')
  expect(text).toContain('🟢 416k/1M · Opus 5.5 · $2.20')
  expect(text).toContain('🌿 main')
  expect(text).not.toContain('Did: moved the reaper')
  expect(text).not.toContain('Ended one')
  expect(text).not.toContain('Crashed one')
})

test('a card that stops its heartbeat drops out of the pane', async ($, on) => {
  const { others, clock } = harness(on)

  await start($)
  others(card({ sessionId: 'live', status: 'needs-input' }))
  await clock.advance(POLL_MS)
  expect(await paneText($)).toContain('needs input')

  await clock.advance(90000)
  expect(await paneText($)).not.toContain('needs input')
})

test('debug mode keeps stale cards and dumps the drawn pane to a file', async ($, on) => {
  const { others, clock, files } = harness(on, { CLAUDE_SIDEBAR_DEBUG: '1' })

  await start($)
  others(card({ sessionId: 'old', title: 'Old fixture', updatedAt: NOW - 200000 }))
  await clock.advance(POLL_MS)

  const dump = files.get('/state/debug/pane.txt') ?? ''
  expect(dump).toContain('Old fixture')
  expect(dump.split('\n')[0]).toBe('╭ work/api ────────────────────────── idle ╮')
})

test('/sidebar opens the pane and a new session opens it again', async ($, on) => {
  const { opened } = harness(on)

  await start($)
  expect(opened).toEqual([])
  expect(await $.command.run(RUN)).toMatchObject({ text: 'Sidebar opened.' })
  expect(opened).toEqual([{ id: 'sidebar', focus: true }])

  await start($)
  expect(opened.at(-1)).toEqual({ id: 'sidebar', focus: undefined })
})

test('closing the pane keeps it closed in the next session', async ($, on) => {
  const { opened } = harness(on, {}, { open: true })

  await start($)
  expect(opened.length).toBe(1)
  expect(await $.command.run(RUN)).toMatchObject({ text: 'Sidebar closed.' })

  await start($)
  expect(opened).toEqual([])
})

test('a card draws its folder and status in the top border, at the pane width', () => {
  const lines = drawn([card({ sessionId: 'a', status: 'running', tool: 'Bash: go test ./...', recap: ['Needs: pick the changelog format before the release goes out today', 'Did: x'] })], 40, 'me')
  expect(lines).toEqual([
    '╭ work/api ───────────────── ✦ running ╮',
    '│ 1: Fix login bug                     │',
    '│ ⚡ Bash: go test ./...               │',
    '│ 🌿 main                              │',
    '│ 🟢 416k/1M · Opus 5.5 · $2.20        │',
    '│ Needs: pick the changelog format     │',
    '│ before the release goes out today    │',
    '╰──────────────────────────────────────╯',
  ])
  expect(lines.map(cellWidth)).toEqual(lines.map(() => 40))
})

test('the folder shows with its parent, and alone when the border has no room', () => {
  expect(folderName('/work/custody/fxi', 20)).toBe('custody/fxi')
  expect(folderName('/work/custody/fxi', 8)).toBe('fxi')
  expect(folderName('/work/custody/fxi', 2)).toBe('f…')
  expect(folderName('/work', 20)).toBe('work')
  expect(folderName('/', 20)).toBe('')
  expect(drawn([card({ sessionId: 'a', cwd: '/work/custody/a-long-folder-name' })], 30, 'me')[0]).toBe('╭ a-long-folder-name ── idle ╮')
})

test('a running card steps its spinner with the frame and keeps its width', () => {
  const tops = SPINNER.map((_, spin) => drawn([card({ sessionId: 'a', status: 'running' })], 40, 'me', spin)[0] ?? '')
  expect(SPINNER.map(cellWidth)).toEqual(SPINNER.map(() => 1))
  expect(new Set(tops).size).toBe(SPINNER.length)
  expect(tops.map(cellWidth)).toEqual(tops.map(() => 40))
  expect(drawn([card({ sessionId: 'a', status: 'running' })], 40, 'me', SPINNER.length)[0]).toBe(tops[0])
  expect(drawn([card({ sessionId: 'a' })], 40, 'me', 0)).toEqual(drawn([card({ sessionId: 'a' })], 40, 'me', 3))
})

test('the spinner turns while the pane is open and a card runs, and stops otherwise', async ($, on) => {
  const { clock, others } = harness(on)
  await start($)
  others(card({ sessionId: 'a', status: 'running' }))
  await clock.advance(POLL_MS)
  const closed = await paneText($)
  await clock.advance(SPIN_MS * 3)
  expect(await paneText($)).toBe(closed)

  await $.command.run(RUN)
  const first = await paneText($)
  await clock.advance(SPIN_MS)
  const second = await paneText($)
  expect(second).not.toBe(first)

  others(card({ sessionId: 'a', status: 'idle' }))
  await clock.advance(POLL_MS)
  const idle = await paneText($)
  await clock.advance(SPIN_MS * 3)
  expect(await paneText($)).toBe(idle)

  others(card({ sessionId: 'a', status: 'running' }))
  await clock.advance(POLL_MS)
  await $.command.run(RUN)
  const shut = await paneText($)
  await clock.advance(SPIN_MS * 3)
  expect(await paneText($)).toBe(shut)
})

test('the border cells count clockwise from the top left corner', () => {
  expect(perimeterIndex(0, 0, 5, 10)).toBe(0)
  expect(perimeterIndex(0, 9, 5, 10)).toBe(9)
  expect(perimeterIndex(4, 9, 5, 10)).toBe(13)
  expect(perimeterIndex(4, 0, 5, 10)).toBe(22)
  expect(perimeterIndex(1, 0, 5, 10)).toBe(25)
  expect(perimeterIndex(2, 5, 5, 10)).toBe(null)
})

test('the comet head is the brightest cell, the tail fades, and it rests for half the cycle', () => {
  expect(cometCell(0, 0, 0, 6, 40)).toEqual({ color: '#F38BA8', isBold: true })
  expect(cometCell(10, 5, 39, 6, 40)).toMatchObject({ isBold: true })
  expect(cometCell(10, 5, 38, 6, 40)).toBe(null)
  expect(cometCell(10, 4, 39, 6, 40)).toMatchObject({ isBold: true })
  expect(cometCell(10, 0, 39, 6, 40)).toMatchObject({ isBold: false })
  expect(cometCell(10, 0, 20, 6, 40)).toBe(null)
  expect(cometCell(10, 2, 20, 6, 40)).toBe(null)
  expect(cometCell(20, 0, 0, 6, 40)).toBe(null)
  expect(cometCell(40, 0, 0, 6, 40)).toMatchObject({ isBold: true })
})

test('a running card flows a gradient over its border lines, with the comet on top, and keeps its text', () => {
  const lit = (list: Card[], spin: number) => renderCards(list, 40, 'me', spin).flatMap(l => l.spans).filter(s => s.color?.startsWith('#') && [...s.text].length === 1 && s.text !== ' ')
  const running = [card({ sessionId: 'a', status: 'running', tool: 'Bash: ls' })]
  expect(lit(running, 29).length).toBe(67)
  expect(lit(running, 29).every(s => '─│╭╮╰╯'.includes(s.text) && !s.isBold)).toBe(true)
  expect(new Set(lit(running, 29).map(s => s.color)).size).toBeGreaterThan(30)
  expect(lit(running, 29).map(s => s.color)).not.toEqual(lit(running, 30).map(s => s.color))
  expect(lit(running, 5).filter(s => s.isBold).length).toBe(2)
  expect(lit(running, 1).filter(s => !'─│╭╮╰╯'.includes(s.text)).length).toBeGreaterThan(0)
  expect(lit([card({ sessionId: 'a' })], 5)).toEqual([])
  expect(lit([card({ sessionId: 'a', status: 'needs-input' })], 5)).toEqual([])
  expect(drawn(running, 40, 'me', 5)).toEqual(drawn(running, 40, 'me', 29))
  expect(renderCards(running, 40, 'me', 5).flatMap(l => l.spans).filter(s => s.hotkey).length).toBe(1)
})

test('a recap keeps the Needs line only, and nothing when the agent asks nothing', () => {
  expect(recapLines('**Needs:** pick a port\nDid: moved the reaper')).toEqual(['Needs: pick a port'])
  expect(recapLines('Needs: -')).toEqual([])
  expect(recapLines('Did: moved the reaper')).toEqual([])
})

test('the own card has a double border and no hotkey, and an empty title reads Ready', () => {
  const lines = drawn([card({ sessionId: 'me', title: '', branch: '', model: '', contextPercent: null, contextTokens: null, costUsd: null })], 30, 'me')
  expect(lines).toEqual(['╔ ▶ work/api ══════════ idle ╗', '║ Ready                      ║', '╚════════════════════════════╝'])
})

test('long text is cut to the cell width, wide glyphs count as two', () => {
  expect(fit('abcdef', 4)).toBe('abc…')
  expect(fit('🌿🌿🌿', 4)).toBe('🌿…')
  expect(cellWidth('⚡ a')).toBe(4)
  expect(wrapWords('one two three four five', 9, 2)).toEqual(['one two', 'three fo…'])
})

test('the model reads as a name and a version', () => {
  expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
  expect(modelName('claude-opus-5-5[1m]')).toBe('Opus 5.5')
  expect(modelName('')).toBe('')
})

test('a hotkey jumps through tmux when both sessions are in tmux', async ($, on) => {
  const { others, clock, tmuxCalls, toasts } = harness(on, { TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%7' })

  await start($)
  others(card({ sessionId: 'live', paneId: '%12' }))
  await clock.advance(POLL_MS)
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'live' })

  expect(tmuxCalls()).toEqual([['tmux', 'switch-client', '-t', '%12']])
  expect(toasts).toEqual([])
})

test('a hotkey outside tmux runs nothing and says why', async ($, on) => {
  const { others, clock, tmuxCalls, toasts } = harness(on)

  await start($)
  others(card({ sessionId: 'live', paneId: '%12' }), card({ sessionId: 'plain', cwd: '/work/zed' }))
  await clock.advance(POLL_MS)
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'live' })
  await pane.press({ key: 'plain' })

  expect(tmuxCalls()).toEqual([])
  expect(toasts).toEqual(['sidebar: jump needs both sessions inside tmux', 'sidebar: jump needs both sessions inside tmux'])
})

test('the own card has no jump button', async ($, on) => {
  const { clock } = harness(on)

  await start($)
  await clock.advance(POLL_MS)
  const pane = await $.ui.mount(PANE)

  expect(await pane.find({ type: 'Button' })).toBe(undefined)
})

test('cards sort by folder then session, so hotkeys stay put', () => {
  const list = visibleCards([card({ sessionId: 'b', cwd: '/work/web' }), card({ sessionId: 'c', cwd: '/work/api' }), card({ sessionId: 'a', cwd: '/work/web' })], NOW)
  expect(list.map(c => c.sessionId)).toEqual(['c', 'a', 'b'])
})

test('hotkeys count from 1 over the other sessions and stop at 9', () => {
  const list = ['a', 'me', ...'bcdefghij'].map(id => card({ sessionId: id }))
  const keys = jumpKeys(list, 'me')
  expect([...keys.entries()].slice(0, 2)).toEqual([['a', '1'], ['b', '2']])
  expect(keys.get('i')).toBe('9')
  expect(keys.has('j')).toBe(false)
  expect(keys.has('me')).toBe(false)
})

test('a feed file with a wrong shape is not a card', () => {
  expect(toCard(null)).toBe(null)
  expect(toCard({ sessionId: 's', updatedAt: 1 })).toBe(null)
  expect(toCard({ sessionId: 's', updatedAt: 1, status: 'sleeping' })).toBe(null)
  expect(toCard({ sessionId: 's', updatedAt: 1, status: 'idle', recap: ['Did: x', 4] })).toMatchObject({ title: '', contextPercent: null, recap: ['Did: x'] })
})

test('the status line reads the state a person cares about first', () => {
  expect(statusLook(card({ status: 'needs-input' })).word).toBe('needs input')
  expect(statusLook(card({ status: 'running' })).word).toBe('running')
  expect(statusLook(card({ asked: true })).word).toBe('asked you')
  expect(statusLook(card({})).word).toBe('idle')
})

test('the usage line skips what a card does not know', () => {
  expect(usageLine(card({ contextPercent: null, contextTokens: null, costUsd: null }))).toBe('Opus 5.5')
  expect(usageLine(card({ contextPercent: 85, contextTokens: null, model: '', costUsd: 0 }))).toBe('🔴 85%')
  expect(usageLine(card({ contextPercent: 60, contextTokens: 120000, contextWindow: 200000 }))).toBe('🟡 120k/200k · Opus 5.5 · $2.20')
})

test('the debug dump sits beside the feed folder', () => {
  expect(debugFile('/s/feed')).toBe('/s/debug/pane.txt')
})

test('the feed directory follows the override, then XDG, then HOME', () => {
  expect(feedDir('/s', '/x', '/h')).toBe('/s/feed')
  expect(feedDir(undefined, '/x', '/h')).toBe('/x/claude-sidebar/feed')
  expect(feedDir(undefined, undefined, '/h')).toBe('/h/.local/state/claude-sidebar/feed')
})
