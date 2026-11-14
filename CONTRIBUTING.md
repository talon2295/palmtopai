# Contributing

Thanks for your interest in palmtop. It is a small project with one maintainer, so:

- **Bugs and ideas**: open an issue. For a bug, say your OS, Node.js version, agent, device and
  browser, and what `palmtop status` prints (it never shows keys or pairing links).
- **Pull requests**: open an issue first for anything bigger than a small fix, so we can agree on
  the approach before you spend time on it.
- **Security issues**: don't open an issue, see [SECURITY.md](SECURITY.md).

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). A map of the code is in
[docs/architecture.md](docs/architecture.md).

## Setup

Requires [Bun](https://bun.sh) 1.4.2 or newer (the CLI and the daemon are shipped for Node.js 22+).

```sh
bun install
bun run test && bun run typecheck && bun run lint
```

In Windows PowerShell 5.1 there is no `&&`: run the three commands one after the other.

Development commands are listed in the [README](README.md#development).

## Rules of the codebase

- TypeScript everywhere, formatted and linted with Biome, 4-space indentation.
- Every change comes with tests (`bun test`; UI with Testing Library and happy-dom).
- Text in the UI, the docs and the code is in English.
- Keys and pairing links never appear in the output of a command an agent can run.
- A change to the shipped bundle (`packages/`, `integrations/`) bumps `version` in
  `packages/cli/package.json`: patch for fixes, minor for features.

## License of contributions

Unless you say otherwise, a contribution you submit is licensed under the project's
[Apache License 2.0](LICENSE), as section 5 of that license says, and you confirm that you have the
right to submit it.
