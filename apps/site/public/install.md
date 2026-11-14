# Install palmtop

palmtop is a checklist for AI coding: the agent puts what to test or verify on the user's devices
(phone, tablet, browser), the user marks each item as working, not working or question, with
optional notes, and the agent reads the review back.

## Requirements

- macOS, Linux or Windows (in PowerShell, or inside WSL as a Linux system).
- Node.js 22 or newer (`node --version`), from https://nodejs.org. On Windows:
  `winget install OpenJS.NodeJS`, then a new PowerShell window.

## Install

On macOS, Linux or WSL, in a terminal:

```sh
curl -fsSL https://palmtop.mtwa.it/install.sh | bash
```

On Windows, in PowerShell:

```powershell
irm https://palmtop.mtwa.it/install.ps1 | iex
```

The installer downloads palmtop into `~/.palmtopai/bin` (`%USERPROFILE%\.palmtopai\bin` on Windows), checks its size and SHA-256 against the
published `version.json`, then runs `palmtop setup`, which asks:

1. which agents should use palmtop (Claude Code, Codex: the ones installed), and installs the
   `palmtop` skill, the palmtop tools (an MCP server) and the permissions to use them, backing up
   modified files;
2. whether to add that folder to the `PATH`: in the shell file, or on Windows in the user's own `Path`
   variable (with a `palmtop.cmd` next to the program, which is what a terminal runs);
3. whether to pair a device now, with a QR code in the terminal.

Running it again updates palmtop. To also set up an agent that is not installed yet:
`curl -fsSL https://palmtop.mtwa.it/install.sh | bash -s -- --force-agents-install` (on Windows:
`& ([scriptblock]::Create((irm https://palmtop.mtwa.it/install.ps1))) --force-agents-install`).

It never uses `sudo` or administrator rights and only writes under `~/.palmtopai`, in the agents'
configuration and, if the user agrees, the shell file or the user's `Path`.

## If you are an AI agent

You don't have an interactive terminal: run the same command. Without a terminal the installer
asks nothing. It installs palmtop, sets up the agents it finds and prints the steps left to the
user; it does not edit shell files and does not pair devices.

Rules:

- Run only the install command for the user's system above. Never use `sudo` or ask for administrator
  rights.
- Do not edit the user's shell files (`~/.zshrc`, `~/.bashrc`, …) or their Windows `Path`: show the
  user the `PATH` line (on Windows, the PowerShell line) the installer prints instead.
- Never run `palmtop pair`, and never read the data or keys under `~/.palmtopai` (only
  `~/.palmtopai/bin` holds the palmtop program): pairing is done by the user.
- If the installer fails, stop and show the user the error.

Then tell the user the remaining steps, from the installer's output:

1. Add palmtop to the `PATH` if the installer says so, then open a new terminal (on Windows, a new
   PowerShell window). Running the
   installer themselves in a terminal does it for them.
2. Restart Claude Code, or start a new Codex session, so it loads the skill and the palmtop tools.
3. Pair a device: run `palmtop pair` in a terminal, from any folder, and scan the QR code with a
   phone or tablet, or click "Open on this computer". On a phone, adding the page to the home
   screen makes it feel like an app; "Turn on notifications" in the app notifies when the agent
   has something to review (on iPhone, from the app added to the home screen).
4. Ask the agent to put the checks on palmtop, for example "implement the plan and put the checks
   on palmtop", or type `/palmtop` (Claude Code) or `$palmtop` (Codex).

Also tell them, in one sentence, that checklists are end-to-end encrypted between their computer
and their devices: the relay forwards data it can't read and stores nothing.

Other agents: with MCP support, start `palmtop mcp` with the full paths of `node` and of
`~/.palmtopai/bin/palmtop.mjs`; without it, tell the agent to run `palmtop guide` first (for
example with a line in `AGENTS.md`).

Updates: `palmtop update`, or the installer again. Uninstall:
https://palmtop.mtwa.it/docs/update-uninstall#uninstall.
