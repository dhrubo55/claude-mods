import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { ALL, BUILTIN, CE, command, DOC, engine, KEY, MIN, PATH, SLOW, start, turn } from './rig'

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]
const PLUGIN = 'auto-handoff'
const BAND = { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} }
const PANE = { title: 'auto-handoff', isFocused: true, bodyColumns: 72, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }
const OPENED = { id: 'auto-handoff', title: 'auto-handoff', focus: true }

/** The engine's own band beneath the plugins: nothing to draw. */
const nothingBeneath = (on: On) =>
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

/** The rig, with an empty engine band beneath. */
const setup = (on: On, s?: Parameters<typeof engine>[1]) => {
  const r = engine(on, s)
  nothingBeneath(on)
  return r
}

const band = ($: Engine, surface: Surface, props: Partial<typeof BAND> = {}) =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: { ...BAND, ...props } })
const pane = ($: Engine, surface: Surface) => $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: PANE })

/** The band row's text on each surface, or undefined where it draws no row. */
async function bandTexts($: Engine, props: Partial<typeof BAND> = {}) {
  const texts: (string | undefined)[] = []
  for (const surface of SURFACES) {
    const ui = await band($, surface, props)
    texts.push((await ui.find({ key: 'band' }))?.text)
    await ui.unmount()
  }
  return texts
}
const both = (text: string | undefined) => SURFACES.map(() => text)

/** Runs the reads on a pane mounted on each surface. */
async function onPane($: Engine, check: (ui: Awaited<ReturnType<typeof pane>>) => Promise<void>) {
  for (const surface of SURFACES) {
    const ui = await pane($, surface)
    await check(ui)
    await ui.unmount()
  }
}

/** The text of the pane's line with that key (state, c-runs, ...): its label, then its value. */
const lineText = async (ui: Awaited<ReturnType<typeof pane>>, key: string) => (await ui.find({ key }))?.text

/** Fires a handoff now and finishes its turn with the document the mod saves. */
async function handOff($: Engine, clock: { settle: () => Promise<void> }) {
  await command($, 'now')
  await clock.settle()
  await turn($, 'handoff', DOC)
}

// --- band ---------------------------------------------------------------------

test('band: no row before the first request, under a survey, or with the option off', async ($, on) => {
  setup(on)
  await start($)
  expect(await bandTexts($)).toEqual(both(undefined))
  await turn($, 't1')
  expect(await bandTexts($)).toEqual(both('⇢ handoff in 55:00 · /handoff (built-in)'))
  // the survey takes the band's place
  expect(await bandTexts($, { hasSurvey: true })).toEqual(both(undefined))
})

test('band: the showBand option off draws no row, and the pane still opens', { options: { showBand: false } }, async ($, on) => {
  const { opened } = setup(on)
  await start($)
  await turn($, 't1')
  expect(await bandTexts($)).toEqual(both(undefined))
  expect((await command($, '')).text).toBe('Opened the auto-handoff pane.')
  expect(opened).toEqual([OPENED])
})

test('band: the plugin option Off draws no row', { options: { enabled: false } }, async ($, on) => {
  setup(on)
  await start($)
  await turn($, 't1')
  expect(await bandTexts($)).toEqual(both(undefined))
})

test('band: counts down, warns in the last minute, and redraws each second', SLOW, async ($, on) => {
  const { clock } = setup(on)
  await start($)
  await turn($, 't1')
  await clock.advance(10 * MIN)
  expect(await bandTexts($)).toEqual(both('⇢ handoff in 45:00 · /handoff (built-in)'))

  // the tick's invalidate redraws a mounted band
  const mounted = [await band($, 'terminal'), await band($, 'desktop')]
  await clock.advance(1_000)
  for (const ui of mounted) {
    expect((await ui.find({ key: 'band' }))?.text).toBe('⇢ handoff in 44:59 · /handoff (built-in)')
    await ui.unmount()
  }

  await clock.advance(44 * MIN + 29_000)
  for (const surface of SURFACES) {
    const ui = await band($, surface)
    const row = await ui.find({ type: 'Text', text: '⇢ handoff in 0:30' })
    expect(row?.text).toBe('⇢ handoff in 0:30 · send a message to keep working · /handoff (built-in)')
    expect(row?.props).toMatchObject({ color: 'yellow', bold: true })
    await ui.unmount()
  }
})

