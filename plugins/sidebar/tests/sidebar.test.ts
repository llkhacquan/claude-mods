import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import { SPINNER, ageLabel, bandLabel, toMode, branchLine, cellWidth, gitState, cometCell, debugFile, feedDir, fit, folderName, jumpKeys, lineText, modelName, perimeterIndex, recapLines, renderCards, statusLook, toCard, usageLine, visibleCards, wrapWords } from '../hooks/register.tsx'
import type { Card } from '../types'

const SID = 'sess-1'
const DIR = '/state/feed'
const NOW = 1000000
const HEARTBEAT_MS = 30000
const WAKE_GAP_MS = 100
const SIGNAL_GAP_MS = 100
const PURGE_MS = 86400000
const SPIN_MS = 150
const GIT_STATUS = [
  '# branch.oid 1f2e3d',
  '# branch.head feature/x',
  '# branch.upstream origin/feature/x',
  '# branch.ab +2 -0',
  '1 .M N... 100644 100644 100644 1f2e3d 1f2e3d a.go',
  '? b.go',
  '',
].join('\n')

const PANE = {
  plugin: 'sidebar',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'sidebar',
  props: { title: 'Sessions', isFocused: true, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const BAND = {
  plugin: 'sidebar',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const RUN = { command: 'sidebar', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const

function card(patch: Partial<Card>): Card {
  return {
    sessionId: 'other',
    paneId: '',
    cwd: '/work/api',
    branch: 'main',
    changed: null,
    unpushed: null,
    status: 'idle',
    since: 0,
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
  const store = new Map(Object.entries(stored))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Text, null, 'below') as RenderElement)
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
    mtimes.set(path, clock.now() + ++writes / 1000)
  }
  const held = new Map<string, { reach: () => void; released: Promise<void> }>()
  const hold = (op: 'read' | 'write' | 'run' | 'call', path: string) => {
    let reach = () => {}
    let release = () => {}
    const reached = new Promise<void>(resolve => (reach = resolve))
    held.set(`${op} ${path}`, { reach, released: new Promise<void>(resolve => (release = resolve)) })
    return { reached, release }
  }
  const pass = async (op: 'read' | 'write' | 'run' | 'call', path: string) => {
    const gate = held.get(`${op} ${path}`)
    if (!gate) return
    held.delete(`${op} ${path}`)
    gate.reach()
    await gate.released
  }
  on('fs.write', async ($, e) => {
    await pass('write', e.path)
    put(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || [...files.keys()].some(p => p.startsWith(`${e.path}/`)) }))
  on('fs.read', async ($, e) => {
    const text = files.get(e.path) ?? ''
    await pass('read', e.path)
    return { value: text }
  })
  on('fs.list', ($, e) => ({
    value: [...files.keys()]
      .filter(p => p.startsWith(`${e.path}/`))
      .map(p => ({ name: p.slice((e.path ?? '').length + 1), kind: 'file' as const, size: files.get(p)!.length, mtimeMs: mtimes.get(p) ?? 0, isLink: false })),
  }))
  on('process.run', async ($, e) => {
    ran.push([...e.argv])
    await pass('run', e.argv[0] ?? '')
    if (e.argv[0] === 'rm') for (const path of e.argv.slice(3)) files.delete(path)
    const isGit = e.argv[0] === 'git'
    return { value: { exitCode: 0, stdout: isGit ? GIT_STATUS : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.stat', ($, e) => ({ value: { kind: 'file' as const, size: files.get(e.path)?.length ?? 0, mtimeMs: mtimes.get(e.path) ?? 0, isLink: false } }))
  const spawned: string[][] = []
  const pending: (() => void)[] = []
  let notify = () => {}
  let isTailDead = false
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    while (!isTailDead) {
      while (pending.length === 0 && !isTailDead) await new Promise<void>(resolve => (notify = resolve))
      const done = pending.shift()
      if (!done) break
      yield { stream: 'stdout' as const, text: '\n' }
      done()
    }
    return { value: { code: 1, signal: null } }
  })
  const killTail = () => {
    isTailDead = true
    notify()
  }
  const pulse = () =>
    new Promise<void>(done => {
      pending.push(done)
      notify()
    })
  const wake = async () => {
    await clock.advance(WAKE_GAP_MS)
    await pulse()
  }
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: SID }))
  on('session.start', () => ({ cwd: '/work/web' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', async ($, e) => {
    await pass('call', e.tool)
    return { result: 'ok' }
  })
  on('classic.PermissionRequest', () => ({}))
  on('turn.complete', () => ({ text: '' }))
  const own = () => JSON.parse(files.get(`${DIR}/${SID}.json`) ?? 'null')
  const others = (...list: Card[]) => {
    for (const c of list) put(`${DIR}/${c.sessionId}.json`, JSON.stringify(c))
  }
  const tmuxCalls = () => ran.filter(argv => argv[0] === 'tmux')
  return { clock, files, mtimes, own, others, tmuxCalls, toasts, opened, store, ran, spawned, wake, pulse, killTail, hold }
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

function drawn(list: Card[], width: number, ownId = '', spin = 0, now = 0): string[] {
  return renderCards(list, width, ownId, spin, now).map(lineText)
}

test('a session publishes its card with no tmux, and a turn moves it from idle to running and back', async ($, on) => {
  const { own } = harness(on)

  await start($)
  expect(own()).toMatchObject({ sessionId: SID, paneId: '', cwd: '/work/web', branch: 'feature/x', changed: 2, unpushed: 2, status: 'idle' })

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
  const { others, wake } = harness(on)

  await start($)
  others(
    card({ sessionId: 'live', status: 'running', tool: 'Edit: /work/api/a.go', recap: ['Did: moved the reaper'] }),
    card({ sessionId: 'gone', status: 'ended', title: 'Ended one' }),
    card({ sessionId: 'crashed', title: 'Crashed one', updatedAt: NOW - 200000 }),
  )
  await wake()

  const text = await paneText($)
  expect(text).toContain('⚡ Edit: /work/api/a.go')
  expect(text).toContain('🟢 416k/1M · Opus 5.5 · $2.20')
  expect(text).toContain('🌿 main')
  expect(text).not.toContain('Did: moved the reaper')
  expect(text).not.toContain('Ended one')
  expect(text).not.toContain('Crashed one')
})

test('a card that stops its heartbeat drops out of the pane', async ($, on) => {
  const { others, clock, wake } = harness(on)

  await start($)
  others(card({ sessionId: 'live', status: 'needs-input' }))
  await wake()
  expect(await paneText($)).toContain('needs input')

  await clock.advance(90000)
  expect(await paneText($)).not.toContain('needs input')
})

test('debug mode keeps stale cards and dumps the drawn pane to a file', async ($, on) => {
  const { others, wake, files } = harness(on, { CLAUDE_SIDEBAR_DEBUG: '1' })

  await start($)
  others(card({ sessionId: 'old', title: 'Old fixture', updatedAt: NOW - 200000 }))
  await wake()

  const dump = files.get('/state/debug/pane.txt') ?? ''
  expect(dump).toContain('Old fixture')
  expect(dump.split('\n')[0]).toBe('╭ work/api ────────────────────────── idle ╮')
})

test('/sidebar opens the pane and a new session opens it again', async ($, on) => {
  const { opened, store } = harness(on)

  await start($)
  expect(opened).toEqual([])
  expect(await $.command.run(RUN)).toMatchObject({ text: 'Sidebar opened in every session.' })
  expect(opened).toEqual([{ id: 'sidebar', focus: true }])
  expect(store.get('mode')).toBe('open')

  opened.length = 0
  await start($)
  expect(opened).toEqual([{ id: 'sidebar', focus: undefined }])
})

test('closing the pane keeps it closed in the next session', async ($, on) => {
  const { opened, store } = harness(on, {}, { open: true })

  await start($)
  expect(opened.length).toBe(1)
  expect(await $.command.run(RUN)).toMatchObject({ text: 'Sidebar closed in every session.' })
  expect(store.get('mode')).toBe('closed')

  await start($)
  expect(opened).toEqual([])
})

test('the stored mode wins over the old open flag, and the flag alone still opens', () => {
  expect(toMode('min', true)).toBe('min')
  expect(toMode('closed', true)).toBe('closed')
  expect(toMode(undefined, true)).toBe('open')
  expect(toMode(undefined, undefined)).toBe('closed')
  expect(toMode('wide', false)).toBe('closed')
})

test('a session follows the signal file with one tail, and a new start replaces it', async ($, on) => {
  const { spawned } = harness(on)

  await start($)
  expect(spawned).toEqual([['/usr/bin/tail', '-n', '0', '-F', '/state/signal']])

  await start($)
  expect(spawned.length).toBe(2)
})

test('a heartbeat that lands inside a new start leaves one tail for that start', async ($, on) => {
  const { spawned, clock, hold } = harness(on)

  await start($)
  const write = hold('write', `${DIR}/${SID}.json`)
  const again = $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/api' })
  await write.reached
  await clock.advance(HEARTBEAT_MS)
  write.release()
  await again
  await clock.advance(0)

  expect(spawned.length).toBe(2)
})

test('a slow read that overlaps a newer one does not put the old card back', async ($, on) => {
  const { others, clock, wake, hold } = harness(on)

  await start($)
  await $.command.run(RUN)
  others(card({ sessionId: 'live', branch: 'old-branch' }))
  const read = hold('read', `${DIR}/live.json`)
  const woken = wake()
  await read.reached
  others(card({ sessionId: 'live', branch: 'new-branch' }))
  await clock.advance(HEARTBEAT_MS)
  read.release()
  await woken
  await clock.advance(0)

  expect(await paneText($)).toContain('🌿 new-branch')
})

test('signals that come in a burst cost one read now and one read after the gap', async ($, on) => {
  const { opened, store, clock, pulse } = harness(on)

  await start($)
  await clock.advance(WAKE_GAP_MS)
  await pulse()
  store.set('mode', 'open')
  await pulse()
  await pulse()
  expect(opened).toEqual([])

  await clock.advance(WAKE_GAP_MS)
  expect(opened).toEqual([{ id: 'sidebar', focus: undefined }])
})

test('the heartbeat starts the tail again after it died', async ($, on) => {
  const { spawned, clock, killTail } = harness(on)

  await start($)
  killTail()
  await clock.advance(HEARTBEAT_MS)

  expect(spawned.length).toBe(2)
})

test('a card file caught half written keeps its last good card', async ($, on) => {
  const { others, files, wake } = harness(on)

  await start($)
  await $.command.run(RUN)
  others(card({ sessionId: 'live' }))
  await wake()
  files.set(`${DIR}/live.json`, '{"sessionId":"li')
  await wake()

  expect(await paneText($)).toContain('work/api')
})

test('a changed card and a changed mode append to the signal file, a heartbeat does not', async ($, on) => {
  const { ran, clock } = harness(on)
  const signals = () => ran.filter(argv => argv[0] === 'tee')

  await start($)
  expect(signals()).toEqual([['tee', '-a', '/state/signal']])

  await clock.advance(HEARTBEAT_MS)
  expect(signals().length).toBe(1)

  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(signals().length).toBe(2)

  await $.command.run(RUN)
  expect(signals().length).toBe(2)

  await clock.advance(SIGNAL_GAP_MS)
  expect(signals().length).toBe(3)
})

test('a turn that ends reads idle before git answers, then takes the git counts', async ($, on) => {
  const { own, hold } = harness(on)

  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const git = hold('run', 'git')
  const done = $.turn.complete({ turnId: 't1', answer: 'Done.', durationMs: 5, isAborted: false, reason: 'answer' })
  await git.reached
  expect(own().status).toBe('idle')

  git.release()
  await done
  expect(own()).toMatchObject({ status: 'idle', changed: 2, unpushed: 2 })
})

test('a tool call beside one that waits for the person keeps the card on needs input', async ($, on) => {
  const { own, hold } = harness(on)

  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const bash = hold('call', 'Bash')
  const waiting = $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  await bash.reached
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })
  await $.tool.call({ tool: 'Read', file_path: '/work/web/a.go' })
  expect(own().status).toBe('needs-input')

  bash.release()
  await waiting
  expect(own().status).toBe('running')
})

test('a patch that changes nothing writes no card and sends no signal', async ($, on) => {
  const { ran, clock, own } = harness(on)
  const signals = () => ran.filter(argv => argv[0] === 'tee')

  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(1000)
  await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
  const written = own().updatedAt
  const sent = signals().length

  await clock.advance(1000)
  await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
  expect(own().updatedAt).toBe(written)
  expect(signals().length).toBe(sent)
})

test('card changes in a burst send one signal now and one after the gap', async ($, on) => {
  const { ran, clock } = harness(on)
  const signals = () => ran.filter(argv => argv[0] === 'tee')

  await start($)
  await clock.advance(1000)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'go build ./...' })
  await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
  expect(signals().length).toBe(2)

  await clock.advance(SIGNAL_GAP_MS)
  expect(signals().length).toBe(3)
})

