export type QuestionStatus = 'open' | 'answered' | 'closed'

export type Answer = { option?: number; text?: string; at: string }

export type ThreadEntry = { who: 'user' | 'claude'; text: string; at: string }

export type Question = {
  kind: 'q'
  id: string
  text: string
  options?: string[]
  notes?: string[]
  lean?: number
  status: QuestionStatus
  at: string
  answer?: Answer
  closed?: { reason?: string; at: string }
  thread?: ThreadEntry[]
}

export type Board = { session: string; next: number; items: Question[] }

export type SendMode = 'send' | 'fill'

export type Queued = { id: string; session: string; option?: number; text?: string; isAsk?: true; tries: number }

declare module 'claude-code' {
  interface PluginState {
    qboard: { board: Shaped<Board>; send: SendMode; showDone: boolean; drafts: Record<string, string>; sending: Record<string, string>; picked: Record<string, number>; paneHidden: boolean; tick: number; queued: Record<string, Queued> }
  }
}
