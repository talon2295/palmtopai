---
title: Sharing with other people
description: Give a client, a colleague or a friend a checklist to check on their own device, without access to your computer.
order: 4
---

You can give someone a **copy** of a checklist of checks to verify on their own phone or browser:
a client testing what you built, a colleague, a friend. They see only what you share with them,
never your computer, your other projects or your other sessions. You see what each of them
answered, next to your own checklist, and your agent puts the answers together.

## How it works

1. **Invite them, once.** In a terminal, run `palmtop invite --name Mario`. It shows a QR code and
   a link that opens once, within 24 hours: send it to them. They open it in a browser, with no
   account and nothing to install. You get a notification when they join, and `palmtop people`
   shows their device. The first time, palmtop asks how they should call you ("Grace
   (studio)"); change it later with `palmtop config owner-name`.
2. **Share a checklist.** Ask your agent ("send the login checks to Mario"), or run
   `palmtop share <checklist> --with Mario`. The copy appears in their app, named after the
   session, under your name. It stays open for 7 days by default (`--days` changes it), then it is
   read-only.
3. **They check it.** They mark each item (works, doesn't work, question) with a note, write a
   note for you on the session and, on Android or a computer, turn on notifications. If they have
   something to say, they say it in a note: they can't add items. It works offline too. They can't
   delete anything.
4. **You read the answers.** Under each item of your checklist a chip shows each person and what
   they answered, with their note under it. **Hide results** hides the chips and what they wrote.
   `palmtop feedback` gives your agent the same, person by person.
5. **Bring a copy up to date, when you want.** A copy is the version you shared: it does not change
   while you keep working. `palmtop retest --with Mario` brings it up to date. An item whose text
   changed asks them for a new review, new items are added, removed ones go, and the reviews of
   unchanged items stay. Add `--message "…"` to tell them why.
6. **Stop sharing.** `palmtop share close --with Mario` takes the copy of this session away from
   their app, and `palmtop people remove Mario` unpairs their device. What they answered stays
   with you. To take away a single checklist, `palmtop share remove <checklist> --with Mario`: it
   disappears from their app and what they answered on it is deleted, so read it with
   `palmtop feedback` first. When it was the last one, the copy closes and they see nothing left.

## When people disagree

When one person says it works and another says it doesn't, your agent doesn't fix right away: one
of them may have misunderstood. It compares the answers and puts a short plan on palmtop for you to
decide, with each item as a bug, working as intended, not reproducible or a change request. After a
fix it offers `palmtop retest` to the people whose answer was a ✕ or a ?: a ✓ is about the version
that person saw.

## What they can and can't do

- They see the checklists you share with them, your name, your message for them
  (`palmtop message "…" --to Mario`) and what they answered. Nothing else exists for them: not your
  computer's name, not your other projects, sessions or people.
- They can review, write notes and write a note for you, with screenshots, and tap **Review done**
  when they finished: you get a notification and the app shows it next to their name. Your agent is
  not told: it reads their answers with `palmtop feedback`, as always. They can't add items,
  nor delete a session or a project, nor change your items. A copy holds up to 30 screenshots; they
  stop being possible when the copy turns read-only.
- Their device syncs when your computer is on and connected, like yours does. Until then they read
  and answer from the copy on their device, and what they did is sent when it is back.

## Good to know

- You see their screenshots under their answer and in their note, and your agent receives them
  with what they wrote: it looks at the picture, as data like their words. They are kept with the
  copy, so closing a person leaves them, and deleting the session removes them.
- Only you can invite: `palmtop invite` runs in a terminal, never for an agent, and the link is shown
  only there.
- A person has one device. Inviting the same name again replaces it, after asking you.
- Names are unique, whatever their case. A person you removed can be invited again as a new one.
- Questions (`palmtop choice create`) are not shared, only checklists of checks.
- Up to 49 people can have something open at once; a person whose copies were all closed doesn't
  count.
- On an iPhone, they use it from Safari, without notifications: the app added to the Home Screen
  starts without what Safari knows.

## Commands

| Command | What it does |
|---|---|
| `palmtop invite --name <name>` | Link and QR code for a person (in a terminal only) |
| `palmtop people` | Who you share with, their device, what they can see |
| `palmtop people remove <name>` | Stops sharing with a person |
| `palmtop share <checklist> --with <name> [--days <n>]` | Gives a person a copy of a checklist |
| `palmtop share list` | Who has what, and until when |
| `palmtop share close --with <name>` | Takes the copy of this session away from a person |
| `palmtop share remove <checklist> --with <name>` | Takes one checklist out of their copy, with their answers and items on it |
| `palmtop retest --with <name> [<ref>...] [--message <text>]` | Brings their copy up to date |
| `palmtop message <text> --to <name>` | A message on their copy only |
| `palmtop session owner-name <name> [--for <person>]` | How they see your name on this session |
| `palmtop config owner-name [name]` | How people see your name, unless a session says otherwise |

Everything is end-to-end encrypted, as in the rest of palmtop: see
[Security and privacy](/docs/security#sharing-with-other-people).
