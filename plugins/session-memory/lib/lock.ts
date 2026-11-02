export type LockFs = {
  mkdir(path: string): Promise<boolean>
  rmdir(path: string): Promise<void>
  mtime(path: string): Promise<number | null>
  now(): number
  sleep(ms: number): Promise<void>
}

export type LockOptions = { staleMs?: number; waitMs?: number; stepMs?: number; onStale?: (ageMs: number) => Promise<void> }

export const BUSY = Symbol('busy')

export async function withLock<T>(fs: LockFs, path: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T | typeof BUSY> {
  const { staleMs = 60_000, waitMs = 30_000, stepMs = 1_000, onStale } = opts
  const deadline = fs.now() + waitMs
  while (!(await fs.mkdir(path))) {
    const mtime = await fs.mtime(path)
    if (mtime !== null && fs.now() - mtime > staleMs) {
      await onStale?.(fs.now() - mtime)
      await fs.rmdir(path)
      continue
    }
    if (fs.now() >= deadline) return BUSY
    await fs.sleep(stepMs)
  }
  try {
    return await fn()
  } finally {
    await fs.rmdir(path)
  }
}
