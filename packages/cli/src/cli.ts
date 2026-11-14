import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AGENT_GUIDE } from '@palmtopai/agent-guide';
import { backupSuffix, claudeConfigDir, codexSkillPath } from '@palmtopai/agents';
import {
    BRANCH_HEADER,
    BUILD_INFO,
    type ChecklistView,
    type FeedbackWithShared,
    type InviteResult,
    type ItemInput,
    type ItemView,
    type PairingConfirmation,
    type PairLink,
    type PairOfferResponse,
    type PersonView,
    type RemovalPreview,
    type RemoveResult,
    type RetestResult,
    relayWebUrl,
    renderTerminalQr,
    resolveHome,
    resolveRelayUrl,
    runForeground,
    type SessionSummary,
    type SessionView,
    type ShareResult,
    type ShareView,
    sameRoot,
} from '@palmtopai/daemon';
import { formatPairingNumber, normalizePairCode } from '@palmtopai/protocol';
import { banner, type ColorDepth, green } from './banner';
import { CliError, DaemonClient, DaemonUnreachableError } from './daemon-client';
import {
    formatChecklist,
    formatDevices,
    formatFeedback,
    formatPeople,
    formatRemoved,
    formatRetest,
    formatSession,
    formatSessionList,
    formatShareResult,
    formatShares,
    formatSystemProjects,
    formatSystemSessions,
    type PairedDeviceEntry,
    printableName,
    removalQuestion,
    type SystemProject,
    type SystemSession,
} from './format';
import { detectProject, type ProjectContext } from './project';
import {
    type AgentId,
    addToPath,
    agentsOnThisComputer,
    defaultAgents,
    installAgents,
    onPath,
    type SetupUi,
    shellProfile,
    tilde,
    userHome,
} from './setup';
import { updateCli } from './update';
import {
    addToUserPath,
    ensureShim,
    type PowerShellRunner,
    pathCommand,
    runPowerShell,
} from './windows';

export const USAGE = `Usage: palmtop <command> [options]

Daemon
  serve                              Run the daemon in the foreground
  serve -b, --background             Start the daemon in the background and return
  stop                               Stop the running daemon
  status                             Daemon, relay, project, devices and session
  pair                               Pair a phone, tablet or browser with this computer
  pair <code>                        Pair the app added to a Home Screen, which shows
                                     the code (in a terminal only, asks first, then
                                     compare the number on both screens)
  devices                            Devices paired with this computer
  devices remove <name|id>           Unpair a device: it can't connect any more
  setup                              Set up palmtop: agents (Claude Code, Codex), PATH,
                                     pairing. Without a terminal: agents only, no questions
  update                             Install the latest palmtop from the relay
  version                            Version and build of palmtop
  config name [name]                 Show or set the name of this computer on your devices
  config name --reset                Use the host name again

People you share with
  invite --name <name>               Invite a person to look at the checklists you share:
                                     a link for them (in a terminal only, you do this)
  people                             Who you share with, their device, what they can see
  people remove <name>               Stop sharing with a person: their device is unpaired
  session owner-name <name> [--for <person>]
                                     How the people see your name on this session
                                     (needs --session; --clear to take it back)
  config owner-name [name]           How the people see your name, unless a session says else

Sessions
  session start [title]              Start a session and print its ref
  session list                       Sessions of the project
  session title <title>              (needs --session)
  sessions                           Sessions of every project on this computer
  sessions delete <ref>              Delete a session everywhere, with its checklists

Projects
  projects                           Projects on this computer
  projects remove <name|path>        Remove a project with its sessions, also on devices

Checklists (need --session)
  checklist create <title> [--item <text>]...
  checklist rename <ref> <title>
  checklist remove <ref>
  add <text> [--checklist <ref>]     Add an item (default: latest checklist)
  edit <ref> <text>                  Change the text of an item
  remove <ref>                       Remove an item
  choice create <question> [--option <text> [--detail <text>]]... [--multiple]
                                     Ask the user to choose between options
  show                               Checklists with review status and notes
  wait                               Wait until the user marks the session done on a
                                     device, then exit (run it in the background)
  message <text>                     Show a message to the user at the top of the session
  message --clear                    Remove the message

Sharing with other people (need --session; they are invited by the user)
  share <checklist> --with <name> [--days <n>]
                                     Give a person a copy of a checklist of checks
  share list                         Who has what, and until when
  share close --with <name>          Take the copy of this session away from a person
  share remove <checklist> --with <name>
                                     Take one checklist out of their copy (their answers on it go)
  retest --with <name> [<ref>...] [--message <text>]
                                     Bring the copy of a person up to date with yours
  message <text> --to <name>         Message shown only on that person's copy

Review (need --session)
  feedback                           Reviews changed since the last feedback, and items
                                     not reviewed yet, also from the people it is shared with

AI agents
  guide                              Instructions for AI agents (any agent that runs commands)

Options
  --session <ref>   Session ref printed by \`session start\` (default: $PALMTOP_SESSION_ID)
  --project <path>  Project directory (default: current directory)
  --json            JSON output
  -h, --help        Show this help
  -y, --yes         Delete without asking for confirmation
  -b, --background  With \`serve\`: start the daemon in the background
  --reset           With \`config name\`: go back to the host name
  --force-agents-install
                    With \`setup\`: also set up agents not installed yet
  --clear           With \`message\`: remove the message
  --name <name>     With \`invite\`: the person to invite
  --for <person>    With \`session owner-name\`: the name is for that person only
  --with <name>     With \`share\`, \`share close\`, \`share remove\` and \`retest\`: the person
  --to <name>       With \`message\`: show it only to that person
  --days <n>        With \`share\`: days before the copy turns read-only (default 7)
  --message <text>  With \`retest\`: message for the person
  --option <text>   With \`choice create\`: one option to choose from, repeatable
  --detail <text>   Lines under an option (after its \`--option\`), or of \`add\` and \`edit\`
  --multiple        With \`choice create\`: the user can choose more than one option
  -v, --version     Show the version

Review status (done / cancelled / question) is set by you on your devices, not by the CLI.
Other agents (without the palmtop skill): tell them to run \`palmtop guide\` first.`;

export interface CliIo {
    /** Script of this CLI (`process.argv[1]`), used to start the daemon as `palmtop serve`. */
    entry: string;
    stdout: (text: string) => void;
    stderr: (text: string) => void;
    env: Record<string, string | undefined>;
    cwd: string;
    /** Asks a yes/no question; absent when there is no interactive terminal (e.g. agents). */
    confirm?: (question: string) => Promise<boolean>;
    /** Asks for a line of text; absent when there is no interactive terminal. */
    ask?: (question: string) => Promise<string>;
    /**
     * Keyboard and screen of a real terminal; absent in pipes, `--json` runs and agents, which
     * must never see a pairing link.
     */
    tty?: {
        readKey: () => Promise<string>;
        /** Wipes screen and scrollback, so a QR code does not stay in the history. */
        clear: () => void;
    };
    /** The questions of `palmtop setup`: only on a real terminal. */
    ui?: SetupUi;
    /** Colours of the output (the logo of `palmtop setup`). */
    color?: ColorDepth;
    /** Never restart a daemon that is already running, even of another build (the MCP server). */
    keepDaemon?: boolean;
    /**
     * Receives each screenshot a feedback gives the agent, as a file (the MCP server sends them as
     * images; the text of the feedback names the same files).
     */
    attach?: (image: { path: string; mime: string }) => void;
    /** `palmtop wait`: pause before asking a daemon that did not answer again (tests). */
    waitRetryMs?: number;
    /** `palmtop wait`: how long a daemon may stay unreachable before the wait ends (tests). */
    waitGiveUpMs?: number;
    /** `palmtop wait`: how long it waits at most, with no tap (tests). */
    waitMaxMs?: number;
    /** The system palmtop runs on (tests say another one); defaults to this one. */
    platform?: NodeJS.Platform;
    /** Runs PowerShell, for the PATH of a Windows user (tests replace it). */
    powershell?: PowerShellRunner;
}

interface Parsed {
    positionals: string[];
    session?: string;
    project?: string;
    json: boolean;
    items: string[];
    /** Options of a choice, in the order they were given, each with its own `--detail`. */
    options: ItemInput[];
    /** `--detail` of `add` and `edit` (the ones of `--option` are in `options`). */
    detail?: string;
    multiple: boolean;
    checklist?: string;
    help: boolean;
    version: boolean;
    yes: boolean;
    background: boolean;
    reset: boolean;
    forceAgentsInstall: boolean;
    clear: boolean;
    with?: string;
    name?: string;
    for?: string;
    to?: string;
    days?: string;
    message?: string;
}

