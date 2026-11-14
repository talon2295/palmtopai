import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { AGENT_GUIDE } from '@palmtopai/agent-guide';
import { defaultComputerName } from '@palmtopai/daemon';
import { CloseCode, createId, createOp, type OpOf, type OpType } from '@palmtopai/protocol';
import { roomIdOf } from '@palmtopai/protocol/relay-crypto';
import { type Relay, startRelay } from '@palmtopai/relay';
import { buildCli } from '../scripts/build';
import { confirmDeletion, extractOptions, isWsl, openCandidates, run } from '../src/cli';
import { CliError } from '../src/daemon-client';
import {
    formatFeedback,
    formatItem,
    formatSessionList,
    formatSystemSessions,
    printableName,
} from '../src/format';
import { sanitizeRemote } from '../src/project';
import { updateCli } from '../src/update';
import { type E2EDevice, pairOverRelay, waitForMessage } from './e2e-device';

// Each test spawns several `node` processes: on a slow or busy machine 5 s is not enough.
setDefaultTimeout(30_000);

/** Windows has no permission bits, no symlinks without a privilege and no `#!/bin/sh` scripts. */
const WINDOWS = process.platform === 'win32';
const NODE = Bun.which('node');
if (!NODE) throw new Error('these tests run the compiled CLI with Node.js 22+: install node');

/** The CLI bundle built for Node, as users run it. */
let cli: string;

interface Result {
    code: number;
    stdout: string;
    stderr: string;
}

/** Every output produced in this file, checked at the end for leaked secrets. */
const outputs: Array<{ args: string[]; text: string }> = [];
const secrets: string[] = [];

function freePort(): number {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
    const port = server.port as number;
    server.stop(true);
    return port;
}

