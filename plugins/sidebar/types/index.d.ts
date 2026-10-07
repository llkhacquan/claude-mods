export type Status = 'idle' | 'running' | 'needs-input' | 'ended'

export type Card = {
  sessionId: string
  paneId: string
  cwd: string
  branch: string
  status: Status
  asked: boolean
  tool: string
  model: string
  contextPercent: number | null
  title: string
  recap: string[]
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    sidebar: { cards: Card[] }
  }
}