/** Options that always take a value. */
const VALUE_OPTIONS = new Set([
    '--session',
    '--project',
    '--item',
    '--checklist',
    '--option',
    '--detail',
    '--with',
    '--name',
    '--for',
    '--to',
    '--days',
    '--message',
]);

/**
 * Takes `--option` and the `--detail` that follows each one out of the arguments, in order:
 * `parseArgs` collects repeated options into separate arrays, which would lose which detail
 * belongs to which option. A `--detail` before any `--option` is left in place: it is the one of
 * `add` and `edit`.
 */
export function extractOptions(argv: string[]): { rest: string[]; options: ItemInput[] } {
    const rest: string[] = [];
    const options: ItemInput[] = [];
    const value = (arg: string, name: string, next: string | undefined) =>
        arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : next;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i] as string;
        if (arg === '--') {
            rest.push(...argv.slice(i));
            break;
        }
        const option = arg === '--option' || arg.startsWith('--option=');
        const detail = arg === '--detail' || arg.startsWith('--detail=');
        if (!option && !(detail && options.length > 0)) {
            rest.push(arg);
            continue;
        }
        const text = value(arg, option ? '--option' : '--detail', argv[i + 1]);
        if (text === undefined) {
            // No value: leave it to parseArgs, which reports the error.
            rest.push(arg);
            continue;
        }
        if (!arg.includes('=')) i++;
        if (option) options.push({ text });
        else (options.at(-1) as ItemInput).detail = text;
    }
    return { rest, options };
}

/**
 * `--item "--version flag"` is refused by parseArgs as ambiguous (the value starts with a dash).
 * Values of options that always take one are joined as `--item=--version flag`.
 */
function joinOptionValues(argv: string[]): string[] {
    const joined: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i] as string;
        if (arg === '--') {
            joined.push(...argv.slice(i));
            break;
        }
        const value = argv[i + 1];
        if (VALUE_OPTIONS.has(arg) && value !== undefined) {
            joined.push(`${arg}=${value}`);
            i++;
        } else {
            joined.push(arg);
        }
    }
    return joined;
}

function parse(argv: string[]): Parsed {
    try {
        const { rest, options } = extractOptions(argv);
        const { values, positionals } = parseArgs({
            args: joinOptionValues(rest),
            allowPositionals: true,
            options: {
                session: { type: 'string' },
                project: { type: 'string' },
                json: { type: 'boolean', default: false },
                item: { type: 'string', multiple: true, default: [] },
                detail: { type: 'string' },
                multiple: { type: 'boolean', default: false },
                checklist: { type: 'string' },
                help: { type: 'boolean', short: 'h', default: false },
                version: { type: 'boolean', short: 'v', default: false },
                yes: { type: 'boolean', short: 'y', default: false },
                background: { type: 'boolean', short: 'b', default: false },
                reset: { type: 'boolean', default: false },
                'force-agents-install': { type: 'boolean', default: false },
                clear: { type: 'boolean', default: false },
                with: { type: 'string' },
                name: { type: 'string' },
                for: { type: 'string' },
                to: { type: 'string' },
                days: { type: 'string' },
                message: { type: 'string' },
            },
        });
        return {
            positionals,
            ...(values.session !== undefined && { session: values.session }),
            ...(values.project !== undefined && { project: values.project }),
            json: values.json ?? false,
            items: values.item ?? [],
            options,
            ...(values.detail !== undefined && { detail: values.detail }),
            multiple: values.multiple ?? false,
            ...(values.checklist !== undefined && { checklist: values.checklist }),
            help: values.help ?? false,
            version: values.version ?? false,
            yes: values.yes ?? false,
            background: values.background ?? false,
            reset: values.reset ?? false,
            forceAgentsInstall: values['force-agents-install'] ?? false,
            clear: values.clear ?? false,
            ...(values.with !== undefined && { with: values.with }),
            ...(values.name !== undefined && { name: values.name }),
            ...(values.for !== undefined && { for: values.for }),
            ...(values.to !== undefined && { to: values.to }),
            ...(values.days !== undefined && { days: values.days }),
            ...(values.message !== undefined && { message: values.message }),
        };
    } catch (error) {
        throw new CliError(`${(error as Error).message}\n\n${USAGE}`, 2);
    }
}

function usage(message: string): CliError {
    return new CliError(`${message}\n\nRun \`palmtop --help\` for usage.`, 2);
}

/** Like `which`: true if an executable named `command` is on `PATH`. */
function osRelease(): string {
    try {
        return readFileSync('/proc/sys/kernel/osrelease', 'utf8');
    } catch {
        return '';
    }
}

/** WSL: a Linux kernel with Windows interop, where the browser lives on the Windows side. */
export function isWsl(
    env: CliIo['env'],
    platform: string = process.platform,
    kernel: () => string = osRelease,
): boolean {
    if (platform !== 'linux') return false;
    if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
    return /microsoft/i.test(kernel());
}

/**
 * Commands that open a URL, in the order they are tried: the first one that starts wins.
 * WSL usually has no Linux browser, so `wslview` (wslu) or `explorer.exe` open the Windows one,
 * which reaches the daemon through the localhost forwarding of WSL 2.
 */
export function openCandidates(
    url: string,
    env: CliIo['env'],
    platform: string = process.platform,
    wsl: boolean = isWsl(env, platform),
): Array<[string, string[]]> {
    if (env.PALMTOP_OPEN) return [[env.PALMTOP_OPEN, [url]]];
    if (platform === 'darwin') return [['open', [url]]];
    if (platform === 'win32') return [['cmd', ['/c', 'start', '', url]]];
    if (wsl) {
        return [
            ['wslview', [url]],
            ['explorer.exe', [url]],
            ['xdg-open', [url]],
        ];
    }
    return [['xdg-open', [url]]];
}

/** Starts one opener, detached; false if that command does not exist. */
function startOpener(program: string, args: string[]): Promise<boolean> {
    return new Promise((done) => {
        const child = spawn(program, args, { stdio: 'ignore', detached: true, windowsHide: true });
        child.once('spawn', () => {
            child.unref();
            done(true);
        });
        child.once('error', () => done(false));
    });
}

/** Opens the URL in a browser. The URL carries a secret: it goes to the opener, never to stdout. */
async function openInBrowser(url: string, env: CliIo['env']): Promise<void> {
    const candidates = openCandidates(url, env);
    for (const [program, args] of candidates) {
        if (await startOpener(program, args)) return;
    }
    const tried = candidates.map(([program]) => program).join(', ');
    throw new CliError(
        `could not open a browser (tried ${tried}); set PALMTOP_OPEN to a command that opens a URL`,
    );
}

/** Opens the pairing page of this computer in a browser, with a single-use code. */
function pairingPageOpener(client: DaemonClient, io: CliIo): () => Promise<void> {
    return async () => {
        const { url } = await client.request<{ url: string }>('POST', '/pair/codes', { body: {} });
        // The URL carries a single-use code: it goes to the browser, never to the output.
        await openInBrowser(url, io.env);
    };
}

const CLOSE_KEYS = new Set(['\r', '\n', '\u001b', '\u0003']);

/**
 * Shows the pairing QR code and its link in the terminal, then revokes the key on exit. The link
 * carries a single-use pairing key: once it is used, revoked or expired, what stayed on screen (or
 * in the scrollback) no longer pairs anything.
 */
async function pairInTerminal(
    client: DaemonClient,
    io: CliIo,
    tty: NonNullable<CliIo['tty']>,
    openPage: () => Promise<void>,
): Promise<number> {
    const link = await client.request<PairLink>('POST', '/pair/links', { body: {} });
    const minutes = Math.max(1, Math.round((link.expiresAt - Date.now()) / 60_000));
    io.stdout(
        [
            `Pair a device with "${link.computerName}"`,
            ...(link.warning ? ['', link.warning] : []),
            '',
            renderTerminalQr(link.url),
            '',
            'Scan it with a phone or tablet, or open this link there:',
            link.url,
            '',
            `It pairs one device, once, within ${minutes} minutes, with every project`,
            'of this computer, including the ones you start later.',
            'App added to the Home Screen? Close this and run `palmtop pair CODE`',
            'with the code the app shows.',
            'Press y to open the pairing page in a browser, Enter or Esc to close.',
        ].join('\n'),
    );
    for (;;) {
        const key = await tty.readKey();
        if (CLOSE_KEYS.has(key)) break;
        if (key !== 'y' && key !== 'Y') continue;
        try {
            await openPage();
        } catch (error) {
            io.stderr(`palmtop: ${(error as Error).message}`);
        }
    }
    await client.request('DELETE', '/pair/links', { body: { key: link.key } });
    tty.clear();
    io.stdout('Pairing closed: that QR code and link do not work any more.');
    return 0;
}

/** How often `palmtop pair CODE` asks the daemon where the pairing is. */
const PAIR_POLL_MS = 250;