function git(cwd: string, ...args: string[]) {
    const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'ignore', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

let home: string;
let repo: string;
let relay: Relay;
let localPort: number;
/** Session refs printed by `session start`, by test name. */
const refs: Record<string, string> = {};

/**
 * Runs the CLI. `session` names a session started by a test and is passed as `--session <ref>`
 * (a name that was never started is passed as is); `null` passes no session.
 */
async function palmtop(
    args: string[],
    options: {
        session?: string | null;
        cwd?: string;
        env?: Record<string, string>;
        /** Path the CLI is started from (default: the bundle). */
        entry?: string;
    } = {},
): Promise<Result> {
    const env: Record<string, string | undefined> = {
        ...process.env,
        PALMTOP_HOME: home,
        PALMTOP_RELAY_URL: `ws://127.0.0.1:${relay.port}`,
        CLAUDE_CONFIG_DIR: join(home, 'claude-config'),
        CODEX_HOME: join(home, 'codex-home'),
        // Codex's skill goes to ~/.agents: never the real home, even with codex on the PATH.
        HOME: home,
        USERPROFILE: home,
        ...options.env,
    };
    delete env.INIT_CWD;
    delete env.PALMTOP_SESSION_ID;
    const session = options.session === undefined ? 'a' : options.session;
    const sessionArgs = session === null ? [] : ['--session', refs[session] ?? session];
    const child = Bun.spawn([NODE as string, options.entry ?? cli, ...args, ...sessionArgs], {
        cwd: options.cwd ?? repo,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    outputs.push({ args, text: `${stdout}\n${stderr}` });
    return { code, stdout, stderr };
}

async function json<T>(args: string[], options: Parameters<typeof palmtop>[1] = {}): Promise<T> {
    const result = await palmtop([...args, '--json'], options);
    if (result.code !== 0) throw new Error(`palmtop ${args.join(' ')} failed: ${result.stderr}`);
    return JSON.parse(result.stdout) as T;
}

interface ItemJson {
    ref: string;
    id: string;
    text: string;
    detail?: string;
    status?: string;
    note?: string;
}
interface ChecklistJson {
    ref: string;
    id: string;
    title: string;
    items: ItemJson[];
}
interface SessionJson {
    ref: string;
    id: string;
    title: string;
    status: string;
    checklists: ChecklistJson[];
}

async function startSession(name: string, title?: string): Promise<SessionJson> {
    const session = await json<SessionJson>(['session', 'start', ...(title ? [title] : [])], {
        session: null,
    });
    refs[name] = session.ref;
    return session;
}

/**
 * A device paired with the computer through the relay, end to end like the web app: it pairs
 * with a single-use key from the Local API (as `palmtop pair` would show), then says hello on the
 * sealed channel. Retries while the relay answers "daemon offline" (the daemon may still be
 * opening the room). Every key used here joins the secrets no output may contain.
 */
async function connectDevice(deviceId = 'phone', rootPath = repo) {
    const registry = JSON.parse(await readFile(join(home, 'projects.json'), 'utf8')) as {
        computer: { roomKey: { publicKey: string } };
        projects: Array<{ projectId: string; rootPath: string }>;
    };
    const project = registry.projects.find((entry) => entry.rootPath === rootPath);
    if (!project) throw new Error('project not found');
    const roomId = roomIdOf(registry.computer.roomKey.publicKey);
    const localKey = (await readFile(join(home, 'local.key'), 'utf8')).trim();

    let device: E2EDevice | undefined;
    for (let attempt = 0; attempt < 100 && !device; attempt++) {
        const link = (await (
            await fetch(`http://127.0.0.1:${localPort}/pair/links`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-palmtop-key': localKey },
                body: '{}',
            })
        ).json()) as { key: string };
        secrets.push(link.key);
        const attemptResult = await pairOverRelay({
            url: `ws://127.0.0.1:${relay.port}/ws?room=${roomId}`,
            roomId,
            pairKey: link.key,
            deviceId,
        });
        if (attemptResult.kind === 'paired') device = attemptResult.device;
        else if (attemptResult.code !== CloseCode.daemonOffline) {
            throw new Error(`pairing refused: ${JSON.stringify(attemptResult)}`);
        } else await Bun.sleep(50);
    }
    if (!device) throw new Error('the daemon never opened the project room');
    const connected = device;
    const { messages } = connected;
    await waitForMessage(connected, (message) => message.type === 'paired');
    connected.send({ type: 'hello', projectId: project.projectId });
    // The project list comes first, the snapshot right after it.
    const snapshot = await waitForMessage(connected, (message) => message.type === 'snapshot');
    let lamport = snapshot.state?.lamport ?? 0;
    const closeListeners: Array<(code: number) => void> = [];
    void connected.closed.then((code) => {
        for (const listener of closeListeners) listener(code);
    });

    return {
        async send<T extends OpType>(sessionId: string, type: T, payload: OpOf<T>['payload']) {
            for (const message of messages)
                lamport = Math.max(lamport, message.op?.clock.lamport ?? 0);
            const op = createOp({
                projectId: project.projectId,
                sessionId,
                type,
                payload,
                clock: { lamport: ++lamport, deviceId },
            });
            connected.send({ type: 'op', op });
            for (;;) {
                if (messages.some((message) => message.op?.opId === op.opId)) return;
                const error = messages.find((message) => message.opId === op.opId);
                if (error) throw new Error(`device op rejected: ${JSON.stringify(error)}`);
                await Bun.sleep(10);
            }
        },
        close: () => connected.close(),
        onClose: (listener: (code: number) => void) => closeListeners.push(listener),
        /** Waits for a project list that no longer has `projectId`. */
        async projectsWithout(projectId: string) {
            for (let attempt = 0; attempt < 200; attempt++) {
                const lists = messages.filter((message) => message.type === 'projects');
                const last = lists.at(-1);
                if (last && !last.projects?.some((entry) => entry.id === projectId)) return true;
                await Bun.sleep(10);
            }
            return false;
        },
    };
}

beforeAll(async () => {
    // realpath: on macOS the temp dir is a symlink and git reports the resolved path.
    home = await realpath(await mkdtemp(join(tmpdir(), 'palmtop-cli-')));
    cli = await buildCli(join(home, 'dist'));
    repo = join(home, 'my-repo');
    await mkdir(join(repo, 'src', 'deep'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'feature/cli');
    git(
        repo,
        'remote',
        'add',
        'origin',
        'https://someone:ghp_SECRETREMOTETOKEN@github.com/me/my-repo.git',
    );
    relay = startRelay({ port: 0, log: () => {} });
    localPort = freePort();
    await writeFile(join(home, 'config.json'), JSON.stringify({ localPort }));
    // Mario was invited earlier (the invitation itself comes with phase 20b.2).
    await writeFile(
        join(home, 'people.json'),
        JSON.stringify({
            people: [{ personId: createId(), name: 'Mario', createdAt: 1 }],
            shares: [],
        }),
    );
});

afterAll(async () => {
    await palmtop(['stop']);
    await relay.stop();
    await rm(home, { recursive: true, force: true });
});

describe('usage', () => {
    test('help and unknown commands', async () => {
        const help = await palmtop(['--help']);
        expect(help.code).toBe(0);
        for (const command of [
            'session start [title]',
            'session list',
            'sessions delete <ref>',
            'projects remove <name|path>',
            'checklist create <title>',
            'feedback',
            'wait',
            'guide',
            'setup',
        ]) {
            expect(help.stdout).toContain(command);
        }
        expect(help.stdout).not.toContain(' check ');
        expect(help.stdout).not.toContain('session end');
        // Replaced by `setup`; still there for `palmtop update` of older versions.
        expect(help.stdout).not.toContain('  install ');

        expect((await palmtop([])).code).toBe(2);
        const unknown = await palmtop(['check', 'abcd']);
        expect(unknown.code).toBe(2);
        expect(unknown.stderr).toContain('unknown command "check"');
        expect((await palmtop(['add'])).code).toBe(2);
        expect((await palmtop(['add', 'a', 'b'])).stderr).toContain('quote it');
        expect((await palmtop(['--bogus'])).code).toBe(2);
    });

    test('version prints the version and build of the bundle', async () => {
        const release = JSON.parse(await readFile(join(home, 'dist', 'version.json'), 'utf8'));
        expect(release.build).toMatch(/^[0-9a-f]{12}$/);
        const expected = `palmtop ${release.version} (build ${release.build})\n`;
        expect((await palmtop(['--version'], { session: null })).stdout).toBe(expected);
        expect((await palmtop(['version'], { session: null })).stdout).toBe(expected);
        expect(
            createHash('sha256')
                .update(await readFile(cli))
                .digest('hex'),
        ).toBe(release.sha256);
    });

    test('guide prints the agent instructions without starting the daemon', async () => {
        const guide = await palmtop(['guide'], { session: null });
        expect(guide).toMatchObject({ code: 0, stderr: '' });
        expect(guide.stdout).toBe(`${AGENT_GUIDE.trimEnd()}\n`);
        expect((await palmtop(['guide', 'extra'], { session: null })).code).toBe(2);
        expect((await palmtop(['status'], { session: null })).stdout).toBe('Daemon: not running\n');
    });

    test('status does not start the daemon', async () => {
        const result = await palmtop(['status'], { session: null });
        expect(result).toMatchObject({ code: 0, stdout: 'Daemon: not running\n' });
        expect((await palmtop(['status'])).stdout).toContain('not running');
    });

    test('session commands need a session id', async () => {
        const result = await palmtop(['show'], { session: null });
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('no session: pass --session <ref>');
        expect((await palmtop(['feedback'], { session: null })).code).toBe(2);
    });
});

describe('sessions, checklists and reviews through the CLI', () => {
    let checklist: ChecklistJson;

    test('config name shows, sets and resets the computer name', async () => {
        const host = defaultComputerName();
        const shown = await palmtop(['config', 'name'], { session: null });
        expect(shown).toMatchObject({ code: 0, stderr: '' });
        expect(shown.stdout).toBe(
            `Computer name: ${host} (host name; set another with \`palmtop config name "<name>"\`)\n`,
        );

        const set = await palmtop(['config', 'name', ' Office Mac '], { session: null });
        expect(set.stdout).toBe('Computer name set to: Office Mac\n');
        expect((await palmtop(['config', 'name'], { session: null })).stdout).toBe(
            `Computer name: Office Mac (host name: ${host})\n`,
        );
        const config = JSON.parse(await Bun.file(join(home, 'config.json')).text());
        expect(config.computerName).toBe('Office Mac');

        const tooLong = await palmtop(['config', 'name', 'x'.repeat(41)], { session: null });
        expect(tooLong.code).toBe(1);
        expect(tooLong.stderr).toContain('longer than 40 characters');
        expect((await palmtop(['config', 'name', 'a', '--reset'], { session: null })).code).toBe(2);
        expect((await palmtop(['config', 'other'], { session: null })).code).toBe(2);

        const reset = await palmtop(['config', 'name', '--reset'], { session: null });
        expect(reset.stdout).toBe(`Computer name reset to the host name: ${host}\n`);
        expect(
            await json<{ name: string; default: string }>(['config', 'name'], { session: null }),
        ).toEqual({ name: host, default: host });
    });

    test('session start starts the daemon in the background and prints the ref to use', async () => {
        const started = await palmtop(['session', 'start'], { session: null });
        const match = started.stdout.match(
            /^Started session ([0-9a-hjkmnp-tv-z]{6}) "feature\/cli · \d\d:\d\d"\nPass --session ([0-9a-z]{6}) to every palmtop command of this session\.\n$/,
        );
        expect(match?.[1]).toBe(match?.[2] as string);
        refs.a = match?.[1] as string;
        expect(await Bun.file(join(home, 'daemon.log')).exists()).toBe(true);

        const status = await palmtop(['status']);
        expect(status.stdout).toContain(`local port ${localPort}\nRelay: `);
        expect(status.stdout).toContain(`(ws://127.0.0.1:${relay.port})`);
        expect(status.stdout).not.toContain('device port');
        expect(status.stdout).toContain(`Project: ${defaultComputerName()} - my-repo (${repo})`);
        expect(status.stdout).toContain(`Session: ${refs.a} "feature/cli · `);
        expect((await palmtop(['status'], { session: null })).stdout).toContain(
            'Session: none selected (1 in this project',
        );
    });

    test('the daemon started by the CLI runs on Node and connects to the relay', async () => {
        type Status = { daemon: { pid: number; relay: { status: string } } };
        let status = await json<Status>(['status']);
        for (let i = 0; i < 100 && status.daemon.relay.status !== 'connected'; i++) {
            await Bun.sleep(30);
            status = await json<Status>(['status']);
        }
        expect(status.daemon.relay.status).toBe('connected');
        // No `ps` on Windows: there the process is only known to be up and connected.
        if (WINDOWS) return;
        const command = Bun.spawnSync(['ps', '-p', String(status.daemon.pid), '-o', 'command=']);
        expect(command.stdout.toString()).toContain(`${cli} serve`);
        expect(command.stdout.toString()).toMatch(/node/);
    });

    test('the Node daemon reconnects after the relay restarts', async () => {
        type Status = { daemon: { relay: { status: string } } };
        const relayStatus = async () => (await json<Status>(['status'])).daemon.relay.status;
        const port = relay.port;
        await relay.stop();
        for (let i = 0; i < 100 && (await relayStatus()) === 'connected'; i++) await Bun.sleep(30);
        expect(await relayStatus()).not.toBe('connected');
        // Down long enough for several refused attempts (Node reports them without a close event).
        await Bun.sleep(1_500);

        relay = startRelay({ port, log: () => {} });
        let status = await relayStatus();
        for (let i = 0; i < 200 && status !== 'connected'; i++) {
            await Bun.sleep(50);
            status = await relayStatus();
        }
        expect(status).toBe('connected');
    });

    test('texts starting with a dash are accepted', async () => {
        const created = await json<ChecklistJson>([
            'checklist',
            'create',
            'Flags',
            '--item',
            '--version flag',
            '--item',
            '-v short flag',
        ]);
        try {
            expect(created.items.map((item) => item.text)).toEqual([
                '--version flag',
                '-v short flag',
            ]);
            // After `--` everything is text: options (and the helper's --session) go before it.
            const added = await palmtop(
                [
                    'add',
                    '--session',
                    refs.a as string,
                    '--checklist',
                    created.ref,
                    '--',
                    '--dry-run flag',
                ],
                { session: null },
            );
            expect(added.code).toBe(0);
            expect(added.stdout).toContain(`to ${created.ref} "Flags": --dry-run flag`);
        } finally {
            await palmtop(['checklist', 'remove', created.ref]);
        }
    });

    test('checklists are created in the session', async () => {
        checklist = await json<ChecklistJson>([
            'checklist',
            'create',
            'Refactor auth',
            '--item',
            'Extract token service',
            '--item',
            'Add rate limit',
        ]);
        expect(checklist.title).toBe('Refactor auth');
        expect(checklist.items.map((item) => item.text)).toEqual([
            'Extract token service',
            'Add rate limit',
        ]);
        expect(checklist.ref).toMatch(/^[0-9a-hjkmnp-tv-z]{6}$/);
    });

    test('text output lists refs, and refs work as short prefixes', async () => {
        const created = await palmtop(['checklist', 'create', 'Docs', '--item', 'Write README']);
        expect(created.stdout).toMatch(/^Created checklist [0-9a-z]{6} "Docs"\n/);

        const added = await json<{ item: ItemJson; checklist: { ref: string } }>([
            'add',
            'Update changelog',
        ]);
        expect(added.checklist.ref).not.toBe(checklist.ref); // latest checklist by default

        const toFirst = await json<{ item: ItemJson; checklist: { ref: string } }>([
            'add',
            'Drop legacy endpoint',
            '--checklist',
            checklist.ref,
        ]);
        expect(toFirst.checklist.ref).toBe(checklist.ref);

        const edited = await palmtop(['edit', toFirst.item.ref.slice(0, 4), 'Drop /v1/session']);
        expect(edited).toMatchObject({
            code: 0,
            stdout: `Updated ${toFirst.item.ref}: Drop /v1/session\n`,
        });

        const show = await palmtop(['show']);
        expect(show.stdout).toContain(`${checklist.ref}  Refactor auth  (0/3 reviewed)`);
        expect(show.stdout).toContain(`[not reviewed] ${toFirst.item.ref}  Drop /v1/session`);
    });

    test('rename, remove and errors on refs', async () => {
        const session = await json<SessionJson>(['show']);
        const docs = session.checklists.find((c) => c.title === 'Docs') as ChecklistJson;

        expect((await palmtop(['checklist', 'rename', docs.ref, 'Documentation'])).stdout).toBe(
            `Renamed checklist ${docs.ref} to "Documentation"\n`,
        );
        const item = docs.items[0] as ItemJson;
        expect((await palmtop(['remove', item.ref])).stdout).toBe(
            `Removed ${item.ref}: Write README\n`,
        );
        expect((await palmtop(['checklist', 'remove', docs.ref])).stdout).toBe(
            `Removed checklist ${docs.ref} "Documentation"\n`,
        );

        const missing = await palmtop(['remove', item.ref]);
        expect(missing).toMatchObject({ code: 1 });
        expect(missing.stderr).toContain(`no item "${item.ref}" in this session`);
        expect((await palmtop(['edit', 'no!', 'x'])).stderr).toContain('invalid item ref');
        expect((await palmtop(['edit', 'ab', 'x'])).stderr).toContain('invalid item ref');

        const titles = (await json<SessionJson>(['show'])).checklists.map((c) => c.title);
        expect(titles).toEqual(['Refactor auth']);
    });

    test('parallel sessions in the same project are isolated', async () => {
        const mine = (await json<SessionJson>(['show'])).checklists[0] as ChecklistJson;
        await startSession('b', 'Other agent');
        const other = await json<ChecklistJson>(
            ['checklist', 'create', 'Other work', '--item', 'B1'],
            {
                session: 'b',
            },
        );

        const intrusion = await palmtop(['edit', (mine.items[0] as ItemJson).ref, 'hijacked'], {
            session: 'b',
        });
        expect(intrusion.code).toBe(1);
        expect(intrusion.stderr).toContain('in this session');

        const add = await palmtop(['add', 'nope', '--checklist', mine.ref], {
            session: 'b',
        });
        expect(add.stderr).toContain(`no checklist "${mine.ref}" in this session`);

        expect(
            (await json<SessionJson>(['show'], { session: 'b' })).checklists.map((c) => c.ref),
        ).toEqual([other.ref]);
        expect((await json<SessionJson>(['show'])).checklists.map((c) => c.title)).toEqual([
            'Refactor auth',
        ]);

        const unknown = await palmtop(['show'], { session: 'zzzzzz' });
        expect(unknown).toMatchObject({ code: 1 });
        expect(unknown.stderr).toContain('no session "zzzzzz" in this project');
    });

    test('concurrent commands are all applied', async () => {
        await startSession('c');
        const results = await Promise.all(
            ['c1', 'c2', 'c3', 'c4'].map((text) =>
                palmtop(['add', text], { session: 'c' }).catch(() => null),
            ),
        );
        // The first add has no checklist yet: all fail cleanly, none corrupts state.
        expect(results.every((result) => result?.code === 1)).toBe(true);

        await json(['checklist', 'create', 'Concurrent'], { session: 'c' });
        await Promise.all(
            ['c1', 'c2', 'c3', 'c4'].map((text) => json(['add', text], { session: 'c' })),
        );
        const session = await json<SessionJson>(['show'], { session: 'c' });
        expect(
            (session.checklists[0] as ChecklistJson).items.map((item) => item.text).sort(),
        ).toEqual(['c1', 'c2', 'c3', 'c4']);
    });

    test('the review done on a device shows up in `show`', async () => {
        const session = await json<SessionJson>(['show']);
        const target = (session.checklists[0] as ChecklistJson).items[1] as ItemJson;
        const phone = await connectDevice();
        await phone.send(session.id, 'item.update', {
            itemId: target.id,
            status: 'question',
            note: 'which limit?\nper user or global?',
        });
        phone.close();

        const show = await palmtop(['show']);
        expect(show.stdout).toContain(
            `[question]     ${target.ref}  ${target.text}\n                 note: which limit?\n                       per user or global?`,
        );
        expect(show.stdout).toContain('(1/3 reviewed)');
    });

    test('feedback reports each review once, with the items still to review', async () => {
        const session = await json<SessionJson>(['show']);
        const [first, second, third] = (session.checklists[0] as ChecklistJson).items as [
            ItemJson,
            ItemJson,
            ItemJson,
        ];

        const feedback = await palmtop(['feedback']);
        expect(feedback.code).toBe(0);
        expect(feedback.stdout).toBe(
            [
                `Session ${refs.a} "${session.title}"`,
                '',
                `${session.checklists[0]?.ref}  Refactor auth  (1/3 reviewed)`,
                `  [not reviewed] ${first.ref}  ${first.text}`,
                `  [question]     ${second.ref}  ${second.text}`,
                '                 note: which limit?',
                '                       per user or global?',
                `  [not reviewed] ${third.ref}  ${third.text}`,
                '',
            ].join('\n'),
        );

        const again = await palmtop(['feedback']);
        expect(again.stdout).toContain('No new feedback since the last time.');
        expect(again.stdout).not.toContain('[question]');
        expect(again.stdout).toContain('1 reviewed item unchanged since the last feedback');

        const asJson = await json<{ hasNew: boolean; ack?: unknown }>(['feedback']);
        expect(asJson.hasNew).toBe(false);
        expect(asJson).not.toHaveProperty('ack');
    });

    test('a review changed later is reported by the next feedback, alone', async () => {
        const session = await json<SessionJson>(['show']);
        const first = (session.checklists[0] as ChecklistJson).items[0] as ItemJson;
        const phone = await connectDevice();
        await phone.send(session.id, 'item.update', { itemId: first.id, status: 'cancelled' });
        phone.close();

        const result = await palmtop(['feedback']);
        expect(result.stdout).not.toContain('No new feedback');
        expect(result.stdout).toContain(`  [fails]        ${first.ref}  ${first.text}`);
        expect(result.stdout).not.toContain('[question]'); // already delivered before
        expect((await palmtop(['feedback'])).stdout).toContain('No new feedback');
    });

    test('items and the note added on a device are reported once; the message shows in show', async () => {
        const session = await json<SessionJson>(['show']);
        const checklist = session.checklists[0] as ChecklistJson;
        const itemId = createId();
        const phone = await connectDevice();
        await phone.send(session.id, 'item.add', {
            itemId,
            checklistId: checklist.id,
            text: 'Also rate limit the login',
            order: 99,
        });
        await phone.send(session.id, 'session.note', { note: 'Keep the old API\nuntil Friday' });
        phone.close();

        const feedback = await palmtop(['feedback']);
        expect(feedback.stdout).not.toContain('No new feedback');
        expect(feedback.stdout).toContain(
            'New note from the user:\n  Keep the old API\n  until Friday',
        );
        expect(feedback.stdout).toMatch(
            /\[not reviewed\]\s+[0-9a-z]{6} {2}Also rate limit the login {2}\(added by the user\)/,
        );
        const again = await palmtop(['feedback']);
        expect(again.stdout).toContain('No new feedback since the last time.');
        expect(again.stdout).not.toContain('New note');
        // Still to review, but no longer new.
        expect(again.stdout).toContain('Also rate limit the login  (added by the user)');

        expect((await palmtop(['message', 'Plan ready: 3 decisions for you'])).stdout).toBe(
            "Message shown on the user's devices: Plan ready: 3 decisions for you\n",
        );
        const show = await palmtop(['show']);
        expect(show.stdout).toMatch(
            /^Session [0-9a-z]{6} "[^"]+"\nYour message to the user \(\d{4}-\d\d-\d\d \d\d:\d\d\):\n {2}Plan ready: 3 decisions for you\nNote from the user:\n {2}Keep the old API\n {2}until Friday\n/,
        );
        expect((await palmtop(['message'])).code).toBe(2);
        expect((await palmtop(['message', 'x', '--clear'])).code).toBe(2);
        expect((await palmtop(['message', '--clear'])).stdout).toBe(
            'Message removed from the session.\n',
        );
        expect((await palmtop(['show'])).stdout).not.toContain('Your message');

        const cleanup = await connectDevice();
        await cleanup.send(session.id, 'item.remove', { itemId });
        await cleanup.send(session.id, 'session.note', { note: '' });
        cleanup.close();
    });

    test('choice create asks a question with its options, answered on a device', async () => {
        const choice = await json<ChecklistJson & { kind: string; pick: string }>([
            'choice',
            'create',
            'Which cache?',
            '--option',
            'Redis',
            '--detail',
            'Shared, one more service',
            '--option',
            'In memory',
        ]);
        try {
            expect(choice).toMatchObject({ kind: 'choice', pick: 'one', title: 'Which cache?' });
            expect(choice.items.map((item) => [item.text, item.detail])).toEqual([
                ['Redis', 'Shared, one more service'],
                ['In memory', undefined],
            ]);

            // `add` without a ref never lands in a choice.
            const added = await json<{ checklist: { ref: string } }>(['add', 'Somewhere else']);
            expect(added.checklist.ref).not.toBe(choice.ref);

            const session = await json<SessionJson>(['show']);
            const option = choice.items[0] as ItemJson;
            const device = await connectDevice();
            await device.send(session.id, 'item.update', {
                itemId: option.id,
                status: 'done',
                note: 'but keep the TTL configurable',
            });
            device.close();

            const show = await palmtop(['show']);
            expect(show.stdout).toContain(`${choice.ref}  Which cache?  (choice, 1 chosen of 2)`);
            expect(show.stdout).toContain(
                [
                    `  [chosen]       ${option.ref}  Redis`,
                    '                 detail: Shared, one more service',
                    '                 note: but keep the TTL configurable',
                ].join('\n'),
            );

            const feedback = await palmtop(['feedback']);
            expect(feedback.stdout).toContain('(choice, 1 chosen of 2');
            expect(feedback.stdout).toContain('[chosen]');

            // Two options at least, and an unknown subcommand is a usage error.
            expect((await palmtop(['choice', 'create', 'Only one', '--option', 'A'])).code).toBe(2);
            expect((await palmtop(['choice', 'remove', choice.ref])).code).toBe(2);

            const multiple = await json<ChecklistJson & { pick: string }>([
                'choice',
                'create',
                'Which of these?',
                '--option',
                'A',
                '--option',
                'B',
                '--multiple',
            ]);
            expect(multiple.pick).toBe('any');
            await palmtop(['checklist', 'remove', multiple.ref]);
        } finally {
            await palmtop(['checklist', 'remove', choice.ref]);
        }
    });

    test('session title', async () => {
        expect((await palmtop(['session', 'title', 'Auth refactor'])).stdout).toBe(
            'Session title set to "Auth refactor"\n',
        );
        expect((await palmtop(['show'])).stdout).toStartWith(`Session ${refs.a} "Auth refactor"\n`);
        expect((await palmtop(['session', 'end'])).code).toBe(2);
    });

    test('session list shows every session of the project', async () => {
        const list = await palmtop(['session', 'list'], { session: null });
        const lines = list.stdout.trim().split('\n');
        expect(lines).toHaveLength(3);
        expect(list.stdout).toMatch(
            new RegExp(
                `${refs.a}  \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d  "Auth refactor"  \\(feature/cli\\)`,
            ),
        );
        expect(list.stdout).toContain(`${refs.b}  `);
        expect(list.stdout).toContain('"Other agent"');
        const sessions = await json<Array<{ ref: string }>>(['session', 'list'], { session: null });
        expect(sessions.map((session) => session.ref).sort()).toEqual(
            [refs.a, refs.b, refs.c].sort() as string[],
        );
    });

    test('read-only commands in a folder without a project do not create one', async () => {
        const elsewhere = join(home, 'elsewhere');
        await mkdir(elsewhere);

        const status = await palmtop(['status'], { cwd: elsewhere, session: null });
        expect(status.code).toBe(0);
        expect(status.stdout).toContain(`Project: none in ${elsewhere} yet`);
        expect(
            await json<{ project: null }>(['status'], { cwd: elsewhere, session: null }),
        ).toMatchObject({ project: null });

        const list = await palmtop(['session', 'list'], { cwd: elsewhere, session: null });
        expect(list).toMatchObject({ code: 0, stdout: expect.stringContaining('No sessions') });
        expect(
            await json<unknown[]>(['session', 'list'], { cwd: elsewhere, session: null }),
        ).toEqual([]);

        // A session ref is enough outside a project: it is looked for in every project.
        const show = await palmtop(['show'], { cwd: elsewhere });
        expect(show.code).toBe(0);
        const unknown = await palmtop(['show'], { cwd: elsewhere, session: 'zzzzzz' });
        expect(unknown.code).toBe(1);
        expect(unknown.stderr).toContain('no session "zzzzzz" on this computer');
        // --project is strict: no fallback to the other projects.
        const strict = await palmtop(['show', '--project', elsewhere], { cwd: elsewhere });
        expect(strict.code).toBe(1);
        expect(strict.stderr).toContain(`no palmtop project in ${elsewhere} yet`);
        // A confirmation is not asked for what cannot happen: the check comes first.
        const close = await palmtop(['share', 'close', '--with', 'Nobody'], {
            cwd: elsewhere,
            session: 'zzzzzz',
        });
        expect(close.code).toBe(1);
        expect(close.stderr).toContain('no session "zzzzzz" on this computer');
        expect(close.stderr).not.toContain('nothing deleted');

        const registry = await readFile(join(home, 'projects.json'), 'utf8');
        expect(registry).not.toContain(elsewhere);
    });

    test('the project is the git root, from any subdirectory or --project', async () => {
        const fromSubdir = await json<SessionJson>(['show'], { cwd: join(repo, 'src', 'deep') });
        const byFlag = await json<SessionJson>(['show', '--project', join(repo, 'src')], {
            cwd: home,
        });
        const direct = await json<SessionJson>(['show']);
        expect(fromSubdir.id).toBe(direct.id);
        expect(byFlag.id).toBe(direct.id);
    });

    test('credentials in the git remote are never stored', async () => {
        const registry = JSON.parse(await readFile(join(home, 'projects.json'), 'utf8')) as {
            projects: Array<{ projectId: string; rootPath: string }>;
        };
        const project = registry.projects.find((entry) => entry.rootPath === repo);
        const snapshot = await readFile(
            join(home, 'data', project?.projectId as string, 'snapshot.json'),
            'utf8',
        );
        expect(snapshot).toContain('https://github.com/me/my-repo.git');
        expect(snapshot).not.toContain('SECRETREMOTETOKEN');
    });

    // The fake opener is a `#!/bin/sh` script.
    test.skipIf(WINDOWS)(
        'pair opens the page through the opener, printing nothing secret',
        async () => {
            const opened = join(home, 'opened-url');
            const opener = join(home, 'fake-open.sh');
            await writeFile(opener, `#!/bin/sh\nprintf '%s' "$1" > '${opened}'\n`);
            await chmod(opener, 0o700);

            const result = await palmtop(['pair'], { env: { PALMTOP_OPEN: opener } });
            expect(result.code).toBe(0);
            expect(result.stdout).toContain(
                `Opened the pairing page for "${defaultComputerName()}"`,
            );
            // Output is piped here, as it is for agents: no QR code and no pairing link.
            expect(result.stdout).not.toContain('#pair?');
            for (let i = 0; i < 50 && !(await Bun.file(opened).exists()); i++) await Bun.sleep(20);
            const url = await readFile(opened, 'utf8');
            outputs.push({ args: ['<opened url is a secret>'], text: '' });
            secrets.push(url, new URL(url).searchParams.get('code') ?? 'missing-code');

            const failing = await palmtop(['pair'], {
                env: { PALMTOP_OPEN: join(home, 'missing-opener') },
            });
            expect(failing.code).toBe(1);
            expect(failing.stderr).toContain('could not open a browser');
        },
    );

    test('install writes the skill and the permission, and a second run changes nothing', async () => {
        const claudeDir = join(home, 'claude-config');
        // Claude Code is on this computer: it has its configuration folder.
        await mkdir(claudeDir, { recursive: true });
        const first = await palmtop(['install'], { session: null });
        expect(first.code).toBe(0);
        expect(first.stdout).toContain(
            `Skill created: ${join(claudeDir, 'skills', 'palmtop', 'SKILL.md')}`,
        );
        expect(first.stdout).toContain(
            `Permissions "mcp__palmtop", "Bash(palmtop *)" added to ${join(claudeDir, 'settings.json')}`,
        );
        // The MCP server points to the bundle that ran the install, with an absolute node.
        expect(first.stdout).toContain(`MCP server created`);
        const registered = JSON.parse(await readFile(join(claudeDir, '.claude.json'), 'utf8'));
        expect(registered.mcpServers.palmtop).toMatchObject({
            type: 'stdio',
            args: [cli, 'mcp'],
        });
        expect(isAbsolute(registered.mcpServers.palmtop.command)).toBe(true);

        const second = await palmtop(['install'], { session: null });
        expect(second.stdout).toContain('Skill already up to date');
        expect(second.stdout).toContain('Permissions already allowed');
        expect(second.stdout).toContain('MCP server already registered');

        await writeFile(join(claudeDir, 'settings.json'), '{ broken');
        const broken = await palmtop(['install'], { session: null });
        expect(broken.code).toBe(1);
        expect(broken.stderr).toContain('is not valid JSON');
    });

    test('install sets up Codex too when it is on this computer', async () => {
        const codexHome = join(home, 'codex-home');
        await mkdir(codexHome, { recursive: true });
        await writeFile(join(codexHome, 'config.toml'), '');
        // The previous test left a broken settings.json on purpose.
        await writeFile(join(home, 'claude-config', 'settings.json'), '{}\n');
        const env = { HOME: home, USERPROFILE: home };
        const first = await palmtop(['install'], { session: null, env });
        expect(first.code).toBe(0);
        expect(first.stdout).toContain('Claude Code\n');
        expect(first.stdout).toContain(
            `Skill created: ${join(home, '.agents', 'skills', 'palmtop')}`,
        );
        expect(first.stdout).toContain(
            `Rules created: ${join(codexHome, 'rules', 'palmtop.rules')}`,
        );
        expect(first.stdout).toContain('type $palmtop');

        const second = await palmtop(['install'], { session: null, env });
        expect(second.stdout).toContain(
            `Skill already up to date: ${join(home, '.agents', 'skills', 'palmtop')}`,
        );
        expect(second.stdout).toContain('Rules already up to date');
        await rm(codexHome, { recursive: true, force: true });
        await rm(join(home, '.agents'), { recursive: true, force: true });
        await writeFile(join(home, 'claude-config', 'settings.json'), '{ broken');
    });

    test('stop and a foreign daemon on the port', async () => {
        expect((await palmtop(['stop'])).stdout).toBe('Daemon stopped.\n');
        expect((await palmtop(['stop'])).stdout).toBe('Daemon is not running.\n');

        const impostor = Bun.serve({
            port: localPort,
            hostname: '127.0.0.1',
            fetch: () => new Response('no', { status: 401 }),
        });
        try {
            const status = await palmtop(['status']);
            expect(status).toMatchObject({
                code: 1,
                stdout: 'Daemon: port used by another daemon\n',
            });
            expect((await palmtop(['show'])).stderr).toContain('used by another daemon');
        } finally {
            impostor.stop(true);
        }
        expect((await json<SessionJson>(['show'])).title).toBe('Auth refactor');
    });

    test('serve --background starts the daemon and returns, and is harmless when it runs', async () => {
        await palmtop(['stop']);
        const started = await palmtop(['serve', '-b'], { session: null });
        expect(started).toMatchObject({ code: 0, stderr: '' });
        expect(started.stdout).toMatch(
            /^Daemon running in the background \(pid \d+\), log in .+daemon\.log\.\n$/,
        );
        expect((await palmtop(['status'], { session: null })).stdout).toContain(
            `local port ${localPort}`,
        );

        const again = await json<{ pid: number }>(['serve', '--background'], { session: null });
        expect(String(again.pid)).toBe(started.stdout.match(/pid (\d+)/)?.[1] as string);
        expect((await palmtop(['serve'], { session: null })).stderr).toContain('already running');
    });
});

describe('sessions and projects of the computer', () => {
    let other: string;

    beforeAll(async () => {
        other = join(home, 'other-repo');
        await mkdir(other);
        git(other, 'init', '-q', '-b', 'main');
    });

    test('sessions lists every project; delete needs a confirmation, then removes it everywhere', async () => {
        const doomed = await json<SessionJson>(['session', 'start', 'Throwaway'], {
            cwd: other,
            session: null,
        });
        await palmtop(['checklist', 'create', 'Secret plan', '--item', 'Rotate the API key'], {
            cwd: other,
            session: doomed.ref,
        });

        const list = await palmtop(['sessions'], { session: null });
        expect(list.stdout).toMatch(/^PROJECT\s+REF\s+LAST ACTIVITY\s+TITLE\n/);
        expect(list.stdout).toMatch(
            new RegExp(`other-repo\\s+${doomed.ref}\\s+just now\\s+Throwaway`),
        );
        expect(list.stdout).toContain(`my-repo     ${refs.a}`);

        const phone = await connectDevice('phone', other);
        const refused = await palmtop(['sessions', 'delete', doomed.ref], { session: null });
        expect(refused).toMatchObject({ code: 1 });
        expect(refused.stderr).toContain(
            'nothing deleted: confirm in an interactive terminal, or pass --yes',
        );
        expect((await palmtop(['sessions'], { session: null })).stdout).toContain(doomed.ref);

        const deleted = await palmtop(['sessions', 'delete', doomed.ref.slice(0, 4), '--yes'], {
            session: null,
        });
        expect(deleted.stdout).toBe(`Deleted session ${doomed.ref} "Throwaway" of other-repo.\n`);
        phone.close();

        expect((await palmtop(['sessions'], { session: null })).stdout).not.toContain(doomed.ref);
        const agent = await palmtop(['show'], { cwd: other, session: doomed.ref });
        expect(agent.stderr).toContain(`no session "${doomed.ref}" in this project`);
        expect(
            (await palmtop(['sessions', 'delete', 'zzzz', '--yes'], { session: null })).stderr,
        ).toContain('no session "zzzz" on this computer');
    });

    test('devices lists the paired devices; remove needs a confirmation and cuts one off', async () => {
        const phone = await connectDevice('web-listed');
        // Set by the close listener: TypeScript can't see the callback assign it.
        let closedWith = null as number | null;
        phone.onClose((code) => {
            closedWith = code;
        });
        const list = await palmtop(['devices'], { session: null });
        expect(list.stdout).toMatch(/^DEVICE\s+ID\s+PAIRED\s+LAST SEEN\n/);
        expect(list.stdout).toMatch(/Test web-listed\s+web-listed\s+just now\s+connected now/);
        const devices = await json<Array<{ deviceId: string; connected: boolean }>>(['devices'], {
            session: null,
        });
        expect(devices.find((device) => device.deviceId === 'web-listed')?.connected).toBe(true);

        // An agent (no terminal, no --yes) can't unpair a device.
        const refused = await palmtop(['devices', 'remove', 'web-listed'], { session: null });
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain('nothing deleted');
        expect(
            (await palmtop(['devices', 'remove', 'nope', '--yes'], { session: null })).stderr,
        ).toContain('no device "nope" paired with this computer');

        // By the start of its id, like refs.
        const removed = await palmtop(['devices', 'remove', 'web-li', '--yes'], { session: null });
        expect(removed.stdout).toBe('Unpaired "Test web-listed".\n');
        for (let i = 0; i < 200 && closedWith === null; i++) await Bun.sleep(10);
        expect(closedWith).toBe(CloseCode.unauthorized);
        expect((await palmtop(['devices'], { session: null })).stdout).not.toContain('web-listed');
    });

    test('projects lists projects; remove needs a confirmation, deletes data and disconnects phones', async () => {
        await palmtop(['session', 'start', 'Kept for a moment'], { cwd: other, session: null });
        const projects = await json<Array<{ id: string; name: string; sessions: number }>>(
            ['projects'],
            {
                session: null,
            },
        );
        const project = projects.find((entry) => entry.name === 'other-repo');
        expect(project?.sessions).toBe(1);
        expect((await palmtop(['projects'], { session: null })).stdout).toMatch(
            new RegExp(`^Computer: ${defaultComputerName()}\\n\\nPROJECT\\s+SESSIONS\\s+DEVICES`),
        );

        expect((await palmtop(['projects', 'remove', 'other-repo'], { session: null })).code).toBe(
            1,
        );
        expect(
            (await palmtop(['projects', 'remove', 'nope', '--yes'], { session: null })).stderr,
        ).toContain('no project "nope" on this computer');

        const phone = await connectDevice('phone', other);
        const removed = await palmtop(['projects', 'remove', other, '--yes'], { session: null });
        expect(removed.stdout).toBe(
            `Removed project other-repo (${other}) with its 1 session. It is gone from your paired devices too.\n`,
        );
        // The device stays paired with the computer and sees the project leave its list.
        expect(await phone.projectsWithout(project?.id as string)).toBe(true);
        expect(await readFile(join(home, 'projects.json'), 'utf8')).not.toContain(other);
        expect(
            await Bun.file(join(home, 'data', project?.id as string, 'snapshot.json')).exists(),
        ).toBe(false);
        expect(
            (await palmtop(['session', 'list'], { cwd: other, session: null })).stdout,
        ).toContain('No sessions');
    });

    test('confirmation: yes deletes, anything else keeps', async () => {
        const question: string[] = [];
        const ask = (answer: boolean) => ({
            confirm: async (text: string) => {
                question.push(text);
                return answer;
            },
        });
        await confirmDeletion({ yes: false }, ask(true), 'Delete?');
        expect(question).toEqual(['Delete? [y/N] ']);
        expect(confirmDeletion({ yes: false }, ask(false), 'Delete?')).rejects.toThrow(
            'nothing deleted',
        );
        await confirmDeletion({ yes: true }, {}, 'Delete?');
        expect(confirmDeletion({ yes: false }, {}, 'Delete?')).rejects.toThrow('pass --yes');
    });
});

describe('palmtop update', () => {
    test('status announces the release of the relay, update installs it and restarts the daemon', async () => {
        const next = join(home, 'dist-next');
        await buildCli(next, { version: '9.9.9' });
        const nextRelease = JSON.parse(await readFile(join(next, 'version.json'), 'utf8'));
        const port = relay.port;
        await relay.stop();
        relay = startRelay({ port, cliRoot: next, log: () => {} });

        let status = '';
        for (let i = 0; i < 200 && !status.includes('Update available'); i++) {
            status = (await palmtop(['status'])).stdout;
            await Bun.sleep(25);
        }
        expect(status).toContain(
            `Update available: palmtop 9.9.9 (build ${nextRelease.build}), run \`palmtop update\``,
        );
        const before = (await json<{ daemon: { pid: number } }>(['status'])).daemon.pid;

        // The install test left a broken settings.json on purpose.
        await writeFile(join(home, 'claude-config', 'settings.json'), '{}\n');
        // Installed as users do: a `palmtop` symlink on the PATH pointing to the bundle. Windows
        // has no symlink without a privilege: its users run the bundle through `palmtop.cmd`.
        const bin = join(home, 'bin');
        await mkdir(bin, { recursive: true });
        if (!WINDOWS) await symlink(cli, join(bin, 'palmtop'));
        const updated = await palmtop(['update'], {
            session: null,
            env: { PATH: `${bin}${delimiter}${process.env.PATH}` },
            entry: WINDOWS ? cli : join(bin, 'palmtop'),
        });
        expect(updated.code).toBe(0);
        expect(updated.stdout).toContain(`to palmtop 9.9.9 (build ${nextRelease.build}).`);
        expect(updated.stdout).toContain('palmtop skill and tools refreshed');
        expect(updated.stdout).toContain('Daemon restarted with the new version.');

        expect(
            createHash('sha256')
                .update(await readFile(cli))
                .digest('hex'),
        ).toBe(nextRelease.sha256);
        expect((await palmtop(['version'], { session: null })).stdout).toContain('palmtop 9.9.9');
        const after = await json<{
            daemon: { pid: number; version: string };
            updateAvailable: boolean;
        }>(['status']);
        expect(after.daemon.pid).not.toBe(before);
        expect(after.daemon.version).toBe('9.9.9');
        expect(after.updateAvailable).toBe(false);
        expect((await palmtop(['update'], { session: null })).stdout).toBe(
            `palmtop 9.9.9 (build ${nextRelease.build}) is up to date.\n`,
        );
        expect((await json<SessionJson>(['show'])).title).toBe('Auth refactor');
    });

    test('a daemon of another build is restarted by the next command', async () => {
        const previous = (await json<{ daemon: { pid: number } }>(['status'])).daemon.pid;
        // Rebuild the original version in place: same path, different build.
        await buildCli(join(home, 'dist'));
        const status = await palmtop(['status']);
        expect(status.stdout).toContain('another palmtop build: it restarts with the next command');
        await json<SessionJson>(['show']);
        const now = await json<{ daemon: { pid: number }; cli: { build: string } }>(['status']);
        expect(now.daemon.pid).not.toBe(previous);
        // Back to the old version: the relay still publishes the newer one.
        expect(status.stdout).toContain('Update available: palmtop 9.9.9');
    });
});

describe('sharing with other people', () => {
    let list: ChecklistJson;

    test('share gives a person a copy, share list shows who has what', async () => {
        await startSession('shared', 'Release 2.1');
        list = await json<ChecklistJson>(
            [
                'checklist',
                'create',
                'Login',
                '--item',
                'Right password',
                '--item',
                'Wrong password',
            ],
            { session: 'shared' },
        );

        const shared = await palmtop(['share', list.ref, '--with', 'mario', '--days', '3'], {
            session: 'shared',
        });
        expect(shared.code).toBe(0);
        expect(shared.stdout).toContain(`Shared Mario: ${list.ref} "Login", open until`);

        const listed = await json<Array<Record<string, unknown>>>(['share', 'list'], {
            session: null,
        });
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({
            person: 'Mario',
            state: 'open',
            project: { name: 'my-repo' },
            session: { title: 'Release 2.1' },
            checklists: [{ ref: list.ref, title: 'Login', reviewed: 0, total: 2 }],
        });
        const table = await palmtop(['share', 'list'], { session: null });
        expect(table.stdout).toContain('Mario');
        expect(table.stdout).toContain('Release 2.1');
    });

    test('the copy is not a project or a session of the computer', async () => {
        const projects = await json<Array<{ name: string }>>(['projects'], { session: null });
        expect(projects.map((project) => project.name)).toEqual(['my-repo']);
        const sessions = await json<Array<{ title: string }>>(['sessions'], { session: null });
        expect(sessions.some((session) => session.title === 'Release 2.1')).toBe(true);
        expect(sessions.filter((session) => session.title === 'Release 2.1')).toHaveLength(1);
    });

    test('mistakes are explained', async () => {
        const again = await palmtop(['share', list.ref, '--with', 'Mario'], { session: 'shared' });
        expect(again.code).toBe(1);
        expect(again.stderr).toContain('palmtop retest --with Mario');

        const stranger = await palmtop(['share', list.ref, '--with', 'Nobody'], {
            session: 'shared',
        });
        expect(stranger.code).toBe(1);
        expect(stranger.stderr).toContain('palmtop invite');

        const noWith = await palmtop(['share', list.ref], { session: 'shared' });
        expect(noWith.code).toBe(2);
        expect(noWith.stderr).toContain('--with <name>');

        const days = await palmtop(['share', list.ref, '--with', 'Mario', '--days', 'x'], {
            session: 'shared',
        });
        expect(days.code).toBe(2);
        const tooLong = await palmtop(['share', list.ref, '--with', 'Mario', '--days', '999'], {
            session: 'shared',
        });
        expect(tooLong.code).toBe(1);

        const perChecklist = await palmtop(['share', 'close', list.ref, '--with', 'Mario'], {
            session: 'shared',
        });
        expect(perChecklist.code).toBe(2);
        expect(perChecklist.stderr).toContain('whole copy');
        expect(perChecklist.stderr).toContain('share remove');

        // One checklist out of the copy: asked first, and the others stay.
        const second = await json<ChecklistJson>(
            ['checklist', 'create', 'Logout', '--item', 'Logs out'],
            { session: 'shared' },
        );
        await palmtop(['share', second.ref, '--with', 'Mario'], { session: 'shared' });
        const unconfirmed = await palmtop(['share', 'remove', second.ref, '--with', 'Mario'], {
            session: 'shared',
        });
        expect(unconfirmed.code).toBe(1);
        expect(unconfirmed.stderr).toContain('nothing deleted');
        const removed = await palmtop(['share', 'remove', second.ref, '--with', 'Mario', '--yes'], {
            session: 'shared',
        });
        expect(removed.code).toBe(0);
        expect(removed.stdout).toContain(`Took ${second.ref} "Logout" out of the copy of Mario.`);
        expect(removed.stdout).toContain(`Still shared: ${list.ref} "Login"`);
        const gone = await palmtop(['share', 'remove', second.ref, '--with', 'Mario', '--yes'], {
            session: 'shared',
        });
        expect(gone.code).toBe(1);
        expect(
            (await palmtop(['share', 'remove', '--with', 'Mario'], { session: 'shared' })).code,
        ).toBe(2);
    });

    test('retest brings the copy up to date and says what changed', async () => {
        const quiet = await palmtop(['retest', '--with', 'Mario'], { session: 'shared' });
        expect(quiet.stdout).toContain(
            'Updated the copy of Mario: 0 added, 0 changed, 0 removed, 2 unchanged.',
        );

        await palmtop(['add', 'Logout works', '--checklist', list.ref], { session: 'shared' });
        await palmtop(['edit', (list.items[0] as ItemJson).ref, 'Right password, twice'], {
            session: 'shared',
        });
        const result = await json<Record<string, unknown>>(
            ['retest', '--with', 'Mario', '--message', 'Please look at the login again'],
            { session: 'shared' },
        );
        expect(result).toEqual({
            person: 'Mario',
            added: 1,
            updated: 1,
            reset: 0,
            removed: 0,
            unchanged: 1,
        });

        const refs = await palmtop(['retest', '--with', 'Mario', 'zzzzzz'], { session: 'shared' });
        expect(refs.code).toBe(1);
        expect(await palmtop(['retest'], { session: 'shared' })).toMatchObject({ code: 2 });
    });

    test('a message can be for one person only', async () => {
        const sent = await palmtop(['message', 'Start with the login', '--to', 'Mario'], {
            session: 'shared',
        });
        expect(sent.stdout).toContain('Message shown to Mario only.');
        // The message of the session is still the agent's own, and still empty.
        const show = await json<{ message?: unknown }>(['show'], { session: 'shared' });
        expect(show.message).toBeUndefined();

        const cleared = await palmtop(['message', '--clear', '--to', 'Mario'], {
            session: 'shared',
        });
        expect(cleared.stdout).toContain('Message removed from the copy of Mario.');
        const nobody = await palmtop(['message', 'Hi', '--to', 'Nobody'], { session: 'shared' });
        expect(nobody.code).toBe(1);

        // --with belongs to share and retest: here it would silently replace the agent's own message.
        const mixedUp = await palmtop(['message', 'Hi', '--with', 'Mario'], { session: 'shared' });
        expect(mixedUp.code).toBe(2);
        expect(mixedUp.stderr).toContain('--to');
        const after = await json<{ message?: unknown }>(['show'], { session: 'shared' });
        expect(after.message).toBeUndefined();
    });

    test('feedback lists the people it is shared with', async () => {
        const text = await palmtop(['feedback'], { session: 'shared' });
        expect(text.stdout).toContain('Shared with other people:');
        expect(text.stdout).toContain('Mario  0/3 reviewed  (open)');
        const feedback = await json<{ shared: { people: unknown[]; ack?: unknown } }>(
            ['feedback'],
            {
                session: 'shared',
            },
        );
        expect(feedback.shared.people).toHaveLength(1);
        expect(feedback.shared.ack).toBeUndefined();
    });

    test('the name of the owner can be set for the session or for one person', async () => {
        const forSession = await palmtop(['session', 'owner-name', 'Grace (studio)'], {
            session: 'shared',
        });
        expect(forSession.stdout).toContain('see you as "Grace (studio)" (1 copy)');
        const forPerson = await palmtop(
            ['session', 'owner-name', 'Grace, your contact', '--for', 'mario'],
            { session: 'shared' },
        );
        expect(forPerson.stdout).toContain('mario see you as "Grace, your contact" (1 copy)');
        const cleared = await palmtop(['session', 'owner-name', '--clear', '--for', 'Mario'], {
            session: 'shared',
        });
        expect(cleared.stdout).toContain('see your name as before');
        expect(
            (
                await palmtop(['session', 'owner-name', 'X', '--for', 'Nobody'], {
                    session: 'shared',
                })
            ).code,
        ).toBe(1);
        expect((await palmtop(['session', 'owner-name'], { session: 'shared' })).code).toBe(2);
        expect(
            (await palmtop(['session', 'owner-name', 'X', '--clear'], { session: 'shared' })).code,
        ).toBe(2);
        await palmtop(['session', 'owner-name', '--clear'], { session: 'shared' });
    });

    test('an invitation is only for a person at a terminal; people is for everyone', async () => {
        const invite = await palmtop(['invite', '--name', 'Luca'], { session: null });
        expect(invite.code).toBe(1);
        expect(invite.stderr).toContain('needs you at a terminal');
        expect(invite.stdout).toBe('');
        const asJson = await palmtop(['invite', '--name', 'Luca', '--json'], { session: null });
        expect(asJson.code).toBe(1);

        const people = await json<Array<Record<string, unknown>>>(['people'], { session: null });
        expect(people).toHaveLength(1);
        expect(people[0]).toMatchObject({ name: 'Mario', device: null, invitedUntil: null });
        const text = await palmtop(['people'], { session: null });
        expect(text.stdout).toContain('not joined yet');
    });

    test('closing needs a yes, and takes the copy away from the person', async () => {
        const asked = await palmtop(['share', 'close', '--with', 'Mario'], { session: 'shared' });
        expect(asked.code).toBe(1);
        expect(asked.stderr).toContain('nothing deleted');

        const closed = await palmtop(['share', 'close', '--with', 'Mario', '--yes'], {
            session: 'shared',
        });
        expect(closed.stdout).toContain('Closed the copy of Mario.');
        const listed = await json<Array<{ state: string }>>(['share', 'list'], { session: null });
        expect(listed[0]?.state).toBe('closed');
        const after = await palmtop(['retest', '--with', 'Mario'], { session: 'shared' });
        expect(after.code).toBe(1);
        expect(after.stderr).toContain('closed');
    });

    test('deleting the session deletes its copies', async () => {
        const removed = await palmtop(['sessions', 'delete', refs.shared as string, '--yes'], {
            session: null,
        });
        expect(removed.code).toBe(0);
        // The daemon drops the copies right after the removal: give it a moment.
        for (let i = 0; i < 50; i++) {
            const listed = await json<unknown[]>(['share', 'list'], { session: null });
            if (listed.length === 0) break;
            await Bun.sleep(50);
        }
        expect(await json<unknown[]>(['share', 'list'], { session: null })).toEqual([]);
    });
});

describe('no secret ever appears in CLI output', () => {
    test('the room key, the local key and pairing keys are absent from every output', async () => {
        const registry = JSON.parse(await readFile(join(home, 'projects.json'), 'utf8')) as {
            computer: { roomKey: { privateKey: string } };
        };
        // The pairing keys of every device paired above are in `secrets` already.
        secrets.push(registry.computer.roomKey.privateKey);
        secrets.push((await readFile(join(home, 'local.key'), 'utf8')).trim());
        secrets.push('SECRETREMOTETOKEN');

        expect(outputs.length).toBeGreaterThan(40);
        expect(secrets.length).toBeGreaterThanOrEqual(4);
        for (const { args, text } of outputs) {
            for (const secret of secrets) {
                if (text.includes(secret))
                    throw new Error(`secret leaked by: palmtop ${args.join(' ')}`);
            }
        }
    });
});

describe('opening the pairing page', () => {
    const url = 'http://127.0.0.1:4318/pair?code=single-use';
    const programs = (
        env: Record<string, string | undefined>,
        platform: string,
        wsl?: boolean,
    ): string[] =>
        openCandidates(url, env, platform, wsl ?? isWsl(env, platform, () => '')).map(
            ([program]) => program,
        );

    test('WSL is detected from the environment or the kernel, never on other platforms', () => {
        expect(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, 'linux', () => '')).toBe(true);
        expect(isWsl({ WSL_INTEROP: '/run/WSL/8_interop' }, 'linux', () => '')).toBe(true);
        expect(isWsl({}, 'linux', () => '6.6.87.2-microsoft-standard-WSL2\n')).toBe(true);
        expect(isWsl({}, 'linux', () => '6.19.8-arch1-3\n')).toBe(false);
        // A Windows-looking kernel on macOS or Windows is not WSL.
        expect(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, 'darwin', () => 'microsoft')).toBe(false);
        expect(isWsl({}, 'win32', () => 'microsoft')).toBe(false);
    });

    test('each platform has its openers, WSL with fallbacks to the Windows side', () => {
        expect(programs({}, 'darwin')).toEqual(['open']);
        expect(programs({}, 'win32')).toEqual(['cmd']);
        expect(programs({}, 'linux', false)).toEqual(['xdg-open']);
        expect(programs({ WSL_DISTRO_NAME: 'Ubuntu' }, 'linux')).toEqual([
            'wslview',
            'explorer.exe',
            'xdg-open',
        ]);
    });

    test('PALMTOP_OPEN replaces every opener', () => {
        const env = { PALMTOP_OPEN: '/usr/local/bin/my-open', WSL_DISTRO_NAME: 'Ubuntu' };
        expect(openCandidates(url, env, 'linux')).toEqual([['/usr/local/bin/my-open', [url]]]);
    });

    test('the URL is one argument, so no shell can split or expand it', () => {
        for (const platform of ['darwin', 'linux', 'win32']) {
            for (const wsl of [false, true]) {
                for (const [, args] of openCandidates(url, {}, platform, wsl)) {
                    expect(args.filter((argument) => argument === url)).toEqual([url]);
                    expect(args.at(-1)).toBe(url);
                }
            }
        }
    });
});

