/**
 * auto-handoff: writes a handoff by itself shortly before the prompt cache of
 * an idle session expires, so the handoff is written while the cache is
 * still warm.
 *
 *   - `turn.step` (main loop) records when each request started: the cache's
 *     lifetime counts from there.
 *   - `turn.start` arms the trigger for every turn the mod did not start; the
 *     turn its own command starts is the handoff turn.
 *   - a one-second `clock.every` warns a minute ahead, then runs the handoff
 *     command with `$.command.run`, which the engine queues until the session
 *     is idle: the configured command when installed, else the bundled
 *     `/auto-handoff:handoff` skill.
 *   - `turn.complete` of the handoff turn reports where the handoff landed;
 *     the first other one offers the installed handoff commands, once. The
 *     built-in skill writes no file: the mod saves its answer with `$.fs`.
 *   - `classic.PermissionRequest` declines every call that would wait for
 *     approval while a handoff turn the mod started runs. It never approves.
 *   - a band row above the prompt shows the countdown; `/auto-handoff` opens
 *     a pane with the timeline, which command runs and why, and buttons.
 *
 * Everything that must survive a hot reload is in `$.state`.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderSurface, Timer, UiOpenResult, UiPressArgument } from 'claude-code'

import type { HandoffRecord } from '../types'
import { askOptions, builtinOf, candidates, clean, configKey, interpret, invocation, QUESTION, resolve } from './lib/choice'
import type { Resolved } from './lib/choice'
import { documentOf, MAX_SUFFIX, pathFor, projectOf, stamp, topicOf } from './lib/document'
import { baseName, decide, fmtClock, handoffPath, policyOf } from './lib/schedule'
import type { Policy } from './lib/schedule'
import { bandSegments, bar, cmdLabel, fitRow, lastLine, pack, phaseOf, resumePrompt, runsOf, stateText, timeline, why } from './lib/view'
import type { View } from './lib/view'

// a queued handoff whose turn never started (the command failed quietly) stops blocking after this
const STUCK_MS = 10 * 60_000
const PANE = 'auto-handoff'
// the band's `details` button: its cells on the terminal, and the narrowest band that still draws it
const BUTTON_COLS = 14
const BUTTON_MIN = 40
// the pane's label column
const LABEL = 15
const WHEN = 12

const lastRequestAt = atom({ plugin: 'auto-handoff', key: 'lastRequestAt' } as const, null)
const armed = atom({ plugin: 'auto-handoff', key: 'armed' } as const, false)
const paused = atom({ plugin: 'auto-handoff', key: 'paused' } as const, false)
const warnedFor = atom({ plugin: 'auto-handoff', key: 'warnedFor' } as const, null)
const pendingSince = atom({ plugin: 'auto-handoff', key: 'pendingSince' } as const, null)
const handoffTurnId = atom({ plugin: 'auto-handoff', key: 'handoffTurnId' } as const, null)
const turnRunning = atom({ plugin: 'auto-handoff', key: 'turnRunning' } as const, false)
const last = atom({ plugin: 'auto-handoff', key: 'last' } as const, null)
const asked = atom({ plugin: 'auto-handoff', key: 'asked' } as const, false)
const NOT_A_DOCUMENT = 'the answer was not a handoff document'
const saveSince = atom({ plugin: 'auto-handoff', key: 'saveSince' } as const, null)
const saveTurnId = atom({ plugin: 'auto-handoff', key: 'saveTurnId' } as const, null)
const declined = atom({ plugin: 'auto-handoff', key: 'declined' } as const, 0)
const handoffAgents = atom({ plugin: 'auto-handoff', key: 'handoffAgents' } as const, [])

// what the model reads when a call in the handoff turn is declined
const DECLINE =
  'auto-handoff declined this call: the handoff runs unattended, so nothing in it waits for approval. ' +
  'Do not retry this call or reach the same goal with another tool. ' +
  'If you cannot write the handoff file, make your final message the complete handoff document in Markdown, ' +
  'starting with its YAML frontmatter; auto-handoff saves it under ~/.claude/handoffs.'

type Config = { policy: Policy; handoffCommand: string; enabled: boolean; showBand: boolean }
type ButtonSpec = { key: string; label: string; hotkey: string; onPress: (press: UiPressArgument) => void }

// module variables start over on a reload; what must survive is in $.state
let timer: Timer | undefined
let ticking = false
// the status text last shown, so the one-second tick writes it only on a change
let shown: string | undefined
// a person is at the prompt (false under -p and the SDK): only then is the question asked
let interactive = false

function status($: EngineInterface, text: string | undefined) {
  if (text === shown) return
  shown = text
  $.ui.status(text)
}

async function resolved($: EngineInterface, { handoffCommand }: Config): Promise<Resolved> {
  const names = (await $.command.list()).map(c => c.name)
  return resolve(names, handoffCommand, $.plugin.name)
}

/** What runs now, for the status reply and the question's outcome. */
function runsText(r: Resolved): string {
  switch (r.kind) {
    case 'configured':
      return invocation(r.command, r.args)
    case 'builtin':
      return `the built-in /${r.command}`
    case 'fallback':
      return `the built-in /${r.command} (/${r.missing} is not installed)`
    case 'none':
      return 'nothing (no handoff command is loaded)'
  }
}

