import type { Register } from 'claude-code'

import type { Board, Question } from '../types'
import { AMBER, EXPLAIN_MORE, PANE, REWROTE, addQuestion, addThread, answerable, applyAnswers, change, contextLines, current, doneFollowUpLine, editOrKeep, editQuestion, ensurePane, filledAnswer, filledAnswers, flushQueued, followUpLine, holdForSwitch, loadAfterSwitch, markBoardTouched, markPaneHidden, mentionLine, openOnBoard, parseAnswers, parseFollowUp, pruneBoards, remindIfAsked, resetLocks, setInteractive, showPane, startTimers, startTurn } from './core'
import type { AskInput, EditInput, Resolved } from './core'
import { desktopPane } from './pane-desktop'
import { terminalPane } from './pane-terminal'

const ASK = 'mcp__qboard__ask'
const CLOSE = 'mcp__qboard__close'
const ANSWER = 'mcp__qboard__answer'
const EXPLAIN = 'mcp__qboard__explain'
const EDIT = 'mcp__qboard__edit'

const FILE_HINT = 'Name a file by absolute path or a path relative to the session cwd: an existing file shows as a button on the card that opens it.'

const ASK_DESCRIPTION = [
  'Put a question for the user on the session board and get its stable id (Q<n>).',
  'Ask every question for the user through this tool, a single one too.',
  'The user reads it on the board, so keep it short and self-contained: one plain line of question, short option labels, and a one-line note in notes for an option whose label alone does not say what it does.',
  'In chat do not repeat the question or its options: write only "Q<n> on board" and your lean with its reason.',
  'The user answers "Q7 2" or "Q7.2"; a bare number answers the oldest open question.',
  'When the user answers, the prompt carries a "qboard: ..." line naming the question and the chosen option: trust it.',
  'Free text "Q7 <words>" typed in chat leaves the card open and comes with a "qboard: the user wrote about Q7" line: judge whether it answers (mcp__qboard__answer), asks (mcp__qboard__explain) or changes the question (mcp__qboard__edit).',
  'No such line but the user clearly answered (a typo like "q 2 .1", or plain words): call mcp__qboard__answer.',
  'The user asks for more with "Q7 explain more" or "Q7 ? <question>": reply with mcp__qboard__explain, or fix the question with mcp__qboard__edit.',
  FILE_HINT,
].join(' ')

function notOpen(b: Board, id: string): string | undefined {
  const q = b.items.find(x => x.id === id)
  if (!q) return `qboard: ${id} is not on the board.`
  if (q.status === 'open') return undefined
  return `qboard: ${id} is ${q.status} (done); the user no longer sees its thread. Ask a new question with mcp__qboard__ask.`
}

const EXPLAIN_DESCRIPTION = [
  'Add your reply to a board question\'s thread, shown under the question in the pane.',
  'Use it when the user writes "Q7 explain more" or "Q7 ? <question>" (the pane\'s explain more and ask buttons send these).',
  'Reply there in a few plain lines, not in chat; in chat write only "Q7 explained on board". Only open questions show a thread: an answered or closed one is denied.',
  FILE_HINT,
].join(' ')

const EDIT_DESCRIPTION = [
  'Rewrite a board question in place, same id: clearer text, other options, notes or lean.',
  'Use it when the question was unclear, a follow-up showed a better option, or the facts changed.',
  'Fields left out stay; new options reset notes and lean unless given too. Only an open question can be edited; an answered or closed one is denied (ask a new question), and the answer tool changes an answer.',
  FILE_HINT,
].join(' ')

const ANSWER_DESCRIPTION =
  'Mark a board question answered when the user answered it but no "qboard: ..." line came with the prompt (a typo, or the answer in plain words). Give option for a chosen option, else text. Unsure which question or option they meant => ask, do not guess.'

