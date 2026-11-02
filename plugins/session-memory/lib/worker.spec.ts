import { describe, expect, test } from 'bun:test'
import type { Item } from './memory-types.ts'
import type { TranscriptRecord } from './slicer.ts'
import type { StoreIO } from './store.ts'
import { candidatesFor, MAX_BYTES, processSession, type Completion, type Job, type WorkerDeps } from './worker.ts'

const DIR = '/state/payments'
const user = (text: string): TranscriptRecord => ({ type: 'user', entrypoint: 'cli', message: { role: 'user', content: text } })
const reply = (text: string): TranscriptRecord => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
const turns = (n: number) => Array.from({ length: n }, (_, i) => [user(`question ${i}`), reply(`answer ${i}`)]).flat()

const newOp = (text: string) =>
  JSON.stringify({ ops: [{ op: 'new', node: 'payments', text, type: 'rule', ref: { lines: ['L1'], by: 'user', stance: 'for', quote: 'question' } }] })

function harness(records: TranscriptRecord[], opts: { answers?: Completion[]; calls?: number; busy?: boolean; sizes?: Record<string, number> } = {}) {
  const files = new Map<string, string>()
  const io: StoreIO = {
    read: async p => files.get(p) ?? null,
    write: async (p, d) => void files.set(p, d),
    list: async dir => [...files.keys()].filter(p => p.startsWith(`${dir}/`)).map(p => p.slice(dir.length + 1)).filter(n => !n.includes('/')),
  }
  const answers = [...(opts.answers ?? [])]
  const prompts: string[] = []
  const logs: string[] = []
  let left = opts.calls ?? 100
  const reads: number[] = []
  const deps: WorkerDeps = {
    io,
    size: async p => opts.sizes?.[p] ?? (files.has(p) ? files.get(p)!.length : null),
    readRecords: async from => (reads.push(from), records.slice(from)),
    complete: async (_s, u) => (prompts.push(u), answers.shift() ?? { text: '{"ops":[]}', inTokens: 10, outTokens: 5 }),
    locked: async fn => (opts.busy ? null : fn()),
    callsLeft: async () => left,
    spend: async () => void left--,
    log: m => void logs.push(m),
  }
  const items = () => (files.get(`${DIR}/items.jsonl`) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as Item)
  const processed = () => (files.get(`${DIR}/processed.jsonl`) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))
  return { deps, files, prompts, logs, reads, items, processed }
}

const job = (over: Partial<Job> = {}): Job => ({ sid: 's1', dir: DIR, group: 'payments', repo: 'api', trigger: 'end', loaded: [], date: '2026-11-02', ...over })
const answer = (text: string): Completion => ({ text, inTokens: 100, outTokens: 20 })

