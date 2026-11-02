export type LockFs = {
  mkdir(path: string): Promise<boolean>
  rmdir(path: string): Promise<void>
  mtime(path: string): Promise<number | null>
  readOwner(path: string): Promise<string | null>
  writeOwner(path: string, token: string): Promise<void>
  now(): number
  sleep(ms: number): Promise<void>
}

export type LockOptions = { staleMs?: number; waitMs?: number; stepMs?: number; onStale?: (ageMs: number) => Promise<void> }

export const BUSY = Symbol('busy')
const BREAK_STALE_MS = 10_000

export async function withLock<T>(fs: LockFs, path: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T | typeof BUSY> {
  const { staleMs = 60_000, waitMs = 30_000, stepMs = 1_000, onStale } = opts
  const deadline = fs.now() + waitMs
  const token = `${fs.now()}-${Math.random().toString(36).slice(2)}`
  while (!(await fs.mkdir(path))) {
    if ((await isStale(fs, path, staleMs)) && (await breakStale(fs, path, staleMs, onStale))) continue
    if (fs.now() >= deadline) return BUSY
    await fs.sleep(stepMs)
  }
  try {
    await fs.writeOwner(path, token)
  } catch (e) {
    await fs.rmdir(path)
    throw e
  }
  try {
    return await fn()
  } finally {
    if ((await fs.readOwner(path)) === token) await fs.rmdir(path)
  }
}

async function isStale(fs: LockFs, path: string, staleMs: number): Promise<boolean> {
  const mtime = await fs.mtime(path)
  return mtime !== null && fs.now() - mtime > staleMs
}

// one breaker at a time => a waiter that read the old mtime re-checks under `.break` and never removes the next holder's lock
async function breakStale(fs: LockFs, path: string, staleMs: number, onStale?: (ageMs: number) => Promise<void>): Promise<boolean> {
  const breaker = `${path}.break`
  if (!(await fs.mkdir(breaker))) {
    if (!(await isStale(fs, breaker, BREAK_STALE_MS))) return false
    await fs.rmdir(breaker)
    return true
  }
  try {
    const mtime = await fs.mtime(path)
    if (mtime !== null && fs.now() - mtime > staleMs) {
      await onStale?.(fs.now() - mtime)
      await fs.rmdir(path)
    }
    return true
  } finally {
    await fs.rmdir(breaker)
  }
}
