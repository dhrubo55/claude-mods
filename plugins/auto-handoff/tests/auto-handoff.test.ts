import { expect, test } from 'claude-code/testing'

import { ALL, ALONE, BUILTIN, CE, command, DOC, engine, KEY, MATT, MIN, PATH, SLOW, start, turn, USAGE, WARNING } from './rig'

// --- firing ---------------------------------------------------------------

test('runs the built-in handoff once, five minutes before the 1-hour cache expires', SLOW, async ($, on) => {
  const { clock, toasts, ran, asks } = engine(on)
  await start($)
  await turn($, 't1')
  expect(asks.length).toBe(0)

  await clock.advance(53 * MIN)
  expect(ran.length).toBe(0)
  expect(toasts.length).toBe(0)

  // the warning comes a minute before firing
  await clock.advance(MIN + 5_000)
  expect(ran.length).toBe(0)
  expect(toasts.filter(t => t === WARNING).length).toBe(1)

  await clock.advance(MIN)
  expect(ran).toEqual([{ command: BUILTIN, args: '' }])
  expect(toasts).toContain(`Running /${BUILTIN}`)

  // the queued command's turn is the handoff turn: the mod saves its answer and does not re-arm
  await turn($, 'handoff', DOC)
  expect(toasts).toContain(`Handoff saved to ${PATH}`)
  await clock.advance(70 * MIN)
  expect(ran.length).toBe(1)

  const status = await command($, 'status')
  expect(status.text).toContain(`runs the built-in /${BUILTIN} at 55:00 idle`)
  expect(status.text).toContain(PATH)
  expect(status.text).toContain('waits for your next turn')

  // your next turn arms it again
  await turn($, 't2')
  await clock.advance(55 * MIN + 1_000)
  expect(ran.length).toBe(2)
})

test('runs a configured /ce-handoff as /<plugin>:ce-handoff create', { ...SLOW, options: { handoffCommand: 'ce-handoff' } }, async ($, on) => {
  const { clock, ran, toasts, asks } = engine(on, { commands: ALL })
  await start($)
  await turn($, 't1')
  await clock.advance(55 * MIN + 1_000)
  expect(asks.length).toBe(0)
  expect(ran).toEqual([{ command: CE, args: 'create' }])
  expect(toasts).toContain(`Running /${CE} create`)
})

test("a configured /handoff runs another plugin's handoff, not the built-in", { ...SLOW, options: { handoffCommand: '/handoff' } }, async ($, on) => {
  const { clock, ran } = engine(on, { commands: ALL })
  await start($)
  await turn($, 't1')
  await clock.advance(55 * MIN + 1_000)
  expect(ran).toEqual([{ command: MATT, args: '' }])
})

test('a configured command that is not installed falls back to the built-in', { ...SLOW, options: { handoffCommand: 'ce-handoff' } }, async ($, on) => {
  const { clock, ran, toasts } = engine(on)
  await start($)
  await turn($, 't1')
  await clock.advance(55 * MIN + 1_000)
  expect(ran).toEqual([{ command: BUILTIN, args: '' }])
  expect(toasts).toContain(`/ce-handoff is not installed in this session; running the built-in /${BUILTIN} instead`)
  const status = await command($, 'status')
  expect(status.text).toContain(`runs the built-in /${BUILTIN} (/ce-handoff is not installed)`)
})

test('runs nothing and says so when no handoff command is loaded', { ...SLOW, options: { handoffCommand: 'ce-handoff' } }, async ($, on) => {
  const { clock, ran, toasts } = engine(on, { commands: ['compact'] })
  await start($)
  await turn($, 't1')
  await clock.advance(55 * MIN + 1_000)
  expect(ran.length).toBe(0)
  expect(toasts).toContain(`No handoff command available: /ce-handoff is not installed and /${BUILTIN} is not loaded. Nothing ran.`)
  const now = await command($, 'now')
  expect(now.text).toBe(`Nothing to run: /${BUILTIN} is not loaded and /ce-handoff is not installed.`)
})

