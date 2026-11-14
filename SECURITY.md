# Security

## Reporting a vulnerability

Please report vulnerabilities privately, with
[GitHub's private vulnerability reporting](https://github.com/talon2295/palmtopai/security/advisories/new),
not in a public issue. Say what you found, how to reproduce it and what it lets an attacker do.

You will get an answer within a few days. Fixes go out as a new version of the CLI (`palmtop update`)
and a new deploy of the relay and the app; the changelog credits you if you like.

## Supported versions

Only the latest version is supported: the app and the relay are always the latest, and `palmtop
status` asks to update an older CLI.

## Scope

In scope: the CLI and daemon (`packages/`), the agent integrations (`integrations/`), the relay
(`apps/relay`), the app (`apps/web`) and the public relay at `palmtop.mtwa.it`. Please don't run
load tests or denial-of-service attacks against the public relay, and don't access data that isn't
yours: test with your own computer and devices, or with your own relay.

## Known limits

These are documented and don't need a report:

- What the relay can still see without reading your checklists, and what end-to-end encryption
  covers, is described on the [security page](https://palmtop.mtwa.it/docs/security).
- The copy of the checklists the app keeps for offline use is protected by the device and the
  browser, like any app's data, not by palmtop's own encryption.
- The model provider of your agent sees what the agent writes, like the rest of the conversation.

How pairing, the relay, end-to-end encryption and the storage on your devices work:
[security docs](https://palmtop.mtwa.it/docs/security). The protocol is in
[`packages/protocol/src/e2e.ts`](packages/protocol/src/e2e.ts).
