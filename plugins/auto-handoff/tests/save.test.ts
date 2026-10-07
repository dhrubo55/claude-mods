import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { ALL, ANSWER, ask, begin, BUILTIN, command, DOC, engine, finish, MIN, PATH, RUN, SLOW, STAMP, start, turn } from './rig'

const DECLINED = /^auto-handoff declined this call: .*make your final message the complete handoff document/s
const NOT_A_DOCUMENT = 'The handoff answer was not a handoff document, so nothing was saved; it is in the transcript.'

/** /auto-handoff now, then the start of the turn it queued. */
async function handoffTurn($: Engine, clock: { settle: () => Promise<void> }, id = 'h') {
  await command($, 'now')
  await clock.settle()
  await begin($, id)
}

type Decision = { behavior: string; message?: string; interrupt?: true } | undefined

// --- F9: the mod saves the built-in handoff ----------------------------------

test('the mod saves the built-in handoff under ~/.claude/handoffs, with created_at', async ($, on) => {
  const { clock, toasts, files, written } = engine(on)
  await start($)
  await turn($, 't1')
  await handoffTurn($, clock)
  await finish($, 'h', DOC)
  expect(written).toEqual([PATH])
  const text = files.get(PATH) ?? ''
  expect(text.split('\n').slice(0, 2)).toEqual(['---', STAMP])
  expect(text).toContain('topic: "auto-handoff-mod"')
  expect(text.endsWith('\n')).toBe(true)
  expect(toasts).toContain(`Handoff saved to ${PATH}`)
  expect((await command($, 'status')).text).toContain(`Last handoff 0:00 ago: ${PATH}`)
})

test('never overwrites a handoff: -2, then -3', async ($, on) => {
  const two = PATH.replace('.md', '-2.md')
  const three = PATH.replace('.md', '-3.md')
  const { clock, toasts, files, written } = engine(on, { existing: [PATH, two] })
  await start($)
  await turn($, 't1')
  await handoffTurn($, clock)
  await finish($, 'h', DOC)
  expect(written).toEqual([three])
  expect(files.get(PATH)).toBe('')
  expect(files.get(two)).toBe('')
  expect(toasts).toContain(`Handoff saved to ${three}`)
})

test('an answer that is not a handoff document saves nothing and says so', async ($, on) => {
  const { clock, toasts, written } = engine(on)
  await start($)
  await turn($, 't1')
  await handoffTurn($, clock)
  await finish($, 'h', 'I could not finish the handoff.')
  expect(written).toEqual([])
  expect(toasts).toContain(NOT_A_DOCUMENT)
  expect((await command($, 'status')).text).toContain('Last handoff 0:00 ago: the answer was not a handoff document.')
})

test('a failed write is reported with its reason', async ($, on) => {
  const { clock, toasts, written } = engine(on, { writeFails: 'EACCES: permission denied' })
  await start($)
  await turn($, 't1')
  await handoffTurn($, clock)
  await finish($, 'h', DOC)
  expect(written).toEqual([])
  const toast = toasts.find(t => t.startsWith('Could not save the handoff (not saved: '))
  expect(toast).toContain('EACCES: permission denied')
  expect(toast).toContain('The document is in the transcript.')
  expect((await command($, 'status')).text).toContain('EACCES: permission denied')
})

test('without HOME the file goes under USERPROFILE', async ($, on) => {
  const { clock, toasts, written } = engine(on, { env: { USERPROFILE: 'C:\\Users\\me' } })
  await start($)
  await turn($, 't1')
  await handoffTurn($, clock)
  await finish($, 'h', DOC)
  // the path the mod built; where it lands is the platform's to resolve
  expect(written.length).toBe(1)
  expect(toasts).toContain('Handoff saved to C:\\Users\\me\\.claude\\handoffs\\work\\auto-handoff-mod.md')
})

test('with neither HOME nor USERPROFILE nothing is saved', async ($, on) => {
  const { clock, toasts, written } = engine(on, { env: {} })
  await start($)
  await turn($, 't1')
  await handoffTurn($, clock)
  await finish($, 'h', DOC)
  expect(written).toEqual([])
  expect(toasts).toContain('Could not save the handoff (not saved: neither HOME nor USERPROFILE is set). The document is in the transcript.')
})

