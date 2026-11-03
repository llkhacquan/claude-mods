export const MAX_DEPTH = 3
export const MAX_CHILDREN = 30

export type By = 'user' | 'agent'
export type Stance = 'for' | 'against'
export type ItemType = 'rule' | 'decision' | 'cause' | 'gotcha' | 'state' | 'reference'

export type Node = { id: string; parent: string | null; title: string }

export type Item = {
  id: string
  node: string
  text: string
  type: ItemType
  refs: { user: number; agent: number; against: number; echo: number }
  voters: { user: string[]; agent: string[]; against: string[]; echo: string[] }
  first: string
  last: string
  conflicts_with: string[]
  dead: boolean
  repos?: string[]
}

export type Ref = {
  item: string
  sid: string
  lines: string[]
  by: By
  stance: Stance
  date: string
  quote: string
  echo: boolean
}

export type RefInput = Omit<Ref, 'item' | 'sid' | 'date' | 'echo'>

export type Op =
  | { op: 'ref'; item: string; ref: RefInput }
  | { op: 'new'; node: string; text: string; type: ItemType; ref: RefInput }
  | { op: 'new-node'; parent: string; id: string; title: string }
  | { op: 'conflict'; with: string; node: string; text: string; type: ItemType; ref: RefInput }
  | { op: 'echo'; item: string; ref: RefInput }
  | { op: 'confirm'; item: string; ref: RefInput }
  | { op: 'reject'; item: string; ref: RefInput }

export type SplitGroup = { id: string; title: string; members: string[] }

export type ReconcileContext = {
  group: string
  repo: string
  nodes: Node[]
  candidates: Item[]
  loaded: string[]
}
