# PLAN: dhurbo55/claude-mods, mod `auto-handoff`

Built with `~/.claude/opus-kit/MOD-BUILD-PROMPT.md`. Claude Code 2.1.292. Started 2026-10-07.

## Goal

Before the prompt cache of an idle session expires, `auto-handoff` writes a handoff on its own. The handoff is written while the cache is still warm, so it is cheap, and the next session can pick up the work from it. The mod is public, installed from this repository's marketplace.

The mod does not depend on any other plugin:
- If no handoff command is configured, it runs its own bundled skill, `/auto-handoff:handoff`. That skill writes `~/.claude/handoffs/<project>/<topic>.md`.
- If other handoff skills are installed (`/ce-handoff`, Matt Pocock's `/handoff`, or any command whose last name segment ends in `handoff`), it asks once which one to use, after the first turn of a session, and saves the answer in its `/config` option.

## Variables

- AUTHOR_NAME = "dhurbo55". This is the name the user gave. GitHub has no user `dhurbo55`, but it does have `dhrubo55`. Confirm the name before the first push. It appears in `.claude-plugin/marketplace.json`, `plugins/auto-handoff/.claude-plugin/plugin.json`, `README.md` and `LICENSE`.
- MARKETPLACE = "dhurbo55-mods"
- LICENSE = "MIT"
- REPO = "dhurbo55/claude-mods"

## Features, with the API each uses (proved against `.claude-plugin/types/claude-code/index.d.ts`, 2.1.292)

### F1. Idle clock and trigger (ported from the working dev copy)

Events:
- `turn.step`, main loop only (`e.agentId` absent). It records the request's start time in `$.state` `lastRequestAt` when the result carries `usage`.
- `turn.start` arms the trigger. The exception is the turn that the mod's own queued command starts: that is the handoff turn, and it is claimed through `pendingSince`.
- `turn.complete` clears `turnRunning`. For the handoff turn it also records `{at, path, ok}` in `last` and reports it.
- `session.start` registers the command and starts `$.clock.every(1000, …)`. `session.end` with `reason: 'clear'` resets the clock state; any other reason cancels the timer.

Methods:
- `$.clock.every`, `$.clock.after` and `$.clock.now`.
- `$.command.list` and `$.command.run`. `run` queues the command until the session is idle.
- `$.ui.toast` and `$.ui.status`. `status` is "Pins text as this plugin's status line under the prompt… One per plugin".

Decision logic (pure, `hooks/lib/schedule.ts`):
- Before the fire time: wait, then one warning 1 minute ahead with a countdown.
- At the fire time (cache lifetime minus lead): fire.
- Past the lifetime: skip, and say why.
- Never fire during a running turn, while paused, or while a handoff is queued. Fire once per idle period.

### F2. Which command runs (new)

Option `handoffCommand` (string, default `""`). Resolution is pure (`hooks/lib/choice.ts`) and runs on `$.command.list()` at fire time:

| Setting | Command found | Runs | Toast |
|---|---|---|---|
| `""` | (none needed) | `/auto-handoff:handoff` | "Running /auto-handoff:handoff" |
| `x` | `x` or `<plugin>:x` | that command; arguments `create` if its last segment is `ce-handoff`, else none | "Running /<cmd> <args>" |
| `x` | absent | `/auto-handoff:handoff` | "/x is not installed in this session; running the built-in /auto-handoff:handoff instead" |
| any | built-in also absent | nothing | "No handoff command available: /auto-handoff:handoff is not loaded. Nothing ran." |

- The built-in is looked up as `<plugin base name>:handoff`, where the base name is `$.plugin.name` up to any `@`.
- Proof: `CommandInfo {name, description, source: CommandSource, plugin?}` (types 1722) and `CommandSource = 'builtin' | 'plugin' | 'user' | 'mcp'` (1871).

### F3. Ask once which handoff skill to use (new)

Candidates (pure, `choice.ts`):
- Commands whose last `:`-segment ends in `handoff`, case-insensitive.
- This plugin's own commands are excluded: `plugin === $.plugin.name`, or a name that starts with `auto-handoff`.
- Ordered `ce-handoff`, `handoff`, then the rest alphabetically.
- At most 3 are shown, plus "Built-in handoff". The `$.ui.ask` limit is 2–4 labels.

Trigger:
- At the end of a main-loop, non-handoff `turn.complete`, when all of these hold:
  - the session is interactive (`session.start` `e.isInteractive`, types 11605);
  - `handoffCommand` is `""`;
  - there is at least one candidate;
  - `$.state` `asked` is false.
- The hook sets `asked` and schedules the question with `$.clock.after(0, …)`, so the dialog does not hold the hook open.

The question:
- `$.ui.ask("Which handoff command should auto-handoff run before the prompt cache expires?", { header: "Handoff", options })`.
- It "Rejects when dismissed, and in a `-p` run" and returns "the label chosen … or free text typed under 'Other'" (types 2406–2420).

Saving:
- Find the row in `$.config.list()` (`ConfigRow {key, value, provider: Origin, …}`, types 1982) whose `provider.plugin === $.plugin.name` and whose key ends in `.handoffCommand`.
- Then call `$.config.set({ key, value })`. It returns `{ value }` or `{ deny }` (types 2030–2073) and "Changes one row as if the person did in the menu".
- After the change, "`register` runs again with the new object" (types 9238), so later fires read the new option.
- "Built-in handoff" saves `auto-handoff:handoff`, so the question is not asked again.

Outcomes, each a toast:
- **Chosen:** "Handoff command set to /<cmd>. Change it in /config or with /auto-handoff setup."
- **Built-in:** "Handoff command set to the built-in /auto-handoff:handoff. Change it in /config or with /auto-handoff setup."
- **Dismissed:** "No handoff command chosen: auto-handoff runs the built-in /auto-handoff:handoff. /auto-handoff setup asks again."
- **"Other" with an unknown name:** "/<typed> is not installed in this session; nothing saved. auto-handoff runs the built-in /auto-handoff:handoff."
- **Denied:** "Could not save the handoff command (<reason>). auto-handoff runs the built-in /auto-handoff:handoff."

`/auto-handoff setup`:
- With candidates, it schedules the same question and answers "Opening the handoff command picker."
- With none, it answers "No other handoff skill is installed; auto-handoff runs the built-in /auto-handoff:handoff."

### F4. The bundled handoff skill (new)

File: `plugins/auto-handoff/skills/handoff/SKILL.md`, invoked as `/auto-handoff:handoff [focus]`. It sets `disable-model-invocation: true`, so the model does not pick it on its own; the person and `$.command.run` can still run it.

It writes `~/.claude/handoffs/<project>/<topic>.md`:
- `<project>` is the basename of the working directory.
- `<topic>` is a 2–6 word kebab-case slug.
- It never overwrites an existing file; it adds `-2`, `-3`, … instead.

Contents:
- objective;
- work done;
- decisions and rejected options;
- current state;
- files to read;
- verification;
- next steps;
- open questions.

Secrets are redacted. The answer's last line is the absolute path, which `handoffPath` picks up.

### F5. Command `/auto-handoff [status|on|off|now|setup]` (ported, plus `setup`)

- It is registered in `session.start` with `immediate: true` and answered by `command.run` with the literal `{ command: 'auto-handoff' }`.
- `status`, or no argument: state, the command that would run, idle time, and the last handoff.
- `off` and `on`: pause or resume for this session.
- `now`: fires at once.
- `setup`: F3.
- Command replies and toasts do not start with "auto-handoff:". The engine already shows the plugin's name. The live run showed "auto-handoff: auto-handoff: queuing …".

### F6. Band row above the prompt (new, 2026-10-07 16:29, approved, implemented)

User answer: "Band row + pane". One row, drawn by `on('ui.render', { component: 'AbovePrompt' }, …)`.

Proof (types):
- `AbovePrompt` props `{ hasSurvey, isWorking, maxRows, bodyColumns, scroll, view }` (10179). "A hook draws a tree, or passes; one instance." The band is drawn on the terminal and desktop only.
- `next(e)` resolves to a `RenderElement` (9302).
- `$.ui.invalidate('ui.render')` redraws (2350).

What the row says, by phase. Times are relative ("in 41:18", "3:12 ago"), not clock times: the mod's clock is `$.clock.now()` in epoch ms, and I have not verified which time zone the plugin sandbox formats local time in.

| Phase | Row |
|---|---|
| no request yet, or option `enabled` off | nothing: `return next(e)` |
| armed, counting | `⇢ handoff in 41:18 · /ce-handoff create · last fix-login.md` |
| last minute | the same, yellow: `⇢ handoff in 0:42 · send a message to keep working` |
| turn running (`turnRunning` or `isWorking`) | dim: `⇢ handoff after 55:00 idle · /ce-handoff create` |
| queued or running | `⇢ writing handoff · /ce-handoff create` |
| handed off | `⇢ handed off 3:12 ago · fix-login.md · arms on your next turn` |
| skipped, cache expired | dim: `⇢ cache expired, no handoff · arms on your next turn` |
| paused | dim: `⇢ handoff paused · /auto-handoff on` |

- **Command label:** the last name segment plus arguments. The built-in shows as `/handoff (built-in)`. A fallback shows as `/handoff (built-in, ce-handoff missing)`.
- **Survey:** it yields with `next(e)` while `e.props.hasSurvey` is true.
- **Width:** it fits `e.props.bodyColumns` by dropping segments from the right: last handoff first, then the command. The countdown always stays.
- **Button:** one, `[h] details` (key `open`), which opens the pane (F7). A band Button's hotkey works only after the person focuses the band (ctrl+x tab or a click).
- **Redraw:** atom writes redraw it on their own. The one-second tick also calls `$.ui.invalidate('ui.render')` while there is something to count from: after the first request (`lastRequestAt !== null`) or after a handoff (`last !== null`).
- **Sharing the row with prompt-cache-control:** the hook calls `next(e)` and returns a column with its own row on top and the tree from beneath under it. If the tree from beneath is empty, it returns its own row alone.
  - Not verified: a tree another plugin drew can be nested inside ours. A test with a hook beneath that draws a Text covers the plain case.
  - Not fixable from this mod: if prompt-cache-control's hook runs above ours, it returns its own tree without calling `next`, and our row is hidden while its band shows. This goes in LIMITS.md and on the live-check list.
- **Option:** `showBand` (boolean, default true, title "Band row above the prompt"). Off: the hook always passes.

### F7. Pane (new, approved, implemented)

User answers:
- Contents: "Timeline, Command resolution".
- Buttons: "Pick command, Copy path / resume prompt, Hand off now / Pause".
- Not chosen: "Open on warning". The pane opens only when the person asks.

Proof (types):
- `$.ui.open({ id, title, focus })` returns `{ isPlaced: true } | { isPlaced: false, reason }` (2472, 13958). A pane the person opened is placed at any width.
- The pane is drawn by `on('ui.render', { component: 'Pane', requestId: 'auto-handoff' }, …)`. `Pane` props: `{ title, isFocused, bodyColumns, placement, scroll, view }` (10236).
- `$.ui.close({ id })` (2486).
- `$.ui.copy({ text, surface })` returns `{ isCopied: true } | { isCopied: false, reason }` (2544, 13586). Its doc says "The terminal writes as /copy does; a remote surface has no path yet". So on desktop a copy is expected to fail. The toast then shows the text instead.
- ButtonProps `{ key, label, hotkey, onPress(e: UiPressArgument) }` (1060). `UiPressArgument.surface` is at 14026.

Opening:
- `/auto-handoff` with no argument (F8), or the band's `details` button.
- Opened with `focus: true` and without `closeOnEscape`. Esc gives the keyboard back to the prompt, and the pane stays open as a live view.
- `[x] Close`, or the engine's ctrl+x x, closes it.

Layout (sized to `Math.max(30, bodyColumns - 1)`, labels in fixed-width Boxes, as in prompt-cache-control):

```
State      armed · fires once per idle period
Idle       41:18 of 60:00  [████████████████░░░░│░░]
Timeline
  last request     41:18 ago
  warning          in 12:42    at 54:00 idle
  handoff          in 13:42    at 55:00 idle
  cache expires    in 18:42    at 60:00 idle
  last handoff     3:12 ago    ~/.claude/handoffs/work/fix-login.md
Command
  setting          ce-handoff  (/config: Handoff command)
  runs             /compound-engineering:ce-handoff create
  why              set in /config, found as compound-engineering:ce-handoff; ce-handoff takes "create"
  installed        /compound-engineering:ce-handoff, /mattpocock-skills:handoff, built-in /auto-handoff:handoff
[n] Hand off now  [p] Pause  [s] Pick command  [c] Copy path  [r] Copy resume prompt  [x] Close
```

- **"why", per resolution kind:**
  - configured: "set in /config, found as X";
  - builtin: "Handoff command is empty" or "set to the built-in";
  - fallback: "/X is not installed in this session; the built-in runs instead";
  - none: "neither /X nor the built-in is loaded".
- **The bar:** `│` marks the handoff point.
- **Rows that have passed** read "passed", and the row for the next event is bold.

Buttons:

| Key | Label | Does | Drawn when |
|---|---|---|---|
| n | Hand off now | the `/auto-handoff now` path: `$.clock.after(0, () => fire(...))`, then a toast | a command resolves and no handoff is queued |
| p | Pause / Resume | sets `paused`; the label flips | always |
| s | Pick command | the `/auto-handoff setup` path: `$.clock.after(0, () => offer(...))` | another handoff command is installed |
| c | Copy path | `$.ui.copy({ text: path, surface: press.surface })` | the last handoff has a path |
| r | Copy resume prompt | copies `Read <path> and continue from it.` | the last handoff has a path |
| x | Close | `$.ui.close({ id })` | always |

A failed copy toasts "Could not copy (<reason>). Path: <path>".

### F8. `/auto-handoff` with no argument opens the pane (changed, approved, implemented)

- In an interactive session, no argument opens the pane and answers "Opened the auto-handoff pane."
- If `$.ui.open` answers `isPlaced: false`, it answers with the status text, as before.
- Under `-p` and the SDK, no argument still answers with the status text.
- `/auto-handoff status` always answers with the text.

### Shared view logic (new file `hooks/lib/view.ts`, pure)

- `phaseOf(snapshot, policy, last)`: the phases in the F6 table.
- `bandParts(model, columns)`: the row's segments after fitting.
- `timeline(model)`: the timeline rows.
- `why(resolved, setting)`: the "why" text.
- `bar(idleMs, policy, width)`: the idle bar.
- `cmdLabel(resolved)`: the command label.

All are unit-tested in `tests/lib.test.ts`. `register.ts` becomes `register.tsx` (JSX), and `hooks/hooks.json` is changed to point to it.

### Tests for F6–F8

UI tests mount through the engine with `$.ui.mount({ plugin, surface, component, props })`, looped over `['terminal', 'desktop'] as const`. Presses use the mount's `press({ key })`. New engine stubs: `ui.open`, `ui.close`, `ui.copy`.

1. Band, by phase: no request (passes), counting, last minute, turn running, queued, handed off, expired, paused, option off, and `hasSurvey` (passes).
2. Band width: at `bodyColumns` 40 and 120 the row fits, and the countdown is kept.
3. Band composition: a test hook beneath draws a Text, and both rows are found.
4. Band `open` button: `ui.open` receives `id: 'auto-handoff'`.
5. Pane, timeline: times at 0, 54:30 and 56:00 idle, and the last handoff path.
6. Pane, command resolution: configured `ce-handoff`, fallback, built-in, and the installed list.
7. Pane buttons:
   - `now` queues the command;
   - `pause` flips its label and stops the fire;
   - `pick` asks;
   - `copy-path` and `copy-resume` send the text and the press's surface;
   - a refused copy toasts the path;
   - `close` calls `ui.close`.
8. `/auto-handoff`: opens the pane when interactive, and gives text under `-p` and for `status`.

Then:
- Run the mutation check again, with one mutation for each of: survey yield, width fit, pause label, copy surface.
- Run validate `--strict` on the mod and the repository, tsc, the tests, and the headless `status`, `off`, `on` and `setup` runs.

### F9. The mod saves the built-in skill's handoff (new, 2026-10-07 17:28, the user chose "Mod saves the file")

Problem: the built-in skill wrote its file with the model's Write tool, so an unattended handoff stopped at a permission prompt unless the person had added two allow rules.

- **Skill** (`skills/handoff/SKILL.md`): writes nothing and runs no shell commands. It may read files with Read, Grep and Glob. Its final message is the handoff document only: YAML frontmatter (`topic`, `title`, `cwd`, `branch` when the conversation shows it) and the same sections as F4.
- **Which turns are saved:** a `command.run` observer on the literal `auto-handoff:handoff` (any origin: the mod's `$.command.run` or the person typing it) sets `saveSince` to the time it ran; `fire` sets it too when it runs the built-in. The next `turn.start` moves it to `saveTurnId`. A throw from `next(e)` clears `saveSince`, and so does the one-second tick after 10 minutes (`STUCK_MS`), so a command that never started a turn cannot mark a later turn of the person's.
- **Saving** (`turn.complete` of `saveTurnId`, answered, not aborted):
  - `documentOf(answer)` (pure, `hooks/lib/document.ts`): unwraps an outer ```` ```markdown ```` fence; takes the answer from its frontmatter (a `---` line closed within 40 lines) or else from its first `# ` heading; null when neither, or when the result is under 200 characters.
  - `topicOf(doc)`: frontmatter `topic`, else `title`, else the first heading, slugified to `[a-z0-9-]`, at most 60 characters; `handoff` when empty.
  - `stamp(doc, iso)`: sets `created_at` in the frontmatter from `$.clock.now()`, replacing one the model wrote; adds a frontmatter block when there is none.
  - Path: `<home>/.claude/handoffs/<project>/<topic>.md`. `<home>` is `$.env.get("HOME")`, else `$.env.get("USERPROFILE")`. `<project>` is the basename of `$.session.cwd()`, lowercased, other characters than `[a-z0-9_-]` replaced by `-`. The separator follows `<home>` (`\` when it has one).
  - Never overwrites: `$.fs.exists` on `<topic>.md`, then `-2`, `-3`, … up to `-99`. Check and write are two calls, not one atomic step (LIMITS).
  - `$.fs.write(path, text)`; it creates the directories.
- **Outcomes**, recorded in `last` and toasted:
  - saved: `{ ok: true, path }`, "Handoff saved to <path>";
  - not a document: `{ ok: false, problem: 'the answer was not a handoff document' }`, toast says the answer is in the transcript;
  - write failed: the catch returns the reason; `{ ok: false, problem: 'not saved: <reason>' }`, toast says the document is in the transcript. Nothing downstream reads the path then, and the band and pane show the problem instead of "did not finish".
- **A person-run `/auto-handoff:handoff`** is saved the same way. Its turn does not arm the trigger and clears `armed`, so the mod does not write a second handoff 55 minutes later.

### F10. Nothing waits for approval during a handoff the mod started (new, the user: "it shouldnt wait at all. why wait")

The build prompt forbids the mod to approve a tool call. So, while a turn the mod started runs (`handoffTurnId` set), it declines every call that would open a permission prompt instead of letting it wait:

- `on('classic.PermissionRequest', …)`: when `handoffTurnId` is null, `next(e)` unchanged. Otherwise, for the main loop (`agent_id` absent) and for subagents started in that turn (`classic.SubagentStart` records their `agent_id` in `handoffAgents`), it returns `{ decision: { behavior: 'deny', message } }` without `interrupt`, so the model continues.
- The message tells the model: auto-handoff runs this handoff unattended and declines every call that needs approval; do not retry it or try another tool for the same purpose; if the handoff file cannot be written, answer with the complete handoff document as Markdown starting with its YAML frontmatter, and auto-handoff saves it.
- `declined` counts the denials in the turn; the first one toasts "Declined <tool> during the handoff instead of waiting for approval."
- `turn.complete` of the handoff turn, for a command other than the built-in: when `declined > 0` and `documentOf(answer)` finds a document, the mod saves it as in F9. Otherwise the path comes from `handoffPath(answer)` as before.
- Not applied to a person-run handoff: the person is there to answer the prompt.
- This replaces the README section "Avoid permission prompts during the handoff" (the two allow rules are no longer needed).
- The three new hooks (`command.run` on the built-in, `classic.PermissionRequest`, `classic.SubagentStart`) have no `.catch`, on purpose. A hook that fails is skipped and the engine goes on: a failed `PermissionRequest` hook means the normal prompt opens and the turn waits, as before F10; a failed `SubagentStart` hook means that subagent's prompts are not declined; a failed `command.run` hook means a `/auto-handoff:handoff` the person ran is not marked and its answer is not saved (it stays in the transcript); one the mod ran is still marked by `fire`. A `.catch` would have to answer in the hook's place, and the only answer it could give for a permission request is a decision the mod could not check.

### Tests for F9–F10

1. Lib: `documentOf` (frontmatter, heading, fenced, preamble, too short, plain prose), `topicOf` (topic, title, heading, empty, long, non-ASCII), `projectOf`, `stamp` (adds, replaces, no frontmatter), `pathFor` with `/` and `\`.
2. Built-in handoff fired by the mod: saved under `<home>/.claude/handoffs/work/<topic>.md` with `created_at`; toast and `last`.
3. An existing file: saved as `-2`; with `-2` present too, `-3`.
4. A non-document answer: nothing written, `last.ok` false with the problem.
5. A failed write: `last.problem` carries the reason.
6. A person-run `/auto-handoff:handoff` (origin `composer`): saved, and the trigger is not armed after it.
7. A permission request during a mod-started handoff: denied with the message, no `interrupt`; a subagent started in that turn too; another subagent and any request outside the turn reach `next`.
8. ce-handoff turn with a denial and a document answer: saved. Without a denial: the path from the answer, nothing written.
9. HOME unset: USERPROFILE is used, with `\`.

Then the mutation check (save without the existence check; deny outside the handoff turn; save a non-document), validate `--strict` (mod and repository), tsc, tests, headless runs.

## userConfig (each option is read by a feature)

| key | type | default | read by |
|---|---|---|---|
| handoffCommand | string | `""` | F2, F3 |
| cacheMinutes | number | 60 | F1 |
| leadMinutes | number | 5 | F1 |
| enabled | boolean | true | F1 |
| showBand | boolean | true | F6 (approved) |

## State (`types/index.d.ts`, `PluginState['auto-handoff']`)

- `lastRequestAt`, `armed`, `paused`, `warnedFor`, `pendingSince`, `handoffTurnId`, `turnRunning` and `last`, carried over from the dev copy.
- `asked` (new, boolean): F3 asked this session.
- F9: `saveSince` (number | null) and `saveTurnId` (string | null). F10: `declined` (number) and `handoffAgents` (string[]). `HandoffRecord` gains an optional `problem`.
- Module variables, lost on a reload by design:
  - `timer`, re-created in `session.start`;
  - `ticking`;
  - `shown`, the status text last written;
  - `interactive`, from `session.start`.

## Built-in patterns copied

- **diff:** commands are registered in `session.start` and the command is answered by its own `command.run` hook. Async engine calls get a `.catch` that turns a failure into a quiet default (`register.ts:154, 282, 410`).
- **agents-md:** a `userConfig` string with `"required": false`, a quoted description that lists what each value does, and an `author` object.
- **telemetry:** not copied. This mod adds no namespace to `$` for other mods.

## API rules confirmed by validate on the dev copy (2026-10-07)

- `$` passes only to top-level functions of `register.ts`.
- `read`/`update` name an atom directly; there is no generic helper.
- The command name is the same literal in `register` and in the `command.run` matcher. validate then reports "answers its own command" rather than a gate.

## Deviations from the template, with reasons

1. **Starts On (`enabled: true`).** The template says "start Off" for behaviour changes. The user asked for an automatic handoff, and Off would make it a manual command. The mod only runs a slash command that the person could run themselves; it never rewrites or approves anything. Since F10 it declines permission prompts during the handoff turns it starts, so they do not wait.
2. **No commits during the build.** git has no identity on this machine, and the user said "will do it later". PROGRESS.md records each gate; the commits are made once the identity is set.
3. **No restart stop after Phase 1.** The types are laid by a headless `claude -p "/auto-handoff" --plugin-dir plugins/auto-handoff` run instead. That run is also done_when item 4.
4. **The missing-command toast changed.** It now runs the built-in instead of "…is not installed in this session, nothing ran". The user asked for no dependency on ce or mattpocock.

## Proposed (not built)

- A `/config` picker over installed skills. userConfig `options` are static, so the dialog in F3 does this job instead.

## Out of scope

Pushing, creating the GitHub repository, git identity, installing into user settings.
