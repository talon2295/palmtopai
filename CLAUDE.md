# PalmtopAI

Human review layer for coding agents: the agent puts checks on the user's devices, the user marks
them, the agent reads the review. See `README.md` and `docs/architecture.md`.

- **bun ≥ 1.4.2** for development and the relay; the daemon and the CLI are shipped for **Node ≥ 22**
  (bun 1.3.7–1.3.8 hang at random while loading modules, oven-sh/bun#26810). Runtime, package
  manager (workspaces) and test runner (`bun test`). Lint and format: Biome, 4-space indentation.
- Commands: `bun run test`, `bun run typecheck`, `bun run lint`, `bun run serve` (daemon in the
  foreground), `bun run pair` (QR in the browser), `bun run build:web` (site in `apps/site` plus the
  app, both in `apps/web/dist`), `bun run build:cli` (Node bundle in `packages/cli/dist`),
  `bun run dev:web`, `bun run dev:site`, `bun run dev:relay` (local relay on :8787),
  `bun run demo:sync`. On the server only: `bun run stats` and `bun run deploy` (see
  `apps/relay/README.md`).
- After changing the code, `bun run build:cli` rebuilds the bundle the `palmtop` command runs.
- **Version**: every change to the shipped bundle (`packages/`, `integrations/`) bumps `version` in
  `packages/cli/package.json` in the same commit: patch for fixes, minor for features or breaking
  changes (while at 0.x). It is the version `palmtop --version` and "Update available" show.
- Every change comes with tests. Text in the UI, the docs and the code is in English.
- Keys and pairing links never appear in the output of a command an agent can run.
- Public documents (README, docs, changelog, site) are concise and positive, and say nothing about
  servers, accounts or commercial plans.