/**
 * `palmtop pair CODE`: sends a single-use pairing key to the device showing CODE (an app on the
 * Home Screen, which can't use the browser's pairing). Only a person at a terminal can do it, and
 * only after confirming: an agent tricked into running it (e.g. by text in a repo) would pair the
 * device of whoever wrote the code. There is no --yes.
 *
 * The key goes through the relay, so the device is registered only once the user sees the same
 * 6-digit number here and on the device: a relay pairing in its place, or sitting in the middle,
 * would show different numbers (end-to-end encryption, `e2e.ts`).
 */
async function pairByCode(
    client: DaemonClient,
    input: string,
    args: Parsed,
    io: CliIo,
): Promise<number> {
    const confirm = io.confirm;
    if (!io.tty || !confirm || args.json) {
        throw new CliError(
            'pairing with a code needs you at a terminal: run `palmtop pair CODE` yourself (agents and scripts cannot)',
        );
    }
    const code = normalizePairCode(input);
    if (!code) throw new CliError(`"${input}" is not a pairing code: it has 6 letters and digits`);
    const health = await client.ensureRunning(io.entry);
    const confirmed = await confirm(
        `Pair "${health.computerName}" with the device showing ${code}? It will see every project of this computer. [y/N] `,
    );
    if (!confirmed) throw new CliError('nothing sent');
    const offer = await client.request<PairOfferResponse>('POST', '/pair/offer', {
        body: { code },
    });
    switch (offer.status) {
        case 'delivered':
            break;
        case 'unknown_code':
            throw new CliError(
                `no device is showing ${code}: check the code in the app (it changes every 5 minutes)`,
            );
        case 'rate_limited':
            throw new CliError('too many codes tried: wait a minute and try again');
        case 'relay_unavailable':
            throw new CliError(
                'the relay is not reachable right now: try again, or scan the QR code of `palmtop pair`',
            );
    }
    const id = offer.id;
    if (!id) throw new CliError('the daemon did not follow the pairing: try again');
    io.stdout(`Sent to the device showing ${code}: waiting for it…`);

    const ready = await pairingState(client, id, (state) => state !== 'waiting');
    if (ready.state !== 'ready' || !ready.number) throw pairingEnded(ready);
    const name = printableName(ready.deviceName ?? '');
    io.stdout(
        [
            '',
            `The device "${name}" shows:`,
            '',
            `    ${formatPairingNumber(ready.number)}`,
            '',
        ].join('\n'),
    );
    const same = await confirm('Is it the same number on the device? [y/N] ');
    await client.request('POST', `/pair/offers/${encodeURIComponent(id)}`, {
        body: { accept: same },
    });
    if (!same) {
        throw new CliError(
            'not paired: the numbers must match. If they did not, someone may be in the middle: pair with the QR code of `palmtop pair` instead',
        );
    }
    const done = await pairingState(client, id, (state) => state !== 'ready');
    if (done.state !== 'accepted') throw pairingEnded(done);
    io.stdout(`Paired "${name}". Confirm on the device to finish.`);
    return 0;
}

/** Polls the pairing by code until `until` is true for its state. */
async function pairingState(
    client: DaemonClient,
    id: string,
    until: (state: PairingConfirmation['state']) => boolean,
): Promise<PairingConfirmation> {
    for (;;) {
        const current = await client.request<PairingConfirmation>(
            'GET',
            `/pair/offers/${encodeURIComponent(id)}`,
        );
        if (until(current.state)) return current;
        await new Promise((resolve) => setTimeout(resolve, PAIR_POLL_MS));
    }
}

function pairingEnded(confirmation: PairingConfirmation): CliError {
    return new CliError(
        confirmation.state === 'expired'
            ? 'the pairing expired: run `palmtop pair CODE` again with the new code'
            : 'the device went away before pairing: run `palmtop pair CODE` again',
    );
}

export async function run(argv: string[], io: CliIo): Promise<number> {
    try {
        return await dispatch(parse(argv), io);
    } catch (error) {
        if (error instanceof CliError) {
            io.stderr(`palmtop: ${error.message}`);
            return error.exitCode;
        }
        // Unexpected errors: message only, never request details that could include secrets.
        io.stderr(`palmtop: unexpected error: ${(error as Error).message}`);
        return 1;
    }
}

type Print = (text: string, json: unknown) => void;