const CLOSE_DESCRIPTION =
  'Take a question off the board without an answer, e.g. it no longer matters or the user answered it in other words. Answered questions need no close.'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'ask',
      description: ASK_DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The question, one line.' },
          options: { type: 'array', items: { type: 'string' }, description: 'Short option labels, in order. Leave out for a free-text question.' },
          notes: { type: 'array', items: { type: 'string' }, description: 'One short line per option, same order as options; "" for an option that needs none.' },
          lean: { type: 'integer', minimum: 1, description: '1-based index of the option you recommend.' },
        },
        required: ['text'],
      },
    })
    await $.tool.register({
      name: 'close',
      description: CLOSE_DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^Q\\d+$' },
          reason: { type: 'string' },
        },
        required: ['id'],
      },
    })
    await $.tool.register({
      name: 'answer',
      description: ANSWER_DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^Q\\d+$' },
          option: { type: 'integer', minimum: 1, description: '1-based option the user chose.' },
          text: { type: 'string', description: 'The answer in the user\'s words, when it is not an option.' },
        },
        required: ['id'],
      },
    })
    await $.tool.register({
      name: 'explain',
      description: EXPLAIN_DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^Q\\d+$' },
          text: { type: 'string', description: 'Your reply, a few plain lines.' },
        },
        required: ['id', 'text'],
      },
    })
    await $.tool.register({
      name: 'edit',
      description: EDIT_DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^Q\\d+$' },
          text: { type: 'string', description: 'The new question, one line.' },
          options: { type: 'array', items: { type: 'string' }, description: 'The new option labels, in order.' },
          notes: { type: 'array', items: { type: 'string' }, description: 'One short line per option, same order as options.' },
          lean: { type: 'integer', minimum: 1, description: '1-based index of the option you recommend.' },
        },
        required: ['id'],
      },
    })
    await $.command.register({ name: 'qboard', description: 'Show or hide the qboard pane: open questions and answers', immediate: true })
    const b = await current($)
    await pruneBoards($, b.session).catch(err => $.ui.log(`qboard: prune failed: ${String(err)}`))
    await resetLocks($)
    await ensurePane($)
    startTimers($)
    setInteractive(e.isInteractive)
    return next(e)
  })

  on('tool.run', { tool: ASK }, async ($, e) => {
    const input = e as unknown as Partial<AskInput>
    if (!input.text?.trim()) return { deny: 'qboard: text is required.' }
    if (input.lean !== undefined && (!input.options || input.lean < 1 || input.lean > input.options.length)) {
      return { deny: 'qboard: lean must point at one of the options.' }
    }
    if (input.notes && input.notes.length > (input.options?.length ?? 0)) {
      return { deny: 'qboard: notes must not outnumber the options.' }
    }
    const at = new Date().toISOString()
    let q!: Question
    await change($, b => {
      const [next, added] = addQuestion(b, { ...input, text: input.text!.trim() }, at)
      q = added
      return next
    })
    markBoardTouched()
    const opts = q.options?.map((o, i) => `${q.id}.${i + 1} ${o}`).join(', ')
    return { result: `${q.id} is on the board.${opts ? ` Options: ${opts}.` : ''} In chat write only "${q.id} on board" and your lean.` }
  })

  on('tool.run', { tool: CLOSE }, async ($, e) => {
    const { id, reason } = e as unknown as { id: string; reason?: string }
    const b = await current($)
    const q = b.items.find(x => x.id === id)
    if (!q) return { deny: `qboard: ${id} is not on the board.` }
    if (q.status !== 'open') return { result: `${id} is already ${q.status}.` }
    const closed = { reason, at: new Date().toISOString() }
    await change($, cur => ({ ...cur, items: cur.items.map(x => (x.id === id ? { ...x, status: 'closed' as const, closed } : x)) }))
    return { result: `${id} closed.` }
  })

  on('tool.run', { tool: ANSWER }, async ($, e) => {
    const { id, option, text } = e as unknown as { id: string; option?: number; text?: string }
    const b = await current($)
    const q = answerable(b, id)
    if (!q) return { deny: `qboard: ${id} is not an open or answered question on the board.` }
    if (option !== undefined && !(q.options && option <= q.options.length)) return { deny: `qboard: ${id} has no option ${option}.` }
    if (option === undefined && !text?.trim()) return { deny: 'qboard: give option or text.' }
    const a: Resolved = option !== undefined ? { id, option } : { id, text: text!.trim() }
    await change($, cur => applyAnswers(cur, [a], new Date().toISOString()))
    return { result: option !== undefined ? `${id} answered: option ${option} "${q.options![option - 1]}".` : `${id} answered.` }
  })

  on('tool.run', { tool: EXPLAIN }, async ($, e) => {
    const { id, text } = e as unknown as { id: string; text?: string }
    const b = await current($)
    const denied = notOpen(b, id)
    if (denied) return { deny: denied }
    if (!text?.trim()) return { deny: 'qboard: text is required.' }
    await change($, cur => addThread(cur, id, { who: 'claude', text: text.trim(), at: new Date().toISOString() }))
    return { result: `${id} thread updated. In chat write only "${id} explained on board".` }
  })

  on('tool.run', { tool: EDIT }, async ($, e) => {
    const input = e as unknown as EditInput
    const b = await current($)
    const denied = notOpen(b, input.id)
    if (denied) return { deny: denied }
    const q = b.items.find(x => x.id === input.id)!
    const edited = editQuestion(q, input)
    if (typeof edited === 'string') return { deny: edited }
    markBoardTouched()
    await change($, cur => {
      const next = { ...cur, items: cur.items.map(x => (x.id === q.id ? editOrKeep(x, input) : x)) }
      const was = cur.items.find(x => x.id === q.id)
      const isFollowUpOpen = was?.thread?.at(-1)?.who === 'user'
      return isFollowUpOpen ? addThread(next, q.id, { who: 'claude', text: REWROTE, at: new Date().toISOString() }) : next
    })
    return { result: `${q.id} updated.` }
  })

  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear' && e.reason !== 'resume') return next(e)
    await holdForSwitch($, e.reason === 'clear')
    const r = await next(e)
    loadAfterSwitch($, e.sessionId)
    return r
  })

  on('command.run', { command: 'qboard' }, async $ => {
    if ((await $.ui.panes()).find(p => p.id === PANE)?.isShown) {
      await $.ui.close({ id: PANE })
      return { text: 'qboard pane closed.' }
    }
    await showPane($)
    return { text: 'qboard pane opened.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind !== 'unload') await markPaneHidden($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) startTurn(e.text)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      void flushQueued($)
      void remindIfAsked($, e.reason, e.answer)
    }
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    const b = await current($)
    if (!b.items.some(q => q.status !== 'closed')) return next(e)
    const at = new Date().toISOString()
    const lines: string[] = []
    const filled = filledAnswers.get(e.text.trim())
    filledAnswers.delete(e.text.trim())
    const f = filled ? undefined : parseFollowUp(e.text)
    if (f) {
      const q = b.items.find(x => x.id === f.id)
      if (!q) lines.push(`qboard: ${f.id} is not on the board.`)
      else if (q.status !== 'open') lines.push(doneFollowUpLine(q))
      else {
        await change($, cur => addThread(cur, f.id, { who: 'user', text: f.text ?? EXPLAIN_MORE, at }))
        lines.push(followUpLine(q, f))
      }
    }
    const { answers, skipped, mention: m } = filled ? filledAnswer(b, filled) : parseAnswers(f ? f.rest : e.text, b)
    if (answers.length > 0) await change($, cur => applyAnswers(cur, answers, at))
    lines.push(...contextLines(b, answers, skipped))
    if (m) {
      await change($, cur => addThread(cur, m.id, { who: 'user', text: m.text, at }))
      lines.push(mentionLine(b.items.find(q => q.id === m.id)!, m.text))
    }
    if (lines.length === 0) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...lines] })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const open = await openOnBoard($)
    if (open.length === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={1}>
        <Text color={AMBER}>●</Text>
        <Text bold>{`${open.length} open:`}</Text>
        <Text color={AMBER} bold>{open.map(q => q.id).join(' ')}</Text>
        {e.surface === 'terminal' ? (
          <Button key="open-pane" plain onPress={() => void showPane($)}>
            [open]
          </Button>
        ) : (
          <Button key="open-pane" variant="secondary" onPress={() => void showPane($)}>
            Open board
          </Button>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => (e.surface === 'terminal' ? terminalPane($, e) : desktopPane($, e as never)))
}
