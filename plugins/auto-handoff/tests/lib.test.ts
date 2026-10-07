import { expect, test } from 'claude-code/testing'

import { argsFor, askOptions, candidates, clean, configKey, findCommand, interpret, resolve } from '../hooks/lib/choice'
import { decide, fmtClock, handoffPath, policyOf } from '../hooks/lib/schedule'
import { bandSegments, bar, cmdLabel, fitRow, pack, phaseOf, resumePrompt, timeline, why } from '../hooks/lib/view'
import type { View } from '../hooks/lib/view'

const NOW = 1_760_000_000_000
const MIN = 60_000
const SELF = 'auto-handoff'
const BUILTIN = 'auto-handoff:handoff'

test('schedule: when to wait, warn, fire or skip', () => {
  const p = policyOf({})
  expect(p).toEqual({ cacheMs: 60 * MIN, leadMs: 5 * MIN, warnMs: MIN })
  expect(policyOf({ cacheMinutes: 5, leadMinutes: 5 }).leadMs).toBe(4 * MIN)
  expect(policyOf({ cacheMinutes: -1, leadMinutes: 'x' })).toEqual(p)

  const base = { now: NOW, lastRequestAt: NOW, armed: true, paused: false, pending: false, turnRunning: false, warnedFor: null }
  expect(decide({ ...base, now: NOW + 53 * MIN }, p).kind).toBe('wait')
  expect(decide({ ...base, now: NOW + 54.5 * MIN }, p)).toEqual({ kind: 'warn', fireInMs: 30_000 })
  expect(decide({ ...base, now: NOW + 54.5 * MIN, warnedFor: NOW }, p).kind).toBe('countdown')
  expect(decide({ ...base, now: NOW + 55 * MIN }, p).kind).toBe('fire')
  expect(decide({ ...base, now: NOW + 60 * MIN }, p).kind).toBe('expired')
  expect(decide({ ...base, now: NOW + 55 * MIN, armed: false }, p).kind).toBe('wait')
  expect(decide({ ...base, now: NOW + 55 * MIN, pending: true }, p).kind).toBe('wait')
  expect(decide({ ...base, now: NOW + 55 * MIN, turnRunning: true }, p).kind).toBe('wait')
  expect(decide({ ...base, lastRequestAt: null }, p).kind).toBe('wait')
})

test('schedule: handoff paths and clock text', () => {
  const ce = '/tmp/compound-engineering-1000/ce-handoff/repo-ab12cd/auto-handoff-mod.md'
  expect(handoffPath(`Captured it.\n\n\`\`\`text\n/ce-handoff resume "${ce}"\n\`\`\``)).toBe(ce)
  expect(handoffPath('```text\n/ce-handoff resume /tmp/x/y.md\n```')).toBe('/tmp/x/y.md')
  expect(handoffPath('Captured the plan.\n\nC:\\Users\\me\\.claude\\handoffs\\work\\fix-login.md')).toBe(
    'C:\\Users\\me\\.claude\\handoffs\\work\\fix-login.md',
  )
  expect(handoffPath('Read /repo/PLAN.md first.\n\n/home/me/.claude/handoffs/work/fix-login-2.md')).toBe('/home/me/.claude/handoffs/work/fix-login-2.md')
  expect(handoffPath('Nothing written.')).toBeNull()
  expect(fmtClock(65_000)).toBe('1:05')
  expect(fmtClock(3_725_000)).toBe('1:02:05')
})

