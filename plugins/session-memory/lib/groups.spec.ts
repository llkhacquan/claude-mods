import { describe, expect, test } from 'bun:test'
import { formatRule, groupNames, groupOfPath, groupOfProjectDir, isGroupName, isTmp, isTmpDir, mangle, mergeRules, parseGroups, repoOfPath, ruleOfPath } from './groups.ts'

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

describe('isTmp', () => {
  test('covers /tmp and the macOS per-user temp dirs, live paths and project dirs alike', () => {
    for (const p of ['/tmp/x', '/private/tmp', '/var/folders/ab/T/TestGate1/001', '/private/var/folders/ab/T/TestGate1/001']) {
      expect(isTmp(p)).toBe(true)
      expect(isTmpDir(mangle(p))).toBe(true)
    }
    expect(isTmp('/home/u/tmp')).toBe(false)
    expect(isTmp('/var/foldersx')).toBe(false)
  })
})

describe('auto rules', () => {
  const user = parseGroups('be ~/code\nskip ~/code/sandbox', '/home/u')
  const auto = parseGroups('ai /home/u/code/agent  # agent tools\nweb /home/u/site  # sites # and blogs\nother /home/u/scratch', '/home/u')

  test('a trailing # comment becomes the desc, not part of the root', () => {
    expect(auto[0]).toEqual({ group: 'ai', root: '/home/u/code/agent', desc: 'agent tools' })
    expect(auto[1]).toEqual({ group: 'web', root: '/home/u/site', desc: 'sites # and blogs' })
    expect(parseGroups(formatRule(auto[0]!), '/home/u')).toEqual([auto[0]!])
  })

  test('a user rule beats an auto rule on the same or a deeper root', () => {
    const rules = mergeRules(user, auto)
    expect(groupOfPath(rules, '/home/u/code/agent/x')).toBe('be')
    expect(groupOfPath(rules, '/home/u/site')).toBe('web')
    expect(groupNames(rules)).toEqual(['be', 'web'])
  })

  test('ruleOfPath tells an unlisted path from a cached "other"', () => {
    const rules = mergeRules(user, auto)
    expect(ruleOfPath(rules, '/home/u/scratch/a')?.group).toBe('other')
    expect(ruleOfPath(rules, '/home/u/notes')).toBe(undefined)
  })

  test('group names are short lowercase slugs, never other or skip', () => {
    expect(['be', 'ai-tools', 'x1'].every(isGroupName)).toBe(true)
    expect(['a', 'Be', '1x', 'other', 'skip', 'a'.repeat(21), 'a b'].some(isGroupName)).toBe(false)
  })
})