// Queues the handoff command. Answers what happened, for a toast.
async function fire($: EngineInterface, cfg: Config): Promise<string> {
  await update($, armed, () => false)
  const r = await resolved($, cfg)
  if (r.kind === 'none') {
    return r.missing
      ? `No handoff command available: /${r.missing} is not installed and /${r.builtin} is not loaded. Nothing ran.`
      : `No handoff command available: /${r.builtin} is not loaded. Nothing ran.`
  }
  const queuedAt = await $.clock.now()
  await update($, pendingSince, () => queuedAt)
  if (r.command === builtinOf($.plugin.name)) await update($, saveSince, () => queuedAt)
  status($, `writing handoff (/${r.command})`)
  try {
    await $.command.run({ command: r.command, args: r.args })
  } catch (err) {
    // the command never queued: no turn will claim pendingSince or saveSince, so release them here
    await update($, pendingSince, () => null)
    await update($, saveSince, () => null)
    status($, undefined)
    return `/${r.command} did not run: ${err instanceof Error ? err.message : String(err)}`
  }
  return r.kind === 'fallback'
    ? `/${r.missing} is not installed in this session; running the built-in /${r.command} instead`
    : `Running ${invocation(r.command, r.args)}`
}

async function tick($: EngineInterface, cfg: Config) {
  const { policy, enabled } = cfg
  if (ticking) return
  ticking = true
  try {
    const now = await $.clock.now()
    const since = await read($, pendingSince)
    if (since !== null && now - since > STUCK_MS) {
      await update($, pendingSince, () => null)
      status($, undefined)
    }
    // a /auto-handoff:handoff that started no turn must not make a later turn's answer a handoff
    const saving = await read($, saveSince)
    if (saving !== null && now - saving > STUCK_MS) await update($, saveSince, () => null)
    const snap = {
      now,
      lastRequestAt: await read($, lastRequestAt),
      armed: await read($, armed),
      paused: !enabled || (await read($, paused)),
      pending: since !== null,
      turnRunning: await read($, turnRunning),
      warnedFor: await read($, warnedFor),
    }
    const d = decide(snap, policy)
    switch (d.kind) {
      case 'warn':
        await update($, warnedFor, () => snap.lastRequestAt)
        $.ui.toast(
          `Handoff in ${fmtClock(d.fireInMs)}: the prompt cache expires in ${fmtClock(d.fireInMs + policy.leadMs)}. Send a message to keep working, or /auto-handoff off to skip.`,
        )
        status($, `handoff in ${fmtClock(d.fireInMs)}`)
        break
      case 'countdown':
        status($, `handoff in ${fmtClock(d.fireInMs)}`)
        break
      case 'fire':
        $.ui.toast(await fire($, cfg))
        break
      case 'expired':
        await update($, armed, () => false)
        status($, undefined)
        $.ui.toast('Handoff skipped: the prompt cache had already expired, so a handoff now would send the whole context again.')
        break
    }
    // the band and the pane count down: redraw them each second while there is a time to show
    if (snap.lastRequestAt !== null || (await read($, last)) !== null) $.ui.invalidate('ui.render')
  } finally {
    ticking = false
  }
}

