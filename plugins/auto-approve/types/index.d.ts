export type Approval = { tool: string; input: string }

export type Offer = { id: string; rule: string; covered: string[]; isRewording: boolean; isInBand: boolean }

declare module 'claude-code' {
  interface PluginState {
    'auto-approve': { approvals: Approval[]; sessionRules: string[]; declined: string[]; offer: Offer | null }
  }
}
