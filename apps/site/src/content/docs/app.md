---
title: The app
description: Review checks on any device, add your own, write notes and get notified.
order: 3
---

The app is a web page at [app.palmtop.mtwa.it](https://app.palmtop.mtwa.it), an address of its own,
apart from this site: open it from the QR code of `palmtop pair`, then add it to your home screen.
It works on phones, tablets and desktop browsers.

## On the Home Screen

On a phone or tablet the app invites you to add it to the Home Screen a couple of minutes after you
pair it, and again each time you open it until you tap **Don't show again**. You can also find it
under **Install app** in the menu of the Dashboard.

- **iPhone and iPad**: tap Share (in the ⋯ menu of Safari), then **Add to Home Screen**.
- **Android**: tap **Install** in the invitation, or open the browser menu ⋮ and tap **Install
  app** or **Add to Home screen**.

The app on the Home Screen doesn't share the browser's storage on iPhone, so it isn't paired yet:
it shows a code of six letters and digits. In a terminal on your computer run `palmtop pair CODE`
with that code, answer `y`, then tap **Pair** on the device. The terminal and the device then show
the same 6-digit number: if it matches, answer `y` in the terminal and tap **Same number** on the
device. If it doesn't, answer no: nothing is paired (see [Security](/docs/security#pairing)).
**Pair a computer** on the Dashboard shows a code too, for your other computers.

## Dashboard and projects

The **Dashboard** is the home of the app: one card for each computer you paired, with its state
(**Live**, **PC offline**) and its projects, each with its sessions, its latest activity and how
many checks are still to review. A computer you just paired shows up right away, also before it
has any project. **Working now** at the top opens the project where your agent is working.

Tap a project to open it. At the top of a project:

- the house button goes back to the Dashboard;
- the title is the path **project › session**: tap the project to see the other projects of that
  computer, tap the session to see the other sessions of the project. Both open a sheet from the
  bottom with their details;
- under it, the connection badge, the name of the computer and **Follow activity**.

The app opens where you left it: with **Follow activity** on, on the project your agent is working
in.

## Archive

Put away what you are done with, without deleting it:

- **Archive a session** from the ⋯ menu of the project (**Archive this session**), or a whole
  project from the ⋯ next to it on the Dashboard (**Archive project**, which archives each of its
  sessions).
- An archived session leaves the Dashboard and its counts; a project whose sessions are all
  archived leaves the Dashboard too. It is archived on every device paired with that computer.
- The **archive button** next to the bell lists what is archived, by computer and project. Tap a
  session to open it as it is, or **Restore** to bring it back (**Restore all** for a project).
- When your agent writes to an archived session (a checklist, new checks or a message, what you
  are notified of), it comes back by itself.

Archiving needs the computer connected, and palmtop 0.20 or newer on it.

## Reviewing checks

- Tap ✓, ✕ or ? next to a check. Once marked, only the chosen mark shows: tap it to change or
  clear it.
- After marking, tap **+ Add note** to explain what happened. Clearing the mark deletes the note
  too (the app asks first). **Add screenshot** attaches a picture to the note (see
  [Screenshots](#screenshots)).
- **Hide reviewed** shows only the checks still to review, with a count at the top. An item you
  just marked stays visible for 5 seconds. Lists with nothing left to review, and questions you
  answered, move below the others.
- Changes save immediately. Offline, they wait on the device and sync when the connection is back
  (see [Offline](#offline)).
- **Review done**, at the bottom of the session, tells the agent you finished. It asks first (and
  says how many checks are not reviewed yet), then turns into "Marked as done" until the agent
  reads your review (or writes something new in the session). It needs the computer online and palmtop 0.24 on it, and it is lit only while an agent is
  waiting for it: when none is, the button is grey and says to tell the agent in the chat. Only Claude Code
  can wait for it for now: it reads your review right away. See
  [Review done](/docs/concepts#review-done).

## Answering a question

When the agent needs a decision it sends a question with its options instead of a checklist. The
options come one card at a time: swipe, or use the arrows and the dots under the card.

- Each card has the option, a couple of lines on what it means, and **Pick**, **No** and **Ask**.
  Tap the mark again to clear it; **+ Add note** explains your answer.
- Usually only one option can be chosen: choosing another moves your answer, and the one chosen
  before becomes an option you refused.
- The last card is **None of these?**: write an answer of your own and the agent takes it as the
  decision. You can delete it while the agent has not read it.
- Once answered, the question closes into a row with the option you chose, a few seconds after your
  answer so you can add a note. Tap the row to open it again.

## Adding checks and notes

- **+ Add item** at the bottom of a checklist adds something for the agent to verify or fix. Tap
  the text of an item you added to edit or delete it.
- **Note for the agent** at the bottom of the session is a list about the whole session. **+ Write
  something** adds an element, **+ Add another** the next ones; tap an element to edit or delete
  it. It says "The agent reads it with the next feedback" until the agent has read it. The agent
  gets all the elements, with `[new]` on the ones it was not given before and `[edit]` on the ones
  you changed.
- **From the agent** at the top of the session is the agent's latest message: a status, or a few
  numbered steps for what you have to do. An address in it, in a check or in a note opens in a new
  tab: `https://example.com/page` or just `example.com`. Tap **Edit** to change a note that has one.

## Text from your agent

What your agent writes (checks, the questions and options of a choice, the message at the top) is
simple markdown: the first line of a check is its **title**, in bold, and what follows is normal
text under it, with lists, *italic*, `code` and links. A link with a label shows the real address
next to it. A command or a string to take away is in a box of its own: tap the copy icon and it goes
on your clipboard exactly as written (the icon turns into a green check for a moment; on a browser
that does not allow it, the text is selected so you can copy it by hand).

Your own text is not formatted: notes, the checks and options you add and what the people you share
with write show as typed, with the addresses clickable. Images and HTML are not supported, even in
your agent's text.

## Screenshots

**Add screenshot** is under the note of a check and in each element of the note for the agent: pick
a picture from the gallery or the camera, or paste one on a computer. The app shrinks it on your
device (a photo loses where it was taken) and sends it to your computer, where your agent can open
it. It shows under the note; tap it to open it full size, **Replace** or **Remove** it while you
write.

- It needs palmtop 0.23 on the computer. A computer the app has never seen online, or an older one,
  says so under the button.
- **Offline**: with the computer off, the picture is kept on the device and counts as unsynced; it
  is sent, before the note that names it, when the computer is back. A picture you opened
  stays on the device, so it shows without the computer.
- A project keeps up to 500 screenshots; a copy shared with somebody up to 30. They go with the
  session or the project they belong to, and a picture no note names any more is removed.

## Connection status

The badge under the title shows **Live** when your computer is connected; the Dashboard shows the
same for every computer. **PC offline** means the
daemon on your computer is not reachable: the computer is asleep, off, or palmtop is not running.
The app reconnects by itself, also after a connection broken on a bad network.

- **Not paired**: the computer no longer knows this device (it was removed with
  `palmtop devices remove`). Remove it from this device and pair again.
- **Key lost**: the browser deleted the data of this app, and the key of this device with it (see
  [Offline](#offline)). The app made a new key, which your computers don't know yet: remove the
  computer from this device and pair again with `palmtop pair`. Your projects and checklists are
  safe on the computer.

## Offline

The app keeps a copy of every project you opened on this device, so it works without your
computer, and a copy of itself, so it also opens when this device has no connection:

- **Computer off or asleep, or no connection on this device**: open the app and the checklists
  are there, as the computer last sent them. The notice at the top says when: "Last synced 5 min
  ago". The app opens without a connection once it has been opened online at least once.
- **Review as usual**: marks, notes, added items, the note for the agent, screenshots and deleting
  a session all work offline. The badge counts what is waiting, for example **PC offline · 3 unsynced**.
- **Nothing is lost if you close the app**: the changes waiting are kept on the device, also after
  closing the app or restarting the phone.
- **Every change is kept, in order**: marking a check ✓, then ✕, then ? sends all three changes.
  The computer ends up with the last one, as if you had made them online.
- **When the computer is back** the app catches up with what the agent did in the meantime, then
  sends your changes. With **Follow activity** on, the app first opens the project with changes
  waiting, then moves to where the agent is working.
- **Changes on both sides**: if the agent and you change the same check while the computer is off,
  the most recent change wins, field by field (a mark and a note are separate). Changes to a
  session deleted on the computer in the meantime are dropped.

Changes are sent from the project they belong to: if you chose another project by hand, they wait
until you open that project again. A project you never opened on this device has no copy: it shows
once the computer is back.

The browser can clear what a site keeps when the device runs out of space, and Safari in a browser
tab clears it after 7 days without a visit. The app asks the browser to keep it (Firefox shows a
question the first time); on iPhone and iPad, add the app to the Home Screen, where this limit
does not apply. When the browser has not promised to keep it, a notice at the top says so once.
If the browser does clear it, the app tells you at the next start, and the computers show
**Key lost** until you pair again. Opened online, the app always uses the latest version: the copy is only for when
there is no connection. An app left open for a long time (on the Home Screen of an iPhone it
doesn't reload by pulling down) shows a yellow dot on the ⋯ of the Dashboard when a new version is
out: tap **New version available** to load it.

## Notifications

Tap the bell at the top of the Dashboard: a bell means notifications are on, a crossed-out bell
that they are off. Your devices are notified when the agent creates a
checklist, adds checks or sets a message, unless the app is on screen on that project. A locked
phone gets them too, also if the app was open when you locked it.
Notifications show the computer, the project and a title, never the text of your checks or of the
message.

- **iPhone and iPad** (iOS 16.4 or newer): notifications only work in the app added to the Home
  Screen. Tap Share, then Add to Home Screen, and open PalmtopAI from there.
- If the browser blocked notifications, allow them for the site in the browser settings.
- If the browser drops them by itself (for example when it clears the data of the app), the app
  turns them back on when you open it, as long as notifications are still allowed for the site.
- One switch per device: it covers every project of every computer you paired, also the ones not
  open at the moment.
- Notifications are not always instant: the push service of your browser or phone can deliver
  them a few minutes late, for example when the phone is saving battery. The app itself always
  shows the latest checks as soon as you open it.

## Several computers and projects

One pairing covers a whole computer: every project on it shows up, also the ones you start later.
Pair as many computers as you like: **+ Pair a computer** on the Dashboard says how. The
Dashboard lists them all, and the projects of each are sorted by activity. Rename a computer with
`palmtop config name "Work laptop"` (see [CLI reference](/docs/cli)).

**Follow activity**, under the title of a project, keeps this device on the project and the
session your agent is working in on that computer. Choosing a project or a session by hand pauses
it until you turn it back on.

## When you share a checklist

Under each item of a checklist you shared, a chip shows each person and what they answered (✓, ✕ or
?), or a dotted chip while they haven't answered; a note they wrote shows under the chips, with
their name. Under the checklists, a box says who the session is shared with and until when, and
shows the notes they wrote. When somebody taps **Review done** on their copy, the box says they
finished reviewing and you get a notification (your agent is not told: it only sees their answers,
as always). **Hide results** hides all of it; the choice is
remembered on this device. See [Sharing with other people](/docs/sharing).

## When somebody shares with you

You open the link you were sent, in a browser, and what they shared appears: a project for each
checklist, under their name. You review it like your own checks, with notes, screenshots and a
note for them. **Review done** at the bottom tells them you finished: they get a notification, and
the button comes back if they bring the copy up to date. You can't delete anything. When the date they set has passed, it turns read-only and
a banner says so; if they take it away, it leaves your list. **Remove from this device…** in the
menu of their name on the Dashboard forgets it. For a new link, ask them: each link opens once.

## Deleting and unpairing

- **Delete this session…** in the ⋯ menu of a project deletes the session shown, with its
  checklists and reviews, on the computer and on every device.
- **Delete this project…** in the same menu deletes the project on the computer and on every device:
  sessions, checklists and reviews. The folder and its files are not touched. The same as
  `palmtop projects remove` on the computer.
- **Unpair this computer…**, in the menu of the computer on the Dashboard, removes the computer,
  with all of its projects, from this device only, including the copies kept for offline use and
  the changes not synced yet. The computer revokes this device's key; if it is off, the app says
  so and `palmtop devices remove` on the computer does it later. Other devices keep working; to
  pair again, run `palmtop pair` on that computer.
- If a computer is gone for good and the app keeps showing **PC offline**, use
  **Remove from this device**.

## Feedback

**Send feedback**, in the ⋯ menu at the top of the Dashboard (or at the bottom of the first screen
before pairing), sends us a bug, a feature request or anything else, with your email so we can
reply. The same form is on the [home page](/#feedback).