// Asks which handoff command to run and saves the answer in /config.
// Answers what happened, for a toast, or null when no other handoff command is installed.
async function choose($: EngineInterface, cfg: Config): Promise<string | null> {
  const commands = await $.command.list()
  const offered = candidates(commands, $.plugin.name)
  if (offered.length === 0) return null
  const names = commands.map(c => c.name)
  const current = runsText(resolve(names, cfg.handoffCommand, $.plugin.name))
  let answer: string
  try {
    answer = await $.ui.ask(QUESTION, { header: 'Handoff', options: askOptions(offered) })
  } catch {
    // dismissed, or nobody to ask
    return `No handoff command chosen: auto-handoff runs ${current}. /auto-handoff setup asks again.`
  }
  const choice = interpret(answer, names, $.plugin.name)
  if (choice.kind === 'dismissed') return `No handoff command chosen: auto-handoff runs ${current}. /auto-handoff setup asks again.`
  if (choice.kind === 'unknown') return `/${choice.typed} is not installed in this session; nothing saved. auto-handoff runs ${current}.`
  const builtin = builtinOf($.plugin.name)
  const command = choice.kind === 'command' ? choice.command : names.includes(builtin) ? builtin : null
  if (!command) return `The built-in handoff skill is not loaded; nothing saved. auto-handoff runs ${current}.`
  let denied: string | undefined
  try {
    const key = configKey(await $.config.list(), $.plugin.name)
    if (!key) denied = 'no /config row for handoffCommand'
    else denied = (await $.config.set({ key, value: command })).deny
  } catch (err) {
    denied = err instanceof Error ? err.message : String(err)
  }
  if (denied !== undefined) return `Could not save the handoff command (${denied}). auto-handoff runs ${current}.`
  return choice.kind === 'builtin'
    ? `Handoff command set to the built-in /${command}. Change it in /config or with /auto-handoff setup.`
    : `Handoff command set to /${command}. Change it in /config or with /auto-handoff setup.`
}

async function offer($: EngineInterface, cfg: Config) {
  const text = await choose($, cfg)
  if (text) $.ui.toast(text)
}

async function describe($: EngineInterface, cfg: Config): Promise<string> {
  const { policy, enabled } = cfg
  const now = await $.clock.now()
  const at = await read($, lastRequestAt)
  const isArmed = await read($, armed)
  const isPaused = await read($, paused)
  const fireAt = policy.cacheMs - policy.leadMs
  const state = !enabled ? 'Off (plugin option)' : isPaused ? 'Paused for this session' : 'On'
  const lines = [
    `${state} · runs ${runsText(await resolved($, cfg))} at ${fmtClock(fireAt)} idle (cache lifetime ${fmtClock(policy.cacheMs)})`,
  ]
  if (at === null) lines.push('No request yet in this conversation.')
  else {
    const idle = now - at
    const when = !isArmed
      ? 'waits for your next turn'
      : idle >= policy.cacheMs
        ? 'cache already expired'
        : idle >= fireAt
          ? 'due now'
          : `fires in ${fmtClock(fireAt - idle)}`
    lines.push(`Idle ${fmtClock(idle)} since the last request; ${when}.`)
  }
  const record = await read($, last)
  if (record) {
    const ago = fmtClock(now - record.at)
    lines.push(
      record.ok
        ? `Last handoff ${ago} ago: ${record.path ?? 'path not found in the answer'}`
        : record.problem
          ? `Last handoff ${ago} ago: ${record.problem}.`
          : `Last handoff ${ago} ago did not finish.`,
    )
  }
  return lines.join('\n')
}

// --- saving the handoff -------------------------------------------------------

type Saved = { path: string } | { problem: string }

