#!/usr/bin/env bash
# Updates the relay on the server: pull, install, build site, web app and CLI, test, reload pm2.
# Run from anywhere inside the repository: apps/relay/deploy/deploy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

# Node 22 for the build and the tests. nvm is a shell function, not a program: it is loaded from
# nvm.sh, and not under `set -u`, which nvm does not support. The pm2 on the PATH is the one of
# this Node, so it is checked here, before anything is built.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    set +u
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    nvm use 22 >/dev/null
    set -u
fi
current_node="$(node --version 2>/dev/null || true)"
case "$current_node" in
    v22.* | v23.* | v24.* | v25.* | v26.*) ;;
    *)
        echo "Node >= 22 required (found ${current_node:-none}): run 'nvm install 22'" >&2
        exit 1
        ;;
esac
if ! command -v pm2 >/dev/null 2>&1; then
    echo "pm2 not found with Node $current_node: run 'npm install -g pm2' in this Node" >&2
    exit 1
fi

required_bun="1.4.2"
current_bun="$(bun --version)"
if [ "$(printf '%s\n%s\n' "$required_bun" "$current_bun" | sort -V | head -n1)" != "$required_bun" ]; then
    echo "bun >= $required_bun required (found $current_bun): run 'bun upgrade'" >&2
    exit 1
fi

echo "==> git pull"
git pull --ff-only

echo "==> bun install"
bun install --frozen-lockfile

echo "==> build site and web app"
bun run build:web

echo "==> build CLI (served for download)"
bun run build:cli

echo "==> relay tests"
bun test ./apps/relay

echo "==> pm2 reload"
# The pm2 daemon may not have ~/.bun/bin on its PATH: point the config to the bun in use.
export BUN_PATH="${BUN_PATH:-$(command -v bun)}"
pm2 startOrReload apps/relay/ecosystem.config.cjs --update-env
pm2 save

sleep 1
if curl -fsS http://127.0.0.1:8787/healthz >/dev/null; then
    echo "==> relay is up"
    curl -fsS http://127.0.0.1:8787/version.json && echo
else
    echo "relay did not answer on 127.0.0.1:8787, see: pm2 logs palmtop-relay" >&2
    exit 1
fi
