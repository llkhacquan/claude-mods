import { describe, expect, test } from 'bun:test'
import { buildAutogroupPrompt, MAX_GROUPS, parseAutogroup, README_CHARS, type GroupInfo } from './autogroup-prompt.ts'

const be: GroupInfo = { name: 'be', desc: '', repos: ['payments', 'ledger'], topics: ['Deploys', 'Ledger math'] }
const web: GroupInfo = { name: 'web', desc: 'public sites', repos: ['site'], topics: [] }
const names = ['be', 'web']
const answer = (v: unknown) => JSON.stringify(v)

describe('buildAutogroupPrompt', () => {
  test('lists the repo, the head of its docs and every group with desc, repos and topics', () => {
    const { system, user } = buildAutogroupPrompt({ root: '/home/u/code/api', repo: 'api', readme: `# api\n${'x'.repeat(5000)}`, groups: [be, web] })
    expect(user).toContain('REPO: api\nROOT: /home/u/code/api')
    expect(user).toContain('- be\n  repos: payments, ledger\n  topics: Deploys; Ledger math')
    expect(user).toContain('- web: public sites\n  repos: site')
    expect(user.length).toBeLessThan(README_CHARS + 300)
    expect(system).toContain('Prefer "join"')
    expect(system).not.toContain('no new group is possible')
  })

  test('at the cap the model is told not to make a new group', () => {
    const full = Array.from({ length: MAX_GROUPS }, (_, i) => ({ ...be, name: `g${i}` }))
    expect(buildAutogroupPrompt({ root: '/r', repo: 'r', readme: '', groups: full }).system).toContain('no new group is possible')
  })
})

describe('parseAutogroup', () => {
  test('join an existing group', () => {
    expect(parseAutogroup(answer({ action: 'join', group: 'be' }), names)).toEqual({ action: 'join', group: 'be', desc: '' })
  })

  test('new group keeps a one-line desc, fenced or not', () => {
    for (const raw of [answer({ action: 'new', group: 'infra', desc: 'clusters\nand  deploys' }), `\`\`\`json\n${answer({ action: 'new', group: 'infra', desc: 'clusters and deploys' })}\n\`\`\``])
      expect(parseAutogroup(raw, names)).toEqual({ action: 'new', group: 'infra', desc: 'clusters and deploys' })
  })

  test('new with an existing name is a join', () => {
    expect(parseAutogroup(answer({ action: 'new', group: 'web', desc: 'x' }), names)).toEqual({ action: 'join', group: 'web', desc: '' })
  })

  test.each([
    ['model said other', answer({ action: 'other', group: 'other' }), 'model said other'],
    ['cap reached', answer({ action: 'new', group: 'infra' }), 'cap of 2 groups'],
  ])('%s => other', (_, raw, why) => {
    const r = parseAutogroup(raw, names, why.startsWith('cap') ? 2 : MAX_GROUPS)
    expect(r).toMatchObject({ action: 'other', group: 'other' })
    expect('why' in r && r.why).toContain(why)
  })

  test.each([
    ['bad JSON', 'I think be', 'no parsable JSON'],
    ['missing group', answer({ action: 'new' }), 'missing group'],
    ['bad name', answer({ action: 'new', group: 'Infra Tools' }), 'bad group name'],
    ['reserved name', answer({ action: 'new', group: 'skip' }), 'bad group name'],
    ['join to unknown group', answer({ action: 'join', group: 'ops' }), 'join to unknown group'],
    ['bad action', answer({ action: 'maybe', group: 'be' }), 'bad action'],
  ])('%s => error, nothing to write', (_, raw, why) => {
    const r = parseAutogroup(raw, names)
    expect('error' in r && r.error).toContain(why)
  })
})
