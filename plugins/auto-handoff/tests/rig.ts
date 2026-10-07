// The engine's answers the mod's tests share: a mocked clock and stand-ins
// for the commands, toasts, the question, /config, the pane calls, the
// environment, the files and the permission requests.
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PermissionRequestDecision, RenderSurface, UiCopyResult, UiOpenResult } from 'claude-code'

export const NOW = 1_760_000_000_000
export const MIN = 60_000
export const CWD = '/home/me/work'
// the timer runs every second: an hour of it is a few thousand ticks
export const SLOW = { timeoutMs: 60_000 }
export const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const
export const USAGE = {
  model: 'claude-opus-5-5',
  input_tokens: 10,
  output_tokens: 20,
  cache_read_input_tokens: 80_000,
  cache_creation_input_tokens: 500,
}
export const BUILTIN = 'auto-handoff:handoff'
export const CE = 'compound-engineering:ce-handoff'
export const MATT = 'mattpocock-skills:handoff'
export const ALONE = ['compact', BUILTIN]
export const ALL = ['compact', BUILTIN, CE, MATT]
export const HOME = '/home/me'
export const PATH = '/home/me/.claude/handoffs/work/auto-handoff-mod.md'
/** A skill's answer that names the file it wrote. */
export const ANSWER = `Captured the objective, the mod's files and the open questions.\n\n${PATH}`
/** The built-in skill's answer: the handoff document, saved as PATH. */
export const DOC = [
  '---',
  'topic: "auto-handoff-mod"',
  'title: "auto-handoff: save the handoff"',
  'cwd: "/home/me/work"',
  '---',
  '',
  '## Objective',
  '',
  'The handoff must never wait for a permission prompt.',
  '',
  '## State',
  '',
  'The save is implemented in hooks/register.tsx; the README still names the old allow rules.',
].join('\n')
/** The time NOW as the saved file's created_at. */
export const STAMP = `created_at: "${new Date(NOW).toISOString()}"`
/** A path as the fs stand-ins keep it: on Windows the engine hands `/home/me` on as `C:\home\me`. */
export const posix = (path: string) => path.replace(/^[A-Za-z]:(?=\\)/, '').replace(/\\/g, '/')
export const WARNING = 'Handoff in 1:00: the prompt cache expires in 6:00. Send a message to keep working, or /auto-handoff off to skip.'
export const KEY = 'auto-handoff.handoffCommand'

type Ran = { command: string; args: string }
type Setup = {
  commands?: readonly string[]
  /** The label or text the person picks; null dismisses the question. */
  answer?: string | null
  /** A reason config.set refuses with. */
  configDeny?: string
  /** What `$.ui.open` answers; placed by default. */
  open?: UiOpenResult
  /** What `$.ui.copy` answers; copied by default. */
  copy?: UiCopyResult
  /** The environment variables `$.env.get` reads; HOME by default. */
  env?: Readonly<Record<string, string>>
  /** Files that exist before the test. */
  existing?: readonly string[]
  /** A reason `$.fs.write` fails with. */
  writeFails?: string
  /** What a settings hook beneath decides on a permission request; nothing by default. */
  permission?: PermissionRequestDecision
}

const info = (name: string) =>
  name.includes(':')
    ? { name, description: '', source: 'plugin' as const, plugin: name.split(':')[0] }
    : { name, description: '', source: 'builtin' as const }

// Nothing sits beneath a test's hooks: these stand for the engine's own answers.
export const engine = (
  on: On,
  { commands = ALONE, answer = null, configDeny, open = { isPlaced: true }, copy = { isCopied: true }, env = { HOME }, existing = [], writeFails, permission }: Setup = {},
) => {
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const ran: Ran[] = []
  const asks: { question: string; labels: string[] }[] = []
  const saved: { key: string; value: unknown }[] = []
  const opened: { id: string; title?: string; focus?: boolean }[] = []
  const closed: string[] = []
  const copied: { text: string; surface?: RenderSurface }[] = []
  const files = new Map<string, string>(existing.map(path => [posix(path), '']))
  const written: string[] = []
  const permissions: { tool: string; decision?: PermissionRequestDecision }[] = []
  const clock = mock.clock(on, { now: NOW })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: commands.map(info) }))
  on('command.run', (_, e) => {
    ran.push({ command: e.command, args: e.args })
    return {}
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', (_, e) => {
    opened.push({ id: e.id, title: e.title, focus: e.focus })
    return { value: open }
  })
  on('ui.close', (_, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('ui.copy', (_, e) => {
    copied.push({ text: e.text, surface: e.surface })
    return { value: copy }
  })
  // $.ui.ask reaches the engine as a call to the AskUserQuestion tool
  on('tool.call', (_, e) => {
    if (e.tool !== 'AskUserQuestion') return { result: '' }
    const q = e.questions[0]!
    asks.push({ question: q.question, labels: q.options.map(o => o.label) })
    return answer === null ? { deny: 'dismissed' } : { result: { answers: { [q.question]: answer } } }
  })
  on('config.list', () => ({
    value: [
      { key: 'theme', label: 'Theme', kind: 'choice' as const, value: 'dark', provider: { plugin: 'engine', tier: 'core' as const }, isLocked: false },
      { key: KEY, label: 'Handoff command', kind: 'text' as const, value: '', provider: { plugin: 'auto-handoff', tier: 'user' as const }, isLocked: false },
    ],
  }))
  on('config.set', (_, e) => {
    saved.push({ key: e.key, value: e.value })
    return configDeny ? { deny: configDeny } : { value: e.value }
  })
  on('session.cwd', () => ({ value: CWD }))
  on('env.get', (_, e) => ({ value: env[e.name] }))
  on('fs.exists', (_, e) => ({ value: files.has(posix(e.path)) }))
  on('fs.write', (_, e) => {
    if (writeFails) return { deny: writeFails }
    files.set(posix(e.path), e.text)
    written.push(posix(e.path))
    return { value: undefined }
  })
  // a settings hook beneath: decides only when the test says so
  on('classic.PermissionRequest', (_, e) => {
    permissions.push({ tool: e.tool_name, decision: permission })
    return permission ? { decision: permission } : {}
  })
  on('classic.SubagentStart', () => ({}))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: USAGE }
  })
  return { clock, toasts, statuses, ran, asks, saved, opened, closed, copied, files, written, permissions }
}

export const start = ($: Engine, isInteractive = true) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive })

// A turn's start and its one model request; `finish` ends it.
export async function begin($: Engine, turnId: string) {
  await $.turn.start({ text: 'work on the mod', turnId })
  const stream = $.turn.step({ turnId, index: 0, model: USAGE.model, messageCount: 3 })
  for await (const _ of stream) void _
  await stream.result
}

export const finish = ($: Engine, turnId: string, answer = 'Done.') =>
  $.turn.complete({ answer, durationMs: 10, isAborted: false, turnId, reason: 'answer' })

// One turn with one model request, started and finished now.
export async function turn($: Engine, turnId: string, answer = 'Done.') {
  await begin($, turnId)
  await finish($, turnId, answer)
}

/** A call in the running turn that would open a permission prompt; `agentId` for a subagent's. */
export const ask = ($: Engine, tool: string, agentId?: string) =>
  $.classic.PermissionRequest({ tool_name: tool, tool_input: { file_path: PATH }, ...(agentId ? { agent_id: agentId } : {}) })

export const command = ($: Engine, args: string) => $.command.run({ command: 'auto-handoff', args, ...RUN })
