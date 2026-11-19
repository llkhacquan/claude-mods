import type { EngineInterface, RenderInputOf } from 'claude-code'

import type { Question } from '../types'
import { BLUE, QUEUED_NOTE, age, cardTexts, draftRows, filePaths, isAwaitingReply, openFile, cardActions, paneState, setDraft, takeDraft, toggleDone, toggleMode, typedLine } from './core'

export async function desktopPane($: EngineInterface, e: RenderInputOf<'Pane', 'desktop'>) {
  const { Box, Text, Button, Input } = $.ui.resolve(e)
  const { b, mode, isDoneShown, draftOf, sendingOf, pickedOf, queuedOf, open, done, files } = await paneState($)

  const pill = (text: string, bg: string) => (
    <Text size="caption" weight="semibold" color="inverseText" backgroundColor={bg}>{` ${text} `}</Text>
  )

  const fileButtons = (q: Question) => {
    const byAbs = new Map<string, string>()
    for (const p of cardTexts(q).flatMap(filePaths)) {
      const abs = files.get(p)
      if (abs && !byAbs.has(abs)) byAbs.set(abs, p)
    }
    if (byAbs.size === 0) return undefined
    const base = (abs: string) => abs.split('/').at(-1)!
    const bases = [...byAbs.keys()].map(base)
    return (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {[...byAbs].map(([abs, typed], i) => (
          <Button key={`${q.id}-file-${i + 1}`} variant="secondary" onPress={() => void openFile($, abs)}>
            {`Open ${bases.filter(b => b === base(abs)).length > 1 ? typed : base(abs)}`}
          </Button>
        ))}
      </Box>
    )
  }

  const card = (q: Question) => {
    const k = q.id
    const src = cardActions($, q)
    const held = queuedOf[k]
    const heldAsk = queuedOf[`${k}?`]
    const isLocked = pickedOf[k] !== undefined || sendingOf[k] !== undefined || held !== undefined
    const lockText = sendingOf[k] ?? (held ? typedLine(q, held) : `${q.id}.${pickedOf[k]}`)
    const lockNote = sendingOf[k] !== undefined || pickedOf[k] !== undefined ? 'sending...' : QUEUED_NOTE
    return (
      <Box key={k} flexDirection="column" gap={1} borderStyle="round" borderColor="warning" padding={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          {pill(q.id, 'warning')}
          <Box flexGrow={1} />
          <Text size="caption" dimColor>{age(q.at)}</Text>
        </Box>
        <Text weight="semibold">{q.text}</Text>
        {fileButtons(q)}
        {q.options?.map((opt, i) => {
          const label = `${q.id}.${i + 1}  ${opt}${q.lean === i + 1 ? '  (recommended)' : ''}`
          return (
            <Box key={`${k}-row-${i + 1}`} flexDirection="column">
              {pickedOf[k] === i + 1 ? (
                <Text key={`${k}-${i + 1}-picked`} color="success" weight="semibold">{`✓ ${label}`}</Text>
              ) : isLocked ? (
                <Text key={`${k}-${i + 1}-off`} dimColor>{label}</Text>
              ) : (
                <Button key={`${k}-${i + 1}`} variant={q.lean === i + 1 ? 'primary' : 'secondary'} onPress={() => src.pick(i + 1)}>
                  {label}
                </Button>
              )}
              {q.notes?.[i] && (
                <Box paddingLeft={1}>
                  <Text size="footnote" dimColor>{q.notes[i]}</Text>
                </Box>
              )}
            </Box>
          )
        })}
        {q.thread?.map((t, i) => (
          <Box key={`${k}-thread-${i}`} flexDirection="row" gap={1}>
            <Text size="caption" weight="semibold" color={t.who === 'user' ? BLUE : 'success'}>{t.who === 'user' ? 'you' : 'claude'}</Text>
            <Box flexGrow={1}>
              <Text>{t.text}</Text>
            </Box>
          </Box>
        ))}
        {isLocked ? (
          <Text key={`${k}-sending`} dimColor>{`${lockText}  (${lockNote})`}</Text>
        ) : (
          <Input
            key={`${k}-input`}
            value={draftOf[k] ?? ''}
            rows={draftRows(draftOf[k])}
            placeholder="Type an answer and press Enter, or a question and press Ask"
            submitLabel={mode === 'send' ? 'Send' : 'Fill'}
            onInput={v => void setDraft($, k, v)}
            onSubmit={v => {
              void takeDraft($, k)
              if (v.trim()) src.answer(v.trim())
            }}
          />
        )}
        <Box flexDirection="row" gap={1} alignItems="center">
          {!heldAsk && (
            <Button key={`${k}-ask`} variant="secondary" onPress={() => void takeDraft($, k).then(text => (text ? src.ask(text) : undefined))}>
              Ask
            </Button>
          )}
          {heldAsk ? (
            <Text key={`${k}-queued`} dimColor>
              {`${typedLine(q, heldAsk)} (${QUEUED_NOTE})`}
            </Text>
          ) : isAwaitingReply(q, Date.now()) ? (
            <Text key={`${k}-waiting`} dimColor>
              waiting for claude...
            </Text>
          ) : (
            <Button key={`${k}-more`} variant="secondary" onPress={() => src.ask()}>
              Explain more
            </Button>
          )}
        </Box>
      </Box>
    )
  }

  const doneRow = (q: Question) => {
    const what = q.status === 'closed'
      ? `closed${q.closed?.reason ? `: ${q.closed.reason}` : ''}`
      : q.answer?.option !== undefined
        ? `${q.id}.${q.answer.option} ${q.options?.[q.answer.option - 1] ?? ''}`
        : (q.answer?.text ?? '')
    return (
      <Box key={q.id} flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text size="caption" weight="semibold" dimColor>{q.id}</Text>
          <Box flexGrow={1}>
            <Text dimColor strikethrough={q.status === 'closed'}>{q.text}</Text>
          </Box>
          <Text size="caption" dimColor>{age(q.answer?.at ?? q.closed?.at ?? q.at)}</Text>
        </Box>
        <Text size="footnote" color={q.status === 'closed' ? undefined : 'success'} dimColor={q.status === 'closed'}>{what}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text size="heading" weight="semibold">qboard</Text>
        {open.length > 0 ? pill(`${open.length} open`, 'warning') : <Text size="caption" color="success">all answered</Text>}
        <Box flexGrow={1} />
        <Button key="mode" variant="secondary" onPress={() => void toggleMode($)}>
          {mode === 'send' ? 'Answers: send now' : 'Answers: fill prompt'}
        </Button>
      </Box>
      {open.length === 0 && (
        <Box flexDirection="column" borderStyle="round" borderDimColor padding={1}>
          <Text weight="semibold">Nothing waits for you.</Text>
          <Text dimColor>New questions show up here when Claude asks.</Text>
        </Box>
      )}
      {open.map(card)}
      {done.length > 0 && (
        <Box flexDirection="column" gap={1}>
          <Button key="done" variant="secondary" onPress={() => void toggleDone($)}>
            {`${isDoneShown ? 'Hide' : 'Show'} answered and closed (${b.items.length - open.length})`}
          </Button>
          {isDoneShown && done.map(doneRow)}
        </Box>
      )}
    </Box>
  )
}
