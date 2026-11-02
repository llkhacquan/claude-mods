export type GroupRule = { group: string; root: string }

export const OTHER = 'other'
export const SKIP = 'skip'

export const mangle = (path: string): string => path.replace(/[^A-Za-z0-9-]/g, '-')

export function parseGroups(text: string, home: string): GroupRule[] {
  const rules: GroupRule[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [group, ...rest] = line.split(/\s+/)
    const root = rest.join(' ').replace(/^~(?=\/|$)/, home).replace(/\/+$/, '')
    if (group && root.startsWith('/')) rules.push({ group, root })
  }
  return rules
}

const longest = (rules: GroupRule[], hit: (r: GroupRule) => boolean): GroupRule | undefined =>
  rules.filter(hit).sort((a, b) => b.root.length - a.root.length)[0]

export function groupOfPath(rules: GroupRule[], path: string): string {
  return longest(rules, r => path === r.root || path.startsWith(`${r.root}/`))?.group ?? OTHER
}

export function groupOfProjectDir(rules: GroupRule[], dirName: string): string {
  return longest(rules, r => dirName === mangle(r.root) || dirName.startsWith(`${mangle(r.root)}-`))?.group ?? OTHER
}

export function repoOfPath(rules: GroupRule[], path: string): string {
  const rule = longest(rules, r => path === r.root || path.startsWith(`${r.root}/`))
  const base = rule ? rule.root : path.replace(/\/worktree\/[^/]+.*$/, '')
  return base.split('/').filter(Boolean).pop() ?? ''
}