// Saves a handoff document as <home>/.claude/handoffs/<project>/<topic>.md, never over an existing file.
async function save($: EngineInterface, doc: string): Promise<Saved> {
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  if (!home) return { problem: 'not saved: neither HOME nor USERPROFILE is set' }
  try {
    const project = projectOf(await $.session.cwd())
    const topic = topicOf(doc)
    const iso = new Date(await $.clock.now()).toISOString()
    for (let n = 1; n <= MAX_SUFFIX; n++) {
      const path = pathFor(home, project, topic, n)
      if (await $.fs.exists(path)) continue
      await $.fs.write(path, stamp(doc, iso))
      return { path }
    }
    return { problem: `not saved: ${topic}.md to ${topic}-${MAX_SUFFIX}.md all exist` }
  } catch (err) {
    // the caller records the reason in `last` and toasts it; the document stays in the transcript
    return { problem: `not saved: ${err instanceof Error ? err.message : String(err)}` }
  }
}

const declinedNote = (n: number) => (n === 0 ? '' : ` (${n} permission prompt${n === 1 ? '' : 's'} declined)`)

// What the handoff turn left: the file the mod saved, or the path its answer names.
async function settle($: EngineInterface, answer: string, isSave: boolean, denials: number): Promise<HandoffRecord> {
  const at = await $.clock.now()
  // the built-in's answer is the document; another skill's is when it could not write its file
  const doc = isSave || denials > 0 ? documentOf(answer) : null
  if (doc) {
    const saved = await save($, doc)
    if ('path' in saved) return { at, path: saved.path, ok: true }
    return { at, path: null, ok: false, problem: saved.problem }
  }
  if (isSave) return { at, path: null, ok: false, problem: NOT_A_DOCUMENT }
  return { at, path: handoffPath(answer), ok: true }
}

// --- band and pane -----------------------------------------------------------

async function viewOf($: EngineInterface, cfg: Config): Promise<View> {
  return {
    now: await $.clock.now(),
    lastRequestAt: await read($, lastRequestAt),
    armed: await read($, armed),
    paused: await read($, paused),
    enabled: cfg.enabled,
    pending: (await read($, pendingSince)) !== null || (await read($, handoffTurnId)) !== null || (await read($, saveTurnId)) !== null,
    turnRunning: await read($, turnRunning),
    last: await read($, last),
  }
}

