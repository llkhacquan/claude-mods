import type { EngineInterface, RenderInputOf } from 'claude-code'

import type { Question } from '../types'
import { AMBER, BLUE, GREEN, QUEUED_NOTE, age, cardTexts, draftRows, filePaths, isAwaitingReply, draftPreview, openFile, cardActions, paneState, setDraft, takeDraft, toggleDone, toggleMode, typedLine } from './core'

export async function terminalPane($: EngineInterface, e: RenderInputOf<'Pane', 'terminal'>) {
  const { Box, Text, Button, Input } = $.ui.resolve(e)
  const chip = (icon: string, label: string) => `[${icon} ${label}]`
  const { b, mode, isDoneShown, draftOf, sendingOf, pickedOf, queuedOf, open, done, files } = await paneState($)

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
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} paddingLeft={1}>
        {[...byAbs].map(([abs, typed], i) => (
          <Button key={`${q.id}-file-${i + 1}`} plain onPress={() => void openFile($, abs)}>
            {chip('\uf15b', bases.filter(b => b === base(abs)).length > 1 ? typed : base(abs))}
          </Button>
        ))}
      </Box>
    )
  }

  const card = (q: Question, isFirst: boolean) => {
    const k = q.id
    const src = cardActions($, q)
    const held = queuedOf[k]
    const heldAsk = queuedOf[`${k}?`]
    const isLocked = pickedOf[k] !== undefined || sendingOf[k] !== undefined || held !== undefined
    const lockText = sendingOf[k] ?? (held ? typedLine(q, held) : `${q.id}.${pickedOf[k]}`)
    const lockNote = sendingOf[k] !== undefined || pickedOf[k] !== undefined ? 'sending...' : QUEUED_NOTE
    const preview = isLocked ? undefined : draftPreview(draftOf[k], e.props.bodyColumns)
    return (
      <Box key={k} flexDirection="column" borderStyle="round" borderColor={isFirst ? AMBER : undefined} borderDimColor={!isFirst} paddingX={1}>
        <Box flexDirection="row" gap={1}>
          <Text inverse bold color={AMBER}>{` ${q.id} `}</Text>
          <Box flexGrow={1}>
            <Text bold>{q.text}</Text>
          </Box>
          <Text dimColor>{age(q.at)}</Text>
        </Box>
        {fileButtons(q)}
        {q.options?.map((opt, i) => (
          <Box key={`${k}-row-${i + 1}`} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              {q.lean === i + 1 ? <Text color={AMBER} bold>*</Text> : <Text> </Text>}
              {pickedOf[k] === i + 1 ? (
                <Text key={`${k}-${i + 1}-picked`} color={GREEN} bold>{`✓ ${q.id}.${i + 1} ${opt}`}</Text>
              ) : isLocked ? (
                <Text key={`${k}-${i + 1}-off`} dimColor>{`${q.id}.${i + 1} ${opt}`}</Text>
              ) : (
                <Button key={`${k}-${i + 1}`} plain hotkey={isFirst && i < 9 ? String(i + 1) : undefined} onPress={() => src.pick(i + 1)}>
                  {`${q.id}.${i + 1} ${opt}`}
                </Button>
              )}
            </Box>
            {q.notes?.[i] && (
              <Box paddingLeft={4}>
                <Text dimColor>{q.notes[i]}</Text>
              </Box>
            )}
          </Box>
        ))}
        {q.thread?.map((t, i) => (
          <Box key={`${k}-thread-${i}`} flexDirection="row" gap={1} paddingLeft={1}>
            <Box flexShrink={0}>
              <Text color={t.who === 'user' ? BLUE : GREEN}>{t.who === 'user' ? 'you' : 'claude'}</Text>
            </Box>
            <Box flexGrow={1}>
              <Text>{t.text}</Text>
            </Box>
          </Box>
        ))}
        {heldAsk ? (
          <Text key={`${k}-queued`} dimColor>
            {chip('\uf05a', `${typedLine(q, heldAsk)} (${QUEUED_NOTE})`)}
          </Text>
        ) : isAwaitingReply(q, Date.now()) ? (
          <Text key={`${k}-waiting`} dimColor>
            {chip('\uf05a', 'waiting for claude...')}
          </Text>
        ) : (
          <Button key={`${k}-more`} plain onPress={() => src.ask()}>
            {chip('\uf05a', 'explain more')}
          </Button>
        )}
        <Box flexDirection="column">
          <Box flexGrow={1} flexDirection="column">
            {preview && <Text key={`${k}-preview`} dimColor>{preview}</Text>}
            {isLocked ? (
              <Text key={`${k}-sending`} dimColor>{`${lockText}  (${lockNote})`}</Text>
            ) : (
              <Input
                key={`${k}-input`}
                value={draftOf[k] ?? ''}
                rows={draftRows(draftOf[k])}
                placeholder="answer, or ask below"
                submitLabel={mode === 'send' ? 'send' : 'fill'}
                onInput={v => void setDraft($, k, v)}
                onSubmit={v => {
                  void takeDraft($, k)
                  if (v.trim()) src.answer(v.trim())
                }}
              />
            )}
          </Box>
          {!heldAsk && (
            <Button key={`${k}-ask`} plain onPress={() => void takeDraft($, k).then(text => (text ? src.ask(text) : undefined))}>
              {chip('\uf059', 'ask')}
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
      <Box key={q.id} flexDirection="row" gap={1}>
        <Text dimColor bold>{q.id.padEnd(4)}</Text>
        <Box flexGrow={1} flexDirection="column">
          <Text dimColor strikethrough={q.status === 'closed'}>{q.text}</Text>
          <Text color={q.status === 'closed' ? undefined : GREEN} dimColor={q.status === 'closed'}>{`=> ${what}`}</Text>
        </Box>
        <Text dimColor>{age(q.answer?.at ?? q.closed?.at ?? q.at)}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1}>
        <Text bold>qboard</Text>
        {open.length > 0
          ? <Text color={AMBER} bold>{`${open.length} open`}</Text>
          : <Text color={GREEN}>all answered</Text>}
        <Box flexGrow={1} />
        <Button key="mode" plain onPress={() => void toggleMode($)}>
          {mode === 'send' ? 'send now' : 'fill prompt'}
        </Button>
      </Box>
      {open.length === 0 && (
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Text bold>Nothing waits for you.</Text>
          <Text dimColor>New questions show up here when Claude asks.</Text>
        </Box>
      )}
      {open.map((q, i) => card(q, i === 0))}
      {done.length > 0 && (
        <Box flexDirection="column">
          <Button key="done" plain hotkey="d" onPress={() => void toggleDone($)}>
            {`${isDoneShown ? 'v' : '>'} Answered and closed (${b.items.length - open.length})`}
          </Button>
          {isDoneShown && done.map(doneRow)}
        </Box>
      )}
      <Text dimColor>{`ctrl+x tab focus  esc back  ${open[0] ? `1-9 answer ${open[0].id}  ` : ''}d done`}</Text>
    </Box>
  )
}
