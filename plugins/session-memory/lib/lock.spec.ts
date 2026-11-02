import { describe, expect, test } from 'bun:test'
import { BUSY, withLock, type LockFs } from './lock.ts'

function fakeFs(held: Map<string, number> = new Map()) {
  let clock = 1_000_000
  const owners = new Map<string, string>()
  const tick = () => new Promise<void>(r => setTimeout(r, 0))
  const fs: LockFs = {
    mkdir: async p => (await tick(), held.has(p) ? false : (held.set(p, clock), true)),
    rmdir: async p => (await tick(), held.delete(p), void owners.delete(p)),
    mtime: async p => (await tick(), held.get(p) ?? null),
    readOwner: async p => (await tick(), owners.get(p) ?? null),
    writeOwner: async (p, t) => void owners.set(p, t),
    now: () => clock,
    sleep: async ms => (await tick(), void (clock += ms)),
  }
  return { fs, held, owners, advance: (ms: number) => (clock += ms) }
}

describe('withLock', () => {
  test('runs fn and frees the lock', async () => {
    const { fs, held } = fakeFs()
    expect(await withLock(fs, '/g/.lock', async () => 'done')).toBe('done')
    expect(held.size).toBe(0)
  })

  test('frees the lock when fn throws', async () => {
    const { fs, held } = fakeFs()
    await expect(withLock(fs, '/g/.lock', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(held.size).toBe(0)
  })

  test('gives up as busy after waitMs on a fresh lock', async () => {
    const { fs, held } = fakeFs()
    held.set('/g/.lock', fs.now())
    let ran = false
    expect(await withLock(fs, '/g/.lock', async () => (ran = true), { waitMs: 5_000, staleMs: 60_000 })).toBe(BUSY)
    expect(ran).toBe(false)
    expect(held.has('/g/.lock')).toBe(true)
  })

  test('breaks a stale lock and runs', async () => {
    const { fs, held, advance } = fakeFs()
    held.set('/g/.lock', fs.now())
    advance(61_000)
    const ages: number[] = []
    expect(await withLock(fs, '/g/.lock', async () => 'ran', { onStale: async age => void ages.push(age) })).toBe('ran')
    expect(ages).toEqual([61_000])
  })

  test('waits for a holder that frees the lock in time', async () => {
    const { fs, held } = fakeFs()
    held.set('/g/.lock', fs.now())
    const sleep = fs.sleep
    fs.sleep = async ms => { await sleep(ms); held.delete('/g/.lock') }
    expect(await withLock(fs, '/g/.lock', async () => 'ran')).toBe('ran')
  })

  test('a breaker left by a crash goes stale in seconds, not after the lock staleMs', async () => {
    const { fs, held, advance } = fakeFs()
    held.set('/g/c', fs.now())
    advance(7_201_000)
    held.set('/g/c.break', fs.now() - 20_000)
    expect(await withLock(fs, '/g/c', async () => 'ran', { waitMs: 0, staleMs: 7_200_000 })).toBe('ran')
    expect(held.size).toBe(0)
  })

  test('frees the lock when writing the owner fails', async () => {
    const { fs, held } = fakeFs()
    fs.writeOwner = async () => { throw new Error('ENOSPC') }
    await expect(withLock(fs, '/g/.lock', async () => 'ran')).rejects.toThrow('ENOSPC')
    expect(held.size).toBe(0)
  })

  test('two waiters on a stale lock never hold it at once', async () => {
    const { fs, held, advance } = fakeFs()
    held.set('/g/.lock', fs.now())
    advance(61_000)
    let inside = 0
    let overlap = false
    const work = (name: string) => async () => {
      inside++
      if (inside > 1) overlap = true
      for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
      inside--
      return name
    }
    const stale = (ticks: number) => async () => {
      for (let i = 0; i < ticks; i++) await new Promise(r => setTimeout(r, 0))
    }
    const both = await Promise.all([withLock(fs, '/g/.lock', work('a'), { onStale: stale(0) }), withLock(fs, '/g/.lock', work('b'), { onStale: stale(4) })])
    expect(both.sort()).toEqual(['a', 'b'])
    expect(overlap).toBe(false)
    expect(held.size).toBe(0)
  })

  test('a holder whose lock was broken does not free the next holder\'s lock', async () => {
    const { fs, held, owners } = fakeFs()
    const result = await withLock(fs, '/g/.lock', async () => {
      held.delete('/g/.lock')
      held.set('/g/.lock', fs.now())
      owners.set('/g/.lock', 'someone-else')
      return 'ran'
    })
    expect(result).toBe('ran')
    expect(held.has('/g/.lock')).toBe(true)
  })
})
