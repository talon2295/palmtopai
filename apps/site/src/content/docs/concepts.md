---
title: Concepts
description: Projects, sessions, checklists and the review loop between you and your agent.
order: 2
---

## The review loop

1. **You ask** the agent for some work and for the checks, in the chat.
2. **The agent writes checks**: one thing to test per item, with what should happen.
3. **You test** and mark each item on any of your devices, with notes where useful.
4. **You tell the agent** you are done: tap **Review done** in the app, or say so in the chat.
5. **The agent reads the review** with `palmtop feedback`, fixes what doesn't work, answers your
   questions and asks you to check again.

### Review done

**Review done** sits at the bottom of a session, after your note. It asks first, and says how many
checks are still not reviewed. Once you confirm, the button turns into "Marked as done" and stays
that way until the agent reads your review, when it comes back: you can tap again if you have more
to check.

What happens next depends on your agent. Claude Code waits for your tap with `palmtop wait` and
reads your review by itself, with no message from you. This works only with Claude Code for now:
other agents (Codex included) are not supported, tell them in the chat, as before. See
[Agents](/docs/agents#waiting-for-your-review).

Tapping **Review done** needs the computer online, and it is lit only while an agent is waiting
for it: if none is, the button is grey and tells you to say it in the chat. This way a tap never goes
nowhere. It also tells the
agent you are done with the list as it is: checks you left unmarked are read as skipped, not as passed.

## Projects

A project is a folder on your computer: the root of the git repository, or the current folder
outside git. It is created the first time an agent starts a session in that folder.

You pair a device with a **computer**, once, and it sees every project of that computer, including
the ones started later. On your devices a project is shown as `COMPUTER - project`, for example
`MacBook - my-app`, and the project list is sorted by what happened last.

## Sessions

The agent starts a session for each conversation (`palmtop session start`), with a short title.
Two agents working in the same project at the same time have separate sessions. The app follows the
work: it shows the project and the session with the latest activity, wherever your agent is
working. Pick a project or a session by hand and it stops following until you turn
**Follow activity** back on.

Sessions stay until you delete them, from any device (⋯ menu, **Delete this session…**) or with
`palmtop sessions delete`. Deleting removes its checklists and reviews everywhere.


## Checks and questions

The agent writes two kinds of list in a session:

- a **checklist**: things to verify one by one, each with its mark and its note;
- a **question** (`palmtop choice create`): one thing to decide, with the options to choose from.
  The options are shown one card at a time, with a couple of lines on what each one means. Answer
  each one (**Pick**, **No**, **Ask**) with a note if useful, or write an answer of your own on
  the last card. Usually only one option can be chosen; the agent can also ask for more than one.

Once a question is answered it closes into a row with the option you chose; tap the row to open it
again and change your answer. The agent reads your answer with the rest of the review.

## Review statuses

The mark says whether a check works, and on the options of a question it is your answer: **✓** is
the option you chose, **✕** one you refuse and **?** one to explain before you decide. The note,
when you write one, tells the agent what to do.

**✓ It works** (`works` in the CLI)
- No note, or a confirmation like "ok": nothing to do.
- A change or an extra, like "dim the button while loading": the agent does it.
- A partial problem, like "works, but no notification arrives": the agent fixes that part.

**✕ It doesn't work** (`fails` in the CLI)
- A note saying what happens, why it fails or how to fix it: the agent uses it to fix the problem.
- A partial result: the agent fixes the part that doesn't work.
- "Remove this feature", even if it works: the agent removes it.
- "Didn't try it": counts as not reviewed.
- No note: the agent asks you what happened before changing code, unless the cause is obvious.

**? Question** (`question` in the CLI)
- No note: you want more information, for example you didn't understand the check. The agent
  explains it.
- With a note: the agent answers it.
- The agent doesn't change code for a question, unless the note asks it to.

**No mark** (`not reviewed` in the CLI): not tried yet. Never treated as passed.

After fixing or changing something because of your review, the agent edits the check and says what
changed: it comes back to review on your devices.

After a fix the agent asks you to check the item again. Tap the chosen mark again to clear it. If
the agent changes the text of a reviewed item, the review is cleared: you check the new text again.

## Notes and messages

- **Note on a check**: what went wrong, or your question. It can have a screenshot.
- **Note for the agent**: one per session, at the bottom of the session, about the whole work. It
  is a list of elements you add and edit one at a time, each with an optional screenshot. The agent
  reads it with the next feedback, and sees which elements are new and which you edited.
- **Items you add**: **+ Add item** at the bottom of a checklist. The agent reads them as requests:
  something more to verify or fix.
- **Message from the agent**: a short, read-only status at the top of the session, for example
  "Login fixed: 4 checks for you", or a few numbered steps for what you have to do and in which
  order. Addresses in it, in checks and in notes open when tapped. The text your agent writes is
  simple markdown (a bold title, lists, links, a box with a copy button for commands); what you
  write stays plain.

## Sharing

A checklist of checks can also go to other people, as a copy of their own: a client, a colleague, a
friend. They check it on their device and you see their answers next to yours. See
[Sharing with other people](/docs/sharing).

## Feedback

`palmtop feedback` shows the agent what changed since it last read: new or changed reviews, items
you added, your note for the agent when it is new, and the items still to review. Each review is
reported once, unless you change its mark or its note.
