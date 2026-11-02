export type GroupRule = { group: string; root: string; desc?: string }

export const OTHER = 'other'
export const SKIP = 'skip'

export const mangle = (path: string): string => path.replace(/[^A-Za-z0-9-]/g, '-')

// /var/folders => macOS $TMPDIR, where Go t.TempDir() tests run `claude -p`
const TMP_ROOTS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders']
export const isTmp = (path: string): boolean => TMP_ROOTS.some(r => path === r || path.startsWith(`${r}/`))
export const isTmpDir = (dirName: string): boolean => TMP_ROOTS.some(r => dirName.startsWith(mangle(r)))

export const isGroupName = (name: string): boolean => /^[a-z][a-z0-9-]{1,19}$/.test(name) && name !== OTHER && name !== SKIP

export function parseGroups(text: string, home: string): GroupRule[] {
  const rules: GroupRule[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const hash = line.search(/\s#/)
    const body = hash < 0 ? line : line.slice(0, hash)
    const desc = hash < 0 ? '' : line.slice(hash).replace(/^\s+#\s*/, '').trim()
    const [group, ...rest] = body.trim().split(/\s+/)
    const root = rest.join(' ').replace(/^~(?=\/|$)/, home).replace(/\/+$/, '')
    if (group && root.startsWith('/')) rules.push(desc ? { group, root, desc } : { group, root })
  }
  return rules
}

export const formatRule = (r: GroupRule): string => `${r.group} ${r.root}${r.desc ? `  # ${r.desc}` : ''}`

const covers = (root: string, path: string) => path === root || path.startsWith(`${root}/`)

export function mergeRules(user: GroupRule[], auto: GroupRule[]): GroupRule[] {
  return [...user, ...auto.filter(a => !user.some(u => covers(u.root, a.root)))]
}

export function groupNames(rules: GroupRule[]): string[] {
  return [...new Set(rules.map(r => r.group))].filter(g => g !== OTHER && g !== SKIP)
}

const longest = (rules: GroupRule[], hit: (r: GroupRule) => boolean): GroupRule | undefined =>
  rules.filter(hit).sort((a, b) => b.root.length - a.root.length)[0]

export const ruleOfPath = (rules: GroupRule[], path: string): GroupRule | undefined => longest(rules, r => covers(r.root, path))

export function groupOfPath(rules: GroupRule[], path: string): string {
  return ruleOfPath(rules, path)?.group ?? OTHER
}

export function groupOfProjectDir(rules: GroupRule[], dirName: string): string {
  return longest(rules, r => dirName === mangle(r.root) || dirName.startsWith(`${mangle(r.root)}-`))?.group ?? OTHER
}

export function repoOfPath(rules: GroupRule[], path: string): string {
  const rule = ruleOfPath(rules, path)
  const base = rule ? rule.root : path.replace(/\/worktree\/[^/]+.*$/, '')
  return base.split('/').filter(Boolean).pop() ?? ''
}