test('does nothing before a turn, while paused, or while a turn is running', SLOW, async ($, on) => {
  const { clock, ran, toasts } = engine(on)
  await start($)
  await clock.advance(120 * MIN)
  expect(ran.length).toBe(0)

  await turn($, 't1')
  const off = await command($, 'off')
  expect(off.text).toBe('Paused for this session. /auto-handoff on resumes it.')
  await clock.advance(56 * MIN)
  expect(ran.length).toBe(0)

  const on_ = await command($, 'on')
  expect(on_.text).toBe('On for this session.')
  // a turn whose one request started long ago and is still running (a long tool call)
  await $.turn.start({ text: 'long build', turnId: 't2' })
  const stream = $.turn.step({ turnId: 't2', index: 0, model: USAGE.model, messageCount: 5 })
  for await (const _ of stream) void _
  await stream.result
  await clock.advance(56 * MIN)
  expect(ran.length).toBe(0)
  expect(toasts.length).toBe(0)
})

test('the plugin option Off stops the timer but not /auto-handoff now', { ...SLOW, options: { enabled: false } }, async ($, on) => {
  const { clock, ran } = engine(on)
  await start($)
  await turn($, 't1')
  await clock.advance(56 * MIN)
  expect(ran.length).toBe(0)
  expect((await command($, 'status')).text).toContain('Off (plugin option)')
  await command($, 'now')
  await clock.settle()
  expect(ran).toEqual([{ command: BUILTIN, args: '' }])
})

test('skips when the cache already expired, and /clear resets the clock', SLOW, async ($, on) => {
  const { clock, ran, toasts } = engine(on)
  await start($)
  await turn($, 't1')
  // paused through the firing window, resumed after the cache's lifetime
  await command($, 'off')
  await clock.advance(61 * MIN)
  await command($, 'on')
  await clock.advance(2_000)
  expect(ran.length).toBe(0)
  expect(toasts).toContain('Handoff skipped: the prompt cache had already expired, so a handoff now would send the whole context again.')

  await turn($, 't2')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { sessionId: 's1' } as never })
  await clock.advance(56 * MIN)
  expect(ran.length).toBe(0)
  const status = await command($, 'status')
  expect(status.text).toContain('No request yet')
})

test('/auto-handoff now runs the handoff right away', { options: { handoffCommand: 'compound-engineering:ce-handoff' } }, async ($, on) => {
  const { clock, ran, toasts } = engine(on, { commands: ALL })
  await start($)
  await turn($, 't1')
  const now = await command($, 'now')
  expect(now.text).toBe(`Queuing /${CE} create`)
  await clock.settle()
  expect(ran).toEqual([{ command: CE, args: 'create' }])
  expect(toasts).toContain(`Running /${CE} create`)
})

test('a handoff turn that is aborted is reported, with no path', async ($, on) => {
  const { clock, toasts } = engine(on)
  await start($)
  await turn($, 't1')
  await command($, 'now')
  await clock.settle()
  await $.turn.start({ text: '/auto-handoff:handoff', turnId: 'h' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: true, turnId: 'h', reason: 'aborted' as never })
  expect(toasts.some(t => t.startsWith('The handoff turn ended ('))).toBe(true)
  expect((await command($, 'status')).text).toContain('did not finish')
})

// --- the question ---------------------------------------------------------

test('after the first turn, asks once which handoff command to run and saves it', async ($, on) => {
  const { clock, asks, saved, toasts } = engine(on, { commands: ALL, answer: `/${CE}` })
  await start($)
  await turn($, 't1')
  await clock.settle()
  expect(asks).toEqual([
    {
      question: 'Which handoff command should auto-handoff run before the prompt cache expires?',
      labels: [`/${CE}`, `/${MATT}`, 'Built-in handoff'],
    },
  ])
  expect(saved).toEqual([{ key: KEY, value: CE }])
  expect(toasts).toContain(`Handoff command set to /${CE}. Change it in /config or with /auto-handoff setup.`)

  await turn($, 't2')
  await clock.settle()
  expect(asks.length).toBe(1)
})

