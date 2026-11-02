import { describe, expect, test } from 'bun:test'
import { BUSY, withLock, type LockFs } from './lock.ts'

function fakeFs(held: Map<string, number> = new Map()) {
  let clock = 1_000_000
  const fs: LockFs = {
    mkdir: async p => (held.has(p) ? false : (held.set(p, clock), true)),
    rmdir: async p => void held.delete(p),
    mtime: async p => held.get(p) ?? null,
    now: () => clock,
    sleep: async ms => void (clock += ms),
  }
  return { fs, held, advance: (ms: number) => (clock += ms) }
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
})