async function openPane($: EngineInterface): Promise<UiOpenResult> {
  try {
    return await $.ui.open({ id: PANE, title: 'auto-handoff', focus: true })
  } catch (err) {
    // the caller answers with the status text instead
    return { isPlaced: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

async function closePane($: EngineInterface) {
  // already closed: nothing to do
  await $.ui.close({ id: PANE }).catch(() => undefined)
}

async function setPaused($: EngineInterface, value: boolean) {
  await update($, paused, () => value)
  if (value) status($, undefined)
}

async function togglePause($: EngineInterface) {
  const isPaused = await read($, paused)
  await setPaused($, !isPaused)
  $.ui.toast(isPaused ? 'Resumed for this session.' : 'Paused for this session.')
}

// $.command.run from a command hook or a press would wait on the caller: run it from a timer
function handOffNow($: EngineInterface, cfg: Config) {
  $.clock.after(0, () => void fire($, cfg).then(text => $.ui.toast(text)))
}

// the question waits on the person: ask it from a timer
async function pick($: EngineInterface, cfg: Config) {
  await update($, asked, () => true)
  $.clock.after(0, () => void offer($, cfg))
}

async function copyText($: EngineInterface, text: string, surface: RenderSurface, what: string) {
  let reason: string | undefined
  try {
    const r = await $.ui.copy({ text, surface })
    if (!r.isCopied) reason = r.reason
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err)
  }
  // a failed copy still hands the person the text, in the toast
  $.ui.toast(reason === undefined ? `Copied the ${what}.` : `Could not copy (${reason}). The ${what}: ${text}`)
}

// a pass with nothing beneath resolves to an empty element
const isEmpty = (tree: RenderElement | undefined) =>
  !tree || ((tree.type === 'Box' || tree.type === 'Text') && !(tree.children && tree.children.length > 0))

export const register: Register = (on, options) => {
  const cfg: Config = {
    policy: policyOf(options),
    handoffCommand: clean(options.handoffCommand),
    enabled: options.enabled !== false,
    showBand: options.showBand !== false,
  }
  const { enabled } = cfg

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    interactive = e.isInteractive
    // a reload starts between turns; a turn left marked running would block the trigger
    await update($, turnRunning, () => false)
    shown = undefined
    await $.command
      .register({
        name: 'auto-handoff',
        description: 'Auto handoff before the prompt cache expires: no argument opens the pane; status, on, off (this session), now, setup (pick the handoff command)',
        argumentHint: '[status|on|off|now|setup]',
        immediate: true,
      })
      .catch(err => $.ui.log(`/auto-handoff not registered: ${err}`))
    timer?.cancel()
    timer = $.clock.every(1000, () => void tick($, cfg))
    return r
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      // /clear starts a new conversation (and a new cache) in the same process; the timer keeps running
      await update($, lastRequestAt, () => null)
      await update($, armed, () => false)
      await update($, warnedFor, () => null)
      await update($, pendingSince, () => null)
      await update($, handoffTurnId, () => null)
      await update($, turnRunning, () => false)
      await update($, saveSince, () => null)
      await update($, saveTurnId, () => null)
      await update($, declined, () => 0)
      await update($, handoffAgents, () => [])
      status($, undefined)
      return next(e)
    }
    timer?.cancel()
    timer = undefined
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    await update($, turnRunning, () => true)
    const isSave = (await read($, saveSince)) !== null
    if (isSave) {
      await update($, saveSince, () => null)
      await update($, saveTurnId, () => e.turnId)
    }
    if ((await read($, pendingSince)) !== null) {
      await update($, pendingSince, () => null)
      await update($, handoffTurnId, () => e.turnId)
      await update($, declined, () => 0)
      await update($, handoffAgents, () => [])
    } else if (isSave) {
      // a handoff the person ran: the next one waits for a turn of theirs
      await update($, armed, () => false)
      status($, undefined)
    } else {
      await update($, armed, () => true)
      status($, undefined)
    }
    return r
  })

  // each main-loop request refreshes the cache from the moment it starts
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const startedAt = await $.clock.now()
    const r = yield* next(e)
    if (r.usage) await update($, lastRequestAt, () => startedAt)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    await update($, turnRunning, () => false)
    const isSave = e.turnId === (await read($, saveTurnId))
    if (!isSave && e.turnId !== (await read($, handoffTurnId))) {
      // the first finished turn of a session with no command chosen offers the installed ones, once
      if (interactive && !cfg.handoffCommand && !(await read($, asked))) {
        await update($, asked, () => true)
        // the question waits on the person: ask it from a timer, not from this hook
        $.clock.after(0, () => void offer($, cfg))
      }
      return r
    }
    const denials = await read($, declined)
    await update($, handoffTurnId, () => null)
    await update($, saveTurnId, () => null)
    await update($, declined, () => 0)
    await update($, handoffAgents, () => [])
    const note = declinedNote(denials)
    if (e.isAborted || e.reason !== 'answer') {
      const ended: HandoffRecord = { at: await $.clock.now(), path: null, ok: false }
      await update($, last, () => ended)
      status($, undefined)
      $.ui.toast(`The handoff turn ended (${e.reason}) before writing a handoff.${note}`)
      return r
    }
    const record = await settle($, e.answer, isSave, denials)
    await update($, last, () => record)
    if (!record.ok) {
      status($, undefined)
      $.ui.toast(
        record.problem === NOT_A_DOCUMENT
          ? `The handoff answer was not a handoff document, so nothing was saved; it is in the transcript.${note}`
          : `Could not save the handoff (${record.problem}). The document is in the transcript.${note}`,
      )
    } else if (record.path) {
      status($, `handoff: ${baseName(record.path)}`)
      $.ui.toast(`${isSave || denials > 0 ? 'Handoff saved to' : 'Handoff written to'} ${record.path}${note}`)
    } else {
      status($, 'handoff written')
      $.ui.toast(`Handoff turn finished; its answer says where the handoff is.${note}`)
    }
    return r
  })

  // the built-in's turn, whoever ran it, ends in a document the mod saves
  on('command.run', { command: 'auto-handoff:handoff' }, async ($, e, next) => {
    const ranAt = await $.clock.now()
    await update($, saveSince, () => ranAt)
    try {
      return await next(e)
    } catch (err) {
      // it did not run: no turn will claim saveSince
      await update($, saveSince, () => null)
      throw err
    }
  })

  // a handoff the mod started never waits for approval: it declines the prompt, never approves
  on('classic.PermissionRequest', async ($, e, next) => {
    const r = await next(e)
    // a settings hook beneath decided: no prompt would open
    if (r.decision || (await read($, handoffTurnId)) === null) return r
    if (e.agent_id && !(await read($, handoffAgents)).includes(e.agent_id)) return r
    const before = await read($, declined)
    await update($, declined, n => n + 1)
    if (before === 0) $.ui.toast(`Declined ${e.tool_name} during the handoff instead of waiting for approval.`)
    return { ...r, decision: { behavior: 'deny', message: DECLINE } }
  })

  // a subagent the handoff turn starts is part of it
  on('classic.SubagentStart', async ($, e, next) => {
    if ((await read($, handoffTurnId)) !== null) await update($, handoffAgents, ids => [...ids, e.agent_id])
    return next(e)
  })

  on('command.run', { command: 'auto-handoff' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      await setPaused($, true)
      return { text: 'Paused for this session. /auto-handoff on resumes it.' }
    }
    if (arg === 'on') {
      await setPaused($, false)
      return { text: enabled ? 'On for this session.' : 'Resumed, but the plugin option "Auto handoff" is off: it fires only with /auto-handoff now.' }
    }
    if (arg === 'now') {
      const r = await resolved($, cfg)
      if (r.kind === 'none') return { text: `Nothing to run: /${r.builtin} is not loaded${r.missing ? ` and /${r.missing} is not installed` : ''}.` }
      handOffNow($, cfg)
      return { text: `Queuing ${invocation(r.command, r.args)}` }
    }
    if (arg === 'setup') {
      if (candidates(await $.command.list(), $.plugin.name).length === 0) {
        return { text: `No other handoff skill is installed; auto-handoff runs ${runsText(await resolved($, cfg))}.` }
      }
      await pick($, cfg)
      return { text: 'Opening the handoff command picker.' }
    }
    // with a person at the prompt, no argument opens the pane; -p and `status` get the text
    if (arg === '' && interactive) {
      const placed = await openPane($)
      if (placed.isPlaced) return { text: 'Opened the auto-handoff pane.' }
    }
    return { text: await describe($, cfg) }
  })

  // one row above the prompt: the countdown, the command, the last handoff
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!cfg.showBand || e.props.hasSurvey) return next(e)
    const v = await viewOf($, cfg)
    const phase = phaseOf({ ...v, turnRunning: v.turnRunning || e.props.isWorking }, cfg.policy)
    const seg = bandSegments(phase, cmdLabel(await resolved($, cfg)), v.last, cfg.policy)
    if (!seg) return next(e)
    // another plugin's band beneath this one keeps its place, under this row
    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const hasButton = columns >= BUTTON_MIN
    const text = fitRow('⇢ ', seg.parts, columns - (hasButton ? BUTTON_COLS : 0))
    const tone = seg.tone === 'warn' ? { color: 'yellow', bold: true } : seg.tone === 'dim' ? { dimColor: true } : {}
    // the key is on a Box: a Text keeps none
    const row = (
      <Box flexDirection="row" columnGap={1}>
        <Box key="band">
          <Text wrap="truncate-end" {...tone}>
            {text}
          </Text>
        </Box>
        {hasButton && <Button key="open" label="details" hotkey="h" onPress={() => void openPane($)} />}
      </Box>
    )
    if (isEmpty(below)) return row
    return (
      <Box flexDirection="column">
        {row}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const width = Math.max(30, e.props.bodyColumns - 1)
    const valueWidth = Math.max(10, width - LABEL)
    const v = await viewOf($, cfg)
    const phase = phaseOf(v, cfg.policy)
    const commands = await $.command.list()
    const names = commands.map(c => c.name)
    const r = resolve(names, cfg.handoffCommand, $.plugin.name)
    const offered = candidates(commands, $.plugin.name)
    const builtin = builtinOf($.plugin.name)
    const installed = [...offered.map(n => `/${n}`), ...(names.includes(builtin) ? [`built-in /${builtin}`] : [])]
    const rows = timeline(v, cfg.policy)
    const lastRow = lastLine(v)
    const path = v.last?.ok ? v.last.path : null
    const idle = v.lastRequestAt === null ? null : Math.max(0, v.now - v.lastRequestAt)
    const idleText = idle === null ? '' : `${fmtClock(idle)} of ${fmtClock(cfg.policy.cacheMs)} `
    const idleBar = idle === null ? null : bar(idle, cfg.policy, valueWidth - idleText.length - 1)

    const line = (key: string, label: string, value: string) => (
      <Box key={key} flexDirection="row">
        <Box width={LABEL} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        <Box width={valueWidth}>
          <Text>{value}</Text>
        </Box>
      </Box>
    )

    const buttons: ButtonSpec[] = []
    if (r.kind !== 'none' && !v.pending) buttons.push({ key: 'now', label: 'Hand off now', hotkey: 'n', onPress: () => handOffNow($, cfg) })
    buttons.push({ key: 'pause', label: v.paused ? 'Resume' : 'Pause', hotkey: 'p', onPress: () => void togglePause($) })
    if (offered.length > 0) buttons.push({ key: 'pick', label: 'Pick command', hotkey: 's', onPress: () => void pick($, cfg) })
    if (path) {
      buttons.push({ key: 'copy-path', label: 'Copy path', hotkey: 'c', onPress: press => void copyText($, path, press.surface, 'handoff path') })
      buttons.push({
        key: 'copy-resume',
        label: 'Copy resume prompt',
        hotkey: 'r',
        onPress: press => void copyText($, resumePrompt(path), press.surface, 'resume prompt'),
      })
    }
    buttons.push({ key: 'close', label: 'Close', hotkey: 'x', onPress: () => void closePane($) })

    return (
      <Box flexDirection="column" width={width}>
        {line('state', 'State', stateText(phase))}
        {idleBar && (
          <Box key="idle" flexDirection="row">
            <Box width={LABEL} flexShrink={0}>
              <Text dimColor>Idle</Text>
            </Box>
            <Text>{idleText}</Text>
            {idleBar.filled && <Text color="cyan">{idleBar.filled}</Text>}
            {idleBar.empty && <Text dimColor>{idleBar.empty}</Text>}
          </Box>
        )}
        <Text bold>Timeline</Text>
        {rows.length === 0 && <Text dimColor>No request yet in this conversation.</Text>}
        {rows.map(t => (
          <Box key={`t-${t.label}`} flexDirection="row">
            <Box width={LABEL} flexShrink={0}>
              <Text bold={t.isNext} dimColor={t.isPassed}>
                {t.label}
              </Text>
            </Box>
            <Box width={WHEN} flexShrink={0}>
              <Text bold={t.isNext} dimColor={t.isPassed}>
                {t.when}
              </Text>
            </Box>
            {t.at && <Text dimColor>{t.at}</Text>}
          </Box>
        ))}
        {lastRow && (
          <Box key="t-last" flexDirection="row">
            <Box width={LABEL} flexShrink={0}>
              <Text>last handoff</Text>
            </Box>
            <Box width={WHEN} flexShrink={0}>
              <Text>{lastRow.when}</Text>
            </Box>
            <Box width={Math.max(10, valueWidth - WHEN)}>
              <Text>{lastRow.what}</Text>
            </Box>
          </Box>
        )}
        <Text bold>Command</Text>
        {line('c-setting', 'setting', cfg.handoffCommand || '(empty)')}
        {line('c-runs', 'runs', runsOf(r))}
        {line('c-why', 'why', why(r, cfg.handoffCommand))}
        {line('c-installed', 'installed', installed.join(', ') || 'none')}
        {pack(buttons, width).map((group, i) => (
          <Box key={`buttons-${i}`} flexDirection="row" columnGap={1}>
            {group.map(b => (
              <Button key={b.key} label={b.label} hotkey={b.hotkey} onPress={b.onPress} />
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