describe('processSession', () => {
  test('mines new records into an item and marks the range processed', async () => {
    const h = harness(turns(3), { answers: [answer(newOp('deploys need a human go'))] })
    const out = await processSession(h.deps, job())
    expect(out).toEqual({ stop: 'done', slices: 1, calls: 1, warn: undefined })
    expect(h.items().map(i => i.text)).toEqual(['deploys need a human go'])
    expect(h.processed()).toEqual([{ sid: 's1', from: 0, to: 6 }])
  })

  test('a second run on the same transcript reads from the cursor and calls nothing', async () => {
    const h = harness(turns(3), { answers: [answer(newOp('x rule'))] })
    await processSession(h.deps, job())
    const again = await processSession(h.deps, job())
    expect(again.calls).toBe(0)
    expect(h.reads).toEqual([0, 6])
    expect(h.items()).toHaveLength(1)
  })

  test('only new records go to the model after the transcript grows', async () => {
    const recs = turns(3)
    const h = harness(recs)
    await processSession(h.deps, job())
    recs.push(user('late question'), reply('late answer'))
    await processSession(h.deps, job())
    expect(h.prompts[1]).toContain('late question')
    expect(h.prompts[1]).not.toContain('question 0')
    expect(h.processed()).toEqual([{ sid: 's1', from: 0, to: 6 }, { sid: 's1', from: 6, to: 8 }])
  })

  test('idle waits for enough human turns, end does not', async () => {
    const idle = harness(turns(2))
    expect((await processSession(idle.deps, job({ trigger: 'idle' }))).stop).toBe('wait')
    expect(idle.prompts).toHaveLength(0)
    const end = harness(turns(2))
    expect((await processSession(end.deps, job({ trigger: 'end' }))).calls).toBe(1)
  })

  test('a model error leaves the range unprocessed', async () => {
    const h = harness(turns(3), { answers: [{ error: 'api-error 529' }] })
    expect((await processSession(h.deps, job())).stop).toBe('model')
    expect(h.processed()).toEqual([])
    expect(h.logs.join()).toContain('api-error 529')
  })

  test('no calls left stops before the model', async () => {
    const h = harness(turns(3), { calls: 0 })
    expect((await processSession(h.deps, job())).stop).toBe('cap')
    expect(h.prompts).toHaveLength(0)
  })

  test('a held lock writes nothing', async () => {
    const h = harness(turns(3), { busy: true, answers: [answer(newOp('x rule'))] })
    expect((await processSession(h.deps, job())).stop).toBe('busy')
    expect(h.files.size).toBe(0)
  })

  test('a group file over the cap is not read', async () => {
    const h = harness(turns(3), { sizes: { [`${DIR}/items.jsonl`]: MAX_BYTES + 1 } })
    expect(await processSession(h.deps, job())).toEqual({ stop: 'too-big', slices: 0, calls: 0, warn: 'items.jsonl' })
    expect(h.reads).toEqual([])
  })

  test('a headless transcript is marked processed without a model call', async () => {
    const recs = turns(3).map(r => (r.type === 'user' ? { ...r, entrypoint: 'sdk-ts' } : r))
    const h = harness(recs)
    expect((await processSession(h.deps, job())).stop).toBe('headless')
    expect(h.prompts).toHaveLength(0)
    expect(h.processed()).toEqual([{ sid: 's1', from: 0, to: 6 }])
  })

  test('a long transcript goes in chained slices that cover every record', async () => {
    const recs = Array.from({ length: 12 }, (_, i) => user(`${i} ${'x'.repeat(9_000)}`))
    const h = harness(recs)
    const out = await processSession(h.deps, job())
    expect(out.slices).toBeGreaterThan(1)
    const ranges = h.processed()
    expect(ranges[0].from).toBe(0)
    expect(ranges.at(-1).to).toBe(12)
    for (let i = 1; i < ranges.length; i++) expect(ranges[i].from).toBe(ranges[i - 1].to)
  })

  test('an item another session saved during the model call is kept', async () => {
    const h = harness(turns(3))
    const other: Item = { id: 'i-1', node: 'payments', text: 'from the other session', type: 'rule', refs: { user: 1, agent: 0, against: 0, echo: 0 }, voters: { user: ['s2'], agent: [], against: [], echo: [] }, first: '2026-11-01', last: '2026-11-01', conflicts_with: [], dead: false }
    h.deps.complete = async () => {
      h.files.set(`${DIR}/items.jsonl`, `${JSON.stringify(other)}\n`)
      return answer(newOp('from this session'))
    }
    await processSession(h.deps, job())
    expect(h.items().map(i => i.text).sort()).toEqual(['from the other session', 'from this session'])
  })
})

describe('candidatesFor', () => {
  const item = (id: string, text: string, last = '2026-11-01'): Item => ({ id, node: 'n', text, type: 'rule', refs: { user: 0, agent: 0, against: 0, echo: 0 }, voters: { user: [], agent: [], against: [], echo: [] }, first: last, last, conflicts_with: [], dead: false })

  test('ranks by shared words and drops dead or unrelated items', () => {
    const items = [item('i-1', 'deploy needs migration first'), item('i-2', 'unrelated thing'), { ...item('i-3', 'deploy migration'), dead: true }, item('i-4', 'deploy only on weekdays')]
    expect(candidatesFor('before the deploy run the migration', items).map(i => i.id)).toEqual(['i-1', 'i-4'])
  })
})
