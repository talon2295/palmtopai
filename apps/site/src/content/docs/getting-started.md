---
title: Getting started
description: Install palmtop, pair your devices and review your first checks in a few minutes.
order: 1
---

## What you need

- **macOS, Linux or Windows**. On Windows it runs in PowerShell, or inside [WSL](#windows-wsl).
- **Node.js 22** or newer: check with `node --version`.
- **A coding agent**. Claude Code and Codex are set up for you, with a skill and the palmtop tools;
  any other agent works too, see [Agents](/docs/agents).
- **A phone, a tablet or another computer** with a modern browser.

## Install

Open a terminal (PowerShell on Windows) and run the command for your system. The
[home page](/) shows the right one for the computer you are reading it on.

| System | Run this | Installer |
| --- | --- | --- |
| macOS, Linux, or a [WSL](#windows-wsl) terminal | `curl -fsSL https://palmtop.mtwa.it/install.sh \| bash` | [install.sh](https://palmtop.mtwa.it/install.sh) |
| Windows, in PowerShell | `irm https://palmtop.mtwa.it/install.ps1 \| iex` | [install.ps1](https://palmtop.mtwa.it/install.ps1) |

An agent that has to install palmtop for you can read [install.md](https://palmtop.mtwa.it/install.md).

### macOS, Linux and WSL

```sh
curl -fsSL https://palmtop.mtwa.it/install.sh | bash
```

The installer checks your system, downloads palmtop into `~/.palmtopai/bin` and verifies its
SHA-256, then asks:

1. **Which agents should use palmtop**: Claude Code and Codex, the ones installed on this
   computer. It adds the palmtop skill, the palmtop tools (an MCP server) and the permissions to use
   them, and backs up the files it changes. See [Agents](/docs/agents).
2. **Whether to add palmtop to your `PATH`**, at the end of your shell file (`~/.zshrc`,
   `~/.bashrc`, `~/.bash_profile` on macOS, or a file in fish's `conf.d`), after a backup. Only if
   `palmtop` isn't on your `PATH` yet.
3. **Whether to pair a device now**: it shows a QR code, see [Pair your devices](#pair-your-devices).

Then open a new terminal and start Claude Code or Codex in your project.

- Run the installer again to update palmtop, or `palmtop setup` to set up an agent you installed
  later.
- An agent that isn't installed can't be chosen. To set it up anyway:
  `curl -fsSL https://palmtop.mtwa.it/install.sh | bash -s -- --force-agents-install`.
- It never uses `sudo`. [Read the script](https://palmtop.mtwa.it/install.sh) before
  running it if you like.
- Run by an agent or a script (no terminal), it asks nothing: it sets up the agents it finds and
  prints the steps left to you, including the `PATH` line.

### Windows (PowerShell)

```powershell
irm https://palmtop.mtwa.it/install.ps1 | iex
```

It needs Windows PowerShell 5.1 or newer (the one every Windows has, or PowerShell 7) and Node.js
22 or newer. The installer downloads palmtop into `%USERPROFILE%\.palmtopai\bin`, verifies its SHA-256 and then runs
`palmtop setup`, which asks:

1. **Which agents should use palmtop**, as above.
2. **Whether to add palmtop to your `Path`**: the user's own variable, not the system's, with the
   old value saved in `%USERPROFILE%\.palmtopai\path-backup-*.txt`. It also writes `palmtop.cmd`
   next to the program, which is what your terminal runs.
3. **Whether to pair a device now**.

Then open a new terminal and start Claude Code or Codex in your project.

- Run the installer again to update palmtop.
- To pass an option to `palmtop setup`:
  `& ([scriptblock]::Create((irm https://palmtop.mtwa.it/install.ps1))) --force-agents-install`.
- It never asks for administrator rights, and it doesn't close your PowerShell window.
  [Read the script](https://palmtop.mtwa.it/install.ps1) before running it if you like.
- Run by an agent or a script (no terminal), it asks nothing: it sets up the agents it finds and
  prints the steps left to you, including the PowerShell line for the `Path`.
- The folder `%USERPROFILE%\.palmtopai` is limited to your Windows user and to the system.

## Install by hand

On macOS, Linux or WSL:

```sh
mkdir -p ~/.palmtopai/bin && cd ~/.palmtopai/bin
curl -fsSL https://palmtop.mtwa.it/palmtop.mjs -o palmtop.mjs
chmod +x palmtop.mjs && ln -sf palmtop.mjs palmtop
./palmtop setup   # agents, PATH and pairing, as the installer does
```

On Windows, in PowerShell:

```powershell
$dir = "$env:USERPROFILE\.palmtopai\bin"
New-Item -ItemType Directory -Force $dir | Out-Null
Invoke-WebRequest -UseBasicParsing https://palmtop.mtwa.it/palmtop.mjs -OutFile "$dir\palmtop.mjs"
node "$dir\palmtop.mjs" setup   # palmtop.cmd, Path, agents and pairing, as the installer does
```

The checksum to compare with is in [version.json](https://palmtop.mtwa.it/version.json).

## Windows (WSL)

If you work in WSL (Windows Subsystem for Linux), palmtop runs there as a Linux tool, and the command for
macOS and Linux above is the one to use. To get WSL, from PowerShell:

```powershell
wsl --install
```

Open the Ubuntu terminal it installs, then do everything else **inside WSL**: Node.js 22, palmtop
and your coding agent too. Start the agent from the WSL terminal: one started from PowerShell or
from a Windows app doesn't see the `palmtop` command and can't put checks on your devices.

- Install Node.js 22 in WSL (for example with [nvm](https://github.com/nvm-sh/nvm)), not on Windows.
- Run the installer from the WSL terminal.
- `palmtop pair` opens the QR page in your Windows browser from WSL. If nothing opens, copy the
  link it prints into the browser.

## Pair your devices

The installer offers to pair a device. To pair one later, or another one, open a terminal and run:

```sh
palmtop pair
```

A QR code opens, scan it with your phone or tablet: the app opens
already paired with this computer, and shows every project on it — including the ones you start
later. On a phone, add the page to your home screen so it feels like an app.

- The QR page works once and expires after a minute: run `palmtop pair` again if needed.
- To use the app in a browser on the same computer, click **Open on this computer**.
- Pair once per device and per computer. Each device needs its own QR code.
- App added to the Home Screen: it shows a code instead. Run `palmtop pair CODE` with that code,
  then check that the terminal and the device show the same number, see
  [On the Home Screen](/docs/app#on-the-home-screen).
- Everything between your computer and your devices is end-to-end encrypted: see
  [Security and privacy](/docs/security).

## Your first checks

Ask your agent for something and for the checks, for example:

```text
implement the plan and put the checks on palmtop
```

The agent does the work, then writes a checklist of things for you to test. Your devices show it
live (and notifies you, if you [turned notifications on](/docs/app#notifications)). Try each check
and mark it:

| Mark | Meaning |
|---|---|
| ✓ | It works. A note can confirm, or ask for a change |
| ✕ | It doesn't work. A note can say what happens, or ask to remove the feature |
| ? | You need more information. The agent explains, without changing code |

Leave a check unmarked if you didn't test it. See [review statuses](/docs/concepts#review-statuses)
for what the agent does with each mark and note. When you are done, tap **Review done** at the bottom of the
session (Claude Code picks your review up by itself; other agents are not supported yet), or tell
the agent in the chat, for example "I reviewed the checks on palmtop", or just "Done". It reads your review, fixes
what doesn't work and asks you to check those items again.

Next: learn the [concepts](/docs/concepts) behind projects, sessions and reviews.