test('band: queued, handed off, then counting again with the last handoff', SLOW, async ($, on) => {
  const { clock, ran } = setup(on)
  await start($)
  await turn($, 't1')
  await clock.advance(55 * MIN)
  expect(ran).toEqual([{ command: BUILTIN, args: '' }])
  expect(await bandTexts($)).toEqual(both('⇢ writing handoff · /handoff (built-in)'))

  await turn($, 'handoff', DOC)
  expect(await bandTexts($)).toEqual(both('⇢ handed off 0:00 ago · auto-handoff-mod.md · arms on your next turn'))

  await turn($, 't2')
  expect(await bandTexts($)).toEqual(both('⇢ handoff in 55:00 · /handoff (built-in) · last auto-handoff-mod.md'))
})

test('band: a running turn, paused, and an expired cache', SLOW, async ($, on) => {
  const { clock } = setup(on)
  await start($)
  await turn($, 't1')
  await $.turn.start({ text: 'more', turnId: 't2' })
  for (const surface of SURFACES) {
    const ui = await band($, surface)
    const row = await ui.find({ type: 'Text', text: '⇢ handoff after' })
    expect(row?.text).toBe('⇢ handoff after 55:00 idle · /handoff (built-in)')
    expect(row?.props).toMatchObject({ dimColor: true })
    await ui.unmount()
  }
  await $.turn.complete({ answer: 'Done.', durationMs: 10, isAborted: false, turnId: 't2', reason: 'answer' })
  // the prompt's own isWorking counts as a running turn
  expect(await bandTexts($, { isWorking: true })).toEqual(both('⇢ handoff after 55:00 idle · /handoff (built-in)'))

  await command($, 'off')
  expect(await bandTexts($)).toEqual(both('⇢ handoff paused · /auto-handoff on'))
  await clock.advance(61 * MIN)
  await command($, 'on')
  await clock.advance(2_000)
  expect(await bandTexts($)).toEqual(both('⇢ cache expired, no handoff · arms on your next turn'))
})

test('band: fits its width, dropping segments, then the button, then cutting the text', async ($, on) => {
  setup(on, { commands: ALL })
  await start($)
  await turn($, 't1')
  for (const surface of SURFACES) {
    for (const [columns, text, hasButton] of [
      [120, '⇢ handoff in 55:00 · /handoff (built-in)', true],
      [40, '⇢ handoff in 55:00', true],
      [30, '⇢ handoff in 55:00', false],
      [12, '⇢ handoff i…', false],
    ] as const) {
      const ui = await band($, surface, { bodyColumns: columns })
      expect((await ui.find({ key: 'band' }))?.text).toBe(text)
      expect((await ui.find({ key: 'open' })) !== undefined).toBe(hasButton)
      expect(text.length).toBeLessThanOrEqual(columns - (hasButton ? 14 : 0))
      await ui.unmount()
    }
  }
})

test('band: another plugin drawing beneath keeps its row, under this one', async ($, on) => {
  engine(on)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box key="below">
        <Text>cache warm</Text>
      </Box>
    )
  })
  await start($)
  for (const surface of SURFACES) {
    // nothing to say: the row beneath alone
    const ui = await band($, surface)
    expect(await ui.find({ key: 'band' })).toBeUndefined()
    expect((await ui.find({ key: 'below' }))?.text).toBe('cache warm')
    await ui.unmount()
  }
  await turn($, 't1')
  for (const surface of SURFACES) {
    const ui = await band($, surface)
    const tree = await ui.drawn()
    expect(tree).toMatchObject({ type: 'Box', props: { flexDirection: 'column' } })
    const found = await ui.findAll({ type: 'Text' })
    expect(found.map(t => t.text)).toEqual(['⇢ handoff in 55:00 · /handoff (built-in)', 'cache warm'])
    await ui.unmount()
  }
})

test('band: details opens the pane', async ($, on) => {
  const { opened } = setup(on)
  await start($)
  await turn($, 't1')
  for (const surface of SURFACES) {
    const ui = await band($, surface)
    const button = await ui.find({ key: 'open' })
    expect(button?.text).toBe('details')
    expect(button?.props.hotkey).toBe('h')
    await ui.press({ key: 'open' })
    await ui.unmount()
  }
  expect(opened).toEqual([OPENED, OPENED])
})

// --- pane ---------------------------------------------------------------------

