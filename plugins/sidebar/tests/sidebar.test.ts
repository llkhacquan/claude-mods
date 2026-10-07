import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { feedDir, jumpKeys, metaLine, statusLook, toCard, visibleCards } from '../hooks/register.tsx'
import type { Card } from '../types'

const SID = 'sess-1'
const DIR = '/state/feed'
const NOW = 1000000
const POLL_MS = 2000

const PANE = {
  plugin: 'sidebar',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'sidebar',
  props: { title: 'Sessions', isFocused: true, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

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
    title: 'Fix login bug',
    recap: [],
    updatedAt: NOW,
    ...patch,
  }
}

function harness(on: On, env: Record<string, string> = {}) {
  const clock = mock.clock(on, { now: NOW })
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
  return { clock, files, own, others, tmuxCalls, toasts }
}

async function start($: Engine) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/web' })
}

async function paneTexts($: Engine): Promise<string[]> {
  const pane = await $.ui.mount(PANE)
  const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text)
  await pane.unmount()
  return texts
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

  const texts = await paneTexts($)
  expect(texts).toContain('● Edit: /work/api/a.go')
  expect(texts).toContain('api · main · opus-5-5 · 42%')
  expect(texts).toContain('Did: moved the reaper')
  expect(texts.join('\n')).not.toContain('Ended one')
  expect(texts.join('\n')).not.toContain('Crashed one')
})

test('a card that stops its heartbeat drops out of the pane', async ($, on) => {
  const { others, clock } = harness(on)

  await start($)
  others(card({ sessionId: 'live', status: 'needs-input' }))
  await clock.advance(POLL_MS)
  expect(await paneTexts($)).toContain('▲ needs input')

  await clock.advance(90000)
  expect(await paneTexts($)).not.toContain('▲ needs input')
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
  expect(statusLook(card({ status: 'needs-input' })).label).toBe('needs input')
  expect(statusLook(card({ status: 'running' })).label).toBe('running')
  expect(statusLook(card({ asked: true })).label).toBe('asked you')
  expect(statusLook(card({})).label).toBe('idle')
})

test('the meta line skips what a card does not know', () => {
  expect(metaLine(card({ branch: '', contextPercent: null }))).toBe('api · opus-5-5')
})

test('the feed directory follows the override, then XDG, then HOME', () => {
  expect(feedDir('/s', '/x', '/h')).toBe('/s/feed')
  expect(feedDir(undefined, '/x', '/h')).toBe('/x/claude-sidebar/feed')
  expect(feedDir(undefined, undefined, '/h')).toBe('/h/.local/state/claude-sidebar/feed')
})