test('choice: which command a fire runs', () => {
  const all = ['compact', BUILTIN, 'compound-engineering:ce-handoff', 'mattpocock-skills:handoff']
  expect(resolve(all, '', SELF)).toEqual({ kind: 'builtin', command: BUILTIN, args: '' })
  expect(resolve(all, '  ', SELF).kind).toBe('builtin')
  expect(resolve(all, 'ce-handoff', SELF)).toEqual({ kind: 'configured', command: 'compound-engineering:ce-handoff', args: 'create' })
  expect(resolve(all, '/handoff', SELF)).toEqual({ kind: 'configured', command: 'mattpocock-skills:handoff', args: '' })
  expect(resolve(all, BUILTIN, SELF)).toEqual({ kind: 'builtin', command: BUILTIN, args: '' })
  expect(resolve(['compact', BUILTIN], 'ce-handoff', SELF)).toEqual({ kind: 'fallback', command: BUILTIN, args: '', missing: 'ce-handoff' })
  expect(resolve(['compact'], '', SELF)).toEqual({ kind: 'none', missing: null, builtin: BUILTIN })
  // a plugin loaded from a folder can carry an @ suffix
  expect(resolve(all, '', 'auto-handoff@inline').kind).toBe('builtin')

  expect(findCommand(['ce-handoff', 'compound-engineering:ce-handoff'], 'ce-handoff', SELF)).toBe('ce-handoff')
  expect(findCommand([BUILTIN], 'handoff', SELF)).toBe(BUILTIN)
  expect(findCommand(['x:claude-handoff'], 'handoff', SELF)).toBeUndefined()
  expect(argsFor('ce-handoff')).toBe('create')
  expect(argsFor('a:handoff')).toBe('')
  expect(clean(' /x:y ')).toBe('x:y')
  expect(clean(42)).toBe('')
})

test('choice: which commands are offered, and what an answer means', () => {
  const commands = [
    { name: 'compact' },
    { name: BUILTIN, plugin: SELF },
    { name: 'auto-handoff' },
    { name: 'zed:Handoff', plugin: 'zed' },
    { name: 'mattpocock-skills:handoff', plugin: 'mattpocock-skills' },
    { name: 'acme:session-handoff', plugin: 'acme' },
    { name: 'compound-engineering:ce-handoff', plugin: 'compound-engineering' },
    { name: 'acme:handoff-notes', plugin: 'acme' },
  ]
  const offered = candidates(commands, SELF)
  expect(offered).toEqual(['compound-engineering:ce-handoff', 'mattpocock-skills:handoff', 'zed:Handoff', 'acme:session-handoff'])
  expect(askOptions(offered)).toEqual(['/compound-engineering:ce-handoff', '/mattpocock-skills:handoff', '/zed:Handoff', 'Built-in handoff'])
  expect(askOptions(['a:handoff'])).toEqual(['/a:handoff', 'Built-in handoff'])
  expect(candidates([{ name: 'compact' }, { name: BUILTIN, plugin: SELF }], SELF)).toEqual([])

  const names = commands.map(c => c.name)
  expect(interpret('Built-in handoff', names, SELF)).toEqual({ kind: 'builtin' })
  expect(interpret('/mattpocock-skills:handoff', names, SELF)).toEqual({ kind: 'command', command: 'mattpocock-skills:handoff' })
  expect(interpret('ce-handoff', names, SELF)).toEqual({ kind: 'command', command: 'compound-engineering:ce-handoff' })
  expect(interpret('/auto-handoff:handoff', names, SELF)).toEqual({ kind: 'builtin' })
  expect(interpret('nope', names, SELF)).toEqual({ kind: 'unknown', typed: 'nope' })
  expect(interpret('  ', names, SELF)).toEqual({ kind: 'dismissed' })

  const row = (key: string, plugin: string) => ({ key, provider: { plugin } })
  expect(configKey([row('theme', 'engine'), row('auto-handoff.handoffCommand', SELF)], SELF)).toBe('auto-handoff.handoffCommand')
  expect(configKey([row('auto-handoff@inline.handoffCommand', 'auto-handoff@inline')], 'auto-handoff@inline')).toBe('auto-handoff@inline.handoffCommand')
  expect(configKey([row('other.handoffCommand', 'other')], SELF)).toBeUndefined()
})

const CE = 'compound-engineering:ce-handoff'
const view = (over: Partial<View> = {}): View => ({
  now: NOW + 10 * MIN,
  lastRequestAt: NOW,
  armed: true,
  paused: false,
  enabled: true,
  pending: false,
  turnRunning: false,
  last: null,
  ...over,
})

