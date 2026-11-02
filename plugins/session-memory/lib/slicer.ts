export type TranscriptRecord = {
  type?: string
  isMeta?: boolean | null
  isSidechain?: boolean | null
  isCompactSummary?: boolean | null
  entrypoint?: string
  message?: { role?: string; content?: string | ContentBlock[] }
  attachment?: { type?: string; prompt?: unknown }
}

export type ContentBlock = {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  is_error?: boolean | null
  content?: string | { type: string; text?: string }[]
}

export type GrayCall = { id: string; tool: string; arg: string; output: string }

export type Slice = {
  lines: string[]
  gray: GrayCall[]
  humanChars: number
  humanTurns: number
  toIndex: number
}

const SILENT_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'ToolSearch', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite', 'Skill'])
const PATH_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const INJECTED = /^\s*<(system-reminder|local-command-stdout|local-command-caveat|command-stdout|bash-stdout|bash-stderr|task-notification)\b/
const FAILURE = /(^|\n)(--- FAIL|FAIL\b|panic:|Traceback \(most recent call last\)|error\[E\d+\])/
const ARG_MAX = 160
const ERR_SIDE = 250
const GRAY_MAX = 1500
const LINE_SIDE = 10_000

export function sliceRecords(records: TranscriptRecord[], fromIndex = 0, maxChars = Infinity): Slice {
  const lines: string[] = []
  const gray: GrayCall[] = []
  const pending = new Map<string, { tool: string; arg: string }>()
  let humanChars = 0
  let humanTurns = 0

  const human = (text: string) => {
    const t = text.trim()
    if (!t) return
    humanChars += t.length
    humanTurns++
    lines.push(`[user] ${t}`)
  }

  const take = (r: TranscriptRecord) => {
    if (r.isSidechain) return

    if (r.type === 'attachment') {
      if (r.attachment?.type === 'queued_command' && typeof r.attachment.prompt === 'string') human(r.attachment.prompt)
      return
    }

    if (r.type === 'user') {
      if (r.isMeta) return
      const content = r.message?.content
      if (r.isCompactSummary) {
        const text = typeof content === 'string' ? content : textOf(content ?? [])
        if (text.trim()) lines.push(`[compact] ${text.trim()}`)
        return
      }
      if (typeof content === 'string') {
        humanText(content, human, lines)
        return
      }
      for (const b of content ?? []) {
        if (b.type === 'text' && b.text) humanText(b.text, human, lines)
        else if (b.type === 'tool_result' && b.tool_use_id) toolResult(b, pending, lines, gray)
      }
      return
    }

    if (r.type === 'assistant') {
      const content = r.message?.content
      if (typeof content === 'string') {
        if (content.trim()) lines.push(`[assistant] ${content.trim()}`)
        return
      }
      for (const b of content ?? []) {
        if (b.type === 'text' && b.text?.trim()) lines.push(`[assistant] ${b.text.trim()}`)
        else if (b.type === 'tool_use' && b.id && b.name) {
          const arg = toolArg(b.name, b.input ?? {})
          pending.set(b.id, { tool: b.name, arg })
          if (PATH_TOOLS.has(b.name)) lines.push(`[tool] ${b.name}: ${arg}`)
        }
      }
    }
  }

  let toIndex = records.length
  for (let i = fromIndex; i < records.length; i++) {
    take(records[i] as TranscriptRecord)
    const size = sizeOf(lines)
    if (size >= maxChars * 2 || (size >= maxChars && pending.size === 0)) {
      toIndex = i + 1
      break
    }
  }

  return {
    lines: lines.map(l => headTail(redact(l), LINE_SIDE)),
    gray,
    humanChars,
    humanTurns,
    toIndex,
  }
}