async function dispatch(args: Parsed, io: CliIo): Promise<number> {
    const [command, sub, ...rest] = args.positionals;
    const print: Print = (text, json) =>
        io.stdout(args.json ? JSON.stringify(json, null, 2) : text);
    if (args.version || command === 'version') {
        print(describeBuild(BUILD_INFO), BUILD_INFO);
        return 0;
    }
    if (args.help || command === undefined || command === 'help') {
        io.stdout(USAGE);
        return command === undefined && !args.help ? 2 : 0;
    }

    const client = new DaemonClient(resolveHome(io.env), {
        restart: !io.keepDaemon,
        notice: io.stderr,
    });

    switch (command) {
        case 'serve': {
            if (args.background) {
                // Same start as the one before a session: detached, logging to daemon.log.
                const health = await client.ensureRunning(io.entry);
                print(
                    `Daemon running in the background (pid ${health.pid}), log in ${client.paths.log}.`,
                    health,
                );
                return 0;
            }
            if ((await client.probe()).kind !== 'down')
                throw new CliError('the daemon is already running');
            await runForeground();
            await new Promise(() => {}); // Runs until a signal stops the process.
            return 0;
        }

        case 'stop': {
            const stopped = await client.stop();
            print(stopped ? 'Daemon stopped.' : 'Daemon is not running.', { stopped });
            return 0;
        }

        case 'status':
            return status(client, args, io, print);

        case 'pair': {
            if (rest.length > 0) throw usage('pair takes at most one code');
            if (sub !== undefined) return pairByCode(client, sub, args, io);
            // Pairing is with the computer, not with a folder: it never registers a project.
            const health = await client.ensureRunning(io.entry);
            const openPage = pairingPageOpener(client, io);
            // Only a real terminal shows the QR and the link: pipes, agents and --json never do.
            if (io.tty && !args.json) return pairInTerminal(client, io, io.tty, openPage);
            await openPage();
            print(
                `Opened the pairing page for "${health.computerName}" in your browser (single use, valid 60 seconds).`,
                { opened: true, computer: health.computerName },
            );
            return 0;
        }

        case 'invite': {
            if (sub !== undefined || rest.length > 0) throw usage('invite takes --name <name>');
            return inviteInTerminal(client, args, io);
        }

        case 'people': {
            await client.ensureRunning(io.entry);
            if (sub === undefined) {
                const { people } = await client.request<{ people: PersonView[] }>('GET', '/people');
                print(formatPeople(people), people);
                return 0;
            }
            if (sub !== 'remove')
                throw usage('unknown people command (try `people remove <name>`)');
            const [name, ...extra] = rest;
            if (!name || extra.length > 0) throw usage('people remove needs one <name>');
            await confirmDeletion(
                args,
                io,
                `Stop sharing with ${printableName(name)}? Their device is unpaired and every copy they have disappears from their app. What they reviewed stays here.`,
            );
            const removed = await client.request<PersonView>(
                'DELETE',
                `/people/${encodeURIComponent(name)}`,
            );
            print(`${printableName(removed.name)} is not shared with any more.`, removed);
            return 0;
        }

        case 'update': {
            if (sub !== undefined) throw usage('update takes no arguments');
            return updateCommand(client, io, print);
        }

        case 'config': {
            if (sub === 'owner-name') return ownerNameConfig(client, rest, args, io, print);
            if (sub !== 'name') throw usage('unknown config command (try `config name`)');
            const [name, ...extra] = rest;
            if (extra.length > 0) throw usage('config name takes one [name] (quote it)');
            if (name !== undefined && args.reset)
                throw usage('config name: pass a name or --reset');
            await client.ensureRunning(io.entry);
            if (name === undefined && !args.reset) {
                const current = await client.request<ComputerName>('GET', '/config/name');
                print(
                    current.name === current.default
                        ? `Computer name: ${current.name} (host name; set another with \`palmtop config name "<name>"\`)`
                        : `Computer name: ${current.name} (host name: ${current.default})`,
                    current,
                );
                return 0;
            }
            const saved = await client.request<ComputerName>('PUT', '/config/name', {
                body: { name: args.reset ? null : name },
            });
            print(
                args.reset
                    ? `Computer name reset to the host name: ${saved.name}`
                    : `Computer name set to: ${saved.name}`,
                saved,
            );
            return 0;
        }

        case 'guide': {
            if (sub !== undefined) throw usage('guide takes no arguments');
            print(AGENT_GUIDE.trimEnd(), { guide: AGENT_GUIDE });
            return 0;
        }

        case 'setup': {
            if (sub !== undefined) throw usage('setup takes no arguments');
            return io.ui && !args.json
                ? setupInteractive(client, io, io.ui, args.forceAgentsInstall)
                : setupUnattended(io, print, args.forceAgentsInstall);
        }

        // Not in the help any more: `palmtop update` of 0.12 and older runs `install --json` on
        // the new palmtop to refresh the skills.
        case 'install': {
            if (sub !== undefined) throw usage('install takes no arguments');
            return installCommand(io, print, args.forceAgentsInstall);
        }

        case 'checklist': {
            if (sub === 'create') {
                const [title, ...extra] = rest;
                if (!title || extra.length > 0)
                    throw usage('checklist create needs one <title> (quote it)');
                const view = await sessionRequest<ChecklistView>(
                    client,
                    args,
                    io,
                    'POST',
                    '/checklists',
                    {
                        title,
                        items: args.items,
                    },
                );
                print(
                    `Created checklist ${view.ref} "${view.title}"\n${formatChecklist(view)}`,
                    view,
                );
                return 0;
            }
            if (sub === 'rename') {
                const [ref, title, ...extra] = rest;
                if (!ref || !title || extra.length > 0)
                    throw usage('checklist rename needs <ref> <title>');
                const view = await sessionRequest<ChecklistView>(
                    client,
                    args,
                    io,
                    'PATCH',
                    `/checklists/${encodeURIComponent(ref)}`,
                    { title },
                );
                print(`Renamed checklist ${view.ref} to "${view.title}"`, view);
                return 0;
            }
            if (sub === 'remove') {
                const [ref, ...extra] = rest;
                if (!ref || extra.length > 0) throw usage('checklist remove needs <ref>');
                const removed = await sessionRequest<{ ref: string; title: string }>(
                    client,
                    args,
                    io,
                    'DELETE',
                    `/checklists/${encodeURIComponent(ref)}`,
                );
                print(`Removed checklist ${removed.ref} "${removed.title}"`, removed);
                return 0;
            }
            throw usage('unknown checklist command');
        }

        // A choice is a checklist whose title is a question and whose items are the options.
        case 'choice': {
            if (sub === 'create') {
                const [question, ...extra] = rest;
                if (!question || extra.length > 0)
                    throw usage('choice create needs one <question> (quote it)');
                if (args.options.length < 2) {
                    throw usage('choice create needs at least two --option "<text>"');
                }
                const view = await sessionRequest<ChecklistView>(
                    client,
                    args,
                    io,
                    'POST',
                    '/checklists',
                    {
                        title: question,
                        items: args.options,
                        kind: 'choice',
                        pick: args.multiple ? 'any' : 'one',
                    },
                );
                print(`Created choice ${view.ref} "${view.title}"\n${formatChecklist(view)}`, view);
                return 0;
            }
            throw usage('unknown choice command');
        }

        case 'add': {
            const text = [sub, ...rest];
            if (!sub || text.length > 1) throw usage('add needs one <text> (quote it)');
            const added = await sessionRequest<{
                checklist: { ref: string; title: string };
                item: ItemView;
            }>(client, args, io, 'POST', '/items', {
                text: sub,
                ...(args.detail !== undefined && { detail: args.detail }),
                ...(args.checklist && { checklist: args.checklist }),
            });
            print(
                `Added ${added.item.ref} to ${added.checklist.ref} "${added.checklist.title}": ${added.item.text}`,
                added,
            );
            return 0;
        }

        case 'edit': {
            const [text, ...extra] = rest;
            if (!sub || extra.length > 0) throw usage('edit needs <ref> <text>');
            // The text can be left out to change only the detail of an option.
            if (text === undefined && args.detail === undefined) {
                throw usage('edit needs <ref> <text>, or --detail <text>');
            }
            const item = await sessionRequest<ItemView>(
                client,
                args,
                io,
                'PATCH',
                `/items/${encodeURIComponent(sub)}`,
                {
                    ...(text !== undefined && { text }),
                    ...(args.detail !== undefined && { detail: args.detail }),
                },
            );
            print(`Updated ${item.ref}: ${item.text}`, item);
            return 0;
        }

        case 'remove': {
            if (!sub || rest.length > 0) throw usage('remove needs <ref>');
            const removed = await sessionRequest<{ ref: string; text: string }>(
                client,
                args,
                io,
                'DELETE',
                `/items/${encodeURIComponent(sub)}`,
            );
            print(`Removed ${removed.ref}: ${removed.text}`, removed);
            return 0;
        }

        case 'message': {
            const text = [sub, ...rest].filter((part) => part !== undefined);
            if (args.clear ? text.length > 0 : text.length !== 1) {
                throw usage('message needs one <text> (quote it), or --clear');
            }
            const message = args.clear ? '' : (sub as string).trim();
            if (!args.clear && message === '') throw usage('message is empty: use --clear');
            if (args.with !== undefined) {
                throw usage(
                    'message takes --to <name> for one person (--with is for share and retest): without --to it would replace your own message',
                );
            }
            if (args.to !== undefined) {
                const { person } = await sessionRequest<{ person: string }>(
                    client,
                    args,
                    io,
                    'PUT',
                    '/message',
                    { message, to: args.to },
                );
                print(
                    args.clear
                        ? `Message removed from the copy of ${printableName(person)}.`
                        : `Message shown to ${printableName(person)} only.`,
                    { person, message },
                );
                return 0;
            }
            const session = await sessionRequest<SessionView>(client, args, io, 'PUT', '/message', {
                message,
            });
            print(
                args.clear
                    ? 'Message removed from the session.'
                    : `Message shown on the user's devices: ${session.message?.text ?? message}`,
                session,
            );
            return 0;
        }

        case 'share': {
            if (sub === 'list') {
                if (rest.length > 0) throw usage('share list takes no arguments');
                await client.ensureRunning(io.entry);
                const { shares } = await client.request<{ shares: ShareView[] }>('GET', '/shares');
                print(formatShares(shares), shares);
                return 0;
            }
            if (sub === 'close') {
                if (rest.length > 0) {
                    throw usage(
                        'share close takes no checklist: it takes the whole copy of the session away from the person (--with <name>); to take one checklist out use `share remove <checklist> --with <name>`',
                    );
                }
                const person = needPerson(args, 'share close');
                // Before asking: a session that is not there cannot be answered with a yes.
                await sessionRequest(client, args, io, 'GET', '');
                await confirmDeletion(
                    args,
                    io,
                    `Take the copy of this session away from ${printableName(person)}? It disappears from their app. What they reviewed stays here.`,
                );
                const closed = await sessionRequest<ShareView>(
                    client,
                    args,
                    io,
                    'DELETE',
                    `/shares/${encodeURIComponent(person)}`,
                );
                print(`Closed the copy of ${printableName(closed.person)}.`, closed);
                return 0;
            }
            if (sub === 'remove') {
                const [checklist, ...extra] = rest;
                if (checklist === undefined || extra.length > 0) {
                    throw usage('share remove needs one <checklist> ref and --with <name>');
                }
                const person = needPerson(args, 'share remove');
                const path = `/shares/${encodeURIComponent(person)}/checklists/${encodeURIComponent(checklist)}`;
                const preview = await sessionRequest<RemovalPreview>(client, args, io, 'GET', path);
                await confirmDeletion(args, io, removalQuestion(preview));
                const result = await sessionRequest<RemoveResult>(client, args, io, 'DELETE', path);
                print(formatRemoved(result), result);
                return 0;
            }
            if (sub === undefined || rest.length > 0) {
                throw usage('share needs one <checklist> ref and --with <name>');
            }
            const person = needPerson(args, 'share');
            const days = args.days === undefined ? undefined : Number(args.days);
            if (days !== undefined && !Number.isInteger(days)) {
                throw usage('--days needs a whole number');
            }
            const result = await sessionRequest<ShareResult>(client, args, io, 'POST', '/shares', {
                checklist: sub,
                with: person,
                ...(days !== undefined && { days }),
            });
            print(formatShareResult(result), result);
            return 0;
        }

        case 'retest': {
            const person = needPerson(args, 'retest');
            const refs = [sub, ...rest].filter((ref): ref is string => ref !== undefined);
            const result = await sessionRequest<RetestResult>(client, args, io, 'POST', '/retest', {
                with: person,
                ...(refs.length > 0 && { items: refs }),
                ...(args.message !== undefined && { message: args.message }),
            });
            print(formatRetest(result), result);
            return 0;
        }

        case 'show': {
            if (sub !== undefined) throw usage('show takes no arguments');
            const session = await sessionRequest<SessionView>(client, args, io, 'GET', '');
            print(formatSession(session), session);
            return 0;
        }

        case 'feedback': {
            if (sub !== undefined) throw usage('feedback takes no arguments');
            const target = await sessionTarget(client, args, io);
            const view = await target.request<FeedbackWithShared>('GET', '/feedback');
            await showFeedback(view, target, io, print);
            return 0;
        }

        case 'wait': {
            if (sub !== undefined) throw usage('wait takes no arguments (it needs --session)');
            return waitForDone(client, args, io, print);
        }

        case 'session': {
            if (sub === 'start') {
                const [title, ...extra] = rest;
                if (extra.length > 0) throw usage('session start takes one [title] (quote it)');
                const target = await projectTarget(client, args, io, { create: true });
                const session = await target.request<SessionView>('POST', '/sessions', {
                    ...(title && { title }),
                });
                print(
                    `Started session ${session.ref} "${session.title}"\nPass --session ${session.ref} to every palmtop command of this session.`,
                    session,
                );
                return 0;
            }
            if (sub === 'list' && rest.length === 0) {
                const project = await projectFor(client, args, io, false);
                const { sessions } = project
                    ? await targetFor(client, project).request<{ sessions: SessionSummary[] }>(
                          'GET',
                          '/sessions',
                      )
                    : { sessions: [] };
                print(formatSessionList(sessions), sessions);
                return 0;
            }
            if (sub === 'owner-name') {
                const [name, ...extra] = rest;
                if (args.clear ? name !== undefined : name === undefined || extra.length > 0) {
                    throw usage('session owner-name needs one <name> (quote it), or --clear');
                }
                const result = await sessionRequest<{ name: string | null; copies: number }>(
                    client,
                    args,
                    io,
                    'PUT',
                    '/owner-name',
                    {
                        name: args.clear ? null : name,
                        ...(args.for !== undefined && { for: args.for }),
                    },
                );
                const who = args.for === undefined ? 'the people who have this session' : args.for;
                print(
                    args.clear
                        ? `${printableName(who)} see your name as before (${result.copies} ${result.copies === 1 ? 'copy' : 'copies'}).`
                        : `${printableName(who)} see you as "${result.name}" (${result.copies} ${result.copies === 1 ? 'copy' : 'copies'}).`,
                    result,
                );
                return 0;
            }
            if (sub === 'title') {
                const [title, ...extra] = rest;
                if (!title || extra.length > 0)
                    throw usage('session title needs one <title> (quote it)');
                const session = await sessionRequest<SessionView>(client, args, io, 'PATCH', '', {
                    title,
                });
                print(`Session title set to "${session.title}"`, session);
                return 0;
            }
            throw usage('unknown session command');
        }

        case 'devices': {
            await client.ensureRunning(io.entry);
            const { devices } = await client.request<{ devices: PairedDeviceEntry[] }>(
                'GET',
                '/devices',
            );
            if (sub === undefined) {
                print(formatDevices(devices), devices);
                return 0;
            }
            if (sub !== 'remove') throw usage('unknown devices command');
            const [target, ...extra] = rest;
            if (!target || extra.length > 0) throw usage('devices remove needs one <name|id>');
            const device = findDevice(devices, target);
            const name = printableName(device.name);
            await confirmDeletion(
                args,
                io,
                `Unpair "${name}" (${device.deviceId})? It will not reach this computer any more, until it pairs again.`,
            );
            await client.request('DELETE', `/devices/${encodeURIComponent(device.deviceId)}`);
            print(`Unpaired "${name}".`, { removed: device });
            return 0;
        }

        case 'sessions': {
            await client.ensureRunning(io.entry);
            const { sessions } = await client.request<{ sessions: SystemSession[] }>(
                'GET',
                '/sessions',
            );
            if (sub === undefined) {
                print(formatSystemSessions(sessions), sessions);
                return 0;
            }
            if (sub !== 'delete') throw usage('unknown sessions command');
            const [ref, ...extra] = rest;
            if (!ref || extra.length > 0) throw usage('sessions delete needs one <ref>');
            const session = findSession(sessions, ref);
            await confirmDeletion(
                args,
                io,
                `Delete session ${session.ref} "${session.title}" of ${session.project.name}, with its checklists and notes, on this computer and on paired devices?`,
            );
            await client.request(
                'DELETE',
                `/projects/${session.project.id}/sessions/${encodeURIComponent(session.id)}`,
            );
            print(`Deleted session ${session.ref} "${session.title}" of ${session.project.name}.`, {
                deleted: session,
            });
            return 0;
        }

        case 'projects': {
            await client.ensureRunning(io.entry);
            const { projects } = await client.request<{ projects: SystemProject[] }>(
                'GET',
                '/projects',
            );
            if (sub === undefined) {
                const { name: computer } = await client.request<ComputerName>(
                    'GET',
                    '/config/name',
                );
                print(`Computer: ${computer}\n\n${formatSystemProjects(projects)}`, projects);
                return 0;
            }
            if (sub !== 'remove') throw usage('unknown projects command');
            const [target, ...extra] = rest;
            if (!target || extra.length > 0) throw usage('projects remove needs one <name|path>');
            const project = findProject(projects, target, io.cwd);
            await confirmDeletion(
                args,
                io,
                `Remove project ${project.name} (${project.rootPath}) with its ${plural(project.sessions, 'session')}? Paired devices lose access to it.`,
            );
            await client.request('DELETE', `/projects/${project.id}`);
            print(
                `Removed project ${project.name} (${project.rootPath}) with its ${plural(project.sessions, 'session')}. It is gone from your paired devices too.`,
                { removed: project },
            );
            return 0;
        }

        default:
            throw usage(`unknown command "${command}"`);
    }
}