test('view: which phase the band and the pane show', () => {
  const p = policyOf({})
  const record = { at: NOW + MIN, path: '/h/work/topic.md', ok: true }
  expect(phaseOf(view(), p)).toEqual({ kind: 'counting', idleMs: 10 * MIN, fireInMs: 45 * MIN, isWarning: false })
  expect(phaseOf(view({ now: NOW + 54 * MIN }), p)).toMatchObject({ kind: 'counting', isWarning: true })
  expect(phaseOf(view({ now: NOW + 53 * MIN + 59_000 }), p)).toMatchObject({ kind: 'counting', isWarning: false })
  // a queued handoff shows even with the option off
  expect(phaseOf(view({ pending: true, enabled: false }), p).kind).toBe('queued')
  expect(phaseOf(view({ enabled: false, paused: true }), p).kind).toBe('off')
  expect(phaseOf(view({ paused: true, lastRequestAt: null }), p).kind).toBe('paused')
  expect(phaseOf(view({ lastRequestAt: null }), p).kind).toBe('none')
  expect(phaseOf(view({ turnRunning: true }), p).kind).toBe('working')
  expect(phaseOf(view({ armed: false, last: record }), p)).toEqual({ kind: 'handed', agoMs: 9 * MIN, record })
  expect(phaseOf(view({ armed: false, last: { ...record, at: NOW - MIN } }), p).kind).toBe('waiting')
  expect(phaseOf(view({ armed: false, now: NOW + 61 * MIN }), p).kind).toBe('expired')
  expect(phaseOf(view({ now: NOW + 61 * MIN }), p).kind).toBe('expired')
})

test('view: band text, its fit, the timeline, the bar and the buttons', () => {
  const p = policyOf({})
  const record = { at: NOW, path: '/h/work/topic.md', ok: true }
  expect(bandSegments({ kind: 'none' }, 'x', null, p)).toBeNull()
  expect(bandSegments({ kind: 'off' }, 'x', null, p)).toBeNull()
  expect(bandSegments({ kind: 'counting', idleMs: 0, fireInMs: 55 * MIN, isWarning: false }, '/handoff (built-in)', record, p)).toEqual({
    parts: ['handoff in 55:00', '/handoff (built-in)', 'last topic.md'],
    tone: 'normal',
  })
  expect(bandSegments({ kind: 'handed', agoMs: 0, record: { ...record, ok: false } }, 'x', null, p)?.parts[0]).toBe('handoff turn ended 0:00 ago without a handoff')

  expect(fitRow('> ', ['a b', 'cc'], 10)).toBe('> a b · cc')
  expect(fitRow('> ', ['a b', 'cc'], 9)).toBe('> a b')
  expect(fitRow('> ', ['abcdefghij'], 6)).toBe('> abc…')

  const rows = timeline(view({ now: NOW + 54 * MIN + 30_000 }), p)
  expect(rows.map(r => [r.label, r.when, r.isNext, r.isPassed])).toEqual([
    ['last request', '54:30 ago', false, true],
    ['warning', 'passed', false, true],
    ['handoff', 'in 0:30', true, false],
    ['cache expires', 'in 5:30', false, false],
  ])
  // nothing is next while the countdown does not run
  expect(timeline(view({ paused: true }), p).some(r => r.isNext)).toBe(false)
  expect(timeline(view({ lastRequestAt: null }), p)).toEqual([])

  expect(bar(30 * MIN, p, 12)).toEqual({ filled: '██████', empty: '░░░░░│' })
  expect(bar(60 * MIN, p, 12)).toEqual({ filled: '███████████│', empty: '' })

  const b = (label: string) => ({ label })
  expect(pack([b('Hand off now'), b('Pause'), b('Close')], 40)).toEqual([[b('Hand off now'), b('Pause')], [b('Close')]])
  expect(resumePrompt('/h/t.md')).toBe('Read /h/t.md and continue from it.')
})

test('view: how the band names the command and the pane says why', () => {
  const configured = resolve([BUILTIN, CE], 'ce-handoff', SELF)
  const builtin = resolve([BUILTIN], '', SELF)
  const fallback = resolve([BUILTIN], 'ce-handoff', SELF)
  const none = resolve(['compact'], '', SELF)
  expect([configured, builtin, fallback, none].map(cmdLabel)).toEqual([
    '/ce-handoff create',
    '/handoff (built-in)',
    '/handoff (built-in, ce-handoff missing)',
    'no handoff command',
  ])
  expect(why(configured, 'ce-handoff')).toBe(`set in /config, found as ${CE}; ce-handoff takes "create"`)
  expect(why(builtin, '')).toBe('Handoff command is empty, so the built-in runs')
  expect(why(fallback, 'ce-handoff')).toBe('/ce-handoff is not installed in this session; the built-in runs instead')
  expect(why(none, '')).toBe(`the built-in /${BUILTIN} is not loaded`)
})
