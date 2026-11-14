---
title: Update and uninstall
description: Keep palmtop up to date, or remove it completely.
order: 9
---

## Update

```sh
palmtop update
```

Or run the [installer](/docs/getting-started#install) again.

It downloads the latest version from the relay, checks its SHA-256, replaces palmtop, updates the
skill and the tools of Claude Code and Codex if installed and restarts the daemon. `palmtop status` tells you when an update is
available. The app on your devices updates by itself. See what changed in the
[changelog](/changelog).

## Uninstall

On macOS, Linux or WSL:

```sh
palmtop stop
rm -rf ~/.claude/skills/palmtop          # Claude Code
claude mcp remove --scope user palmtop   # Claude Code tools
rm -rf ~/.agents/skills/palmtop ~/.codex/rules/palmtop.rules   # Codex
rm -rf ~/.palmtopai   # also deletes checklists and pairings
```

Then:

- remove `mcp__palmtop` and `Bash(palmtop *)` from `~/.claude/settings.json`;
- remove the lines from `# >>> palmtop mcp` to `# <<< palmtop mcp <<<` from `~/.codex/config.toml`;
- remove the `PATH` line from your shell file (`~/.zshrc`, `~/.bashrc` or `~/.bash_profile`);
- on each device, **Unpair this computer…** from the menu of the computer on the Dashboard, and
  remove the app from the home screen.

On Windows, run `palmtop stop`, then delete the folder `%USERPROFILE%\.palmtopai` and remove its `bin`
folder from the `Path` of your user (Windows Settings, search "environment variables"). The files of
your agents are in the same places as above, under `%USERPROFILE%`.