interface ResolvedProject extends ProjectContext {
    projectId: string;
    name: string;
}

/** Returns the project of the current directory, creating it the first time. */
async function resolveProject(
    client: DaemonClient,
    args: Parsed,
    io: CliIo,
): Promise<ResolvedProject> {
    const context = detectProject(args.project ?? io.cwd);
    const { projectId, name } = await client.request<{ projectId: string; name: string }>(
        'POST',
        '/projects/resolve',
        {
            body: {
                rootPath: context.rootPath,
                ...(context.gitRemote && { gitRemote: context.gitRemote }),
            },
        },
    );
    return { ...context, projectId, name };
}

/**
 * Returns the project of the current directory, or `null` if there is none yet. Only
 * `session start` creates projects: other commands must not register random folders.
 */
async function lookupProject(
    client: DaemonClient,
    args: Parsed,
    io: CliIo,
): Promise<ResolvedProject | null> {
    const context = detectProject(args.project ?? io.cwd);
    const { project } = await client.request<{
        project: { projectId: string; name: string } | null;
    }>('POST', '/projects/lookup', { body: { rootPath: context.rootPath } });
    return project && { ...context, ...project };
}

function noProject(rootPath: string): CliError {
    return new CliError(
        `no palmtop project in ${rootPath} yet: start one with \`palmtop session start\``,
    );
}

function needPerson(args: Parsed, command: string): string {
    if (!args.with) throw usage(`${command} needs --with <name>`);
    return args.with;
}

