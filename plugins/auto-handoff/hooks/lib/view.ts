// Pure logic of what the band row and the pane show. No `$` here, so tests
// call it directly.

import type { HandoffRecord } from '../../types'
import { invocation } from './choice'
import type { Resolved } from './choice'
import { baseName, fmtClock } from './schedule'
import type { Policy } from './schedule'

/** The state the band and the pane draw from, read from `$.state` and the clock. */
export type View = {
  now: number
  lastRequestAt: number | null
  armed: boolean
  paused: boolean
  /** The plugin option `enabled`. */
  enabled: boolean
  /** A handoff is queued, or its turn is running. */
  pending: boolean
  turnRunning: boolean
  last: HandoffRecord | null
}

export type Phase =
  | { kind: 'none' }
  | { kind: 'off' }
  | { kind: 'paused' }
  | { kind: 'queued' }
  | { kind: 'working' }
  | { kind: 'counting'; idleMs: number; fireInMs: number; isWarning: boolean }
  | { kind: 'handed'; agoMs: number; record: HandoffRecord }
  | { kind: 'expired' }
  | { kind: 'waiting' }

export const fireAtOf = (p: Policy) => p.cacheMs - p.leadMs

export function phaseOf(v: View, p: Policy): Phase {
  if (v.pending) return { kind: 'queued' }
  if (!v.enabled) return { kind: 'off' }
  if (v.paused) return { kind: 'paused' }
  if (v.lastRequestAt === null) return { kind: 'none' }
  if (v.turnRunning) return { kind: 'working' }
  const idleMs = Math.max(0, v.now - v.lastRequestAt)
  if (!v.armed) {
    // the handoff turn's own requests start before it completes, so its record is the newer
    if (v.last && v.last.at >= v.lastRequestAt) return { kind: 'handed', agoMs: v.now - v.last.at, record: v.last }
    return idleMs >= p.cacheMs ? { kind: 'expired' } : { kind: 'waiting' }
  }
  if (idleMs >= p.cacheMs) return { kind: 'expired' }
  const fireInMs = Math.max(0, fireAtOf(p) - idleMs)
  return { kind: 'counting', idleMs, fireInMs, isWarning: fireInMs <= p.warnMs }
}

const lastSegment = (name: string) => name.slice(name.lastIndexOf(':') + 1)

/** The command as the band names it: `/ce-handoff create`, `/handoff (built-in)`. */
export function cmdLabel(r: Resolved): string {
  switch (r.kind) {
    case 'configured':
      return invocation(lastSegment(r.command), r.args)
    case 'builtin':
      return `/${lastSegment(r.command)} (built-in)`
    case 'fallback':
      return `/${lastSegment(r.command)} (built-in, ${r.missing} missing)`
    case 'none':
      return 'no handoff command'
  }
}

/** What a fire runs, in full. */
export const runsOf = (r: Resolved) => (r.kind === 'none' ? 'nothing' : invocation(r.command, r.args))

/** Why that command runs. */
export function why(r: Resolved, setting: string): string {
  switch (r.kind) {
    case 'configured': {
      const args = r.args ? `; ${lastSegment(r.command)} takes "${r.args}"` : ''
      return `set in /config, found as ${r.command}${args}`
    }
    case 'builtin':
      return setting ? 'set to the built-in' : 'Handoff command is empty, so the built-in runs'
    case 'fallback':
      return `/${r.missing} is not installed in this session; the built-in runs instead`
    case 'none':
      return r.missing ? `neither /${r.missing} nor the built-in /${r.builtin} is loaded` : `the built-in /${r.builtin} is not loaded`
  }
}

export type Tone = 'normal' | 'warn' | 'dim'

const SEP = ' · '

/** The band row's segments, most important first; null when the band has nothing to say. */
export function bandSegments(phase: Phase, label: string, last: HandoffRecord | null, p: Policy): { parts: string[]; tone: Tone } | null {
  switch (phase.kind) {
    case 'none':
    case 'off':
      return null
    case 'paused':
      return { parts: ['handoff paused', '/auto-handoff on'], tone: 'dim' }
    case 'queued':
      return { parts: ['writing handoff', label], tone: 'normal' }
    case 'working':
      return { parts: [`handoff after ${fmtClock(fireAtOf(p))} idle`, label], tone: 'dim' }
    case 'counting': {
      const head = `handoff in ${fmtClock(phase.fireInMs)}`
      if (phase.isWarning) return { parts: [head, 'send a message to keep working', label], tone: 'warn' }
      const lastPart = last?.ok && last.path ? `last ${baseName(last.path)}` : ''
      return { parts: [head, label, lastPart].filter(Boolean), tone: 'normal' }
    }
    case 'handed': {
      const { record } = phase
      const ago = fmtClock(phase.agoMs)
      if (!record.ok) {
        const what = record.problem ? `handoff ${ago} ago: ${record.problem}` : `handoff turn ended ${ago} ago without a handoff`
        return { parts: [what, 'arms on your next turn'], tone: 'dim' }
      }
      return { parts: [`handed off ${ago} ago`, record.path ? baseName(record.path) : '', 'arms on your next turn'].filter(Boolean), tone: 'normal' }
    }
    case 'expired':
      return { parts: ['cache expired, no handoff', 'arms on your next turn'], tone: 'dim' }
    case 'waiting':
      return { parts: ['handoff arms on your next turn', label], tone: 'dim' }
  }
}

