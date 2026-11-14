#!/bin/sh
# Installs palmtop, the checklist for AI coding: https://palmtop.mtwa.it
#
#   curl -fsSL https://palmtop.mtwa.it/install.sh | bash
#
# Downloads palmtop into ~/.palmtopai/bin, checks it against the published SHA-256, then runs
# `palmtop setup`: on a terminal it asks which agents to set up, whether to add palmtop to your
# PATH and whether to pair a device; without one (an agent, a script) it asks nothing and prints
# the steps left. Running it again updates palmtop. Options are passed to `palmtop setup`:
#
#   curl -fsSL https://palmtop.mtwa.it/install.sh | bash -s -- --force-agents-install
#
# It never uses sudo and writes only under ~/.palmtopai, plus what `palmtop setup` tells you.

set -eu

# Everything is inside main, called on the last line: a download cut halfway runs nothing.
main() {
    base="${PALMTOP_INSTALL_URL:-https://palmtop.mtwa.it}"
    dir="$HOME/.palmtopai/bin"

    if [ -t 1 ]; then
        green=$(printf '\033[38;5;79m')
        red=$(printf '\033[31m')
        dim=$(printf '\033[2m')
        reset=$(printf '\033[0m')
    else
        green='' red='' dim='' reset=''
    fi

    case "$(uname -s)" in
        Darwin | Linux) ;;
        # Git Bash and the like: a Windows user wants the PowerShell installer, not this one.
        MINGW* | MSYS* | CYGWIN*)
            fail "this is the installer for macOS, Linux and WSL. On Windows, run this in PowerShell: irm $base/install.ps1 | iex" ;;
        *) fail "palmtop runs on macOS, Linux and Windows. Found $(uname -s)." ;;
    esac

    if ! command -v node >/dev/null 2>&1; then
        fail "palmtop needs Node.js 22 or newer: install it from https://nodejs.org, then run this again."
    fi
    node_version=$(node -p 'process.versions.node')
    if [ "${node_version%%.*}" -lt 22 ]; then
        fail "palmtop needs Node.js 22 or newer (found $node_version): update it from https://nodejs.org, then run this again."
    fi
    command -v curl >/dev/null 2>&1 || fail "curl is needed to download palmtop."

    mkdir -p "$dir"
    download="$dir/.palmtop.mjs.download"
    release="$dir/.version.json.download"
    trap 'rm -f "$download" "$release"' EXIT

    step "Downloading palmtop from $base"
    curl -fsSL "$base/version.json" -o "$release" || fail "could not download $base/version.json"
    curl -fsSL "$base/palmtop.mjs" -o "$download" || fail "could not download $base/palmtop.mjs"

    # Size and SHA-256 of the download against version.json; prints the version.
    version=$(node -e '
        const fs = require("node:fs");
        const crypto = require("node:crypto");
        const [releaseFile, bundleFile] = process.argv.slice(1);
        const release = JSON.parse(fs.readFileSync(releaseFile, "utf8"));
        const bundle = fs.readFileSync(bundleFile);
        const sha256 = crypto.createHash("sha256").update(bundle).digest("hex");
        if (bundle.length !== release.size || sha256 !== release.sha256) process.exit(1);
        console.log(release.version);
    ' "$release" "$download") || fail "the download does not match its SHA-256: nothing was installed."

    chmod 755 "$download"
    mv "$download" "$dir/palmtop.mjs"
    ln -sf palmtop.mjs "$dir/palmtop"
    step "palmtop $version installed in ~/.palmtopai/bin ${dim}(SHA-256 verified)${reset}"

    # With `curl | bash` the script is the standard input: the questions read the terminal.
    if [ -t 1 ] && { : </dev/tty; } 2>/dev/null; then
        exec "$dir/palmtop" setup "$@" </dev/tty
    fi
    exec "$dir/palmtop" setup "$@"
}

step() {
    printf '%s✓%s %s\n' "$green" "$reset" "$1"
}

fail() {
    printf '%s✗ %s%s\n' "$red" "$1" "$reset" >&2
    exit 1
}

main "$@"
