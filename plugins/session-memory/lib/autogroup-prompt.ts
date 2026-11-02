import { isGroupName, OTHER } from './groups.ts'

export const MAX_GROUPS = 8
export const README_CHARS = 2000
const DESC_CHARS = 80

export type GroupInfo = { name: string; desc: string; repos: string[]; topics: string[] }
export type AutogroupInput = { root: string; repo: string; readme: string; groups: GroupInfo[] }
export type AutogroupAnswer = { action: 'join' | 'new' | 'other'; group: string; desc: string; why?: string }

const SYSTEM = (full: boolean) => `You file a code repo into a memory group. Sessions in one group share one memory of decisions, rules and gotchas, so a group holds repos whose sessions teach each other something: same product, same team, or same kind of work.

The user message gives the new repo (root path, name, head of its CLAUDE.md or README.md) and the existing groups (name, description, repos, top topics).

Rules:
- Prefer "join": pick an existing group when the repo fits it.
- "new" only when no group fits. The name is 2-20 chars of lowercase letters, digits and dashes, starting with a letter, and not "other" or "skip". Give "desc": one line under ${DESC_CHARS} chars saying what the group covers.
- "other" when the repo is a scratch dir, a sample, a fork or a test fixture, or you cannot tell what it is.
- A personal repo never joins a work group, and a work repo never joins a personal group. Paths and descriptions tell which is which.${full ? `\n- ${MAX_GROUPS} groups exist, so no new group is possible. Answer "join" or "other".` : ''}

Output JSON only, no prose, no code fence: {"action":"join"|"new"|"other","group":"<name>","desc":"<only for new>"}`

export function buildAutogroupPrompt(input: AutogroupInput): { system: string; user: string } {
  const groups =
    input.groups
      .map(g => [`- ${g.name}${g.desc ? `: ${g.desc}` : ''}`, `  repos: ${g.repos.join(', ') || '(none)'}`, ...(g.topics.length ? [`  topics: ${g.topics.join('; ')}`] : [])].join('\n'))
      .join('\n') || '(none yet)'
  const readme = input.readme.slice(0, README_CHARS).trim() || '(no CLAUDE.md or README.md)'
  return { system: SYSTEM(input.groups.length >= MAX_GROUPS), user: `REPO: ${input.repo}\nROOT: ${input.root}\n\nHEAD OF DOCS:\n${readme}\n\nGROUPS:\n${groups}` }
}

const other = (why: string): AutogroupAnswer => ({ action: 'other', group: OTHER, desc: '', why })

export function parseAutogroup(raw: string, names: string[], max = MAX_GROUPS): AutogroupAnswer | { error: string } {
  const v = extractObject(raw)
  if (!v) return { error: 'no parsable JSON' }
  const { action, group, desc } = v
  if (action === 'other') return other('model said other')
  if (typeof group !== 'string') return { error: 'missing group' }
  const name = group.trim()
  if (action === 'join' || (action === 'new' && names.includes(name))) return names.includes(name) ? { action: 'join', group: name, desc: '' } : { error: `join to unknown group ${name}` }
  if (action !== 'new') return { error: `bad action ${String(action)}` }
  if (!isGroupName(name)) return { error: `bad group name ${name}` }
  if (names.length >= max) return other(`cap of ${max} groups`)
  const line = typeof desc === 'string' ? desc.replace(/\s+/g, ' ').trim().slice(0, DESC_CHARS) : ''
  return { action: 'new', group: name, desc: line }
}

function extractObject(raw: string): Record<string, unknown> | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  for (const t of [fence?.[1], raw, first >= 0 && last > first ? raw.slice(first, last + 1) : undefined]) {
    if (!t) continue
    try {
      const v = JSON.parse(t.trim())
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    } catch {
      continue
    }
  }
  return null
}
