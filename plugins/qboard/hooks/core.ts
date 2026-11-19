import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Board, Queued, Question, SendMode, ThreadEntry } from '../types'

export const PANE = 'qboard'
const DONE_SHOWN = 5
const SWITCH_STEP_MS = 100
const SWITCH_TRIES = 50

const EMPTY: Board = { session: '', next: 1, items: [] }
const board = atom({ plugin: 'qboard', key: 'board' } as const, EMPTY, { shape: 'board-1' })
const sendMode = atom({ plugin: 'qboard', key: 'send' } as const, 'send' as SendMode)
const showDone = atom({ plugin: 'qboard', key: 'showDone' } as const, false)
const drafts = atom({ plugin: 'qboard', key: 'drafts' } as const, {} as Record<string, string>)
const paneHidden = atom({ plugin: 'qboard', key: 'paneHidden' } as const, false)
const picked = atom({ plugin: 'qboard', key: 'picked' } as const, {} as Record<string, number>)
const sending = atom({ plugin: 'qboard', key: 'sending' } as const, {} as Record<string, string>)
const tick = atom({ plugin: 'qboard', key: 'tick' } as const, 0)
const queued = atom({ plugin: 'qboard', key: 'queued' } as const, {} as Record<string, Queued>)

export const AMBER = '#e0a526'
export const GREEN = '#3fa66b'
export const BLUE = '#6fa8dc'

