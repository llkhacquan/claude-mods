import { describe, expect, test } from 'bun:test'
import { groupOfPath, groupOfProjectDir, mangle, parseGroups, repoOfPath } from './groups.ts'

const CONFIG = `
# group root
be ~/code/payments
be ~/code/ledger
devops /srv/gitops
skip ~/code/payments/scratch
`
const rules = parseGroups(CONFIG, '/home/u')

describe('parseGroups', () => {
  test('expands ~, skips comments and blank lines, drops relative roots', () => {
    expect(parseGroups('a ~/x/\nb relative\n# c /y', '/home/u')).toEqual([{ group: 'a', root: '/home/u/x' }])
  })
})

describe('groupOfPath', () => {
  test('matches the root, its worktrees and sub dirs', () => {
    expect(groupOfPath(rules, '/home/u/code/payments')).toBe('be')
    expect(groupOfPath(rules, '/home/u/code/payments/worktree/fix-a')).toBe('be')
  })

  test('longest root wins', () => {
    expect(groupOfPath(rules, '/home/u/code/payments/scratch/x')).toBe('skip')
  })

  test('a sibling with the same prefix is not inside the root', () => {
    expect(groupOfPath(rules, '/home/u/code/payments-sdk')).toBe('other')
  })
})

describe('groupOfProjectDir', () => {
  test('matches the mangled root and anything under it', () => {
    expect(groupOfProjectDir(rules, mangle('/home/u/code/ledger'))).toBe('be')
    expect(groupOfProjectDir(rules, mangle('/home/u/code/ledger/worktree/x.y'))).toBe('be')
    expect(groupOfProjectDir(rules, mangle('/srv/gitops/plans/a'))).toBe('devops')
    expect(groupOfProjectDir(rules, mangle('/home/u/notes'))).toBe('other')
  })

  test('mangle turns every char outside letters, digits and dash into a dash', () => {
    expect(mangle('/home/u/.config/a_b.c')).toBe('-home-u--config-a-b-c')
  })
})

describe('repoOfPath', () => {
  test('names the configured root, else the dir above worktree/, else the last dir', () => {
    expect(repoOfPath(rules, '/home/u/code/ledger/worktree/x')).toBe('ledger')
    expect(repoOfPath(rules, '/home/u/notes/worktree/x/sub')).toBe('notes')
    expect(repoOfPath(rules, '/home/u/notes/sub')).toBe('sub')
  })
})
