---
name: handoff
description: Answer with a handoff document for this session so a fresh session can continue the work. auto-handoff saves the answer to ~/.claude/handoffs/<project>/<topic>.md; it runs this skill before the prompt cache expires.
argument-hint: "[focus for the next session]"
disable-model-invocation: true
---

# Handoff

Answer with one handoff document that lets a fresh session continue this session's work without this conversation. Do not continue the work itself, ask questions, or change any file.

Focus for the next session (optional): $ARGUMENTS

## Tools

- Do not write, edit or create files, and do not run shell commands. auto-handoff saves your answer as the handoff file, so this skill needs no tool that asks for approval.
- You may read files with Read, Grep and Glob when the conversation does not already show what you need.
- If a call is declined, do not retry it or try another tool for the same purpose. Write the document from what you know.

## What to write

Your final message is the document and nothing else: no sentence before it, no code fence around it, no tool call after it.

Start with this frontmatter, every value double-quoted:

```yaml
---
topic: "<kebab-case slug of 2 to 6 words naming the objective, e.g. auth-token-refresh>"
title: "<short title>"
cwd: "<absolute working directory>"
branch: "<git branch, when the conversation shows one>"
---
```

auto-handoff adds `created_at` and names the file after `topic`.

Then these sections. Leave out a section that has nothing in it.

- **Objective**: what the user wants and their latest intent. Put the focus above here when one was given.
- **Done**: what was completed in this session, with file paths.
- **Decisions**: what was decided and why; alternatives that were rejected and why.
- **State**: what is finished, in progress (and what remains in it), or not started; uncommitted or temporary state.
- **Read first**: plans, docs and files the next session should read, each with what matters in it.
- **Verification**: tests and checks that ran, with their results, and what was not verified.
- **Next steps**: the plausible next actions, in order.
- **Open questions**: what is still undecided or blocked.

Point to files instead of copying their contents. Write facts the next session can check, not instructions to it. Leave out secrets, tokens, passwords and personal data that the work does not need.
