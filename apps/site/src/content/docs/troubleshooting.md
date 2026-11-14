---
title: Troubleshooting
description: Fixes for the most common problems.
order: 8
---

Start with `palmtop status` in your project: it shows the daemon, the relay connection, the
project, the connected devices and whether an update is available.

## The app says "PC offline"

The daemon on your computer is not connected to the relay. You can keep reviewing the projects you
opened before: changes wait on the device and sync when the computer is back (see
[Offline](/docs/app#offline)).

- Is the computer awake? Run `palmtop status`: `Daemon: not running` means it stopped, for
  example after a restart of the computer. Start it again with `palmtop serve -b` (it runs in the
  background, like when the agent starts a session).
- `Relay: connecting` or `disconnected`: check the internet connection of the computer.
- Did you delete `~/.palmtopai`, or is that computer gone for good? The app can't tell and keeps
  waiting: use **Remove from this device** and pair again. A project deleted on the computer, on
  the other hand, simply leaves the list on your devices.

## "Palmtop on your computer is out of date"

The app is newer than palmtop on your computer. Run `palmtop update`.

## "Update available" or "Relay: refuses this palmtop version"

Run `palmtop update`. It downloads the new version, checks it, updates the skill of your agents
and restarts the daemon.

## After updating to 0.18, the app asks to pair again

Version 0.18 brought end-to-end encryption and moved the app to
[app.palmtop.mtwa.it](https://app.palmtop.mtwa.it): pairings made before don't work any more.
Update palmtop on each computer (`palmtop update`), then pair each device once more with
`palmtop pair`. Your projects and checklists stay on the computer.

## "This device is no longer paired"

The computer removed this device (`palmtop devices remove`). Tap **Remove from this device**, then
pair it again with `palmtop pair`.

## "Key lost" or "This device lost its key"

The browser deleted the data of the app, and the key of this device with it, usually because the
device is low on space. The app made a new key, which your computers don't know: on each computer
marked **Key lost**, tap **Remove from this device**, then pair again with `palmtop pair`. Your
projects and checklists are on the computer, nothing is lost there.

To make it less likely: free some space, and add the app to the Home Screen.

## Notifications turn off by themselves

The browser dropped the subscription, for example when it cleared the data of the app. Open the
app: it turns them back on by itself while notifications are allowed for the site. If the bell
stays crossed out, tap it.

## The numbers don't match

When you pair with a code, the terminal and the device must show the same 6-digit number. If they
don't, answer no on both sides: nothing is paired. Try again with a new code; if the numbers still
differ, pair with the QR code of `palmtop pair` instead.

## "Open palmtop with its https:// address" or "This browser is too old"

End-to-end encryption uses the browser's own cryptography, which browsers offer only on a secure
page (`https://`) and from Safari 17, Chrome 137 or Firefox 130 on. Open
[app.palmtop.mtwa.it](https://app.palmtop.mtwa.it), or update the browser.

## "That invitation is not valid any more"

An invitation opens once, within 24 hours. Ask the person who sent it for a new one (they run
`palmtop invite --name <you>` again, which replaces your device if you had one).

## "Pairing link expired"

The QR page works once and for one minute. Run `palmtop pair` again, from any folder.

## "That pairing link is not valid"

The link was cut or changed. Scan a new QR code from `palmtop pair`.

## A screenshot does not send or does not show

- **"Needs the computer to be online once"**: the app has not seen this computer with palmtop 0.23.
  Open the app with the computer on, or run `palmtop update` on it.
- **"This computer needs `palmtop update` to take screenshots"**: the computer runs an older palmtop.
- **"Screenshot not available while the computer is offline"**: this device never opened that picture
  and the computer is off. It shows once the computer is back.
- **"This project holds as many screenshots as it can"**: remove old sessions or screenshots; a
  copy shared with somebody holds fewer than a project.
- **A picture "is too detailed to be sent"**: pick a smaller one; the app shrinks it to about 140 KB.

## The agent doesn't use palmtop

- Claude Code: run `palmtop setup`, then restart Claude Code. Ask explicitly, for example "put the
  checks on palmtop", or type `/palmtop`.
- Codex: run `palmtop setup`, then start a new Codex session. Ask explicitly, or type `$palmtop`.
- The palmtop tools are missing: run `palmtop setup` and restart the agent. In Claude Code,
  `claude mcp list` shows `palmtop` as `Connected`. If you changed your Node.js version (with nvm,
  for example), run `palmtop setup` again: it points the tools to the Node.js on your `PATH`.
- Other agents: tell them to run `palmtop guide` first (see [Agents](/docs/agents)).
- `palmtop: command not found`: `~/.palmtopai/bin` is not in your `PATH`, see
  [Getting started](/docs/getting-started#install-by-hand).

## The agent doesn't notice that I tapped Review done

- It only does if it is waiting, and only Claude Code can for now: other agents (Codex included) are
  not supported, and a conversation where the wait ended (the agent was closed, or you told it to
  go on) has to be told in the chat. The button turns into "Marked as done" either way.
- The button is grey: it needs the computer online and palmtop 0.24 on it (`palmtop update`), and an
  agent waiting for it. If it says the agent is not waiting, tell the agent in the chat, or ask it to
  wait for your tap (`palmtop status` lists the sessions somebody waits in).
- `palmtop wait` ended with `4`: the daemon was not running for two minutes. Start it
  (`palmtop serve -b`) and the agent starts the wait again.
- `palmtop status` lists the sessions an agent is waiting in. A wait ends by itself at your tap, when
  the session is deleted, when a newer wait takes its place (code `5`) and after a day without a tap
  (code `6`, a timeout: nothing is wrong, and the agent starts it again only if it is still
  waiting): none stays for ever.

## Agent errors

| Error | Meaning |
|---|---|
| `no session yet` | The agent didn't start a session in this conversation: it starts one, or picks one with `session_list` |
| `no session: pass --session <ref>` | A command without the tools: the agent forgot `--session <ref>` |
| `palmtop was updated since this conversation started` | Restart the conversation (or the agent) to use the new version |
| `the palmtop daemon is older than this palmtop` | Run `palmtop serve -b` in a terminal, then try again |
| `no session "<ref>" in this project` | The session was deleted, for example from one of your devices |
| `no palmtop project in <path> yet` | Nothing was started in this folder: `palmtop session start` first |

## The daemon doesn't start

Check `~/.palmtopai/daemon.log`, and that `node --version` is 22 or newer. `port 4318 is used by another
daemon` means a palmtop started with a different `PALMTOP_HOME` is running: use the same
environment in every terminal.

## On Windows

- **`palmtop` is not recognized**: open a **new** PowerShell window; the `Path` of a window already
  open doesn't change. If it still isn't found, the installer or `palmtop setup` printed a
  PowerShell line to add `%USERPROFILE%\.palmtopai\bin` to your `Path`: run it, then open a new
  window.
- **The installer says Node.js is missing or too old**: `winget install OpenJS.NodeJS` (or
  `winget upgrade OpenJS.NodeJS`), then open a new PowerShell window and run the installer again.
  Any version from 22 on works.
- **`local port 4318 is not available to this user`**: Windows can keep ranges of ports for itself
  (Hyper-V, WSL, Docker). Put another port in `%USERPROFILE%\.palmtopai\config.json`, for example
  `{ "localPort": 47318 }`, and run the command again.
- **An update or a write fails with "access denied" or "busy"**: an antivirus or the file indexer is
  holding the file for a moment. palmtop tries again by itself; if it still fails, run the command
  again.
- **The daemon stops when I restart the PC**: that's expected. The next command that needs it
  starts it again.
- **`could not limit … to your Windows user`** in `daemon.log`: palmtop couldn't narrow the permissions
  of its folder (`icacls`). The daemon works anyway, with the permissions your profile folder
  already has.

## Notifications don't arrive

- Turn them on from the ⋯ menu of the project, on each device.
- iPhone and iPad: open the app from the Home Screen, not from Safari.
- They are not sent while the app is open on screen.
- Blocked in the browser: allow notifications for the site in the browser settings.