const sizeOf = (lines: string[]): number => lines.reduce((n, l) => n + Math.min(l.length, LINE_SIDE * 2), 0)

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g,
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bsk-(ant-|or-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b(bearer|token)\s+[A-Za-z0-9._~+/=-]{20,}/gi,
  /\b[spr]k_(live|test)_[A-Za-z0-9]{10,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /\b(0x)?[0-9a-fA-F]{64}\b/g,
]
const SECRET_WORD = String.raw`[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|passwd|api[_-]?key|private[_-]?key|access[_-]?key|_key\b|credential|mnemonic|seed)[A-Za-z0-9_.-]*`
const KEYED_QUOTED = new RegExp(String.raw`\b(${SECRET_WORD})(["']?\s*[:=]\s*)(["'])([^"'\n]{6,})\3`, 'gi')
const KEYED_SECRET = new RegExp(String.raw`\b(${SECRET_WORD})(["']?\s*[:=]\s*["']?)([^\s"',;}]{6,})`, 'gi')
const FLAG_SECRET = new RegExp(String.raw`(\s--?${SECRET_WORD})(\s+)(?:(["'])[^"'\n]{6,}\3|[^\s"'-][^\s"']{5,})`, 'gi')
const BASIC_AUTH = /\b(authorization:\s*basic\s+)[A-Za-z0-9+/=]{8,}/gi
const USER_FLAG = /(\s(?:-u|--user)\s+["']?[^\s:"']+:)[^\s"']+/g
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)@/gi

export function redact(s: string): string {
  let out = s
  for (const p of SECRET_PATTERNS) out = out.replace(p, '[redacted]')
  out = out.replace(KEYED_QUOTED, (_, k, sep, q) => `${k}${sep}${q}[redacted]${q}`)
  out = out.replace(KEYED_SECRET, (_, k, sep, v) => (v.startsWith('[redacted]') ? `${k}${sep}${v}` : `${k}${sep}[redacted]`))
  out = out.replace(FLAG_SECRET, (_, flag, space) => `${flag}${space}[redacted]`)
  out = out.replace(BASIC_AUTH, (_, pre) => `${pre}[redacted]`)
  out = out.replace(USER_FLAG, (_, pre) => `${pre}[redacted]`)
  out = out.replace(URL_PASSWORD, (_, pre) => `${pre}[redacted]@`)
  return out
}

export function parseJsonl(raw: string): TranscriptRecord[] {
  const out: TranscriptRecord[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      out.push({})
    }
  }
  return out
}

export function isHeadless(records: TranscriptRecord[]): boolean {
  const entry = records.find(r => r.type === 'user' && r.entrypoint)?.entrypoint
  return entry !== undefined && entry !== 'cli'
}

function humanText(text: string, human: (t: string) => void, lines: string[]) {
  if (INJECTED.test(text)) return
  const cmd = text.match(/<command-name>([^<]*)<\/command-name>/)
  if (cmd) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim()
    lines.push(`[cmd] ${(cmd[1] ?? '').trim()}${args ? ' ' + args : ''}`)
    return
  }
  if (/^\s*<command-message>/.test(text)) return
  human(text)
}

function toolResult(b: ContentBlock, pending: Map<string, { tool: string; arg: string }>, lines: string[], gray: GrayCall[]) {
  const call = pending.get(b.tool_use_id!)
  if (!call) return
  pending.delete(b.tool_use_id!)
  const raw = resultText(b.content)
  const failed = b.is_error || FAILURE.test(raw)
  if (!failed && (SILENT_TOOLS.has(call.tool) || PATH_TOOLS.has(call.tool))) return
  const output = redact(raw)

  if (failed) {
    lines.push(`[tool-error] ${call.tool}: ${call.arg}\n${headTail(output, ERR_SIDE)}`)
    return
  }
  lines.push(`[tool] ${call.tool}: ${call.arg}`)
  if (output.trim()) gray.push({ id: b.tool_use_id!, tool: call.tool, arg: call.arg, output: output.slice(0, GRAY_MAX) })
}

function toolArg(name: string, input: Record<string, unknown>): string {
  const pick = input.command ?? input.file_path ?? input.url ?? input.pattern ?? input.description ?? input.prompt ?? ''
  const s = redact(typeof pick === 'string' ? pick : JSON.stringify(pick))
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > ARG_MAX ? flat.slice(0, ARG_MAX) + '...' : flat
}

function resultText(c: ContentBlock['content']): string {
  if (typeof c === 'string') return c
  return (c ?? []).filter(x => x.type === 'text' && x.text).map(x => x.text).join('\n')
}

function textOf(blocks: ContentBlock[]): string {
  return blocks.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n')
}

function headTail(s: string, side: number): string {
  const t = s.trim()
  if (t.length <= side * 2) return t
  return `${t.slice(0, side)}\n...\n${t.slice(-side)}`
}