test('a card file not written for a day is removed, and a fresh one stays', async ($, on) => {
  const { others, mtimes, files, wake } = harness(on)

  await start($)
  others(card({ sessionId: 'old' }), card({ sessionId: 'live' }))
  mtimes.set(`${DIR}/old.json`, NOW - PURGE_MS - 1)
  await wake()

  expect(files.has(`${DIR}/old.json`)).toBe(false)
  expect(files.has(`${DIR}/live.json`)).toBe(true)
})

test('debug mode removes no card file', async ($, on) => {
  const { others, mtimes, files, wake } = harness(on, { CLAUDE_SIDEBAR_DEBUG: '1' })

  await start($)
  others(card({ sessionId: 'old' }))
  mtimes.set(`${DIR}/old.json`, NOW - PURGE_MS - 1)
  await wake()

  expect(files.has(`${DIR}/old.json`)).toBe(true)
})

test('with no signal an idle session reads nothing until the heartbeat, which catches the change', async ($, on) => {
  const { others, clock, store, opened } = harness(on)

  await start($)
  others(card({ sessionId: 'live' }))
  store.set('mode', 'open')
  await clock.advance(HEARTBEAT_MS - 1)
  expect(opened).toEqual([])

  await clock.advance(1)
  expect(opened).toEqual([{ id: 'sidebar', focus: undefined }])
  expect(await paneText($)).toContain('work/api')
})

