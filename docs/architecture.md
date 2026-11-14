# Architecture

A map of the code: what each part does, how a check travels from the agent to your phone and back,
and how it is encrypted. For the product itself, see the [README](../README.md) and the
[docs](https://palmtop.mtwa.it/docs).

## The parts

```text
Your computer                           Relay                     Your devices
agent ── palmtop CLI / MCP              forwards sealed           web app (PWA)
             │ HTTP on 127.0.0.1        frames, one room          one key per device
             ▼                          per computer
         palmtop daemon  ◄──── wss ────►            ◄──── wss ────►
         ~/.palmtopai
```

- **CLI** (`packages/cli`): the `palmtop` command. It starts and stops the daemon, pairs devices,
  sets up the agents, and gives the agent its commands (`session start`, `checklist create`,
  `item add`, `feedback`, `wait`, …). `palmtop mcp` serves the same commands as an MCP server on
  stdio. The CLI, the daemon, the protocol and the agent guide are bundled into one JavaScript
  file for Node.js 22+ (`bun run build:cli`).
- **Daemon** (`packages/daemon`): one process per computer, and the source of truth. It stores the
  projects in `~/.palmtopai` (`PALMTOP_HOME` overrides it), serves a Local API on `127.0.0.1` to
  the CLI (authenticated with a local key), holds the connection to the relay, and runs the
  encrypted sessions with the devices. It also sends web push notifications and keeps the rooms of
  the people you share a copy with.
- **Relay** (`apps/relay`): a small Bun server. It forwards frames between a daemon and its
  devices, hands out pairing codes, and serves the site, the app and the CLI downloads. Rooms live
  in memory only; it forwards data it can't read and stores nothing.
- **App** (`apps/web`): React, Vite, Tailwind and shadcn/ui, installable on the Home Screen. It
  keeps the last confirmed state and the local edits, so it works offline and syncs on reconnect.
- **Client** (`packages/client`): what the app uses to talk to a computer: device keys, pairing,
  the encrypted socket, the sync client and the local cache. No React in it.
- **Protocol** (`packages/protocol`): shared by everything. Message schemas (zod), operations and
  `apply()`, Lamport clocks, the relay protocol and the end-to-end encryption.
- **Agent guide** (`integrations/agent-guide`): the instructions an agent reads (`palmtop guide`).
- **Agents** (`integrations/agents`): the setup for Claude Code and Codex: the skill, the
  permissions and the MCP server entry.
- **Site** (`apps/site`): the website, docs and changelog (Astro), built next to the app.

## Data model and sync

A **project** is a folder on the computer (the root of its git repository). The agent opens a
**session** per conversation; a session holds **checklists** of **items**, plus questions with
options, a message from the agent and your note.

Every change is an **operation** (`session.upsert`, `item.add`, `item.update`, …) stamped with a
Lamport clock and the id of the device that made it. `apply()` merges them last-write-wins per
field, so the daemon, the app and the tests all reach the same state from the same operations.
The daemon numbers each accepted operation (`seq`) and stores a snapshot plus an append-only log
per project (`packages/daemon/src/storage`). A device subscribes from the last `seq` it has and
receives only what it missed.

## From the agent to your phone and back

1. The agent runs `palmtop item add …` (or the MCP tool). The CLI calls the daemon's Local API.
2. The daemon turns it into an operation, applies it and stores it.
3. It sends the operation, sealed, to every connected device of that computer through the relay.
4. You mark the item on a device: the app applies the operation locally and sends it back the same
   way. The daemon applies it and forwards it to the other devices.
5. When you tap **Review done**, `palmtop wait` returns, and `palmtop feedback` gives the agent
   your review as text.

## End-to-end encryption

The code is in `packages/protocol/src/e2e.ts`; the [security docs](https://palmtop.mtwa.it/docs/security)
explain it for users.

- **Identities.** The computer's identity is the Ed25519 key of its relay room
  (`roomId = sha256(public key)`), so the room id a device stores pins its computer. Each device
  makes its own Ed25519 key in the browser, not extractable.
- **Pairing.** The QR code or link carries a single-use pairing key in the URL fragment. The
  device proves it with an HMAC, so the key never travels; pairing with a code adds a 6-digit
  number to compare on both screens.
- **Every connection** runs a handshake with fresh X25519 keys, signed by both identities, then
  derives one AES-256-GCM key per direction with HKDF-SHA-256. Frames carry a counter that must go
  up by one: a frame changed, repeated, dropped or out of order closes the connection.
- **The relay** sees the handshake and then only sealed frames. Daemons prove to it that they
  hold the key of each room they open (`packages/protocol/src/relay.ts`).

WebCrypto only, the same code in Node.js, Bun and the browser.

## Where things are

| Path | What |
|---|---|
| `packages/protocol/src` | `schemas.ts`, `apply.ts`, `clock.ts`, `relay.ts`, `e2e.ts` |
| `packages/daemon/src` | `daemon.ts`, `local-api.ts`, `device-hub.ts`, `relay-link.ts`, `room.ts`, `storage/`, `sharing.ts` |
| `packages/client/src` | `secure-socket.ts`, `sync-client.ts`, `pair-client.ts`, `client-cache.ts` |
| `packages/cli/src` | `cli.ts` (the commands), `mcp.ts`, `setup.ts`, `update.ts` |
| `apps/relay/src` | `relay.ts` (rooms and pairing codes), `static.ts`, `cli-release.ts` |
| `apps/web/src` | the app |
| `integrations/*` | agent guide and agent setup |

## Running it locally

```sh
bun install
bun run dev:relay                                   # relay on 127.0.0.1:8787
PALMTOP_RELAY_URL=ws://localhost:8787 bun run serve  # daemon in the foreground
bun run dev:web                                     # the app, proxied to the local relay
```

The app is then at `http://app.localhost:8787`, and `PALMTOP_RELAY_URL=ws://localhost:8787 bun run pair`
shows a QR code to pair it. Set `PALMTOP_HOME` to a scratch folder to keep your own
`~/.palmtopai` out of it. Tests: `bun run test`.