test('a /auto-handoff:handoff you run is saved, prompts in it open as usual, and it does not arm the trigger', SLOW, async ($, on) => {
  const { clock, ran, toasts, written } = engine(on)
  await start($)
  await turn($, 't1')
  await $.command.run({ command: BUILTIN, args: '', ...RUN })
  await begin($, 'mine')
  // you are at the prompt: the mod does not decline
  expect(((await ask($, 'Write')).decision as Decision)?.behavior).toBeUndefined()
  await finish($, 'mine', DOC)
  expect(written).toEqual([PATH])
  expect(toasts).toContain(`Handoff saved to ${PATH}`)
  // the handoff you ran counts: no second one from the mod
  await clock.advance(56 * MIN)
  expect(ran).toEqual([{ command: BUILTIN, args: '' }])
  // your next turn arms it again
  await turn($, 't2')
  await clock.advance(55 * MIN + 1_000)
  expect(ran.length).toBe(2)
})

test('a /auto-handoff:handoff that never started a turn stops marking turns after 10 minutes', SLOW, async ($, on) => {
  const { clock, toasts, written } = engine(on)
  await start($)
  await turn($, 't1')
  await $.command.run({ command: BUILTIN, args: '', ...RUN })
  await clock.advance(11 * MIN)
  await turn($, 't2', 'An ordinary answer.')
  expect(written).toEqual([])
  expect(toasts).not.toContain(NOT_A_DOCUMENT)
})

// --- F10: nothing waits for approval ----------------------------------------

test('a handoff the mod started declines permission prompts instead of waiting', async ($, on) => {
  const { clock, toasts, permissions } = engine(on)
  await start($)
  await turn($, 't1')
  // outside a handoff turn the prompt opens as usual
  expect((await ask($, 'Write')).decision).toBeUndefined()

  await handoffTurn($, clock)
  const d = (await ask($, 'Write')).decision as Decision
  expect(d?.behavior).toBe('deny')
  expect(d?.message).toMatch(DECLINED)
  // the model goes on and answers
  expect(d?.interrupt).toBeUndefined()
  expect(toasts).toContain('Declined Write during the handoff instead of waiting for approval.')

  // a subagent the handoff turn started is declined too; any other subagent is not
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'general-purpose' })
  expect(((await ask($, 'Bash', 'a1')).decision as Decision)?.behavior).toBe('deny')
  expect((await ask($, 'Bash', 'other')).decision).toBeUndefined()
  expect(toasts.filter(t => t.startsWith('Declined ')).length).toBe(1)
  // the settings hooks beneath were asked first every time
  expect(permissions.map(p => p.tool)).toEqual(['Write', 'Write', 'Bash', 'Bash'])

  await finish($, 'h', DOC)
  expect(toasts).toContain(`Handoff saved to ${PATH} (2 permission prompts declined)`)
  // after the turn, prompts open again
  expect((await ask($, 'Write')).decision).toBeUndefined()
})

test("a settings hook's decision stands during the handoff", async ($, on) => {
  const { clock, toasts } = engine(on, { permission: { behavior: 'deny', message: 'blocked by policy' } })
  await start($)
  await turn($, 't1')
  await handoffTurn($, clock)
  const d = (await ask($, 'Write')).decision as Decision
  expect(d?.message).toBe('blocked by policy')
  expect(toasts.some(t => t.startsWith('Declined '))).toBe(false)
})

test('another handoff skill: the mod saves its answer only when a call was declined', { options: { handoffCommand: 'ce-handoff' } }, async ($, on) => {
  const { clock, toasts, written } = engine(on, { commands: ALL })
  await start($)
  await turn($, 't1')
  // it wrote its own file and named it
  await handoffTurn($, clock, 'h1')
  await finish($, 'h1', ANSWER)
  expect(written).toEqual([])
  expect(toasts).toContain(`Handoff written to ${PATH}`)

  // its write was declined, and it answered with the document
  await handoffTurn($, clock, 'h2')
  await ask($, 'Write')
  await finish($, 'h2', DOC)
  expect(written).toEqual([PATH])
  expect(toasts).toContain(`Handoff saved to ${PATH} (1 permission prompt declined)`)
})