/**
 * Joins the segments into one row of at most `columns` cells: drops segments
 * from the end, then cuts the first with an ellipsis.
 */
export function fitRow(prefix: string, parts: readonly string[], columns: number): string {
  const room = Math.max(1, columns)
  for (let n = parts.length; n > 0; n--) {
    const text = prefix + parts.slice(0, n).join(SEP)
    if (text.length <= room) return text
  }
  const text = prefix + (parts[0] ?? '')
  return text.length <= room ? text : `${text.slice(0, Math.max(0, room - 1))}…`
}

export type TimelineRow = { label: string; when: string; at: string; isNext: boolean; isPassed: boolean }

/** The pane's timeline: the last request, then the warning, the handoff and the cache's expiry. */
export function timeline(v: View, p: Policy): TimelineRow[] {
  if (v.lastRequestAt === null) return []
  const idle = Math.max(0, v.now - v.lastRequestAt)
  const fireAt = fireAtOf(p)
  const events = [
    { label: 'warning', at: fireAt - p.warnMs },
    { label: 'handoff', at: fireAt },
    { label: 'cache expires', at: p.cacheMs },
  ]
  // the countdown only runs while armed and idle; otherwise no event is next
  const isCounting = v.armed && !v.paused && v.enabled && !v.pending && !v.turnRunning
  let nextSeen = false
  const rows: TimelineRow[] = [{ label: 'last request', when: `${fmtClock(idle)} ago`, at: '', isNext: false, isPassed: true }]
  for (const ev of events) {
    const isPassed = idle >= ev.at
    const isNext = isCounting && !isPassed && !nextSeen
    if (isNext) nextSeen = true
    rows.push({ label: ev.label, when: isPassed ? 'passed' : `in ${fmtClock(ev.at - idle)}`, at: `at ${fmtClock(ev.at)} idle`, isNext, isPassed })
  }
  return rows
}

/** The pane's last-handoff line, or null before the first handoff. */
export function lastLine(v: View): { when: string; what: string } | null {
  if (!v.last) return null
  const when = `${fmtClock(v.now - v.last.at)} ago`
  if (!v.last.ok) return { when, what: v.last.problem ?? 'did not finish' }
  return { when, what: v.last.path ?? 'path not found in the answer' }
}

/** The pane's state line. */
export function stateText(phase: Phase): string {
  switch (phase.kind) {
    case 'none':
      return 'no request yet in this conversation'
    case 'off':
      return 'off (plugin option); Hand off now still runs it'
    case 'paused':
      return 'paused for this session'
    case 'queued':
      return 'handoff queued or running'
    case 'working':
      return 'turn running; the idle clock starts when it ends'
    case 'counting':
      return phase.isWarning ? 'handoff in under a minute; send a message to keep working' : 'armed; fires once per idle period'
    case 'handed':
      return phase.record.ok ? 'handed off; arms on your next turn' : 'the handoff turn did not finish; arms on your next turn'
    case 'expired':
      return 'cache expired, no handoff; arms on your next turn'
    case 'waiting':
      return 'arms on your next turn'
  }
}

/** The idle bar: `width` cells filled up to the idle time, `│` at the handoff point. */
export function bar(idleMs: number, p: Policy, width: number): { filled: string; empty: string } {
  const w = Math.max(4, Math.floor(width))
  const fill = Math.round((Math.min(Math.max(0, idleMs), p.cacheMs) / p.cacheMs) * w)
  const mark = Math.min(w - 1, Math.round((fireAtOf(p) / p.cacheMs) * w))
  const cells = Array.from({ length: w }, (_, i) => (i === mark ? '│' : i < fill ? '█' : '░'))
  return { filled: cells.slice(0, fill).join(''), empty: cells.slice(fill).join('') }
}

/**
 * Splits buttons into rows of at most `width` cells. The terminal draws each
 * as `[ label ]` with its hotkey mark (`n: `), one cell apart.
 */
export function pack<T extends { label: string }>(items: readonly T[], width: number): T[][] {
  const rows: T[][] = []
  let used = 0
  for (const item of items) {
    const w = item.label.length + 7
    const row = rows[rows.length - 1]
    if (!row || used + 1 + w > width) {
      rows.push([item])
      used = w
    } else {
      row.push(item)
      used += 1 + w
    }
  }
  return rows
}

/** The resume prompt the pane copies. */
export const resumePrompt = (path: string) => `Read ${path} and continue from it.`
