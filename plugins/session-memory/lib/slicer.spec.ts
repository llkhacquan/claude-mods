import { describe, expect, test } from 'bun:test'
import { isHeadless, parseJsonl, redact, sliceRecords, type TranscriptRecord } from './slicer.ts'

const user = (content: TranscriptRecord['message'] extends infer M ? M extends { content?: infer C } ? C : never : never, extra: Partial<TranscriptRecord> = {}): TranscriptRecord => ({ type: 'user', entrypoint: 'cli', message: { role: 'user', content }, ...extra })
const assistant = (content: unknown[]): TranscriptRecord => ({ type: 'assistant', message: { role: 'assistant', content: content as never } })
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input })
const toolResult = (id: string, content: string, is_error = false) => ({ type: 'tool_result', tool_use_id: id, content, is_error })

describe('sliceRecords', () => {
  test('keeps human prompts and assistant text, drops thinking', () => {
    const s = sliceRecords([
      user('why is the build slow?'),
      assistant([{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Slow because it opens the file on every call.' }]),
    ])
    expect(s.lines).toEqual(['[user] why is the build slow?', '[assistant] Slow because it opens the file on every call.'])
    expect(s.humanChars).toBe('why is the build slow?'.length)
  })

  test('keeps queued mid-turn messages as human text', () => {
    const s = sliceRecords([{ type: 'attachment', attachment: { type: 'queued_command', prompt: 'use the other model' } }, { type: 'attachment', attachment: { type: 'hook_success' } }])
    expect(s.lines).toEqual(['[user] use the other model'])
  })

  test('drops injected reminders, meta and sidechain records', () => {
    const s = sliceRecords([
      user('<system-reminder>noise</system-reminder>'),
      user('meta', { isMeta: true }),
      user('subagent prompt', { isSidechain: true }),
      user([{ type: 'text', text: '<local-command-stdout>x</local-command-stdout>' }] as never),
    ])
    expect(s.lines).toEqual([])
  })

  test('renders slash commands as one line', () => {
    const s = sliceRecords([user('<command-message>wt</command-message>\n<command-name>/wt</command-name>\n<command-args>here</command-args>')])
    expect(s.lines).toEqual(['[cmd] /wt here'])
  })

  test('keeps compaction summaries', () => {
    const s = sliceRecords([user('Summary of prior work', { isCompactSummary: true })])
    expect(s.lines).toEqual(['[compact] Summary of prior work'])
  })

  test('drops read-only tool output, keeps edit paths', () => {
    const s = sliceRecords([
      assistant([toolUse('a', 'Read', { file_path: '/r/x.go' }), toolUse('b', 'Edit', { file_path: '/r/y.go', old_string: 'o', new_string: 'n' })]),
      user([toolResult('a', 'package main ...'), toolResult('b', 'ok')] as never),
    ])
    expect(s.lines).toEqual(['[tool] Edit: /r/y.go'])
    expect(s.gray).toEqual([])
  })

  test('keeps failing tool output with head and tail', () => {
    const long = 'x'.repeat(600) + 'END'
    const s = sliceRecords([
      assistant([toolUse('a', 'Bash', { command: 'make install' })]),
      user([toolResult('a', 'Exit code 137\n' + long, true)] as never),
    ])
    expect(s.lines[0].startsWith('[tool-error] Bash: make install\nExit code 137')).toBe(true)
    expect(s.lines[0].endsWith('END')).toBe(true)
    expect(s.lines[0]).toContain('\n...\n')
  })

  test('treats test failures in successful output as errors', () => {
    const s = sliceRecords([
      assistant([toolUse('a', 'Bash', { command: 'go test ./...' })]),
      user([toolResult('a', 'ok pkg/a\n--- FAIL: TestX (0.01s)')] as never),
    ])
    expect(s.lines[0]).toStartWith('[tool-error] Bash: go test ./...')
  })

  test('puts other successful output in the gray zone', () => {
    const s = sliceRecords([
      assistant([toolUse('a', 'Bash', { command: 'kubectl get pods' })]),
      user([toolResult('a', 'pod-1 Running')] as never),
    ])
    expect(s.lines).toEqual(['[tool] Bash: kubectl get pods'])
    expect(s.gray).toEqual([{ id: 'a', tool: 'Bash', arg: 'kubectl get pods', output: 'pod-1 Running' }])
  })

  test('resumes from a cursor and reports the next one', () => {
    const recs = [user('first'), user('second')]
    const a = sliceRecords(recs)
    expect(a.toIndex).toBe(2)
    const b = sliceRecords([...recs, user('third')], a.toIndex)
    expect(b.lines).toEqual(['[user] third'])
  })

  test('stops at the record that reaches maxChars', () => {
    const recs = [user('a'.repeat(10)), user('b'.repeat(10)), user('c'.repeat(10))]
    const s = sliceRecords(recs, 0, 20)
    expect(s.lines).toEqual(['[user] aaaaaaaaaa', '[user] bbbbbbbbbb'])
    expect(s.toIndex).toBe(2)
  })

  test('chunks chain to cover every record once', () => {
    const recs = Array.from({ length: 7 }, (_, i) => user(`msg ${i} ${'x'.repeat(20)}`))
    const seen: string[] = []
    let from = 0
    while (from < recs.length) {
      const s = sliceRecords(recs, from, 60)
      seen.push(...s.lines)
      from = s.toIndex
    }
    expect(seen).toEqual(sliceRecords(recs).lines)
  })

  test('does not cut between a tool call and its result', () => {
    const recs = [
      user('x'.repeat(30)),
      assistant([toolUse('a', 'Bash', { command: 'make test' })]),
      user([toolResult('a', 'FAIL: boom', true)] as never),
      user('after'),
    ]
    const s = sliceRecords(recs, 1, 10)
    expect(s.toIndex).toBe(3)
    expect(s.lines).toEqual(['[tool-error] Bash: make test\nFAIL: boom'])
  })

  test('cuts with a call still open once twice over maxChars', () => {
    const recs = [assistant([{ type: 'text', text: 'y'.repeat(50) }, toolUse('a', 'Bash', { command: 'sleep 1' })]), user('later')]
    expect(sliceRecords(recs, 0, 20).toIndex).toBe(1)
  })

  test('counts human turns', () => {
    const s = sliceRecords([user('one'), assistant([{ type: 'text', text: 'ok' }]), user('two'), user('<system-reminder>x</system-reminder>')])
    expect(s.humanTurns).toBe(2)
  })

  test('same input gives same output', () => {
    const recs = [user('a'), assistant([{ type: 'text', text: 'b' }])]
    expect(sliceRecords(recs)).toEqual(sliceRecords(recs))
  })
})

describe('redact', () => {
  test.each([
    ['private key block', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['aws key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['github token', 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'],
    ['slack token', 'xoxb-1234567890-abcdefghij'],
    ['openai style key', 'sk-proj-abcdefghijklmnopqrstuv'],
    ['bearer token', 'Bearer abcdefghijklmnopqrstuvwxyz123456'],
    ['token scheme', 'token abcdefghijklmnopqrstuvwxyz123456'],
    ['aws session key id', 'ASIAIOSFODNN7EXAMPLE'],
    ['github fine-grained token', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'],
    ['google api key', 'AIzaSyA-1234567890abcdefghijklmnopqrstu'],
    ['stripe live key', 'sk_live_51HabcdefghijKLMNOP'],
    ['gitlab token', 'glpat-abcdefghij1234567890'],
    ['npm token', 'npm_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['hugging face token', 'hf_abcdefghijklmnopqrstuvwxyz0123456'],
    ['raw 32-byte hex key', '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'],
  ])('%s', (_, secret) => {
    expect(redact(`before ${secret} after`)).toBe('before [redacted] after')
  })

  test('a private key with no END line is redacted to the end', () => {
    expect(redact('key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn')).toBe('key:\n[redacted]')
  })

  test('hides the value after a secret flag, keeps the flag', () => {
    expect(redact('psql --password hunter2hunter2 -h db')).toBe('psql --password [redacted] -h db')
    expect(redact('cast send --private-key 0xabc123def456 x')).toBe('cast send --private-key [redacted] x')
    expect(redact('cli --api-key "two words here"')).toBe('cli --api-key [redacted]')
    expect(redact('cli --token -v')).toBe('cli --token -v')
  })

  test('hides the whole quoted multi-word mnemonic', () => {
    expect(redact('MNEMONIC="abandon ability able about above absent"')).toBe('MNEMONIC="[redacted]"')
    expect(redact("seed: 'abandon ability able about'")).toBe("seed: '[redacted]'")
  })

  test('hides basic auth and curl user passwords', () => {
    expect(redact('Authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe('Authorization: Basic [redacted]')
    expect(redact('curl -u admin:s3cretpw https://x')).toBe('curl -u admin:[redacted] https://x')
    expect(redact('curl --user "admin:s3cretpw" https://x')).toBe('curl --user "admin:[redacted]" https://x')
  })

  test('one huge pasted message is cut to its head and tail', () => {
    const s = sliceRecords([user(`start ${'x'.repeat(50_000)} end`)])
    expect(s.lines[0]!.length).toBeLessThan(20_100)
    expect(s.lines[0]).toStartWith('[user] start')
    expect(s.lines[0]).toEndWith(' end')
  })

  test('a secret across the cut of a long error output is redacted before the cut', () => {
    const key = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(600)}\n-----END PRIVATE KEY-----`
    const s = sliceRecords([assistant([toolUse('a', 'Bash', { command: 'deploy' })]), user([{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: `${'log line\n'.repeat(60)}${key}` }] as never)])
    expect(s.lines[0]).not.toContain('AAAA')
    expect(s.lines[0]).toContain('[redacted]')
  })

  test('keeps the key name of env and json secrets', () => {
    expect(redact('DB_PASSWORD=hunter2hunter2')).toBe('DB_PASSWORD=[redacted]')
    expect(redact('{"api_key": "abcdef123456"}')).toBe('{"api_key": "[redacted]"}')
    expect(redact('export GATEWAY_KEY=zzzzzzzz')).toBe('export GATEWAY_KEY=[redacted]')
    expect(redact('monkey=bananas123')).toBe('monkey=bananas123')
  })

  test('removes the password from a connection url', () => {
    expect(redact('postgres://app:s3cr3t@db:5432/x')).toBe('postgres://app:[redacted]@db:5432/x')
  })

  test('leaves commit shas and plain text alone', () => {
    const s = 'commit bfbe110a15278d51414633c5a1fe5dd62acccee8 fixed the token refresh'
    expect(redact(s)).toBe(s)
  })

  test('slice output is redacted, gray zone included', () => {
    const s = sliceRecords([
      user('my key is DB_PASSWORD=hunter2hunter2'),
      assistant([toolUse('a', 'Bash', { command: 'cat .env' })]),
      user([toolResult('a', 'API_TOKEN=abcdefghijkl')] as never),
    ])
    expect(s.lines[0]).toBe('[user] my key is DB_PASSWORD=[redacted]')
    expect(s.gray[0].output).toBe('API_TOKEN=[redacted]')
  })
})

describe('parseJsonl', () => {
  test('keeps index alignment on a bad line', () => {
    expect(parseJsonl('{"type":"user"}\nnot json\n{"type":"assistant"}\n')).toHaveLength(3)
  })
})

describe('isHeadless', () => {
  test('cli is interactive, other entrypoints are headless', () => {
    expect(isHeadless([user('x')])).toBe(false)
    expect(isHeadless([user('x', { entrypoint: 'sdk-cli' })])).toBe(true)
  })
})
