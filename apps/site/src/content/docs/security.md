---
title: Security and privacy
description: How palmtop encrypts your checklists end to end, what the relay sees and how pairing is protected.
order: 7
---

palmtop keeps your data on your computer, and since version 0.18 everything between your computer
and your devices is **end-to-end encrypted**: only they can read your checklists. The relay
forwards data it can't read, and stores nothing.

## How it works

```text
Your computer                      Relay                        Your devices
agent ─ palmtop CLI                forwards sealed data         web app
          │  127.0.0.1             over TLS, one room           paired with
          ▼                        per computer                 a QR code
      palmtop daemon  ◄── wss ───►                ◄── wss ───►
      ~/.palmtopai                                              its own key
```

- **Your computer** keeps everything: checklists, reviews and notes live in `~/.palmtopai`
  (directories `700`, files `600`; on Windows the folder is limited to your user and to the system,
  with `icacls`). The daemon listens only on `127.0.0.1`; the CLI talks to it with
  a local key.
- **The relay** (`palmtop.mtwa.it`) forwards encrypted messages between the daemon and your
  devices. It keeps rooms and pairing codes in memory only and stores nothing on disk. It connects
  out from your computer: nothing on your network is opened.
- **Your devices** run the app at `app.palmtop.mtwa.it`, each with a key of its own, see
  [below](#on-your-devices).

## End-to-end encryption

Every connection between a device and your computer starts with a handshake through the relay:

1. The computer proves it holds the key of its room, the one the device saw when it paired. A
   relay pretending to be your computer fails here.
2. The device proves it holds its own key, the one your computer registered when it paired. A
   device that was never paired, or was removed, fails here.
3. Both sides derive fresh keys for this connection only, and from then on every message is sealed:
   checklists, reviews, notes, project names, notification settings, everything.

The relay sees the handshake (public keys and signatures) and then only sealed frames. A frame
changed, repeated, dropped or sent out of order is refused, and the connection closes.

It uses only the browser's own cryptography (WebCrypto), no library: Ed25519 signatures, an X25519
key exchange at every connection (an old connection stays secret even if a key leaks later),
HKDF-SHA-256 and AES-256-GCM. That needs Safari 17, Chrome 137, Firefox 130 or newer, and the app
says so on an older browser.

## What the relay sees

The relay can't read what you send, and it keeps nothing: nothing is written to disk. Like any
server that carries traffic, it only knows how messages travel:

- IP addresses, when devices connect, and the size and rate of messages;
- the room id of each computer and how many devices are connected to it, and the rooms of the
  people you share with ([Sharing](#sharing-with-other-people)), which it counts apart from
  computers; it doesn't know who they are or what is shared;
- the name of the computer while it delivers a pairing code (see [Pairing](#pairing)).

Its logs record only connections (IP address, time, the first characters of a room id), never
message contents, keys or query strings.

What your agent writes is also part of your conversation with it, so its model provider sees it,
as it sees the rest of that conversation.

## On your devices

The app lives at its own address, `app.palmtop.mtwa.it`, so its storage is apart from the site's.

- **The device key** is made in the browser and kept in IndexedDB as a key that **can't be copied
  out** (`extractable: false`): a page or extension can't read it, and it is only usable while the
  app is open. If the browser deletes it (for example when space runs low), the app makes a new
  one and says so: the device pairs again, and the old key is gone for everyone.
- **Each pairing** is kept in `localStorage`: the id and name of the computer, its room on the
  relay, its public key and the names of its projects. Nothing secret: without the device key it
  opens nothing.
- **A copy of each project you opened** stays on the device, so the app works while the computer
  is off (see [Offline](/docs/app#offline)): sessions, checklists, reviews and notes, plus the
  changes not synced yet. Like the data of any app, it is protected by your device: its lock and
  disk encryption, and the browser, which keeps it apart from every other site.
- A service worker keeps a copy of the app itself (its page, scripts and styles, no checklists) so
  it opens without a connection.
- The app loads no third-party scripts, no analytics and no ads, and forbids any other script with a
  strict Content Security Policy (`script-src 'self'`).
- The pairing link is removed from the address bar as soon as it is used, so it doesn't stay in
  the history.
- When it connects, the app sends the relay an anonymous random id for statistic purposes. It is
  not the id the app uses with your computer, and it says nothing about you or your projects.

## Pairing

- **A pairing is with a computer**, not with a single project: a paired device sees every project
  of that computer, including the ones started later. Pair only devices you trust with all of it.
- **With a QR code**, the link carries a single-use key (valid five minutes) in the URL fragment
  (`#…`), which browsers never send to servers. The device proves it knows the key without sending
  it, and the app removes it from the address bar. The relay never sees the key, so it can't take
  part in the pairing.
- The QR page is served only on `127.0.0.1`, opened with a one-time code that expires after a
  minute. `palmtop pair` also shows the QR code in the terminal, never in a pipe or to an agent,
  and revokes the key when you close it.
- **The app on the Home Screen pairs with a code** it shows (six letters and digits, changed every
  five minutes and after each use). `palmtop pair CODE` sends a single-use key to the device
  showing the code. To make sure nothing in between takes part, **the terminal and the device show
  the same 6-digit number**, and both ask you to confirm it: anything in the middle would make the
  two numbers different. Answer no on either side if they don't match, and nothing is paired.
- `palmtop pair CODE` works only in a terminal and asks you first: an agent can't run it, so text
  in a repository can't trick it into pairing someone else's device.
- **The agent never sees pairing links or keys**: no command it uses prints them, and the guide
  forbids running `palmtop pair` or reading `~/.palmtopai`.

## Sharing with other people

A person you [share with](/docs/sharing) gets a **room of their own**, with its own key, apart from
your computer's: their device can reach the copies made for them and nothing else, so it learns
nothing of your computer, your other projects, sessions or people, not even their names. Their
messages are end-to-end encrypted like yours.

- **Only you invite**, in a terminal: `palmtop invite` shows a link that opens once, within 24 hours,
  and never to an agent. The link carries a single-use key in the fragment (`#…`), which browsers
  never send to servers. Whoever opens it first gets the device, and you see its name in
  `palmtop people` and when you share, and can remove it.
- **A person sees only their copies**: they can review and write notes on them, but not
  add items, delete a session or a project, nor change your items. A copy turns read-only at its date and
  disappears when you close it.
- **One device for each person.** Inviting again replaces it; `palmtop people remove` unpairs it
  and takes its copies away. What they answered stays with you.
- **Notifications** to them carry only your name and a title, never the text of your checks.
- Text written by a person is data for your agent, not instructions: the guide tells it so. So is a
  screenshot they attach.
- A screenshot a person attaches is stored on your computer, in the folder of their copy, and goes
  with it.

## Screenshots

A screenshot you attach is shrunk and re-encoded on your device (the location of a photo is left
out) and sent to your computer like everything else, end-to-end encrypted. It is stored there as a
file in `~/.palmtopai/images`, readable only by you, never in the log of your checklists and never
on the relay. It goes with its session or project, and with the copy of a person it came from. Your
agent can open the files the feedback names, nothing else in that folder.

## Removing a device

- `palmtop devices` lists the devices paired with this computer, when each was last seen and
  whether it is connected now.
- `palmtop devices remove <name|id>` revokes one: its key and its notifications are deleted on the
  computer, it is disconnected at once and can't connect again. Pairing it again makes it a new
  device.
- **Unpair this computer…** in the app (on the Dashboard, in the menu of the computer) does the same
  from the device, and deletes the pairing and the copies of that computer's projects. If the
  computer is off, the app tells you: it still accepts the device until you run
  `palmtop devices remove` there.

## Notifications

Notifications are sent by the daemon on your computer through the push service of your browser
(Apple, Google, Mozilla, Microsoft), encrypted for your device by the Web Push standard: the push
service delivers them without reading them. They carry only the computer and project name and a
title, like "New checklist: Login flow", never the text of your checks or of the agent's message.

## Downloads

`palmtop update` and the installer check the size and SHA-256 of the download against the published
`version.json` before replacing palmtop.
