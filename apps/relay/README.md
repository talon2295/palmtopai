# PalmtopAI relay

Public, anonymous and stateless relay between phones and PalmtopAI daemons. It serves the public
page (`/`, with `/install.md` for agents), the web app (at the root of `app.<host>`, a name of its
own so that its storage stays apart from the site's) and the CLI, and forwards
WebSocket messages. It stores no messages: the only things it writes to disk are anonymous
counters and the feedback people send from the site and the app (`DATA_DIR`).

- Daemons connect to `wss://<host>/daemon` and prove every project room with an Ed25519
  signature over a fresh nonce (`roomId = sha256(publicKey)`). The relay answers with a session
  token that lives only in memory, for that connection.
- Phones connect to `wss://<host>/ws?room=<roomId>`. Everything after that is between the phone
  and the daemon, end to end (`packages/protocol/src/e2e.ts`): a handshake where each proves its
  key, then sealed frames only. The relay forwards them without being able to read them; who may
  connect is decided by the daemon, not by the relay.
- The app on a Home Screen, not paired yet, connects to `wss://<host>/wait` and gets a pairing code
  (6 characters, Crockford base32, renewed every 5 minutes and after each use). `palmtop pair
  CODE` makes the daemon send a single-use pairing key for that code (`pair.offer`); the relay
  forwards it to the waiting phone. Codes live in memory only, while the phone waits, and are
  never logged.
- Rooms exist only while their daemon is connected. A restart of the relay drops every room;
  daemons reconnect and phones resume by themselves.
- It publishes the CLI: `/palmtop.mjs` and `/version.json` (version, build id, sha256, size),
  built on the server by `deploy.sh`. `palmtop update` downloads from the relay it is configured
  with, and daemons are told on connection that a new build is available.
- Daemons send their protocol version; older than `MIN_DAEMON_PROTOCOL` are refused with close
  code 4426 and `palmtop status` asks to run `palmtop update`.
- Contents are **end-to-end encrypted** between the daemon and the phones: the relay forwards
  data it can't read, stores nothing and never logs message contents.

## Server setup (Lightsail, Ubuntu)

Prerequisites: bun ≥ 1.4.2, pm2, nginx, certbot, git. Only ports 80 and 443 need to be open:
the relay listens on 127.0.0.1:8787.

```bash
curl -fsSL https://bun.sh/install | bash        # then open a new shell
npm install -g pm2                              # or: bun add -g pm2
sudo apt install nginx certbot python3-certbot-nginx

git clone https://github.com/talon2295/palmtopai.git ~/palmtopai && cd ~/palmtopai
bun install --frozen-lockfile
bun run build:web
bun run build:cli
bun test ./apps/relay

BUN_PATH=$(command -v bun) pm2 startOrReload apps/relay/ecosystem.config.cjs --update-env
pm2 save
pm2 startup                                      # once per server: start pm2 at boot

sudo certbot certonly --nginx -d palmtop.mtwa.it -d app.palmtop.mtwa.it   # the site and the app
sudo mkdir -p /etc/nginx/snippets
sudo cp apps/relay/deploy/palmtop-proxy.conf.example /etc/nginx/snippets/palmtop-proxy.conf
sudo cp apps/relay/deploy/nginx.conf.example /etc/nginx/sites-available/palmtop.mtwa.it
sudo ln -s /etc/nginx/sites-available/palmtop.mtwa.it /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

On a server that already hosts other nginx sites, check that none of them defines
`map $http_upgrade $connection_upgrade` or a `log_format palmtop_noquery` (duplicates make
`nginx -t` fail): `sudo nginx -T | grep -n 'connection_upgrade\|log_format'`. The example uses
`listen … http2`, which works on nginx 1.18 (Ubuntu 22.04).

`bun upgrade` changes bun for every app of the server user: check `pm2 list` for other apps
started with bun before upgrading.

The DNS record of every name in the file must point to the static IP of the instance before
running certbot. The example answers on `palmtop.mtwa.it` (the site and the relay) and on
`app.palmtop.mtwa.it` (the app): use your own two names instead.

### Moving to another domain

`DEFAULT_RELAY_URL` is compiled into the CLI bundle, and `palmtop update` downloads `version.json`
and `palmtop.mjs` from it: an installed version only knows the address it was built with. So keep
the old name answering (same relay, both names in `server_name` and in the certificate) until the
people running it have updated, and make sure it serves the **new** build. Afterwards, turn the old
name into a redirect to the new home page: devices that added the app to the Home Screen still open
the old origin, and their pairing (stored per origin) has to be made again on the new one.

## Updates

```bash
cd ~/palmtopai && bun run deploy        # same as apps/relay/deploy/deploy.sh
```

Switches to Node 22 with nvm (and stops if the Node or `pm2` of that version is missing), pulls,
installs, builds the site, the web app and the CLI, runs the relay tests, reloads pm2, checks
`/healthz` and prints the published `version.json`. Bump `version` in `packages/cli/package.json`
for releases people should notice: every change of the bundle is a new build anyway.
A reload closes every connection: daemons and phones reconnect within seconds.

Since 0.19 the relay also understands `room.close` and the `guest` flag of a room (the rooms of the
people a computer shares checklists with, which `bun run stats` counts apart from computers). A
daemon of 0.19 sends them, and an older relay does not know `room.close`: **deploy the relay first**,
then run `palmtop update` on the computers.

## Checks

```bash
curl -s https://palmtop.mtwa.it/healthz                  # {"ok":true}
curl -s https://palmtop.mtwa.it/version.json             # published CLI
pm2 logs palmtop-relay                                # connections, never contents
```

From a computer with the CLI: `palmtop status` shows `Relay: connected (wss://palmtop.mtwa.it)`,
or the name that computer was installed with.

## Configuration

Environment variables (set in `ecosystem.config.cjs`):

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Listen address (keep loopback behind nginx) |
| `PORT` | `8787` | Listen port |
| `WEB_ROOT` | `apps/web/dist` | Built site (`apps/site`, at `/`) and web app (`dist/app`, served at the root of `app.<host>`; the site's `/app/…` redirects there), from `bun run build:web` |
| `CLI_ROOT` | `packages/cli/dist` | Built CLI (`palmtop.mjs`, `version.json`), read at start |
| `DATA_DIR` | `~/.palmtop-relay` | Anonymous counters (`stats.json`) and feedback (`feedback.jsonl`) |
| `ADMIN_PORT` | `8788` | Statistics for `bun run stats`, on 127.0.0.1 only (never proxied by nginx) |
| `TRUST_PROXY` | off | `1`: client IP from `X-Forwarded-For` (nginx must overwrite it) |
| `RELAY_DEVICE_CONNECTIONS_PER_MINUTE` | 60 | New phone connections per IP |
| `RELAY_DAEMON_CONNECTIONS_PER_MINUTE` | 20 | New daemon connections per IP |
| `RELAY_DEVICE_MESSAGES_PER_SECOND` | 30 | Per phone connection |
| `RELAY_DAEMON_MESSAGES_PER_SECOND` | 1000 | Per daemon connection |
| `RELAY_ROOMS_PER_DAEMON` | 50 | Rooms per daemon connection: the computer's, and one for each person it shares with (49 at most) |
| `RELAY_DEVICES_PER_ROOM` | 20 | Phones per project room |
| `RELAY_DEVICE_MESSAGE_BYTES` | 262144 | Max phone message |
| `RELAY_DAEMON_MESSAGE_BYTES` | 8388608 | Max daemon message (snapshots) |
| `RELAY_HANDSHAKE_TIMEOUT_MS` | 10000 | Time for a daemon to authenticate |

Run a single instance only: rooms live in the memory of one process.

## Development

```bash
bun run dev:relay                                       # 127.0.0.1:8787
PALMTOP_RELAY_URL=ws://localhost:8787 palmtop status    # development only, not documented for users
```

The site is then at `http://localhost:8787`, the app at `http://app.localhost:8787` (Chrome and
Firefox send `*.localhost` to this computer). A phone needs HTTPS: the app's encryption runs only
in a secure context, so a relay on a local IP over plain HTTP is not enough.