test('choosing the built-in saves it, so the question is not asked again', async ($, on) => {
  const { clock, saved, toasts } = engine(on, { commands: ALL, answer: 'Built-in handoff' })
  await start($)
  await turn($, 't1')
  await clock.settle()
  expect(saved).toEqual([{ key: KEY, value: BUILTIN }])
  expect(toasts).toContain(`Handoff command set to the built-in /${BUILTIN}. Change it in /config or with /auto-handoff setup.`)
})

test('a dismissed question saves nothing and keeps the built-in', async ($, on) => {
  const { clock, asks, saved, toasts } = engine(on, { commands: ALL, answer: null })
  await start($)
  await turn($, 't1')
  await clock.settle()
  expect(asks.length).toBe(1)
  expect(saved.length).toBe(0)
  expect(toasts).toContain(`No handoff command chosen: auto-handoff runs the built-in /${BUILTIN}. /auto-handoff setup asks again.`)
  // once per session
  await turn($, 't2')
  await clock.settle()
  expect(asks.length).toBe(1)
})

test('a name typed under Other is checked against the installed commands', async ($, on) => {
  const { clock, saved, toasts } = engine(on, { commands: ALL, answer: 'my-handoff' })
  await start($)
  await turn($, 't1')
  await clock.settle()
  expect(saved.length).toBe(0)
  expect(toasts).toContain(`/my-handoff is not installed in this session; nothing saved. auto-handoff runs the built-in /${BUILTIN}.`)
})

test('a refused save keeps the built-in and says why', async ($, on) => {
  const { clock, toasts } = engine(on, { commands: ALL, answer: `/${MATT}`, configDeny: 'set by your organization' })
  await start($)
  await turn($, 't1')
  await clock.settle()
  expect(toasts).toContain(`Could not save the handoff command (set by your organization). auto-handoff runs the built-in /${BUILTIN}.`)
})

test('does not ask when no other handoff command is installed', async ($, on) => {
  const { clock, asks } = engine(on, { commands: ['compact', BUILTIN, 'other:claude-notes'], answer: 'Built-in handoff' })
  await start($)
  await turn($, 't1')
  await clock.settle()
  expect(asks.length).toBe(0)
})

test('does not ask when a handoff command is configured', { options: { handoffCommand: 'ce-handoff' } }, async ($, on) => {
  const { clock, asks } = engine(on, { commands: ALL, answer: 'Built-in handoff' })
  await start($)
  await turn($, 't1')
  await clock.settle()
  expect(asks.length).toBe(0)
})

test('does not ask in a -p run', async ($, on) => {
  const { clock, asks } = engine(on, { commands: ALL, answer: 'Built-in handoff' })
  await start($, false)
  await turn($, 't1')
  await clock.settle()
  expect(asks.length).toBe(0)
})

test('/auto-handoff setup asks again, or says there is nothing to pick', async ($, on) => {
  const { clock, asks, saved } = engine(on, { commands: ALL, answer: `/${MATT}` })
  await start($)
  const r = await command($, 'setup')
  expect(r.text).toBe('Opening the handoff command picker.')
  await clock.settle()
  expect(asks.length).toBe(1)
  expect(saved).toEqual([{ key: KEY, value: MATT }])
  // setup counts as the session's question: the first turn does not ask again
  await turn($, 't1')
  await clock.settle()
  expect(asks.length).toBe(1)
})

test('/auto-handoff setup with no other handoff command installed', async ($, on) => {
  const { asks } = engine(on)
  await start($)
  const r = await command($, 'setup')
  expect(r.text).toBe(`No other handoff skill is installed; auto-handoff runs the built-in /${BUILTIN}.`)
  expect(asks.length).toBe(0)
})