export function age(iso: string) {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60 ? `${min % 60}m` : ''}`
}

export type Resolved = { id: string; option?: number; text?: string; bare?: boolean }

const qNum = (id: string) => Number(id.slice(1))

export function openQuestions(b: Board): Question[] {
  return b.items.filter(q => q.status === 'open').sort((x, y) => qNum(x.id) - qNum(y.id))
}

export function answerable(b: Board, id: string): Question | undefined {
  return b.items.find(q => q.id === id && q.status !== 'closed')
}

const OPTION_REF = /(?<!\blean\s*)\bQ(\d+)(?:\s*[.:=]\s*|\s+)(\d+)\b/gi
const LEAD_REF = /^Q(\d+)\b(?!\.)[ \t:=>-]*([^\n]*)/i
const HEADING = /^Q(\d+)\.(?!\d)/i
const ON_BOARD = /\bQ(\d+) (?:explained )?on board\b/gi

export type Mention = { id: string; text: string }

export type Skip = { id: string; why: 'unknown' | 'answered' | 'closed' | 'list' | 'pasted' | 'heading' }

function openOrSkip(b: Board, id: string): Question | Skip {
  const q = b.items.find(x => x.id === id)
  if (!q) return { id, why: 'unknown' }
  return q.status === 'open' ? q : { id, why: q.status }
}

// pasted model text is never an answer: an option list names one id with several options
// (Q3.1, Q3.2), the chat line says "Q3 on board" / "Lean Q3.1", a heading is "Q3. <question>";
// an answered question changes only through the answer tool;
// typed "Q3 <words>" may be an answer, a question or a counter-proposal => a mention for claude to judge
export function parseAnswers(text: string, b: Board): { answers: Resolved[]; skipped: Skip[]; mention?: Mention } {
  const t = text.trim()
  const answers: Resolved[] = []
  const skipped: Skip[] = []

  const bare = /^(\d+)$/.exec(t)
  if (bare) {
    const q = openQuestions(b)[0]
    const n = Number(bare[1])
    if (q?.options && n >= 1 && n <= q.options.length) answers.push({ id: q.id, option: n, bare: true })
    return { answers, skipped }
  }

  const pasted = new Set([...t.matchAll(ON_BOARD)].map(m => `Q${m[1]}`))
  for (const id of pasted) {
    const q = openOrSkip(b, id)
    skipped.push('why' in q ? q : { id, why: 'pasted' })
  }
  const refs = [...t.matchAll(OPTION_REF)].filter(m => !pasted.has(`Q${m[1]}`))
  const named = new Map<string, Set<number>>()
  for (const m of refs) named.set(`Q${m[1]}`, (named.get(`Q${m[1]}`) ?? new Set()).add(Number(m[2])))
  const isWordy = /\S/.test(t.slice(0, refs[0]?.index ?? 0)) || refs.some((m, i) => !isBareRef(b, m, t.slice(m.index + m[0].length, refs[i + 1]?.index ?? t.length)))
  for (const [id, picks] of named) {
    const q = openOrSkip(b, id)
    if ('why' in q) skipped.push(q)
    else if (picks.size > 1) skipped.push({ id, why: 'list' })
    else if (!isWordy) {
      const n = [...picks][0]!
      if (q.options && n >= 1 && n <= q.options.length) answers.push({ id, option: n })
    }
  }
  const first = refs[0]
  if (isWordy && first?.index === 0 && !skipped.some(x => x.id === `Q${first[1]}`)) {
    const rest = t.slice(`Q${first[1]}`.length).replace(/^[\s.:=>-]+/, '')
    return { answers, skipped, mention: { id: `Q${first[1]}`, text: rest } }
  }
  if (answers.length > 0 || skipped.length > 0) return { answers, skipped }

  const heading = HEADING.exec(t)
  if (heading) {
    const q = openOrSkip(b, `Q${heading[1]}`)
    skipped.push('why' in q ? q : { id: q.id, why: 'heading' })
    return { answers, skipped }
  }
  const lead = LEAD_REF.exec(t)
  if (lead && !pasted.has(`Q${lead[1]}`)) {
    const id = `Q${lead[1]}`
    const rest = t.slice(lead[0].length - (lead[2] ?? '').length).trim()
    const q = openOrSkip(b, id)
    if ('why' in q) skipped.push(q)
    else if (rest) return { answers, skipped, mention: { id, text: rest } }
  }
  return { answers, skipped }
}

// "Q3 2", "Q3.2, Q4 1" or the pane's "Q3 2 (<label>)" pick an option; "Q3 2 looks risky" or "not Q3 2" is free text
function isBareRef(b: Board, m: RegExpExecArray, tail: string): boolean {
  const label = b.items.find(q => q.id === `Q${m[1]}`)?.options?.[Number(m[2]) - 1]
  const rest = label !== undefined && tail.trimStart().startsWith(`(${label})`) ? tail.trimStart().slice(label.length + 2) : tail
  return /^[\s,;.&]*(?:and\b[\s,;.]*)?$/i.test(rest)
}

export function applyAnswers(b: Board, answers: Resolved[], at: string): Board {
  if (answers.length === 0) return b
  const byId = new Map(answers.map(a => [a.id, a]))
  return {
    ...b,
    items: b.items.map(q => {
      const a = byId.get(q.id)
      if (!a) return q
      return { ...q, status: 'answered', answer: { option: a.option, text: a.text, at } }
    }),
  }
}

const POLITE = ['let me know if', 'let me know when', 'feel free to', "if you'd like any", 'if you want any', 'happy to help', "don't hesitate", 'just let me know']
const STARTERS = ['which ', 'what ', 'how ', 'should i ', 'do you ', 'want me to ', 'shall i ', 'would you ']
const LEAN_LINE = /^\W*lean\s+(?:Q\d+[.\s])?\d+\b/im
const UNRESOLVED_HEAD = /^\W*unresolved questions?\W*(.*)$/im
const EMPTY_LIST = /^\W*(?:none|n\/a|nothing|no)\b/i
const OPTION_LINE = /^\s*(?:Q\d+\.)?\d+[.)]\s+\S/
const SAYS_ON_BOARD = /\bQ\d+ (?:explained )?on board\b/i

function endsWithQuestion(text: string): boolean {
  const parts = text.split(/[.!?\n]/).map(p => p.trim()).filter(p => p !== '')
  const last = (parts.at(-1) ?? '').toLowerCase()
  if (last === '' || POLITE.some(p => last.includes(p))) return false
  return text.endsWith('?') || (!last.includes(':') && STARTERS.some(s => last.startsWith(s)))
}

function endsWithOptionList(text: string): boolean {
  const lines = text.split('\n').map(l => l.trim())
  let i = lines.length
  while (i > 0 && OPTION_LINE.test(lines[i - 1]!)) i--
  return lines.length - i >= 2 && (lines[i - 1] ?? '').endsWith('?')
}

function hasUnresolvedList(text: string): boolean {
  const head = UNRESOLVED_HEAD.exec(text)
  if (!head) return false
  const rest = `${head[1] ?? ''}\n${text.slice(head.index + head[0].length)}`.trim()
  return rest !== '' && !EMPTY_LIST.test(rest)
}

export function asksInChat(answer: string): boolean {
  const text = answer.trim()
  if (text === '' || SAYS_ON_BOARD.test(text)) return false
  return hasUnresolvedList(text) || LEAN_LINE.test(text) || endsWithOptionList(text) || endsWithQuestion(text)
}

const REMINDER_MARK = 'qboard reminder:'

const REMINDER_TEXT = `${REMINDER_MARK} your last reply ends on a question for the user written in chat. Put it on the board with mcp__qboard__ask, then in chat write only "Q<n> on board" and your lean with its reason. If it was not a question for the user, reply "no question" and stop.`

const SKIP_LINE: Record<Skip['why'], (id: string) => string> = {
  unknown: id => `qboard: ${id} is not on the board.`,
  answered: id => `qboard: ${id} is already answered, left unchanged. If the user meant to change the answer, call mcp__qboard__answer.`,
  closed: id => `qboard: ${id} is closed, left unchanged.`,
  list: id => `qboard: ${id} is named with several options, read as a pasted list, left open.`,
  pasted: id => `qboard: "${id} on board" read as pasted chat text, ${id} left open.`,
  heading: id => `qboard: "${id}. ..." read as a pasted heading, left open. If the user meant it as an answer, call mcp__qboard__answer.`,
}

export function mentionLine(q: Question, text: string): string {
  return `qboard: the user wrote about ${q.id} "${q.text}": "${text}". The card is still open. If it answers ${q.id}, record it with mcp__qboard__answer (option if it names one, else text); if it asks about ${q.id}, reply with mcp__qboard__explain; if it changes the question, use mcp__qboard__edit.`
}

export function contextLines(b: Board, answers: Resolved[], skipped: Skip[]): string[] {
  const lines = answers.map(a => {
    const q = b.items.find(x => x.id === a.id)!
    const what = a.option !== undefined ? `option ${a.option} "${q.options![a.option - 1]}"` : `"${a.text}"`
    const how = a.bare ? ` (bare "${a.option}" read as the oldest open question)` : ''
    return `qboard: ${q.id} "${q.text}" answered: ${what}${how}.`
  })
  return [...lines, ...skipped.map(x => SKIP_LINE[x.why](x.id))]
}

const FOLLOW_UP = /^Q(\d+)\b[ \t:.=-]*(?:\?[ \t]*([^\n]*)|explain(?: more)?\b[^\n]*)/i

export type FollowUp = { id: string; text?: string }

export function parseFollowUp(text: string): (FollowUp & { rest: string }) | undefined {
  const t = text.trim()
  const m = FOLLOW_UP.exec(t)
  if (!m) return undefined
  const rest = t.slice(m[0].length).trim()
  const asked = m[2]?.trim()
  return asked ? { id: `Q${m[1]}`, text: asked, rest } : { id: `Q${m[1]}`, rest }
}

export function followUpLine(q: Question, f: FollowUp): string {
  const reply = `Reply with mcp__qboard__explain for ${q.id} (or rewrite the question with mcp__qboard__edit if it was unclear), then write only "${q.id} explained on board" in chat.`
  return f.text
    ? `qboard: the user asks about ${q.id} "${q.text}": "${f.text}". ${reply}`
    : `qboard: the user wants ${q.id} "${q.text}" explained more. ${reply}`
}

export function doneFollowUpLine(q: Question): string {
  return `qboard: ${q.id} is ${q.status} (done), left unchanged. Answer the user in chat, or ask a new question with mcp__qboard__ask.`
}

export const EXPLAIN_MORE = 'explain more'
export const REWROTE = 'rewrote the question'
// claude may never call explain => the wait ends on its own so the button cannot stay stuck
const PENDING_MS = 5 * 60_000

export function isAwaitingReply(q: Question, now: number): boolean {
  const last = q.thread?.at(-1)
  return last?.who === 'user' && now - Date.parse(last.at) < PENDING_MS
}

export function addThread(b: Board, id: string, entry: ThreadEntry): Board {
  return { ...b, items: b.items.map(q => (q.id === id ? { ...q, thread: [...(q.thread ?? []), entry] } : q)) }
}

export type EditInput = { id: string; text?: string; options?: string[]; notes?: string[]; lean?: number }

// new options => old notes and lean no longer line up, so they reset unless given again
export function editQuestion(q: Question, input: EditInput): Question | string {
  const options = input.options ?? q.options
  const notes = (input.notes ?? (input.options ? undefined : q.notes))?.map(n => n.trim())
  const lean = input.lean ?? (input.options ? undefined : q.lean)
  if (lean !== undefined && (!options || lean < 1 || lean > options.length)) return 'qboard: lean must point at one of the options.'
  if (notes && notes.length > (options?.length ?? 0)) return 'qboard: notes must not outnumber the options.'
  const { options: _o, notes: _n, lean: _l, ...rest } = q
  return {
    ...rest,
    text: input.text?.trim() || q.text,
    ...(options?.length ? { options } : {}),
    ...(options?.length && notes?.some(n => n.trim()) ? { notes } : {}),
    ...(lean ? { lean } : {}),
  }
}

export function editOrKeep(q: Question, input: EditInput): Question {
  const edited = editQuestion(q, input)
  return typeof edited === 'string' ? q : edited
}

export type AskInput = { text: string; options?: string[]; notes?: string[]; lean?: number }

export function addQuestion(b: Board, input: AskInput, at: string): [Board, Question] {
  const q: Question = {
    kind: 'q',
    id: `Q${b.next}`,
    text: input.text,
    ...(input.options?.length ? { options: input.options } : {}),
    ...(input.options?.length && input.notes?.some(n => n.trim()) ? { notes: input.notes.map(n => n.trim()) } : {}),
    ...(input.lean ? { lean: input.lean } : {}),
    status: 'open',
    at,
  }
  return [{ ...b, next: b.next + 1, items: [...b.items, q] }, q]
}

async function boardDir($: EngineInterface) {
  return `${(await $.env.get('HOME')) ?? ''}/.local/state/qboard`
}

async function boardPath($: EngineInterface, session: string) {
  return `${await boardDir($)}/${session}.json`
}

const DAY_MS = 86_400_000
const IDLE_KEEP_MS = 7 * DAY_MS
const OPEN_KEEP_MS = 30 * DAY_MS
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const BOARD_FILE = new RegExp(`^${UUID}\\.json$`)

export function isPrunable(b: Board, ageMs: number): boolean {
  return ageMs > OPEN_KEEP_MS || (ageMs > IDLE_KEEP_MS && openQuestions(b).length === 0)
}

function asBoard(text: string): Board | undefined {
  try {
    const b = JSON.parse(text) as Board
    return typeof b?.session === 'string' && Array.isArray(b.items) ? b : undefined
  } catch {
    return undefined
  }
}

// a live session whose file goes still keeps its board in the atom => its next write recreates it
export async function pruneBoards($: EngineInterface, keep: string) {
  const dir = await boardDir($)
  if (!(await $.fs.exists(dir))) return
  const now = Date.now()
  for (const f of await $.fs.list(dir)) {
    const ageMs = now - f.mtimeMs
    if (f.kind !== 'file' || !BOARD_FILE.test(f.name) || f.name === `${keep}.json` || ageMs <= IDLE_KEEP_MS) continue
    const path = `${dir}/${f.name}`
    try {
      const b = asBoard((await $.fs.read(path)) as string)
      if (!b || !isPrunable(b, ageMs)) continue
      const rm = await $.process.run(['rm', '-f', '--', path])
      if (rm.exitCode !== 0) $.ui.log(`qboard: could not delete ${path}: ${rm.stderr}`)
    } catch (err) {
      $.ui.log(`qboard: prune skipped ${path}: ${String(err)}`)
    }
  }
}

async function loadFile($: EngineInterface, path: string): Promise<Board | undefined> {
  if (!(await $.fs.exists(path))) return undefined
  try {
    return JSON.parse((await $.fs.read(path)) as string) as Board
  } catch (err) {
    $.ui.log(`qboard: unreadable ${path}, starting empty: ${String(err)}`)
    return undefined
  }
}

let clearedBoard: Board | undefined
let clearedQueue: Record<string, Queued> | undefined
let isFirstSession = true

// board follows the user across /clear (clearedBoard, kept by session.end before the atom
// resets) and across a handoff to a new process (QBOARD_FROM=<old session id> set by the
// launcher; it names the process's first session only, never a /resume target)
export async function current($: EngineInterface): Promise<Board> {
  const session = await $.session.id()
  const b = await read($, board)
  if (b.session === session) return b
  const carry = clearedBoard?.session && clearedBoard.session !== session ? clearedBoard : undefined
  if (carry) clearedBoard = undefined
  const from = isFirstSession ? await $.env.get('QBOARD_FROM') : undefined
  const prev =
    (await loadFile($, await boardPath($, session))) ??
    (carry?.session ? carry : undefined) ??
    (from && from !== session ? await loadFile($, await boardPath($, from)) : undefined)
  const loaded: Board = { session, next: prev?.next ?? 1, items: prev?.items ?? [] }
  // a change() that loaded and wrote during the awaits above wins over this older snapshot
  const b2 = await update($, board, cur => (cur.session === session ? cur : loaded))
  if (b2 === loaded && prev && prev.session !== session)
    await $.fs.write(await boardPath($, session), `${JSON.stringify(loaded, null, 2)}\n`)
  return b2
}

// engine 2.1.326: /clear and /resume reset the atom and switch $.session.id() up to ~600 ms
// session.start also fires on a reload or worker respawn => a pane the user hid stays hidden
export async function ensurePane($: EngineInterface) {
  try {
    if (await read($, paneHidden)) return
    if (!(await $.ui.panes()).some(p => p.id === PANE)) await $.ui.open({ id: PANE, title: 'qboard' })
  } catch (err) {
    $.ui.log(`qboard: could not open the pane: ${String(err)}`)
  }
}

export async function showPane($: EngineInterface) {
  await update($, paneHidden, () => false)
  await $.ui.open({ id: PANE, title: 'qboard', focus: true })
}

// after session.end, with no session.start => wait for the new id, then load. /resume of the
// current session keeps the id but still resets the atom => load once the wait runs out
export function loadAfterSwitch($: EngineInterface, from: string, triesLeft = SWITCH_TRIES) {
  $.clock.after(SWITCH_STEP_MS, async () => {
    if ((await $.session.id()) === from && triesLeft > 1) loadAfterSwitch($, from, triesLeft - 1)
    else {
      const b = await current($)
      const carried = clearedQueue
      clearedQueue = undefined
      if (carried) await update($, queued, m => ({ ...Object.fromEntries(Object.entries(carried).map(([k, v]) => [k, { ...v, session: b.session }])), ...m }))
      await update($, paneHidden, () => false)
      await ensurePane($)
    }
  })
}

async function save($: EngineInterface, b: Board) {
  await update($, board, () => b)
  await $.fs.write(await boardPath($, b.session), `${JSON.stringify(b, null, 2)}\n`)
}

// transform inside update => a pane press and a tool call never overwrite each other
export async function change($: EngineInterface, f: (b: Board) => Board): Promise<Board> {
  await current($)
  const b = await update($, board, f)
  await $.fs.write(await boardPath($, b.session), `${JSON.stringify(b, null, 2)}\n`)
  return b
}

export function pressLine(q: Question, a: Resolved): string {
  return a.option !== undefined ? `${q.id} ${a.option} (${q.options![a.option - 1]})` : `${q.id} ${a.text}`
}

// own prompt.submit hook never sees this plugin's $.prompt.submit => onSend does the hook's board work
async function submit($: EngineInterface, sendText: string, onSend: () => Promise<unknown>): Promise<string | undefined> {
  const sent = await $.prompt.submit({ text: sendText, asUser: true })
  if (sent.drop !== undefined) return sent.drop
  await onSend()
  return undefined
}

// a pane text answer in fill mode reaches the prompt.submit hook as typed "Q3 <text>" => still an answer,
// matched whole so text like "2 workers" or "explain more later" is not parsed as an option or follow-up
export const filledAnswers = new Map<string, Resolved>()

async function fill($: EngineInterface, typed: string): Promise<boolean> {
  const filled = await $.prompt.fill({ text: typed })
  $.ui.toast(filled.isFilled ? `in the prompt: ${typed}` : `could not send: ${typed}`)
  return filled.isFilled
}

async function fillTyped($: EngineInterface, q: Question, item: Queued) {
  const typed = typedLine(q, item)
  const isFilled = await fill($, typed)
  if (isFilled && !item.isAsk && item.option === undefined && item.text) filledAnswers.set(typed.trim(), { id: q.id, text: item.text.trim() })
}

export function filledAnswer(b: Board, a: Resolved): ReturnType<typeof parseAnswers> {
  const q = openOrSkip(b, a.id)
  return 'why' in q ? { answers: [], skipped: [q] } : { answers: [a], skipped: [] }
}

export function typedLine(q: Question, item: Queued): string {
  if (item.isAsk) return item.text ? `${q.id} ? ${item.text}` : `${q.id} explain more`
  return item.option !== undefined ? `${q.id} ${item.option}` : `${q.id} ${item.text}`
}

function sendLine(q: Question, item: Queued): string {
  return item.isAsk ? typedLine(q, item) : pressLine(q, { id: q.id, option: item.option, text: item.text })
}

function onSent($: EngineInterface, q: Question, item: Queued): () => Promise<unknown> {
  const at = new Date().toISOString()
  return item.isAsk
    ? () => change($, b => addThread(b, q.id, { who: 'user', text: item.text ?? EXPLAIN_MORE, at }))
    : () => change($, b => applyAnswers(b, [{ id: q.id, option: item.option, text: item.text }], at))
}

// a Stop drops queued plugin prompts and holds new ones until the person sends input => retry at turn end
const MAX_TRIES = 5

async function deliver($: EngineInterface, q: Question, item: Queued, isSendForced = false) {
  const key = queueKey(item)
  const unqueue = () => update($, queued, ({ [key]: _, ...rest }) => rest)
  if (!isSendForced && (await read($, sendMode)) === 'fill') return fillTyped($, q, item)
  const drop = await submit($, sendLine(q, item), onSent($, q, item))
  if (drop === undefined) return unqueue()
  $.ui.log(`qboard: ${typedLine(q, item)} dropped (${drop}), try ${item.tries + 1} of ${MAX_TRIES}`)
  if (item.tries + 1 >= MAX_TRIES) {
    await unqueue()
    return fillTyped($, q, item)
  }
  await update($, queued, m => ({ ...m, [key]: { ...item, tries: item.tries + 1 } }))
}

const queueKey = (item: Queued) => (item.isAsk ? `${item.id}?` : item.id)

export const QUEUED_NOTE = 'queued, sends after the turn'

let flushing: Promise<unknown> = Promise.resolve()

// an item stays in the queue until its send settles => its card stays locked, no second answer races it
export function flushQueued($: EngineInterface) {
  const run = async () => {
    for (const key of Object.keys(await read($, queued))) {
      const item = (await read($, queued))[key]
      if (!item) continue
      const b = await current($)
      const q = item.session === b.session ? answerable(b, item.id) : undefined
      if (q?.status !== 'open') {
        await update($, queued, ({ [key]: _, ...rest }) => rest)
        continue
      }
      await deliver($, q, item, true)
    }
  }
  flushing = flushing.then(run, run)
  return flushing
}

async function send($: EngineInterface, q: Question, a: Resolved) {
  const session = (await current($)).session
  await deliver($, q, { id: q.id, session, option: a.option, text: a.text, tries: 0 })
}

async function sendFollowUp($: EngineInterface, q: Question, text?: string) {
  const session = (await current($)).session
  await deliver($, q, { id: q.id, session, text, isAsk: true, tries: 0 })
}

async function whileSending($: EngineInterface, id: string, text: string, work: () => Promise<unknown>) {
  await update($, sending, s => ({ ...s, [id]: text }))
  try {
    await work()
  } finally {
    await update($, sending, ({ [id]: _, ...rest }) => rest)
  }
}

const MAX_DRAFT_ROWS = 6
// rows 1 => single-line field that drops typed newlines; 2+ => textarea
const MIN_DRAFT_ROWS = 2

export function draftRows(draft: string | undefined, width?: number): number {
  const lines = (draft ?? '').split('\n')
  const wrapped = width ? lines.reduce((n, l) => n + Math.ceil(Math.max(1, [...l].length) / width), 0) : lines.length
  return Math.min(MAX_DRAFT_ROWS, Math.max(MIN_DRAFT_ROWS, wrapped))
}

// pane body minus card border + padding (4), gap (1), [ask] chip (7), submit label (5)
const INPUT_CHROME_COLUMNS = 17
const MIN_INPUT_WIDTH = 10

export function inputWidth(bodyColumns: number): number {
  return Math.max(MIN_INPUT_WIDTH, bodyColumns - INPUT_CHROME_COLUMNS)
}

// update() is not atomic across two concurrent presses => the claim is a sync check-and-set
const pressing = new Set<string>()

async function whilePicked($: EngineInterface, key: string, option: number, work: () => Promise<unknown>) {
  if (pressing.has(key)) return
  pressing.add(key)
  try {
    await update($, picked, p => ({ ...p, [key]: option }))
    await work()
  } finally {
    pressing.delete(key)
    await update($, picked, ({ [key]: _, ...rest }) => rest)
  }
}

export async function takeDraft($: EngineInterface, id: string): Promise<string> {
  let text = ''
  await update($, drafts, d => {
    text = d[id]?.trim() ?? ''
    return { ...d, [id]: '' }
  })
  return text
}

const FILE_PATH = /(?<![\w./~-])((?:~\/|\.{1,2}\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)*\.(?:html?|md|svg|png|jpe?g|gif|webp|pdf|txt))(?![\w/-]|\.\w)/gi

export function filePaths(text: string): string[] {
  return [...new Set([...text.matchAll(FILE_PATH)].map(m => m[1]!))]
}

export function resolvePath(path: string, cwd: string, home: string): string {
  const full = path.startsWith('~/') ? `${home}/${path.slice(2)}` : path.startsWith('/') ? path : `${cwd}/${path}`
  const parts: string[] = []
  for (const part of full.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return `/${parts.join('/')}`
}

export const cardTexts = (q: Question) => [q.text, ...(q.notes ?? []), ...(q.thread ?? []).map(t => t.text)]

async function existingFiles($: EngineInterface, texts: readonly string[]): Promise<Map<string, string>> {
  const cwd = await $.session.cwd()
  const home = (await $.env.get('HOME')) ?? ''
  const paths = [...new Set(texts.flatMap(filePaths))].map(path => [path, resolvePath(path, cwd, home)] as const)
  const exists = await Promise.all(paths.map(([, abs]) => $.fs.exists(abs)))
  return new Map(paths.filter((_, i) => exists[i]))
}

export async function openFile($: EngineInterface, path: string) {
  const r = await $.process.run(['open', path])
  if (r.exitCode !== 0) $.ui.toast(`could not open ${path}`)
}

export type CardActions = {
  pick: (option: number) => void
  answer: (text: string) => void
  ask: (text?: string) => void
}

let tickTimer: { cancel: () => void } | undefined
let isInteractive = false
let isBoardTouched = false
let isReminderTurn = false

// a mod cannot block a turn end (classic.Stop never reaches a user-tier mod) => re-prompt right after it
export async function remindIfAsked($: EngineInterface, reason: string, answer: string) {
  try {
    if (!isInteractive || reason !== 'answer' || isReminderTurn || isBoardTouched || !asksInChat(answer)) return
    if (Object.keys(await read($, queued)).length > 0) return
    const sent = await $.prompt.submit({ text: REMINDER_TEXT })
    if (sent.drop !== undefined) $.ui.log(`qboard: question reminder dropped (${sent.drop})`)
  } catch (err) {
    $.ui.log(`qboard: question reminder failed: ${String(err)}`)
  }
}

export async function resetLocks($: EngineInterface) {
  await update($, picked, () => ({}))
  await update($, sending, () => ({}))
}

export function startTimers($: EngineInterface) {
  tickTimer?.cancel()
  tickTimer = $.clock.every(60_000, () => void update($, tick, n => n + 1))
}

export async function markPaneHidden($: EngineInterface) {
  await update($, paneHidden, () => true)
}

export async function openOnBoard($: EngineInterface) {
  return openQuestions(await read($, board))
}

export function setDraft($: EngineInterface, id: string, value: string) {
  return update($, drafts, d => ({ ...d, [id]: value }))
}

export function toggleDone($: EngineInterface) {
  return update($, showDone, v => !v)
}

export function toggleMode($: EngineInterface) {
  return update($, sendMode, m => (m === 'send' ? 'fill' : 'send'))
}

export function setInteractive(value: boolean) {
  isInteractive = value
}

export function markBoardTouched() {
  isBoardTouched = true
}

export function startTurn(text: string) {
  isReminderTurn = text.includes(REMINDER_MARK)
  isBoardTouched = false
}

export async function holdForSwitch($: EngineInterface, isClear: boolean) {
  clearedBoard = isClear ? await read($, board) : undefined
  clearedQueue = isClear ? await read($, queued) : undefined
  isFirstSession = false
}

export async function paneState($: EngineInterface) {
  const b = await read($, board)
  const mode = await read($, sendMode)
  const isDoneShown = await read($, showDone)
  const draftOf = await read($, drafts)
  const sendingOf = await read($, sending)
  const pickedOf = await read($, picked)
  await read($, tick)
  const open = openQuestions(b)
  const done = b.items.filter(q => q.status !== 'open').slice(-DONE_SHOWN).reverse()
  const queuedOf = await read($, queued)
  const files = await existingFiles($, open.flatMap(cardTexts))
  return { b, mode, isDoneShown, draftOf, sendingOf, pickedOf, queuedOf, open, done, files }
}

export function cardActions($: EngineInterface, q: Question): CardActions {
  return {
    pick: n => void whilePicked($, q.id, n, () => send($, q, { id: q.id, option: n })),
    answer: text => void whileSending($, q.id, text, () => send($, q, { id: q.id, text })),
    ask: text => void (text ? whileSending($, q.id, text, () => sendFollowUp($, q, text)) : sendFollowUp($, q)),
  }
}