function sessionRef(args: Parsed, io: CliIo): string {
    const ref = args.session ?? io.env.PALMTOP_SESSION_ID;
    if (!ref) {
        throw usage(
            'no session: pass --session <ref> or set PALMTOP_SESSION_ID (start a session with `palmtop session start`)',
        );
    }
    return ref;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface Target {
    request<T>(method: Method, path: string, body?: unknown): Promise<T>;
}

/**
 * Starts the daemon if needed and finds the project once, for requests under its path. Only
 * `create` registers a project that does not exist yet; otherwise the command fails.
 */
async function projectTarget(
    client: DaemonClient,
    args: Parsed,
    io: CliIo,
    options: { create?: boolean; session?: string } = {},
): Promise<Target> {
    const project = await projectFor(client, args, io, options.create ?? false);
    if (!project) throw noProject(detectProject(args.project ?? io.cwd).rootPath);
    return targetFor(client, project, options.session);
}

async function projectFor(
    client: DaemonClient,
    args: Parsed,
    io: CliIo,
    create: boolean,
): Promise<ResolvedProject | null> {
    await client.ensureRunning(io.entry);
    return create ? resolveProject(client, args, io) : lookupProject(client, args, io);
}

function targetFor(client: DaemonClient, project: ResolvedProject, session?: string): Target {
    const base = `/projects/${project.projectId}${
        session === undefined ? '' : `/sessions/${encodeURIComponent(session)}`
    }`;
    return {
        request: (method, path, body) =>
            client.request(method, `${base}${path}`, {
                ...(body !== undefined && { body }),
                ...(project.branch && { headers: { [BRANCH_HEADER]: project.branch } }),
            }),
    };
}

/**
 * The session of a command. In a folder with a palmtop project (or with `--project`) it is looked
 * for in that project, as always. Anywhere else it is looked for in every project of this
 * computer, like `sessions delete` does: a ref says enough, and closing a copy from the home
 * folder is no different from closing it from the project.
 */
async function sessionTarget(client: DaemonClient, args: Parsed, io: CliIo): Promise<Target> {
    const ref = sessionRef(args, io);
    const project = await projectFor(client, args, io, false);
    if (project) return targetFor(client, project, ref);
    if (args.project !== undefined) {
        throw noProject(detectProject(args.project).rootPath);
    }
    const { sessions } = await client.request<{ sessions: SystemSession[] }>('GET', '/sessions');
    const found = findSession(sessions, ref);
    const base = `/projects/${found.project.id}/sessions/${encodeURIComponent(found.id)}`;
    return {
        request: (method, path, body) =>
            client.request(method, `${base}${path}`, {
                ...(body !== undefined && { body }),
            }),
    };
}

async function sessionRequest<T>(
    client: DaemonClient,
    args: Parsed,
    io: CliIo,
    method: Method,
    path: string,
    body?: unknown,
): Promise<T> {
    return (await sessionTarget(client, args, io)).request<T>(method, path, body);
}

/** Prints the feedback, then marks it as delivered: a crash in between repeats it, never loses it. */
async function showFeedback(view: FeedbackWithShared, target: Target, io: CliIo, print: Print) {
    const { ack, shared, ...rest } = view;
    const sharedAck = shared?.ack ?? [];
    const shown = {
        ...rest,
        ...(shared && { shared: { ...shared, ack: undefined } }),
    };
    print(formatFeedback(shown), shown);
    for (const image of [...(view.images ?? []), ...(shared?.images ?? [])]) {
        io.attach?.({ path: image.path, mime: image.mime });
    }
    if (
        ack.items.length === 0 &&
        ack.sessionNote === undefined &&
        ack.done === undefined &&
        sharedAck.length === 0
    ) {
        return;
    }
    try {
        await target.request('POST', '/feedback/ack', {
            ...ack,
            ...(sharedAck.length > 0 && { shared: sharedAck }),
        });
    } catch (error) {
        io.stderr(
            `palmtop: warning: the feedback was not marked as delivered and will be reported again (${(error as Error).message})`,
        );
    }
}

/** Exit code of `palmtop wait` when the session (or its project) is gone. */
export const EXIT_SESSION_GONE = 3;
/** Exit code of `palmtop wait` when the daemon stays unreachable. */
export const EXIT_DAEMON_GONE = 4;
/** Exit code of `palmtop wait` when another `palmtop wait` took over the session. */
export const EXIT_REPLACED = 5;
/** Exit code of `palmtop wait` when it waited the whole time it may, without a tap. */
export const EXIT_EXPIRED = 6;
const WAIT_RETRY_MS = 2_000;
const WAIT_GIVE_UP_MS = 120_000;
/** A wait nobody taps for ends after this long: abandoned ones do not stay for ever. */
const WAIT_MAX_MS = 24 * 3_600_000;

/**
 * `palmtop wait`: returns when the user marks the session done on a device, with a fixed line
 * that sends the agent to `feedback`: nothing the user wrote is printed here. It asks the daemon
 * again and again (the daemon answers `pending` now and then), picks up by itself when the daemon
 * restarts, ends when another wait takes the place of this one (one wait for each session) and
 * after a day without a tap.
 */
async function waitForDone(
    client: DaemonClient,
    args: Parsed,
    io: CliIo,
    print: Print,
): Promise<number> {
    const target = await sessionTarget(client, args, io);
    const retryMs = io.waitRetryMs ?? WAIT_RETRY_MS;
    const giveUpMs = io.waitGiveUpMs ?? WAIT_GIVE_UP_MS;
    const maxMs = io.waitMaxMs ?? WAIT_MAX_MS;
    const started = Date.now();
    // Names this process to the daemon: it is the same wait while it asks again.
    const id = randomUUID();
    let claim = true;
    let downSince: number | null = null;
    for (;;) {
        if (Date.now() - started > maxMs) {
            throw new CliError(
                'timeout: a day went by without Review done, so the wait ended. Nothing is wrong: start it again only if you are still waiting for the review',
                EXIT_EXPIRED,
            );
        }
        let answer: {
            status: 'done' | 'pending' | 'superseded';
            session?: { ref: string; title: string };
        };
        try {
            answer = await target.request(
                'GET',
                `/wait?client=${id}${claim ? '&claim=1' : ''}&hold=${Math.max(1, maxMs - (Date.now() - started))}`,
            );
        } catch (error) {
            if (error instanceof DaemonUnreachableError) {
                downSince ??= Date.now();
                if (Date.now() - downSince > giveUpMs) {
                    throw new CliError(
                        'the daemon is not running: the wait ended. Start it with `palmtop serve -b`.',
                        EXIT_DAEMON_GONE,
                    );
                }
                await new Promise((done) => setTimeout(done, retryMs));
                continue;
            }
            if (error instanceof CliError && error.status === 404) {
                throw new CliError(`${error.message}: nothing to wait for`, EXIT_SESSION_GONE);
            }
            throw error;
        }
        downSince = null;
        claim = false;
        if (answer.status === 'done') {
            const ref = answer.session?.ref ?? sessionRef(args, io);
            print(`The user marked session ${ref} done: call feedback.`, answer);
            return 0;
        }
        if (answer.status === 'superseded') {
            throw new CliError(
                'another wait took over this session: nothing to do, that one is still waiting',
                EXIT_REPLACED,
            );
        }
    }
}

const NO_AGENT_FOUND =
    'No supported agent found (Claude Code, Codex): install one and run `palmtop setup` again, or use --force-agents-install.';

async function installCommand(io: CliIo, print: Print, force: boolean): Promise<number> {
    const platform = io.platform ?? process.platform;
    if (platform === 'win32') await ensureShim(io.entry);
    const installs = await installAgents(
        defaultAgents(agentsOnThisComputer(io.env), force),
        io.env,
        io.entry,
    );
    const palmtopOnPath = onPath('palmtop', io.env.PATH ?? '', { platform });
    print(
        [
            ...installs.flatMap((agent) => [
                agent.label,
                ...agent.details.map((line) => `  ${line}`),
                `  ${agent.usage}`,
            ]),
            ...(installs.length === 0 ? [NO_AGENT_FOUND] : []),
            'Other agents: tell them to run `palmtop guide` (e.g. in AGENTS.md) and allow the `palmtop` command.',
            ...(palmtopOnPath
                ? []
                : [
                      `Warning: \`palmtop\` is not on your PATH, so your agent cannot run it: add ${dirname(io.entry)} to your PATH.`,
                  ]),
        ].join('\n'),
        {
            ...Object.fromEntries(
                installs.map((agent) => [
                    agent.id === 'claude' ? 'claudeCode' : agent.id,
                    agent.result,
                ]),
            ),
            palmtopOnPath,
        },
    );
    return 0;
}

/**
 * `palmtop setup` without a terminal (agents, scripts, `--json`): sets up the agents found on
 * this computer and prints what is left to the user. It asks nothing and edits no shell file.
 */
async function setupUnattended(io: CliIo, print: Print, force: boolean): Promise<number> {
    const platform = io.platform ?? process.platform;
    if (platform === 'win32') await ensureShim(io.entry);
    const installs = await installAgents(
        defaultAgents(agentsOnThisComputer(io.env), force),
        io.env,
        io.entry,
    );
    const binDir = dirname(io.entry);
    const palmtopOnPath = onPath('palmtop', io.env.PATH ?? '', { platform });
    // Windows has no profile file: the PATH of the user is a variable, set from PowerShell.
    const windowsPath = platform === 'win32' ? pathCommand(binDir) : null;
    const profile = windowsPath ? null : shellProfile(binDir, io.env, platform);
    const pathStep = windowsPath
        ? `Put palmtop on your PATH: run this in PowerShell, then open a new terminal:\n    ${windowsPath}`
        : profile
          ? `Put palmtop on your PATH: add this line to ${tilde(profile.file, io.env)}, then open a new terminal:\n    ${profile.line}`
          : `Put palmtop on your PATH: add ${binDir} to it, then open a new terminal.`;
    const steps = [
        ...(palmtopOnPath ? [] : [pathStep]),
        'Pair a device: run `palmtop pair` in a terminal, from any folder.',
        'Ask your agent to put the checks on palmtop.',
    ];
    print(
        [
            ...installs.flatMap((agent) => [
                agent.label,
                ...agent.details.map((line) => `  ${line}`),
            ]),
            ...(installs.length === 0 ? [NO_AGENT_FOUND] : []),
            'Next steps for you:',
            ...steps.map((step, i) => `  ${i + 1}. ${step}`),
        ].join('\n'),
        {
            agents: installs.map(({ id, changed, result }) => ({ id, changed, result })),
            palmtopOnPath,
            ...(profile && !palmtopOnPath && { path: { file: profile.file, line: profile.line } }),
            ...(windowsPath && !palmtopOnPath && { path: { line: windowsPath } }),
        },
    );
    return 0;
}

/** `palmtop setup` on a terminal: logo, agents, PATH, daemon, and pairing a device. */
async function setupInteractive(
    client: DaemonClient,
    io: CliIo,
    ui: SetupUi,
    force: boolean,
): Promise<number> {
    const depth = io.color ?? 'none';
    const cancelled = () => {
        ui.cancel('Setup cancelled: run `palmtop setup` again whenever you like.');
        return 1;
    };
    io.stdout(`\n${banner(BUILD_INFO.version, depth)}\n`);
    ui.intro('Set up palmtop');

    const agents = agentsOnThisComputer(io.env);
    let selected: AgentId[] = [];
    if (force || agents.some((agent) => agent.found)) {
        // Agents that are not installed can be chosen only with --force-agents-install.
        const answer = await ui.multiselect(
            'Which agents should use palmtop?',
            agents.map((agent) => ({
                value: agent.id,
                label: agent.label,
                hint: agent.found ? 'found on this computer' : 'not installed',
                disabled: !agent.found && !force,
            })),
            agents.filter((agent) => agent.found).map((agent) => agent.id),
        );
        if (answer === null) return cancelled();
        selected = answer;
    } else {
        ui.warn(
            `No supported agent found (${agents.map((agent) => agent.label).join(', ')}). Install one, then run \`palmtop setup\` again: any other agent can learn palmtop with \`palmtop guide\`.`,
        );
    }
    const installs = await installAgents(selected, io.env, io.entry);
    for (const agent of installs) {
        ui.success(
            agent.changed
                ? `${agent.label}: palmtop skill and permission installed`
                : `${agent.label}: already set up`,
        );
    }
    if (installs.length === 0 && (force || agents.some((agent) => agent.found))) {
        ui.info('No agent selected: any agent can learn palmtop with `palmtop guide`.');
    }

    let newTerminal = false;
    const binDir = dirname(io.entry);
    const platform = io.platform ?? process.platform;
    if (platform === 'win32') await ensureShim(io.entry);
    if (!onPath('palmtop', io.env.PATH ?? '', { platform })) {
        const profile = platform === 'win32' ? null : shellProfile(binDir, io.env, platform);
        if (platform === 'win32') {
            const add = await ui.confirm('Add palmtop to your PATH?', true);
            if (add === null) return cancelled();
            if (add) {
                try {
                    const result = await addToUserPath(
                        binDir,
                        io.powershell ?? runPowerShell,
                        backupSuffix(new Date()),
                    );
                    ui.success(
                        result.change === 'unchanged'
                            ? 'palmtop is already on your PATH'
                            : `Added palmtop to your PATH${result.backup ? ` (your earlier PATH is kept in ${result.backup})` : ''}`,
                    );
                    newTerminal = true;
                } catch (error) {
                    ui.warn(
                        `Could not change your PATH (${(error as Error).message}). Run this in PowerShell yourself:\n${pathCommand(binDir)}`,
                    );
                }
            } else {
                ui.info(`Run this in PowerShell yourself:\n${pathCommand(binDir)}`);
            }
        } else if (profile === null) {
            ui.warn(`Add ${binDir} to your PATH, so you and your agents can run palmtop.`);
        } else {
            const file = tilde(profile.file, io.env);
            const add = await ui.confirm(`Add palmtop to your PATH in ${file}?`, true);
            if (add === null) return cancelled();
            if (add) {
                const result = await addToPath(profile, backupSuffix(new Date()));
                ui.success(
                    result.change === 'unchanged'
                        ? `${file} already puts palmtop on your PATH`
                        : `Added palmtop to your PATH in ${file}${result.backup ? ` (backup: ${tilde(result.backup, io.env)})` : ''}`,
                );
                newTerminal = true;
            } else {
                ui.info(`Add this line to ${file} yourself:\n${profile.line}`);
            }
        }
    }

    const spin = ui.spinner();
    spin.start('Starting palmtop in the background');
    const health = await client.ensureRunning(io.entry);
    spin.stop(`palmtop is running on "${health.computerName}"`);

    const pair = await ui.confirm('Pair a device now? (phone, tablet or another computer)', true);
    if (pair === null) return cancelled();
    if (pair && io.tty) {
        await pairInTerminal(client, io, io.tty, pairingPageOpener(client, io));
    } else {
        ui.info('Pair a device later with `palmtop pair`, from any folder.');
    }

    const names = installs.map((agent) => agent.label).join(' or ') || 'your agent';
    ui.info(
        [
            `Next: ${newTerminal ? 'open a new terminal, then start' : 'start'} ${names} in your project`,
            'and ask it to put the checks on palmtop.',
        ].join('\n'),
    );
    ui.outro(green('palmtop is ready.', depth));
    return 0;
}

async function status(
    client: DaemonClient,
    args: Parsed,
    io: CliIo,
    print: Print,
): Promise<number> {
    const probe = await client.probe();
    if (probe.kind !== 'up') {
        const running = probe.kind === 'foreign' ? 'port used by another daemon' : 'not running';
        print(`Daemon: ${running}`, { daemon: { running: false, reason: probe.kind } });
        return probe.kind === 'foreign' ? 1 : 0;
    }
    const { health } = probe;
    const { release } = health.relay;
    const updateAvailable =
        BUILD_INFO.build !== 'dev' && release != null && release.build !== BUILD_INFO.build;
    const daemonLine = [
        `Daemon: running (pid ${health.pid}), local port ${health.localPort}${
            health.build === BUILD_INFO.build
                ? ''
                : ', another palmtop build: it restarts with the next command'
        }`,
        health.relay.status === 'outdated'
            ? `Relay: refuses this palmtop version, run \`palmtop update\` (${health.relay.url})`
            : `Relay: ${health.relay.status} (${health.relay.url})`,
        ...(updateAvailable
            ? [`Update available: ${describeBuild(release)}, run \`palmtop update\``]
            : []),
    ].join('\n');
    const waits = await waitingSessions(client);
    const waitLines = waits.map(
        (wait) =>
            `Waiting for Review done: ${wait.session.ref} "${wait.session.title}" (${wait.project.name})`,
    );
    const project = await lookupProject(client, args, io);
    if (!project) {
        const { rootPath } = detectProject(args.project ?? io.cwd);
        print(
            `${[daemonLine, ...waitLines].join('\n')}\nProject: none in ${rootPath} yet (start one with \`palmtop session start\`)`,
            {
                daemon: { running: true, ...health },
                cli: BUILD_INFO,
                updateAvailable,
                waits,
                project: null,
            },
        );
        return 0;
    }
    const ref = args.session ?? io.env.PALMTOP_SESSION_ID;
    const detail = await client.request<{
        seq: number;
        connectedDevices: number;
        sessions: number;
        session: { ref: string; title: string } | null;
    }>(
        'GET',
        `/projects/${project.projectId}/status${ref ? `?session=${encodeURIComponent(ref)}` : ''}`,
    );

    const sessionLine = !ref
        ? `Session: none selected (${detail.sessions} in this project, see \`palmtop session list\`)`
        : detail.session
          ? `Session: ${ref} "${detail.session.title}"`
          : `Session: ${ref} not found in this project`;
    print(
        [
            daemonLine,
            ...waitLines,
            `Project: ${withComputer(health.computerName, project.name)} (${project.rootPath})`,
            `Devices connected: ${detail.connectedDevices}`,
            sessionLine,
        ].join('\n'),
        {
            daemon: { running: true, ...health },
            cli: BUILD_INFO,
            updateAvailable,
            waits,
            project: { id: project.projectId, name: project.name, rootPath: project.rootPath },
            connectedDevices: detail.connectedDevices,
            sessions: detail.sessions,
            session: detail.session,
        },
    );
    return 0;
}

/** The sessions an agent is waiting for a Review done in (daemons before 0.24 do not know). */
async function waitingSessions(
    client: DaemonClient,
): Promise<
    Array<{ project: { id: string; name: string }; session: { ref: string; title: string } }>
> {
    try {
        const { waits } = await client.request<{
            waits: Array<{
                project: { id: string; name: string };
                session: { ref: string; title: string };
            }>;
        }>('GET', '/waits');
        return waits;
    } catch {
        return [];
    }
}

interface ComputerName {
    name: string;
    /** Host name, used when no name is set. */
    default: string;
}

/** `NAME - project`, as devices show it; daemons before 0.4.0 report no computer name. */
function withComputer(computer: string | undefined, project: string): string {
    return computer ? `${computer} - ${project}` : project;
}

function describeBuild(build: { version: string; build: string }): string {
    return build.build === 'dev'
        ? 'palmtop (sources)'
        : `palmtop ${build.version} (build ${build.build})`;
}

async function updateCommand(client: DaemonClient, io: CliIo, print: Print): Promise<number> {
    const webUrl = relayWebUrl(resolveRelayUrl(io.env));
    const result = await updateCli({ entry: io.entry, webUrl, current: BUILD_INFO });
    if (result.status === 'up-to-date') {
        print(`${describeBuild(BUILD_INFO)} is up to date.`, { updated: false, ...result });
        return 0;
    }
    const lines = [`Updated ${describeBuild(BUILD_INFO)} to ${describeBuild(result.release)}.`];

    // The skills come from the guide inside the bundle, and the MCP server points to it: refresh both.
    const skills = [
        join(claudeConfigDir(io.env), 'skills', 'palmtop', 'SKILL.md'),
        codexSkillPath(userHome(io.env)),
    ];
    if (skills.some((skill) => existsSync(skill))) {
        const install = spawnSync(process.execPath, [result.path, 'install', '--json'], {
            env: io.env,
            encoding: 'utf8',
        });
        lines.push(
            install.status === 0
                ? 'palmtop skill and tools refreshed (restart your agent to load them).'
                : 'Warning: the palmtop skill and tools were not refreshed: run `palmtop setup`.',
        );
    }

    const probe = await client.probe();
    if (probe.kind === 'up') {
        await client.ensureRunning(io.entry, result.release.build);
        lines.push('Daemon restarted with the new version.');
    }
    print(lines.join('\n'), { updated: true, release: result.release });
    return 0;
}

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Finds a session of any project by ref (at least 4 characters) or full id. */
export function findSession(sessions: SystemSession[], ref: string): SystemSession {
    const wanted = ref.trim().toLowerCase();
    const exact = sessions.find((session) => session.id.toLowerCase() === wanted);
    if (exact) return exact;
    if (wanted.length < 4)
        throw new CliError(`invalid session ref "${ref}": use at least 4 characters`);
    const matches = sessions.filter((session) => session.ref.startsWith(wanted));
    if (matches.length === 0) {
        throw new CliError(`no session "${ref}" on this computer (see \`palmtop sessions\`)`);
    }
    if (matches.length > 1) {
        throw new CliError(`session ref "${ref}" is ambiguous, use more characters`);
    }
    return matches[0] as SystemSession;
}

/** Finds a device by its id, the start of it (4 characters or more), or its exact name. */
export function findDevice(devices: PairedDeviceEntry[], target: string): PairedDeviceEntry {
    const wanted = target.trim();
    const byId = devices.filter((device) => device.deviceId === wanted);
    if (byId.length === 1) return byId[0] as PairedDeviceEntry;
    const byName = devices.filter((device) => device.name === wanted);
    if (byName.length === 1) return byName[0] as PairedDeviceEntry;
    if (byName.length > 1) {
        throw new CliError(`several devices are named "${wanted}": use the id instead`);
    }
    const byPrefix =
        wanted.length >= 4 ? devices.filter((device) => device.deviceId.startsWith(wanted)) : [];
    if (byPrefix.length === 1) return byPrefix[0] as PairedDeviceEntry;
    if (byPrefix.length > 1)
        throw new CliError(`device id "${wanted}" is ambiguous, use more characters`);
    throw new CliError(`no device "${wanted}" paired with this computer (see \`palmtop devices\`)`);
}

/** Finds a project by name, path (relative to `cwd`) or id. */
export function findProject(projects: SystemProject[], target: string, cwd: string): SystemProject {
    const path = resolve(cwd, target);
    const byPath = projects.filter(
        (project) => sameRoot(project.rootPath, path) || project.id === target,
    );
    if (byPath.length === 1) return byPath[0] as SystemProject;
    const byName = projects.filter((project) => project.name === target);
    if (byName.length === 1) return byName[0] as SystemProject;
    if (byName.length > 1) {
        throw new CliError(`several projects are named "${target}": use the path instead`);
    }
    throw new CliError(`no project "${target}" on this computer (see \`palmtop projects\`)`);
}

/**
 * Deletions need a yes in an interactive terminal, or `--yes`. Without a terminal (agents,
 * scripts) and without `--yes`, nothing is deleted.
 */
export async function confirmDeletion(
    args: Pick<Parsed, 'yes'>,
    io: Pick<CliIo, 'confirm'>,
    question: string,
): Promise<void> {
    if (args.yes) return;
    if (!io.confirm) {
        throw new CliError('nothing deleted: confirm in an interactive terminal, or pass --yes');
    }
    if (!(await io.confirm(`${question} [y/N] `))) throw new CliError('nothing deleted');
}

/**
 * `palmtop invite --name Mario`: a link that opens once, within a day, in the room of that person.
 * Only a person at a terminal can do it, like `palmtop pair CODE`: the link is a secret, and it
 * must never reach the output of an agent. What the person can see is only what is shared with
 * them later.
 */
async function inviteInTerminal(client: DaemonClient, args: Parsed, io: CliIo): Promise<number> {
    const tty = io.tty;
    if (!tty || !io.confirm || args.json) {
        throw new CliError(
            'an invitation needs you at a terminal: run `palmtop invite --name <name>` yourself (agents and scripts cannot)',
        );
    }
    if (!args.name) throw usage('invite needs --name <name>');
    await client.ensureRunning(io.entry);

    // The people see this name as the one who shares with them: asked the first time only.
    const owner = await client.request<{ name: string | null }>('GET', '/config/owner-name');
    if (owner.name === null && io.ask) {
        const answer = (
            await io.ask(
                'How should the people you share with call you? (e.g. "Grace (studio)"; Enter to skip) ',
            )
        ).trim();
        if (answer !== '') {
            await client.request('PUT', '/config/owner-name', { body: { name: answer } });
        }
    }

    const { people } = await client.request<{ people: PersonView[] }>('GET', '/people');
    const existing = people.find(
        (person) => person.name.toLowerCase() === args.name?.toLowerCase(),
    );
    if (existing?.device) {
        const ok = await io.confirm(
            `${printableName(existing.name)} has a device already (${printableName(existing.device.name)}). A new invitation unpairs it. Continue? [y/N] `,
        );
        if (!ok) throw new CliError('nothing changed');
    }
    const invite = await client.request<InviteResult>('POST', '/people/invite', {
        body: { name: args.name, replace: existing?.device != null },
    });
    const name = printableName(invite.name);
    io.stdout(
        [
            `Invite ${name} to look at the checklists you share`,
            ...(invite.warning ? ['', invite.warning] : []),
            '',
            renderTerminalQr(invite.url),
            '',
            `Send ${name} this link, or have them scan the code. It opens once, until ${formatInviteEnd(invite.expiresAt)}:`,
            invite.url,
            '',
            `${name} sees only what you share with them, never the rest of this computer.`,
            'You get a notification when they open it. Then give them a checklist with',
            `\`palmtop share <checklist> --with ${name}\`.`,
            'Press Enter or Esc to close: the screen is cleared, the link stays valid.',
        ].join('\n'),
    );
    for (;;) {
        if (CLOSE_KEYS.has(await tty.readKey())) break;
    }
    tty.clear();
    io.stdout(
        `Invitation for ${name} ready until ${formatInviteEnd(invite.expiresAt)}. \`palmtop people\` shows when they join.`,
    );
    return 0;
}

function formatInviteEnd(expiresAt: number): string {
    const date = new Date(expiresAt);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `palmtop config owner-name [name]`: how the people see you, unless a session says otherwise. */
async function ownerNameConfig(
    client: DaemonClient,
    rest: string[],
    args: Parsed,
    io: CliIo,
    print: Print,
): Promise<number> {
    const [name, ...extra] = rest;
    if (extra.length > 0) throw usage('config owner-name takes one [name] (quote it)');
    if (name !== undefined && args.reset) throw usage('config owner-name: pass a name or --reset');
    await client.ensureRunning(io.entry);
    if (name === undefined && !args.reset) {
        const current = await client.request<{ name: string | null }>('GET', '/config/owner-name');
        print(
            current.name === null
                ? 'Owner name: not set (the people see "Shared checklists"; set one with `palmtop config owner-name "<name>"`)'
                : `Owner name: ${current.name}`,
            current,
        );
        return 0;
    }
    const saved = await client.request<{ name: string | null }>('PUT', '/config/owner-name', {
        body: { name: args.reset ? null : name },
    });
    print(
        saved.name === null
            ? 'Owner name removed: the people see "Shared checklists" again.'
            : `Owner name set to: ${saved.name}`,
        saved,
    );
    return 0;
}
