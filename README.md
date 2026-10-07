# claude-mods

Claude Code mods by dhrubo55. This repository is a plugin marketplace (`dhrubo55-mods`). Each mod is in its own folder under `plugins/`.

| Mod | What it does |
|---|---|
| [auto-handoff](plugins/auto-handoff) | Writes a handoff shortly before the prompt cache of an idle session expires. |

## auto-handoff

An idle Claude Code session keeps its prompt cache for a limited time: 60 minutes on a Claude subscription, 5 minutes with an API key. After that, the next message sends the whole conversation again at the full input price. auto-handoff runs a handoff command 5 minutes before the cache expires. The handoff is written while the cache is still warm, so it costs little. A fresh session can then continue from the handoff instead of the long conversation.

Tested on Claude Code **2.1.292**. The mod uses the function-hook plugin API (mods), which needs a recent Claude Code.

### Install

```
/plugin install auto-handoff --marketplace dhrubo55/claude-mods
```

Or in two steps:

```
/plugin marketplace add dhrubo55/claude-mods
/plugin install auto-handoff@dhrubo55-mods
```

To try it from a clone without installing it:

```
claude --plugin-dir ./plugins/auto-handoff
```

### What happens

1. Each request the main conversation sends to the model starts the cache's lifetime again.
2. A minute before the handoff, a toast says so: "Handoff in 1:00: the prompt cache expires in 6:00. Send a message to keep working, or /auto-handoff off to skip." The status line counts down.
3. At 55 minutes idle (the cache lifetime minus 5 minutes), the mod queues the handoff command. It runs like a command you typed.
4. While that turn runs, nothing in it waits for your approval: the mod declines each call that would open a permission prompt (see [Permission prompts during the handoff](#permission-prompts-during-the-handoff)).
5. When the handoff turn ends, the mod saves the built-in skill's answer as the handoff file, and a toast gives its path.
6. The mod fires once per idle period. It arms again on your next turn.

It never fires before the conversation's first request, during a running turn, or while paused. If the cache has already expired (for example, the computer was asleep), it skips the handoff and says why: a handoff then would send the whole conversation again.

### The row above the prompt

After the conversation's first request, a row above the prompt shows the countdown, the command that will run and the last handoff:

```
⇢ handoff in 44:59 · /handoff (built-in) · last auto-handoff-mod.md   [ h: details ]
```

- In the last minute it turns yellow and bold and says "send a message to keep working".
- It also shows when the handoff is queued, when it was handed off, when a turn is running, when the mod is paused, and when the cache expired with no handoff.
- On a narrow screen it drops the last segments first, then the `details` button (below 40 columns), then cuts the text.
- It is hidden while a survey shows, and when the `Band row above the prompt` option is off.
- Another plugin's row above the prompt stays, under this one.

### The pane

`/auto-handoff` with no argument, or `details` on the row, opens a pane:

- **State** and an **Idle** bar from 0 to the cache lifetime, with `│` where the handoff fires.
- **Timeline:** the last request, the warning, the handoff and the cache's expiry, each with the time left or "passed". The next event is bold. The last handoff and its path follow.
- **Command:** the `Handoff command` setting, what runs, why (for example, "/ce-handoff is not installed in this session; the built-in runs instead"), and the handoff commands installed.
- **Buttons:**

| Button | Hotkey | What it does |
|---|---|---|
| Hand off now | `n` | Queues the handoff. Hidden while one is queued, or when no handoff command is loaded. |
| Pause / Resume | `p` | Pauses or resumes the mod for this session. |
| Pick command | `s` | Asks which handoff command to run, as `/auto-handoff setup` does. Shown when another handoff skill is installed. |
| Copy path | `c` | Copies the last handoff's path. |
| Copy resume prompt | `r` | Copies `Read <path> and continue from it.` |
| Close | `x` | Closes the pane. |

The copy buttons show after a handoff whose path the mod found. If the copy fails, the toast shows the text instead. The pane never opens by itself.

### Which handoff command runs

auto-handoff does not depend on any other plugin.

- **By default** it runs its own skill, `/auto-handoff:handoff`.
- **If other handoff skills are installed**, for example `/ce-handoff` from compound-engineering or `/handoff` from mattpocock-skills, it asks once, after the first turn of a session:
  - The question is "Which handoff command should auto-handoff run before the prompt cache expires?"
  - It lists up to three installed commands whose name ends in `handoff`, and "Built-in handoff".
  - The answer is saved in the `Handoff command` option, so the question is not asked again.
  - `/auto-handoff setup` asks again.
- **If the configured command is not installed** in a session, the built-in skill runs instead, and a toast says so.
- `ce-handoff` is run as `/<plugin>:ce-handoff create`. Other commands run without arguments.

### The built-in skill

`/auto-handoff:handoff [focus]` answers with a handoff document in Markdown, and the mod saves that answer as a file. The skill itself writes nothing and runs no shell commands, so it needs no permission. You can also run it yourself; the mod saves that answer too.

- **Where:** `~/.claude/handoffs/<project>/<topic>.md`.
  - `~` is `HOME`, or `USERPROFILE` when `HOME` is not set.
  - `<project>` is the name of the working directory.
  - `<topic>` is the document's `topic`, else its `title`, else its first heading, as a kebab-case name.
  - It never overwrites a file; it adds `-2`, `-3` and so on, up to `-99`.
  - The mod adds `created_at` to the document's frontmatter.
- **When nothing is saved:** if the answer is not a handoff document (no frontmatter or `# ` heading, or under 200 characters), or the write fails, a toast says why. The answer is still in the transcript.
- **What it records:**
  - the objective;
  - work done;
  - decisions;
  - current state;
  - files to read first;
  - verification;
  - next steps;
  - open questions.
- **Secrets:** it leaves out secrets and personal data the work does not need.

To continue in a new session, point Claude at the file: `Read ~/.claude/handoffs/<project>/<topic>.md and continue from it.`

### Permission prompts during the handoff

You do not need to add any permission rules.

The mod runs the handoff while you are away, so a permission prompt in that turn would wait for you while the cache expires. Instead, during a handoff turn the mod started, the mod declines each call that would open a permission prompt. It never approves a call.

- The model gets this message with the decline: do not retry, and if the handoff file cannot be written, answer with the whole document. The turn goes on.
- The first decline shows a toast: "Declined <tool> during the handoff instead of waiting for approval." The toast at the end of the turn counts the declined prompts.
- Subagents started in the handoff turn are covered too. Other subagents are not.
- Your own permission rules and settings hooks still apply. A call your rules allow opens no prompt, so the mod never sees it. A decision from a settings hook stands.
- A `/auto-handoff:handoff` you run yourself is not covered. You are at the prompt to answer.
- **Another handoff skill**, such as `/ce-handoff`, writes its own file. If its write is declined and its answer is a handoff document, the mod saves the answer under `~/.claude/handoffs` as above. To let such a skill write its own file, allow its folder in `permissions.allow`.

### Command

| Command | What it does |
|---|---|
| `/auto-handoff` | Opens the pane. Under `claude -p`, or when the pane cannot be placed, it prints the status text instead. |
| `/auto-handoff status` | Prints whether it is on, which command runs, when it fires, the idle time and the last handoff. |
| `/auto-handoff off` | Pauses it for this session. |
| `/auto-handoff on` | Resumes it. |
| `/auto-handoff now` | Runs the handoff now. |
| `/auto-handoff setup` | Asks again which handoff command to run. |

Hotkeys: `h` on the row above the prompt opens the pane; the pane's own keys are in the table above. In the terminal, the row's hotkey works once the row has focus: click it, or press ctrl+x then tab.

### Options (`/config`)

| Option | Default | Meaning |
|---|---|---|
| Handoff command | empty | The command to run, without the slash, e.g. `compound-engineering:ce-handoff`. Empty runs the built-in skill. |
| Cache lifetime (min) | 60 | How long the cache lives. 60 on a Claude subscription; set 5 with an API key or usage credits. |
| Hand off before expiry (min) | 5 | How many minutes before expiry the handoff runs. |
| Auto handoff | on | Off: it never fires by itself. `/auto-handoff now` still works. |
| Band row above the prompt | on | Off: no row above the prompt. `/auto-handoff` still opens the pane, and the status line still counts down the last minute. |

### What it reaches

From `claude plugin validate plugins/auto-handoff --strict`:

- **hooks:** session.start, session.end, turn.start, turn.step, turn.complete, command.run{command=auto-handoff:handoff}, classic.PermissionRequest, classic.SubagentStart, command.run{command=auto-handoff}, ui.render{component=AbovePrompt}, ui.render{component=Pane, requestId=auto-handoff}
- **calls:** $.clock.after, $.clock.every, $.clock.now, $.command.list, $.command.register, $.command.run (via fire), $.config.list (via choose), $.config.set (via choose), $.env.get (via save), $.fs.exists (via save), $.fs.write (via save), $.session.cwd (via save), $.state.get, $.state.set, $.ui.ask (via choose), $.ui.close (via closePane), $.ui.copy (via copyText), $.ui.invalidate (via tick), $.ui.log, $.ui.open (via openPane), $.ui.resolve, $.ui.status (via status), $.ui.toast
- **environment reads:** HOME, USERPROFILE. It sets none.

The mod makes no network calls and runs no processes.

- **Files:** it checks whether a handoff file exists and writes new ones, only under `~/.claude/handoffs/<project>/`. It reads no files.
- **Clipboard:** `$.ui.copy` writes to it only when you press a copy button.
- **Tool calls:** it never approves a call and never changes one. During a handoff turn it started, it declines the calls that would open a permission prompt.
- **Settings:** the only one it changes is its own `Handoff command` option, when you answer its question.

The three hooks added for saving and declining (`command.run` on `auto-handoff:handoff`, `classic.PermissionRequest`, `classic.SubagentStart`) have no `.catch`, so validate lists them as "gating hook without .catch". That is deliberate. If one fails, the engine skips it and goes on as if the mod were not there: the prompt opens, or the answer is not saved and stays in the transcript.

### Limits

Full list: [LIMITS.md](LIMITS.md).

- **No `/config` list of your installed handoff skills.** A plugin option's choices are fixed. The mod asks once after the first turn instead, and `/auto-handoff setup` asks again.
- **The question shows at most three other handoff commands.** To use another one, type its name under "Other", or set it in `/config`.
- **The mod starts on.** Turn it off with the `Auto handoff` option.
- **The cache lifetime is a setting.** The mod cannot measure it. With an API key, set `Cache lifetime (min)` to 5.
- **A call that needs approval is declined during the handoff, not approved.** The built-in skill needs none. Another skill whose write is declined finishes without its file; the mod saves its answer when that is a handoff document.
- **The handoff document is also in the transcript**, because it is the turn's answer.
- **Checking for a free name and writing are two steps.** Another process that creates the same file between them would have it overwritten.
- **For other skills, the path is read from the handoff turn's answer.** It works with `/ce-handoff`. For skills that do not print it, the toast tells you to look in the answer.
- **One handoff per idle period.** It arms again on your next turn.
- **No question without a person at the prompt.** Under `claude -p` and the SDK it is not asked.

## Development

```
claude plugin validate plugins/auto-handoff --strict
claude plugin validate . --strict
claude plugin test plugins/auto-handoff
tsc -p plugins/auto-handoff
```

`tsc` needs the types that Claude Code writes to `plugins/auto-handoff/.claude-plugin/types/` the first time it loads the mod, for example from `claude -p "/auto-handoff" --plugin-dir ./plugins/auto-handoff`. That folder is in `.gitignore`. On Windows, run the `claude -p "/…"` command from PowerShell. Git Bash rewrites `/auto-handoff` into a file path.

## License

MIT. See [LICENSE](LICENSE).
