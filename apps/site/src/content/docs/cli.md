---
title: CLI reference
description: Every palmtop command, for you and for your agent.
order: 6
---

Run `palmtop --help` for the same list. Commands start the daemon when it isn't running.

## Daemon and setup

| Command | What it does |
|---|---|
| `palmtop status` | Daemon, relay, project, connected devices and session. Shows "Update available" and the sessions an agent is waiting in. |
| `palmtop pair` | Pairs a device with this computer: QR code in the terminal and in the browser |
| `palmtop pair CODE` | Pairs the app added to a Home Screen, which shows CODE. Only in a terminal, after you confirm and check that the device shows the same number |
| `palmtop devices` | Devices paired with this computer: when each was last seen, and whether it is connected |
| `palmtop devices remove <name\|id>` | Revokes a device: it is disconnected and can't connect again |
| `palmtop serve` | Runs the daemon in the foreground |
| `palmtop serve -b` | Starts the daemon in the background and returns (`--background`) |
| `palmtop stop` | Stops the daemon |
| `palmtop update` | Installs the latest palmtop, updates the skill and restarts the daemon |
| `palmtop version` | Version and build (also `--version`) |
| `palmtop config name [name]` | Shows or sets the name of this computer on your devices |
| `palmtop config name --reset` | Goes back to the host name |
| `palmtop setup` | Sets up palmtop, as the installer does: agents (Claude Code, Codex), `PATH`, pairing. Without a terminal it asks nothing and prints the steps left |
| `palmtop setup --force-agents-install` | Also sets up agents that are not installed yet |
| `palmtop guide` | Prints the instructions for AI agents |
| `palmtop mcp` | The MCP server of your agent, on standard input and output. The agent starts it: you don't need to run it |

## Sessions and projects

| Command | What it does |
|---|---|
| `palmtop session start [title]` | Starts a session and prints its 6-character ref |
| `palmtop session list` | Sessions of the project |
| `palmtop session title <title>` | Renames the session |
| `palmtop sessions` | Sessions of every project on this computer (`[archived]`: archived on a device, `[done]`: you tapped Review done) |
| `palmtop sessions delete <ref>` | Deletes a session everywhere, with its checklists |
| `palmtop projects` | Projects on this computer |
| `palmtop projects remove <name\|path>` | Removes a project with its sessions, on the computer and on your devices |

Deleting asks for confirmation in a terminal; without a terminal pass `--yes`.

## Checklists (need `--session`)

An agent that has the palmtop tools doesn't type these commands (see [Agents](/docs/agents)): they
are for you, for scripts and for agents without the tools.

| Command | What it does |
|---|---|
| `palmtop checklist create <title> --item <text>...` | Creates a checklist with its items |
| `palmtop checklist rename <ref> <title>` | Renames a checklist |
| `palmtop checklist remove <ref>` | Removes a checklist |
| `palmtop choice create <question> --option <text> [--detail <text>]...` | Asks you to choose between options |
| `palmtop add <text> [--checklist <ref>]` | Adds an item (default: latest checklist of checks) |
| `palmtop edit <ref> <text> [--detail <text>]` | Changes the text of an item (clears its review) |
| `palmtop remove <ref>` | Removes an item |
| `palmtop show` | Checklists with review status and notes |
| `palmtop wait` | Waits until you tap **Review done**, then exits: for Claude Code, which runs it in the background (other agents are not supported yet, see [Agents](/docs/agents#waiting-for-your-review)). Exit `0` you are done, `3` the session is gone, `4` the daemon stays away, `5` another wait took its place, `6` timeout: a day went by without a tap, nothing is wrong |
| `palmtop message <text>` | Shows a message at the top of the session |
| `palmtop message --clear` | Removes the message |
| `palmtop feedback` | Reviews changed since the last feedback, and items not reviewed yet |

A text starting with `-` works after `--item`; as a positional argument put `--` before it:
`palmtop add --session k3m9qz -- "--dry-run flag"`.

A question is a list of its own: its title is the question and its items are the options, each with
an optional `--detail` of one or two lines. Every `--detail` belongs to the `--option` before it,
and `--multiple` lets you choose more than one option. The other commands work on it: `palmtop add
--checklist <ref>` adds an option, `palmtop remove <ref>` removes one, `palmtop checklist remove
<ref>` removes the whole question.

```bash
palmtop choice create "Which way for the offline cache?" --session k3m9qz \
  --option "IndexedDB" --detail "Survives a restart, one more schema to migrate" \
  --option "Memory only" --detail "Simplest, the queue is lost when the app closes"
```

## Sharing with other people

| Command | What it does |
|---|---|
| `palmtop invite --name <name>` | Link and QR code for a person; opens once, within 24 hours. In a terminal only, never with `--json` |
| `palmtop people` | The people you share with, their device and how many copies they have |
| `palmtop people remove <name>` | Stops sharing with a person: their device is unpaired |
| `palmtop share <checklist> --with <name> [--days <n>]` | Gives a person a copy of a checklist of checks (needs `--session`) |
| `palmtop share list` | Who has what, and until when |
| `palmtop share close --with <name>` | Takes the copy of this session away from a person |
| `palmtop share remove <checklist> --with <name>` | Takes one checklist out of their copy, with their answers and items on it |
| `palmtop retest --with <name> [<ref>...] [--message <text>]` | Brings their copy up to date with yours |
| `palmtop message <text> --to <name>` | A message shown on that person's copy only |
| `palmtop session owner-name <name> [--for <person>]` | How people see your name on this session (`--clear` takes it back) |
| `palmtop config owner-name [name]` | How people see your name, unless a session says otherwise (`--reset` removes it) |

See [Sharing with other people](/docs/sharing).

## Options

| Option | Meaning |
|---|---|
| `--session <ref>` | Session ref printed by `session start` (default: `$PALMTOP_SESSION_ID`) |
| `--project <path>` | Project directory (default: current directory) |
| `--json` | JSON output |
| `--with <name>`, `--to <name>`, `--for <person>`, `--name <name>`, `--days <n>`, `--message <text>` | The person, and the details of the sharing commands |
| `-y`, `--yes` | Delete without asking for confirmation |
| `-b`, `--background` | With `serve`: start the daemon in the background |
| `-h`, `--help` | Help |

Refs accept a prefix of at least 4 characters. Exit codes: `0` ok, `1` error, `2` wrong usage.

## Environment

| Variable | Meaning |
|---|---|
| `PALMTOP_SESSION_ID` | Default for `--session`: `export PALMTOP_SESSION_ID=<ref>` in a terminal (in PowerShell `$env:PALMTOP_SESSION_ID = '<ref>'`) to run session commands by hand without repeating it. Agents always pass `--session` |
| `PALMTOP_HOME` | Data directory instead of `~/.palmtopai` (`%USERPROFILE%\.palmtopai` on Windows) |

Use the same values in every terminal: the daemon started automatically inherits the environment of
the first command.