test('pane: the timeline counts to the warning, the handoff and the expiry', SLOW, async ($, on) => {
  const { clock } = setup(on)
  await start($)
  await onPane($, async ui => {
    expect(await lineText(ui, 'state')).toContain('no request yet in this conversation')
    expect(await ui.find({ type: 'Text', text: 'No request yet in this conversation.' })).toBeDefined()
  })

  await turn($, 't1')
  await clock.advance(10 * MIN)
  await onPane($, async ui => {
    expect(await lineText(ui, 'state')).toContain('armed; fires once per idle period')
    expect(await ui.find({ type: 'Text', text: '10:00 of 1:00:00' })).toBeDefined()
    expect((await ui.find({ key: 't-last request' }))?.text).toContain('10:00 ago')
    const warning = await ui.find({ key: 't-warning' })
    expect(warning?.text).toContain('in 44:00')
    expect(warning?.text).toContain('at 54:00 idle')
    expect((await ui.find({ type: 'Text', text: 'in 44:00' }))?.props.bold).toBe(true)
    expect((await ui.find({ type: 'Text', text: 'in 45:00' }))?.props.bold ?? false).toBe(false)
    expect((await ui.find({ key: 't-cache expires' }))?.text).toContain('in 50:00')
  })

  await clock.advance(44 * MIN + 30_000)
  await onPane($, async ui => {
    expect((await ui.find({ key: 't-warning' }))?.text).toContain('passed')
    expect((await ui.find({ type: 'Text', text: 'in 0:30' }))?.props.bold).toBe(true)
  })

  await clock.advance(MIN)
  await turn($, 'handoff', DOC)
  await onPane($, async ui => {
    expect(await lineText(ui, 'state')).toContain('handed off; arms on your next turn')
    expect((await ui.find({ key: 't-last' }))?.text).toContain(PATH)
  })
})

test('pane: a configured /ce-handoff, what it runs and why', { options: { handoffCommand: 'ce-handoff' } }, async ($, on) => {
  setup(on, { commands: ALL })
  await start($)
  await onPane($, async ui => {
    expect(await lineText(ui, 'c-setting')).toContain('ce-handoff')
    expect(await lineText(ui, 'c-runs')).toContain(`/${CE} create`)
    expect(await lineText(ui, 'c-why')).toContain(`set in /config, found as ${CE}; ce-handoff takes "create"`)
    expect(await lineText(ui, 'c-installed')).toContain(`/${CE}, /mattpocock-skills:handoff, built-in /${BUILTIN}`)
  })
  await turn($, 't1')
  expect(await bandTexts($)).toEqual(both('⇢ handoff in 55:00 · /ce-handoff create'))
})

test('pane: a configured command that is not installed falls back to the built-in', { options: { handoffCommand: 'ce-handoff' } }, async ($, on) => {
  setup(on)
  await start($)
  await onPane($, async ui => {
    expect(await lineText(ui, 'c-runs')).toContain(`/${BUILTIN}`)
    expect(await lineText(ui, 'c-why')).toContain('/ce-handoff is not installed in this session; the built-in runs instead')
    expect(await lineText(ui, 'c-installed')).toContain(`built-in /${BUILTIN}`)
  })
  await turn($, 't1')
  expect(await bandTexts($)).toEqual(both('⇢ handoff in 55:00 · /handoff (built-in, ce-handoff missing)'))
})

test('pane: an empty setting runs the built-in', async ($, on) => {
  setup(on)
  await start($)
  await onPane($, async ui => {
    expect(await lineText(ui, 'c-setting')).toContain('(empty)')
    expect(await lineText(ui, 'c-runs')).toContain(`/${BUILTIN}`)
    expect(await lineText(ui, 'c-why')).toContain('Handoff command is empty, so the built-in runs')
  })
})

test('pane: with no handoff command loaded, no Hand off now button', async ($, on) => {
  setup(on, { commands: ['compact'] })
  await start($)
  await onPane($, async ui => {
    expect(await lineText(ui, 'c-runs')).toContain('nothing')
    expect(await lineText(ui, 'c-why')).toContain(`the built-in /${BUILTIN} is not loaded`)
    expect(await ui.find({ key: 'now' })).toBeUndefined()
  })
})