test('a mode another session stores opens, then closes, the pane at the next signal', async ($, on) => {
  const { opened, wake, store } = harness(on)

  await start($)
  store.set('mode', 'open')
  await wake()
  expect(opened).toEqual([{ id: 'sidebar', focus: undefined }])

  store.set('mode', 'min')
  await wake()
  expect(opened).toEqual([])
  expect(store.get('mode')).toBe('min')

  store.set('mode', 'open')
  await wake()
  store.set('mode', 'closed')
  await wake()
  expect(opened).toEqual([])
})

test('the minimize button closes the pane and stores min, and the band button brings it back', async ($, on) => {
  const { opened, others, wake, store } = harness(on, {}, { mode: 'open' })

  await start($)
  others(card({ sessionId: 'live', status: 'needs-input' }), card({ sessionId: 'asks', asked: true }))
  await wake()
  expect(await (await $.ui.mount(BAND)).find({ type: 'Button' })).toBe(undefined)

  await (await $.ui.mount(PANE)).press({ key: 'minimize' })
  expect(opened).toEqual([])
  expect(store.get('mode')).toBe('min')

  const band = await $.ui.mount(BAND)
  expect((await band.find({ type: 'Button' }))?.props.label).toBe('[+] sidebar · 3 sessions · 2 need you')
  await band.press({ key: 'restore' })
  expect(opened).toEqual([{ id: 'sidebar', focus: true }])
  expect(store.get('mode')).toBe('open')
})

