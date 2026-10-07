# LIMITS: auto-handoff

Tested on Claude Code 2.1.292. Each entry says what the mod cannot do, and what it does instead.

## Differences from the build prompt and the request

1. **No `/config` picker that lists the installed handoff skills.** A plugin option's choices are fixed in `plugin.json`, so `/config` cannot list the skills installed on each machine. Instead:
   - After the first finished turn of a session, if no command is set and another handoff skill is installed, the mod asks once which one to use. It saves the answer in the `handoffCommand` option.
   - `/auto-handoff setup` asks again.
   - `/config` still shows `handoffCommand` as a text field.
2. **The question shows at most three other handoff commands.** `$.ui.ask` takes 2 to 4 options, and one is "Built-in handoff". To use a fourth command, type its name under "Other", or set it in `/config`.
3. **The mod starts On.** The build prompt says to start a behaviour change Off. An automatic handoff that starts Off would only run by hand. The mod only runs a slash command the person could run themselves. It never rewrites or approves a tool call; the only calls it declines are those that would open a permission prompt during a handoff turn it started (item 7). The `Auto handoff` option turns it off.
4. **A configured command that is not installed falls back to the built-in skill**, with a toast that says so. The earlier version ran nothing in that case.
5. **No commits during the build.** git has no identity on this machine yet. PROGRESS.md records each gate instead.

## Limits of the design

6. **The cache lifetime is a setting, not a measurement.** The mod cannot read how long the prompt cache lives. It counts from the start of the last main-loop request. The default of 60 minutes matches a Claude subscription. With an API key or usage credits the cache lives 5 minutes, so set `Cache lifetime (min)` to 5.
7. **During a handoff the mod started, a call that needs approval is declined.** The turn runs while you are away, so a prompt would wait while the cache expires. The build prompt forbids the mod to approve a call, so it declines it, with a message telling the model to answer with the whole document instead. What follows:
   - The built-in skill writes nothing and needs no approval, so a decline only stops a read the model tried outside what your rules allow.
   - Another handoff skill whose write is declined has no file of its own. The mod saves its answer when that is a handoff document; otherwise the toast says nothing was saved.
   - Subagents started in the handoff turn are covered, as the mod records them through `classic.SubagentStart`. A subagent the mod did not see start is not.
   - A `/auto-handoff:handoff` you run yourself is not covered: you are there to answer the prompt.
   - Allow rules you add still apply, and a settings hook's decision stands, because the mod asks the hooks beneath first.
8. **The mod saves only an answer that looks like a handoff document.** It must start with YAML frontmatter or a `# ` heading (text before either is dropped, and an outer ```` ```markdown ```` fence is taken off), and be at least 200 characters long. Anything else is not saved; the toast says so, and the answer is in the transcript. For a skill other than the built-in with no declined call, the path is read from its answer as before: `/ce-handoff` prints a resume line, and for skills that print no path the toast says "Handoff turn finished; its answer says where the handoff is."
9. **The mod fires once per idle period.** After a handoff it waits for your next turn before it arms again. The handoff turn itself refreshes the cache.
10. **The question is asked only with a person at the prompt.** Under `claude -p` and the SDK it is never asked, and the configured command, or else the built-in, runs. `/auto-handoff setup` under `claude -p` still answers "Opening the handoff command picker." when another handoff skill is installed, but nothing is asked and nothing is saved.
11. **The row above the prompt depends on the plugins above it.** Plugins draw the row in load order, and each passes the row on by calling `next`. A plugin loaded above auto-handoff that draws its own row without calling `next` hides this row. The pane, the toasts and the status line still work.
12. **The row's `h` hotkey needs focus.** In the terminal, the row takes keys only after a click on it, or ctrl+x then tab. `/auto-handoff` opens the pane without it.
13. **A copy can report success without reaching the clipboard.** The terminal copies as `/copy` does. Where it falls back to OSC 52 and the terminal drops it, the copy still reports success (2.1.292 types, `UiCopyResult`). The same types say a remote surface, such as the desktop app, has no copy path yet. When a copy fails, the toast shows the text to copy by hand.
14. **Checking for a free file name and writing are two steps.** `$.fs.write` has no exclusive create. If another process creates the same `<topic>.md` between the check and the write, the mod overwrites it. Two sessions in one project that hand off on the same topic in the same moment are the case where that can happen.
15. **The handoff document is also in the transcript.** It is the turn's answer, so it stays in the conversation and the session's transcript file as well as in the saved file. The skill leaves out secrets for both.
16. **The home folder is `HOME`, else `USERPROFILE`.** On Windows with a `HOME` that is not your profile folder (some tools set one), handoffs go under that `HOME`, not under the `.claude` folder Claude Code uses.
17. **The three new hooks fail open.** `command.run` on `auto-handoff:handoff`, `classic.PermissionRequest` and `classic.SubagentStart` have no `.catch`. If one throws or runs past the 10-second budget, the engine skips it: the permission prompt opens and waits, as before; that subagent's prompts are not declined; or a `/auto-handoff:handoff` you ran is not saved (its answer is in the transcript). A `.catch` would have to decide a permission request in the mod's place without the check the hook makes.

## Not verified in a live session

The tests cover these paths through the engine's test stand-in, not a live session:

- The question appears while the session is idle. It is asked from a timer callback, after the turn ends.
- After the answer is saved, the plugin reloads and only one timer runs.
- `$.command.run` starts the built-in skill, which has `disable-model-invocation: true`.
- The handoff fires while the question is still open.
- An installed copy and a development copy of the same mod run in one session.
- The row above the prompt when prompt-cache-control is also installed: which row shows, and in which order.
- What the engine itself draws above the prompt when the mod passes on (`next(e)`). The tests put an empty stand-in beneath, because the test kit has nothing there.
- The copy buttons in the desktop app.
- The pane's layout at 110 and 144 terminal columns, and its redraw each second.
- `command.run` fires for `/auto-handoff:handoff` when you type it, so its answer is saved. The mod's own run is also marked by `fire`.
- `classic.PermissionRequest` fires in the handoff turn in the default, `acceptEdits` and `auto` permission modes, and under `claude -p`, and the deny lets the model go on.
- The model follows the decline message: it does not retry with another tool, and it answers with the document.
- `turn.complete`'s `answer` holds the whole document when the model wrote text, called a tool, then wrote the document.
- The save under a real home folder on Windows and macOS, including a `-2` name.
