// Pure logic of auto-handoff: when to warn, when to fire, and where the
// handoff landed. No `$` here, so tests call it directly.

const MIN = 60_000

export type Policy = {
  /** Cache lifetime, counted from the start of the last request. */
  cacheMs: number
  /** Fire this long before the cache expires. */
  leadMs: number
  /** Warn this long before firing. */
  warnMs: number
}

export type Snapshot = {
  now: number
  lastRequestAt: number | null
  armed: boolean
  paused: boolean
  pending: boolean
  turnRunning: boolean
  warnedFor: number | null
}

export type Decision =
  | { kind: 'wait' }
  | { kind: 'warn'; fireInMs: number }
  | { kind: 'countdown'; fireInMs: number }
  | { kind: 'fire' }
  | { kind: 'expired' }

export function positive(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
}

export function policyOf(options: Readonly<Record<string, unknown>>): Policy {
  const cacheMs = positive(options.cacheMinutes, 60) * MIN
  const lead = typeof options.leadMinutes === 'number' && options.leadMinutes >= 0 ? options.leadMinutes : 5
  // a lead as long as the cache would fire right after every turn: keep a minute of idle
  const leadMs = Math.min(lead * MIN, Math.max(0, cacheMs - MIN))
  return { cacheMs, leadMs, warnMs: Math.min(MIN, cacheMs - leadMs) }
}

export function decide(s: Snapshot, p: Policy): Decision {
  if (!s.armed || s.paused || s.pending || s.turnRunning || s.lastRequestAt === null) return { kind: 'wait' }
  const idle = s.now - s.lastRequestAt
  const fireAt = p.cacheMs - p.leadMs
  // past the lifetime the cache is cold: a handoff now pays a full prefix write
  if (idle >= p.cacheMs) return { kind: 'expired' }
  if (idle >= fireAt) return { kind: 'fire' }
  const fireInMs = fireAt - idle
  if (fireInMs > p.warnMs) return { kind: 'wait' }
  return s.warnedFor === s.lastRequestAt ? { kind: 'countdown', fireInMs } : { kind: 'warn', fireInMs }
}

const RESUME = /\/ce-handoff\s+resume\s+(?:"([^"]+)"|'([^']+)'|(\S+))/g
const MD_PATH = /(?:[A-Za-z]:[\\/]|\/|~[\\/])[^\s"'`<>|*?]*?\.md\b/g

/**
 * Where the handoff turn says it wrote the handoff: ce-handoff's resume line,
 * else the last absolute `.md` path. Used for skills other than the built-in,
 * whose answer the mod saves itself.
 */
export function handoffPath(answer: string): string | null {
  const resume = [...answer.matchAll(RESUME)].pop()
  if (resume) return (resume[1] ?? resume[2] ?? resume[3] ?? '').replace(/[`.,;:)\]]+$/, '') || null
  return [...answer.matchAll(MD_PATH)].pop()?.[0] ?? null
}

export const baseName = (path: string) => path.split(/[\\/]/).pop() || path

export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}