for (const surface of SURFACES) {
  test(`pane (${surface}): pause, resume, hand off now and close`, async ($, on) => {
    const { clock, ran, toasts, closed } = setup(on)
    await start($)
    await turn($, 't1')
    const ui = await pane($, surface)
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.map(b => [b.key, b.text, b.props.hotkey])).toEqual([
      ['now', 'Hand off now', 'n'],
      ['pause', 'Pause', 'p'],
      ['close', 'Close', 'x'],
    ])

    await ui.press({ key: 'pause' })
    expect(toasts).toContain('Paused for this session.')
    expect((await ui.find({ key: 'pause' }))?.text).toBe('Resume')
    expect(await lineText(ui, 'state')).toContain('paused for this session')
    await ui.press({ key: 'pause' })
    expect(toasts).toContain('Resumed for this session.')
    expect((await ui.find({ key: 'pause' }))?.text).toBe('Pause')

    await ui.press({ key: 'now' })
    await clock.settle()
    expect(ran).toEqual([{ command: BUILTIN, args: '' }])
    expect(toasts).toContain(`Running /${BUILTIN}`)
    // queued: no second handoff from the pane
    expect(await ui.find({ key: 'now' })).toBeUndefined()
    expect(await lineText(ui, 'state')).toContain('handoff queued or running')

    await ui.press({ key: 'close' })
    expect(closed).toEqual(['auto-handoff'])
    await ui.unmount()
  })

  test(`pane (${surface}): pick command asks which handoff command to run`, async ($, on) => {
    const { clock, asks, saved, toasts } = setup(on, { commands: ALL, answer: `/${CE}` })
    await start($)
    const ui = await pane($, surface)
    expect((await ui.find({ key: 'pick' }))?.props.hotkey).toBe('s')
    await ui.press({ key: 'pick' })
    await clock.settle()
    expect(asks.length).toBe(1)
    expect(saved).toEqual([{ key: KEY, value: CE }])
    expect(toasts).toContain(`Handoff command set to /${CE}. Change it in /config or with /auto-handoff setup.`)
    await ui.unmount()
  })

  test(`pane (${surface}): copies the path and the resume prompt on its own surface`, async ($, on) => {
    const { clock, copied, toasts } = setup(on)
    await start($)
    await turn($, 't1')
    await handOff($, clock)
    const ui = await pane($, surface)
    expect((await ui.find({ key: 'copy-path' }))?.props.hotkey).toBe('c')
    expect((await ui.find({ key: 'copy-resume' }))?.props.hotkey).toBe('r')
    await ui.press({ key: 'copy-path' })
    await ui.press({ key: 'copy-resume' })
    expect(copied).toEqual([
      { text: PATH, surface },
      { text: `Read ${PATH} and continue from it.`, surface },
    ])
    expect(toasts).toContain('Copied the handoff path.')
    expect(toasts).toContain('Copied the resume prompt.')
    await ui.unmount()
  })

  test(`pane (${surface}): a copy that fails shows the text in the toast`, async ($, on) => {
    const { clock, toasts } = setup(on, { copy: { isCopied: false, reason: 'no-clipboard' } })
    await start($)
    await turn($, 't1')
    await handOff($, clock)
    const ui = await pane($, surface)
    await ui.press({ key: 'copy-path' })
    expect(toasts).toContain(`Could not copy (no-clipboard). The handoff path: ${PATH}`)
    await ui.unmount()
  })
}

// --- the command ---------------------------------------------------------------

test('/auto-handoff with no argument opens the pane; status gives the text', async ($, on) => {
  const { opened } = setup(on)
  await start($)
  expect((await command($, '')).text).toBe('Opened the auto-handoff pane.')
  expect(opened).toEqual([OPENED])
  const status = await command($, 'status')
  expect(status.text).toContain(`On · runs the built-in /${BUILTIN} at 55:00 idle`)
  expect(opened.length).toBe(1)
})

test('/auto-handoff with no argument gives the text when the pane waits undrawn', async ($, on) => {
  const { opened } = setup(on, { open: { isPlaced: false, reason: 'the terminal is 80 columns wide' } })
  await start($)
  expect((await command($, '')).text).toContain(`On · runs the built-in /${BUILTIN} at 55:00 idle`)
  expect(opened.length).toBe(1)
})

test('/auto-handoff with no argument gives the text in a -p run', async ($, on) => {
  const { opened } = setup(on)
  await start($, false)
  expect((await command($, '')).text).toContain(`On · runs the built-in /${BUILTIN} at 55:00 idle`)
  expect(opened.length).toBe(0)
})