test('a session that starts while the mode is min shows the band and no pane', async ($, on) => {
  const { opened } = harness(on, {}, { mode: 'min' })

  await start($)

  expect(opened).toEqual([])
  expect((await (await $.ui.mount(BAND)).find({ type: 'Button' }))?.props.label).toBe('[+] sidebar · 1 session')
})

test('the minimized row keeps what the mods below draw in the band', async ($, on) => {
  harness(on, {}, { mode: 'min' })

  await start($)
  const band = await $.ui.mount(BAND)

  expect((await band.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['below'])
  expect((await band.findAll({ type: 'Button' })).length).toBe(1)
})

test('the band yields to a survey', async ($, on) => {
  harness(on, {}, { mode: 'min' })

  await start($)
  const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true } })

  expect(await band.find({ type: 'Button' })).toBe(undefined)
})

test('the band counts the sessions and the ones that wait for the person', () => {
  expect(bandLabel([card({})])).toBe('[+] sidebar · 1 session')
  expect(bandLabel([card({}), card({ status: 'running' })])).toBe('[+] sidebar · 2 sessions')
  expect(bandLabel([card({ status: 'needs-input' }), card({})])).toBe('[+] sidebar · 2 sessions · 1 needs you')
  expect(bandLabel([card({ status: 'needs-input' }), card({ asked: true }), card({ status: 'running', asked: true })])).toBe('[+] sidebar · 3 sessions · 2 need you')
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

test('an age reads in minutes, hours, then days, and stays empty under a minute or with no start', () => {
  const at = 10 * 86400000
  expect(ageLabel(at - 59000, at)).toBe('')
  expect(ageLabel(at - 60000, at)).toBe('1m')
  expect(ageLabel(at - 59 * 60000, at)).toBe('59m')
  expect(ageLabel(at - 60 * 60000, at)).toBe('1h')
  expect(ageLabel(at - 23 * 3600000, at)).toBe('23h')
  expect(ageLabel(at - 49 * 3600000, at)).toBe('2d')
  expect(ageLabel(0, at)).toBe('')
})

test('an idle or asked card shows how long it has waited, a busy card does not', () => {
  const top = (patch: Partial<Card>) => drawn([card({ sessionId: 'a', since: NOW - 12 * 60000, ...patch })], 40, 'me', 0, NOW)[0]
  const tops = [top({}), top({ asked: true }), top({ status: 'needs-input' }), top({ status: 'running' }), top({ since: 0 })]
  expect(tops).toEqual([
    '╭ work/api ────────────────── idle 12m ╮',
    '╭ work/api ───────────── asked you 12m ╮',
    '╭ work/api ─────────────── needs input ╮',
    '╭ work/api ───────────────── ✦ running ╮',
    '╭ work/api ────────────────────── idle ╮',
  ])
  expect(tops.map(t => cellWidth(t ?? ''))).toEqual(tops.map(() => 40))
})

test('the age starts when the status changes, and a heartbeat keeps it', async ($, on) => {
  const { own, clock } = harness(on)

  await start($)
  expect(own().since).toBe(NOW)

  await clock.advance(30000)
  expect(own()).toMatchObject({ since: NOW, updatedAt: NOW + 30000 })

  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(own().since).toBe(NOW + 30000)

  await clock.advance(60000)
  await $.turn.complete({ turnId: 't1', answer: 'Done.', durationMs: 5, isAborted: false, reason: 'answer' })
  expect(own()).toMatchObject({ status: 'idle', since: NOW + 90000 })
})

test('a session that starts again over its idle card keeps the age', async ($, on) => {
  const { own, others } = harness(on)
  others(card({ sessionId: SID, since: NOW - 600000 }))

  await start($)
  expect(own().since).toBe(NOW - 600000)
})

test('a session that starts again over its running card starts the age anew', async ($, on) => {
  const { own, others } = harness(on)
  others(card({ sessionId: SID, status: 'running', since: NOW - 600000 }))

  await start($)
  expect(own()).toMatchObject({ status: 'idle', since: NOW })
})

test('git status gives the branch, the changed files, and the commits not pushed yet', () => {
  expect(gitState(GIT_STATUS)).toEqual({ branch: 'feature/x', changed: 2, unpushed: 2 })
  expect(gitState('# branch.oid 1f2e3d\n# branch.head main\n')).toEqual({ branch: 'main', changed: 0, unpushed: null })
  expect(gitState('# branch.oid 1f2e3d\n# branch.head (detached)\n')).toMatchObject({ branch: 'HEAD' })
  expect(gitState('# branch.head main\n# branch.ab +0 -3\n')).toMatchObject({ unpushed: 0 })
})

test('the branch row adds only the git counts above zero', () => {
  expect(branchLine(card({ changed: 1, unpushed: 5 }))).toBe('🌿 main · 1 changed · 5 unpushed')
  expect(branchLine(card({ changed: 0, unpushed: 5 }))).toBe('🌿 main · 5 unpushed')
  expect(branchLine(card({ changed: 3, unpushed: null }))).toBe('🌿 main · 3 changed')
  expect(branchLine(card({ changed: 0, unpushed: 0 }))).toBe('🌿 main')
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
  const { clock, others, wake } = harness(on)
  await start($)
  others(card({ sessionId: 'a', status: 'running' }))
  await wake()
  const closed = await paneText($)
  await clock.advance(SPIN_MS * 3)
  expect(await paneText($)).toBe(closed)

  await $.command.run(RUN)
  const first = await paneText($)
  await clock.advance(SPIN_MS)
  const second = await paneText($)
  expect(second).not.toBe(first)

  others(card({ sessionId: 'a', status: 'idle' }))
  await wake()
  const idle = await paneText($)
  await clock.advance(SPIN_MS * 3)
  expect(await paneText($)).toBe(idle)

  others(card({ sessionId: 'a', status: 'running' }))
  await wake()
  await $.command.run(RUN)
  const shut = await paneText($)
  await clock.advance(SPIN_MS * 3)
  expect(await paneText($)).toBe(shut)
})

test('a card that needs input blinks its border, three frames on and three off, and keeps its text', () => {
  const waiting = [card({ sessionId: 'a', status: 'needs-input' }), card({ sessionId: 'me', status: 'needs-input' })]
  const corners = (spin: number) => renderCards(waiting, 40, 'me', spin).flatMap(l => l.spans).filter(s => s.text === '╭' || s.text === '╔').map(s => s.color)
  expect([0, 2, 3, 5, 6].map(corners)).toEqual([
    ['#FAB387', '#FAB387'],
    ['#FAB387', '#FAB387'],
    ['subtle', 'suggestion'],
    ['subtle', 'suggestion'],
    ['#FAB387', '#FAB387'],
  ])
  expect(drawn(waiting, 40, 'me', 0)).toEqual(drawn(waiting, 40, 'me', 3))
})

test('the frame timer also runs for a card that needs input', async ($, on) => {
  const { clock, others, wake } = harness(on)
  await start($)
  others(card({ sessionId: 'a', status: 'needs-input' }))
  await wake()
  await $.command.run(RUN)

  const pane = await $.ui.mount(PANE)
  const colors = async () => (await pane.findAll({ type: 'Text' })).map(t => t.props.color)
  const on0 = await colors()
  await clock.advance(SPIN_MS * 3)
  expect(await colors()).not.toEqual(on0)
  await pane.unmount()
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
  const { others, wake, tmuxCalls, toasts } = harness(on, { TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%7' })

  await start($)
  others(card({ sessionId: 'live', paneId: '%12' }))
  await wake()
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'live' })

  expect(tmuxCalls()).toEqual([['tmux', 'switch-client', '-t', '%12']])
  expect(toasts).toEqual([])
})

test('a hotkey outside tmux runs nothing and says why', async ($, on) => {
  const { others, wake, tmuxCalls, toasts } = harness(on)

  await start($)
  others(card({ sessionId: 'live', paneId: '%12' }), card({ sessionId: 'plain', cwd: '/work/zed' }))
  await wake()
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'live' })
  await pane.press({ key: 'plain' })

  expect(tmuxCalls()).toEqual([])
  expect(toasts).toEqual(['sidebar: jump needs both sessions inside tmux', 'sidebar: jump needs both sessions inside tmux'])
})

test('the own card has no jump button', async ($, on) => {
  const { wake } = harness(on)

  await start($)
  await wake()
  const pane = await $.ui.mount(PANE)

  expect((await pane.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual(['[-]'])
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