describe('updateCli', () => {
    const current = { version: '0.1.0', build: '000000000000' };
    const bundle = new TextEncoder().encode('#!/usr/bin/env node\nconsole.log("next");\n');
    const release = {
        version: '0.2.0',
        build: '111111111111',
        sha256: createHash('sha256').update(bundle).digest('hex'),
        size: bundle.length,
    };

    async function installed() {
        const dir = await mkdtemp(join(tmpdir(), 'palmtop-update-'));
        const entry = join(dir, 'palmtop.mjs');
        await writeFile(entry, 'old', { mode: 0o755 });
        return { dir, entry };
    }

    function relayServing(files: Record<string, unknown>): typeof fetch {
        return (async (url: string | URL | Request) => {
            const name = String(url).split('/').pop() as string;
            if (!(name in files)) return new Response('missing', { status: 404 });
            const body = files[name];
            return new Response(body instanceof Uint8Array ? body : JSON.stringify(body));
        }) as typeof fetch;
    }

    const failure = async (promise: Promise<unknown>) => {
        try {
            await promise;
        } catch (error) {
            expect(error).toBeInstanceOf(CliError);
            return (error as Error).message;
        }
        throw new Error('expected a failure');
    };

    test('replaces the bundle only when the download matches version.json', async () => {
        const { dir, entry } = await installed();
        try {
            const webUrl = 'https://relay.test';
            const corrupted = relayServing({
                'version.json': release,
                'palmtop.mjs': new TextEncoder().encode('tampered'),
            });
            expect(
                await failure(updateCli({ entry, webUrl, current, fetch: corrupted })),
            ).toContain('does not match version.json');
            expect(await readFile(entry, 'utf8')).toBe('old');

            const good = relayServing({ 'version.json': release, 'palmtop.mjs': bundle });
            expect(await updateCli({ entry, webUrl, current, fetch: good })).toMatchObject({
                status: 'updated',
                release,
            });
            expect(await readFile(entry, 'utf8')).toContain('console.log("next")');
            if (!WINDOWS) expect((await Bun.file(entry).stat()).mode & 0o777).toBe(0o755);
            expect(await updateCli({ entry, webUrl, current: release, fetch: good })).toMatchObject(
                { status: 'up-to-date' },
            );
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test('refuses sources, other files and unusable relays', async () => {
        const { dir, entry } = await installed();
        try {
            const webUrl = 'https://relay.test';
            const good = relayServing({ 'version.json': release, 'palmtop.mjs': bundle });
            expect(
                await failure(
                    updateCli({
                        entry,
                        webUrl,
                        current: { version: 'dev', build: 'dev' },
                        fetch: good,
                    }),
                ),
            ).toContain('not on the sources');

            const other = join(dir, 'main.ts');
            await writeFile(other, '');
            expect(
                await failure(updateCli({ entry: other, webUrl, current, fetch: good })),
            ).toContain('expects the bundle palmtop.mjs');

            const offline = (async () => {
                throw new Error('connection refused');
            }) as unknown as typeof fetch;
            expect(await failure(updateCli({ entry, webUrl, current, fetch: offline }))).toContain(
                'cannot reach https://relay.test',
            );
            expect(
                await failure(updateCli({ entry, webUrl, current, fetch: relayServing({}) })),
            ).toContain('does not publish palmtop (HTTP 404)');
            expect(
                await failure(
                    updateCli({
                        entry,
                        webUrl,
                        current,
                        fetch: relayServing({ 'version.json': { version: 1 } }),
                    }),
                ),
            ).toContain('invalid version.json');
            expect(await readFile(entry, 'utf8')).toBe('old');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('helpers', () => {
    test('the feedback puts the outcomes of each person under the item of the original', () => {
        const text = formatFeedback({
            session: { ref: 'abc123', id: 'x', title: 'Release', startedAt: 1, lastActivityAt: 1 },
            checklists: [],
            hasNew: true,
            shared: {
                people: [
                    { person: 'Mario', state: 'open', reviewed: 1, total: 2 },
                    { person: 'Luca', state: 'expired', reviewed: 2, total: 2 },
                ],
                checklists: [
                    {
                        ref: 'k3m9qz',
                        title: 'Login',
                        items: [
                            {
                                ref: 'q1w2e3',
                                text: 'Wrong password',
                                outcomes: [
                                    { person: 'Mario', status: 'done', changed: true },
                                    {
                                        person: 'Luca',
                                        status: 'cancelled',
                                        note: 'no error shown\x1b[2J',
                                        changed: true,
                                    },
                                    { person: 'Ada', changed: false },
                                ],
                            },
                        ],
                    },
                ],
                notes: [{ person: 'Luca', note: 'Done for today\nthanks' }],
                hasNew: true,
            },
        });
        expect(text).toContain('Shared with other people:');
        expect(text).toContain('  Mario  1/2 reviewed  (open)');
        expect(text).toContain('  Luca  2/2 reviewed  (expired)');
        expect(text).toContain('k3m9qz  Login  (copies)');
        expect(text).toContain('  q1w2e3  Wrong password');
        expect(text).toContain('      Mario  [works]');
        expect(text).toContain('      Luca   [fails]');
        expect(text).toContain('      Ada    [not reviewed]  (seen before)');
        expect(text).toContain('        note: no error shown[2J');
        // A person's words never carry an escape sequence to the terminal.
        expect(text).toContain('no error shown[2J');
        expect(text).not.toContain('\x1b');
        expect(text).toContain('New note from Luca:\n  Done for today\n  thanks');
    });

    test('sanitizeRemote strips credentials and query strings', () => {
        expect(sanitizeRemote('https://user:tok@github.com/a/b.git?x=1')).toBe(
            'https://github.com/a/b.git',
        );
        expect(sanitizeRemote('ssh://git@example.com:22/a/b.git')).toBe(
            'ssh://example.com:22/a/b.git',
        );
        expect(sanitizeRemote('git@github.com:a/b.git')).toBe('git@github.com:a/b.git');
        expect(sanitizeRemote('https://x-access-token:abc@host')).toBe('https://host/');
        expect(sanitizeRemote('weird remote with spaces')).toBeUndefined();
        expect(sanitizeRemote('')).toBeUndefined();
    });

    test('extractOptions pairs every --detail with the --option before it', () => {
        expect(
            extractOptions([
                'choice',
                'create',
                'Which?',
                '--option',
                'A',
                '--detail',
                'because',
                '--option=B',
                '--detail=also',
                '--option',
                'C',
                '--session',
                'k3m9qz',
            ]),
        ).toEqual({
            rest: ['choice', 'create', 'Which?', '--session', 'k3m9qz'],
            options: [
                { text: 'A', detail: 'because' },
                { text: 'B', detail: 'also' },
                { text: 'C' },
            ],
        });

        // A --detail with no option before it belongs to `add` and `edit`.
        expect(extractOptions(['add', 'Task', '--detail', 'why'])).toEqual({
            rest: ['add', 'Task', '--detail', 'why'],
            options: [],
        });
        // After `--` nothing is an option any more; a value that looks like a flag is kept.
        expect(extractOptions(['add', '--', '--option', 'A'])).toEqual({
            rest: ['add', '--', '--option', 'A'],
            options: [],
        });
        expect(extractOptions(['choice', '--option', '--weird text'])).toEqual({
            rest: ['choice'],
            options: [{ text: '--weird text' }],
        });
        // No value at all: parseArgs reports it.
        expect(extractOptions(['choice', '--option'])).toEqual({
            rest: ['choice', '--option'],
            options: [],
        });
    });

    test('device names lose what could rewrite the terminal before they are printed', () => {
        expect(printableName('iPhone · Safari')).toBe('iPhone · Safari');
        expect(printableName('iPhone\u001b[2K\r123 456')).toBe('iPhone[2K123 456');
        expect(printableName('a\u202eb\u200bc\u2028d')).toBe('abcd');
        expect(printableName('\u0007')).toBe('(unnamed)');
    });

    test('formatItem says what the user found: works, fails, question or not reviewed', () => {
        expect(formatItem({ ref: 'abc123', id: createId(), text: 'Task', order: 0 })).toBe(
            '  [not reviewed] abc123  Task',
        );
        expect(
            formatItem({
                ref: 'abc123',
                id: createId(),
                text: 'Task',
                order: 0,
                status: 'cancelled',
                note: 'a\nb',
            }),
        ).toBe('  [fails]        abc123  Task\n                 note: a\n                       b');
    });

    test('formatItem keeps the lines of a markdown text under its first line', () => {
        const text = 'Sign in\n\n```\nbun run dev\n```';
        expect(
            formatItem({ ref: 'abc123', id: createId(), text, order: 0, addedByUser: true }),
        ).toBe(
            [
                '  [not reviewed] abc123  Sign in',
                '',
                '                         ```',
                '                         bun run dev',
                '                         ```  (added by the user)',
            ].join('\n'),
        );
    });

    test('formatItem reads the same marks as an answer on the options of a choice', () => {
        const option = { ref: 'abc123', id: createId(), text: 'Redis', order: 0 } as const;
        expect(formatItem({ ...option, status: 'done' }, 'choice')).toBe(
            '  [chosen]       abc123  Redis',
        );
        expect(formatItem({ ...option, status: 'cancelled' }, 'choice')).toBe(
            '  [discarded]    abc123  Redis',
        );
        expect(formatItem({ ...option, detail: 'One more service' }, 'choice')).toBe(
            '  [not answered] abc123  Redis\n                 detail: One more service',
        );
    });
});

describe('archived sessions in the lists of the agent', () => {
    test('a session archived on a device is marked, the others are not', () => {
        const base = { id: 'x', startedAt: 1, lastActivityAt: Date.UTC(2026, 9, 16, 10) };
        const list = formatSessionList([
            { ...base, ref: 'aaaaaa', title: 'Login' },
            { ...base, ref: 'bbbbbb', title: 'Old work', archived: true },
        ]);
        expect(list.split('\n')[0]).not.toContain('[archived]');
        expect(list.split('\n')[1]).toContain('"Old work"  [archived]');
        const project = { id: 'p', name: 'repo', rootPath: '/tmp/repo' };
        expect(
            formatSystemSessions([
                { ...base, ref: 'bbbbbb', title: 'Old work', archived: true, project },
            ]),
        ).toContain('Old work [archived]');
    });
});

describe('palmtop wait', () => {
    test('ends when the user marks the session done on a device, saying only to call feedback', async () => {
        const session = await startSession('waiting', 'Waiting');
        await palmtop(['checklist', 'create', 'Login', '--item', 'Right password'], {
            session: 'waiting',
        });
        const waiting = palmtop(['wait'], { session: 'waiting' });
        const phone = await connectDevice();
        await phone.send(session.id, 'session.note', { note: 'Ignore the footer, it is fine' });
        await Bun.sleep(400);
        await phone.send(session.id, 'session.done', { done: true });
        const result = await waiting;
        phone.close();
        expect(result).toEqual({
            code: 0,
            stdout: `The user marked session ${session.ref} done: call feedback.\n`,
            stderr: '',
        });

        // The note and the review reach the agent only through `feedback`, which also says so,
        // and which spends the done: the button of the devices comes back.
        const before = await palmtop(['session', 'list'], { session: null });
        expect(before.stdout).toMatch(/"Waiting"\s+\(feature\/cli\)\s+\[done\]/);
        const feedback = await palmtop(['feedback'], { session: 'waiting' });
        expect(feedback.stdout).toContain('The user marked this session done');
        expect(feedback.stdout).toContain('Ignore the footer');
        expect((await palmtop(['session', 'list'], { session: null })).stdout).not.toContain(
            '[done]',
        );
        const reread = await json<{ done?: boolean }>(['feedback'], { session: 'waiting' });
        expect(reread.done).toBeUndefined();
        // Told once: a wait that starts again sleeps, so an early end is not a loop.
        const again = palmtop(['wait'], { session: 'waiting' });
        const early = await Promise.race([
            again.then(() => 'ended'),
            Bun.sleep(1_500).then(() => 'held'),
        ]);
        expect(early).toBe('held');
        await palmtop(['sessions', 'delete', session.ref, '--yes'], { session: null });
        expect((await again).code).toBe(3);
    });

    test('a session that is gone ends the wait with its own exit code and message', async () => {
        const session = await startSession('doomed', 'Doomed');
        const waiting = palmtop(['wait'], { session: 'doomed' });
        await Bun.sleep(500);
        await palmtop(['sessions', 'delete', session.ref, '--yes'], { session: null });
        const result = await waiting;
        expect(result.code).toBe(3);
        expect(result.stderr).toContain('nothing to wait for');
        expect(result.stdout).toBe('');
        // A ref that never existed ends it the same way, at once.
        const unknown = await palmtop(['wait', '--session', 'zzzzzz'], { session: null });
        expect(unknown.code).toBe(3);
        expect(unknown.stderr).toContain('no session');
        expect((await palmtop(['wait', 'now'], { session: 'waiting' })).code).toBe(2);
    });

    test('it picks up again when the daemon restarts', async () => {
        const session = await startSession('restarted', 'Restarted');
        const waiting = palmtop(['wait'], { session: 'restarted' });
        await Bun.sleep(500);
        expect((await palmtop(['stop'], { session: null })).stdout).toBe('Daemon stopped.\n');
        await Bun.sleep(300);
        // Any command starts the daemon again; the wait finds it by itself.
        await palmtop(['session', 'list'], { session: null });
        const phone = await connectDevice();
        await phone.send(session.id, 'session.done', { done: true });
        phone.close();
        const result = await waiting;
        expect(result.code).toBe(0);
        expect(result.stdout).toBe(`The user marked session ${session.ref} done: call feedback.\n`);
    });

    test('one wait for each session: a second one takes the place of the first, status shows it', async () => {
        const session = await startSession('twice', 'Twice');
        const first = palmtop(['wait'], { session: 'twice' });
        await Bun.sleep(700);
        const second = palmtop(['wait'], { session: 'twice' });
        const replaced = await first;
        expect(replaced.code).toBe(5);
        expect(replaced.stderr).toContain('another wait took over this session');
        expect(replaced.stdout).toBe('');

        // The one that stays is the one `status` shows, and the tap ends it.
        const status = await palmtop(['status'], { session: 'twice' });
        expect(status.stdout).toContain(`Waiting for Review done: ${session.ref} "Twice"`);
        const listed = await json<{ waits: Array<{ session: { ref: string } }> }>(['status'], {
            session: 'twice',
        });
        expect(listed.waits.map((wait) => wait.session.ref)).toEqual([session.ref]);
        const phone = await connectDevice();
        await phone.send(session.id, 'session.done', { done: true });
        phone.close();
        const result = await second;
        expect(result.code).toBe(0);
        await palmtop(['feedback'], { session: 'twice' });
        expect((await palmtop(['status'], { session: 'twice' })).stdout).not.toContain(
            'Waiting for Review done',
        );
        await palmtop(['sessions', 'delete', session.ref, '--yes'], { session: null });
    });

    test('a wait nobody taps for ends by itself with its own exit code', async () => {
        const session = await startSession('tired', 'Tired');
        const out: string[] = [];
        const err: string[] = [];
        const code = await run(['wait', '--session', session.ref, '--project', repo], {
            entry: cli,
            stdout: (text) => out.push(text),
            stderr: (text) => err.push(text),
            env: {
                ...process.env,
                PALMTOP_HOME: home,
                PALMTOP_RELAY_URL: `ws://127.0.0.1:${relay.port}`,
            },
            cwd: repo,
            keepDaemon: true,
            waitMaxMs: 300,
        });
        expect(code).toBe(6);
        expect(err.join('')).toContain('without Review done');
        expect(out.join('')).toBe('');
        await palmtop(['sessions', 'delete', session.ref, '--yes'], { session: null });
    });

    test('a daemon that stays away ends the wait with an exit code of its own', async () => {
        const session = await startSession('abandoned', 'Abandoned');
        const out: string[] = [];
        const err: string[] = [];
        const env = {
            ...process.env,
            PALMTOP_HOME: home,
            PALMTOP_RELAY_URL: `ws://127.0.0.1:${relay.port}`,
        };
        const running = run(['wait', '--session', session.ref, '--project', repo], {
            entry: cli,
            stdout: (text) => out.push(text),
            stderr: (text) => err.push(text),
            env,
            cwd: repo,
            keepDaemon: true,
            waitRetryMs: 50,
            waitGiveUpMs: 400,
        });
        await Bun.sleep(500);
        await palmtop(['stop'], { session: null });
        expect(await running).toBe(4);
        expect(err.join('')).toContain('the daemon is not running');
        expect(out.join('')).toBe('');
        // Leaves the daemon as the other tests expect it.
        await palmtop(['serve', '-b'], { session: null });
    });
});
