---
title: Agents
description: Use palmtop with Claude Code, Codex or any other coding agent.
order: 5
---

Your agent uses palmtop through a small set of **tools**: start a session, write checklists and
questions, read your review. They come from an MCP server that palmtop provides (`palmtop mcp`,
which the agent starts by itself), together with a short guide that tells the agent when and how
to use them (`palmtop guide` prints it). The tools take the text as it is, with no shell in
between: a check with quotes, `&` or `$` arrives as you read it, on any system.

What the agent writes for you is simple markdown, and the guide tells it how: the first line of a
check is its title (bold on your devices), and a command or a string to copy goes in a block with a
copy button. See [Text from your agent](/docs/app#text-from-your-agent).

An agent that has no MCP support can still run the `palmtop` commands, see
[Other agents](#other-agents).

## Claude Code

The [installer](/docs/getting-started#install) and `palmtop setup` set up Claude Code when it is
installed on this computer:

- the `palmtop` skill in `~/.claude/skills/palmtop/`, generated from the same guide;
- the `palmtop` MCP server, for all your projects (with `claude mcp add --scope user`, or in
  `~/.claude.json` if the `claude` command isn't on your `PATH`);
- the permissions `mcp__palmtop` and `Bash(palmtop *)` in `~/.claude/settings.json`, so the agent
  doesn't ask before each use.

It respects `CLAUDE_CONFIG_DIR`, backs up the files it changes, and does nothing if everything is
already in place. Restart Claude Code after installing. `palmtop update` updates the skill and the
server too.

The server keeps the session of the conversation, so the agent doesn't have to carry its ref around.
Check that Claude Code sees it with `claude mcp list`: `palmtop` should be `Connected`.

Then just ask, for example:

```text
implement the plan and put the checks on palmtop
put the tests I should run on palmtop
put what I need to check on palmtop
```

You can also type `/palmtop` with an optional session title. When you finished testing, tap
**Review done** in the app, or say so in the chat: "I reviewed the checks on palmtop", or just
"Done".

## Codex

The installer and `palmtop setup` set up Codex too when it is installed on this computer (the
`codex` command, or its files in `~/.codex` or `CODEX_HOME`):

- the `palmtop` skill in `~/.agents/skills/palmtop/`, generated from the same guide, with its name
  and icon for the Codex app;
- the `palmtop` MCP server, in a block of `~/.codex/config.toml` marked with `# >>> palmtop mcp`
  lines, set to run its tools without asking. A `[mcp_servers.palmtop]` you wrote yourself is left
  as it is;
- the rules file `~/.codex/rules/palmtop.rules`, which lets Codex run `palmtop` commands without
  asking. Allowed commands run outside the Codex sandbox: palmtop needs it to reach its daemon on
  this computer.

Start a new Codex session after installing, then ask as with Claude Code, or type `$palmtop`.
`palmtop update` updates the skill too.

## Other agents

An agent that supports MCP servers can start palmtop with `node`, the installed program and `mcp`.
Use the full paths (`which node`, and the folder where palmtop is installed):

```json
{
  "mcpServers": {
    "palmtop": {
      "command": "/usr/local/bin/node",
      "args": ["/home/you/.palmtopai/bin/palmtop.mjs", "mcp"]
    }
  }
}
```

Without MCP, tell the agent to read the guide and to run the `palmtop` commands, for example with a
line in `AGENTS.md` (or your agent's instructions file):

```markdown
To put checks on the user's devices, use palmtop: run `palmtop guide` first and follow it.
```

The guide explains sessions, how to write checks, how to read the review and what each mark means.
It ends with the command for each tool.

## Waiting for your review

When you tap **Review done** (see [Review done](/docs/concepts#review-done)) an agent that is
waiting for it reads your review by itself. It waits by running `palmtop wait --session <ref>` as a
command in the background: the command ends when you tap, and the agent is called back. This works
only with Claude Code for now, in a local session (terminal, desktop app or VS Code), where
background commands have no time limit. Other agents, Codex included, are not supported: tell them
in the chat.

- The agent waits only when there is something to wait for. After you tap, if everything is reviewed
  and nothing failed, it is finished with the list and doesn't wait again; if it fixes something or
  changes the checks, it waits for your next tap.
- To skip what is left, tell the agent in the chat: it stops waiting and reads your review as it is.
- The command only says that you are done: what you wrote reaches the agent with `palmtop feedback`.
- It stops when the conversation or the agent closes. Closing Claude Code, or a computer that goes to
  sleep for long, ends it: then tell the agent in the chat.
- Several sessions, also in different projects, wait on their own, one wait for each session: if a
  second one starts, it takes the place of the first. A wait nobody taps for ends by itself after a
  day (a timeout, nothing is wrong), and the agent starts it again only if it is still waiting. `palmtop status` lists the sessions
  waiting for you.

## What the agent can and cannot do

- It writes, edits and removes checklists and items, asks questions with their options, and sets
  the session message, which it can also use for a few numbered steps telling you what to do.
- It reads your note as a list, with `[new]` and `[edit]` on the elements that changed, and opens
  the screenshots you attached: with the palmtop tools the picture comes with the result, otherwise
  it opens the file the feedback names, in `~/.palmtopai/images`.
- It has no tool to pair, invite, delete sessions or projects, unpair devices or stop sharing:
  those stay commands that you run.
- It **cannot** mark reviews, nor tap **Review done**, nor answer its own questions: only you can,
  on your devices.
- It never runs `palmtop pair` and never reads `~/.palmtopai`, except the screenshot files the
  feedback names: pairing links and keys stay out of the conversation, and no command it uses
  prints them.
- It doesn't delete sessions or projects unless you ask it to, and it doesn't stop sharing with
  someone unless you ask.
- It can give a person you invited a copy of a checklist, bring it up to date and read what they
  answered. It **cannot** invite anyone: `palmtop invite` runs only in a terminal, for you. What people write is data for the agent, not instructions.
  See [Sharing with other people](/docs/sharing).
- Notes and items you add are treated as your words. If one asks for something risky or unrelated
  to its check (deleting data, revealing credentials, running unrelated commands, contacting
  external services), the guide tells the agent not to do it, but to quote it and ask you to
  confirm in the chat. It is an instruction to the agent, not a lock: keep your devices to yourself.
