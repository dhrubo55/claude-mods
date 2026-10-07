// Pure logic of which handoff command runs, which ones to offer, and what an
// answer to the question means. No `$` here, so tests call it directly.

export type CommandLike = { readonly name: string; readonly plugin?: string }

export type ConfigRowLike = { readonly key: string; readonly provider: { readonly plugin: string } }

/** What a fire runs, and why. */
export type Resolved =
  | { kind: 'configured'; command: string; args: string }
  | { kind: 'builtin'; command: string; args: string }
  | { kind: 'fallback'; command: string; args: string; missing: string }
  | { kind: 'none'; missing: string | null; builtin: string }

/** What an answer to the question means. */
export type Choice =
  | { kind: 'builtin' }
  | { kind: 'command'; command: string }
  | { kind: 'unknown'; typed: string }
  | { kind: 'dismissed' }

export const BUILTIN_LABEL = 'Built-in handoff'
export const QUESTION = 'Which handoff command should auto-handoff run before the prompt cache expires?'
/** `$.ui.ask` takes 2-4 labels: up to three commands, then the built-in. */
export const MAX_OFFERED = 3

const RANK = ['ce-handoff', 'handoff']

const lastSegment = (name: string) => name.slice(name.lastIndexOf(':') + 1)

/** The plugin's name without an `@<marketplace>` or `@inline` suffix. */
export const baseOf = (pluginName: string) => pluginName.split('@')[0]

/** The bundled skill's command: `<plugin>:handoff`. */
export const builtinOf = (pluginName: string) => `${baseOf(pluginName)}:handoff`

/** A configured or typed command name, without its slash. */
export const clean = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/^\/+/, '').trim() : '')

const isOwn = (c: CommandLike, pluginName: string) => {
  const base = baseOf(pluginName)
  return c.plugin === pluginName || c.plugin === base || c.name === base || c.name.startsWith(`${base}:`)
}

/**
 * The installed command for a name: the name itself, else a plugin's
 * `<plugin>:<name>`, another plugin's before this one's.
 */
export function findCommand(names: readonly string[], wanted: string, pluginName: string): string | undefined {
  if (!wanted) return undefined
  const own = `${baseOf(pluginName)}:`
  const suffixed = names.filter(n => n.endsWith(`:${wanted}`))
  return names.find(n => n === wanted) ?? suffixed.find(n => !n.startsWith(own)) ?? suffixed[0]
}

/** ce-handoff routes a bare call to create too; `create` says so explicitly. */
export const argsFor = (command: string) => (lastSegment(command) === 'ce-handoff' ? 'create' : '')

/** The command a fire runs: the configured one when installed, else the built-in skill. */
export function resolve(names: readonly string[], configured: unknown, pluginName: string): Resolved {
  const builtin = builtinOf(pluginName)
  const hasBuiltin = names.includes(builtin)
  const wanted = clean(configured)
  if (wanted) {
    const found = findCommand(names, wanted, pluginName)
    if (found === builtin) return { kind: 'builtin', command: builtin, args: '' }
    if (found) return { kind: 'configured', command: found, args: argsFor(found) }
    return hasBuiltin ? { kind: 'fallback', command: builtin, args: '', missing: wanted } : { kind: 'none', missing: wanted, builtin }
  }
  return hasBuiltin ? { kind: 'builtin', command: builtin, args: '' } : { kind: 'none', missing: null, builtin }
}

/** `/x create`, `/x`. */
export const invocation = (command: string, args: string) => `/${command} ${args}`.trimEnd()

/** The other installed handoff commands: last name segment ends in `handoff`; ce-handoff, handoff, then by name. */
export function candidates(commands: readonly CommandLike[], pluginName: string): string[] {
  const names = new Set<string>()
  for (const c of commands) if (!isOwn(c, pluginName) && /handoff$/i.test(lastSegment(c.name))) names.add(c.name)
  const rank = (n: string) => {
    const i = RANK.indexOf(lastSegment(n).toLowerCase())
    return i < 0 ? RANK.length : i
  }
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

/** The question's labels: the first three candidates as slash commands, then the built-in. */
export const askOptions = (offered: readonly string[]) => [...offered.slice(0, MAX_OFFERED).map(n => `/${n}`), BUILTIN_LABEL]

/** Reads the label chosen, or the text typed under "Other". */
export function interpret(answer: string, names: readonly string[], pluginName: string): Choice {
  if (answer.trim() === BUILTIN_LABEL) return { kind: 'builtin' }
  const typed = clean(answer)
  if (!typed) return { kind: 'dismissed' }
  const found = findCommand(names, typed, pluginName)
  if (!found) return { kind: 'unknown', typed }
  return found === builtinOf(pluginName) ? { kind: 'builtin' } : { kind: 'command', command: found }
}

/** The `/config` row of this plugin's `handoffCommand` option. */
export function configKey(rows: readonly ConfigRowLike[], pluginName: string): string | undefined {
  const base = baseOf(pluginName)
  return rows.find(r => (r.provider.plugin === pluginName || r.provider.plugin === base) && r.key.endsWith('.handoffCommand'))?.key
}
