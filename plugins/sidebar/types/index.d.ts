export type Status = 'idle' | 'running' | 'needs-input' | 'ended'

export type Card = {
  sessionId: string
  paneId: string
  cwd: string
  branch: string
  changed: number | null
  unpushed: number | null
  status: Status
  since: number
  asked: boolean
  tool: string
  model: string
  contextPercent: number | null
  contextTokens: number | null
  contextWindow: number | null
  costUsd: number | null
  title: string
  recap: string[]
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    sidebar: { cards: Card[]; frame: number }
  }
}
