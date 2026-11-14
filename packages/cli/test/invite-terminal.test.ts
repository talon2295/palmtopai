import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Daemon, startDaemon } from '@palmtopai/daemon';
import { type Relay, startRelay } from '@palmtopai/relay';
import { type CliIo, run } from '../src/cli';
import { pairOverRelay } from './e2e-device';

const ESC = '';
const QR_COLOURS = `${ESC}[97;40m`;

/** `palmtop invite` on a terminal: a link for one person, shown to nobody else. */
describe('invite in the terminal', () => {
    let home: string;
    let project: string;
    let relay: Relay;
    let daemon: Daemon;

    function freePort(): number {
        const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
        const port = server.port as number;
        server.stop(true);
        return port;
    }

    beforeAll(async () => {
        home = await mkdtemp(join(tmpdir(), 'palmtop-invite-'));
        project = await mkdtemp(join(tmpdir(), 'palmtop-invite-repo-'));
        const localPort = freePort();
        await writeFile(join(home, 'config.json'), `${JSON.stringify({ localPort })}\n`);
        relay = startRelay({ port: 0, log: () => {} });
        daemon = await startDaemon({
            home,
            localPort,
            relayUrl: `ws://127.0.0.1:${relay.port}`,
            relayReconnectDelayMs: { min: 20, max: 200 },
            log: () => {},
        });
    });

    afterAll(async () => {
        await daemon.stop();
        await relay.stop();
        await rm(home, { recursive: true, force: true });
        await rm(project, { recursive: true, force: true });
    });

    /** A CLI run with a fake terminal (`keys`), or without one at all (`null`). */
    function io(
        keys: string[] | null,
        options: { confirm?: boolean; ask?: string } = {},
    ): CliIo & { out: string[]; cleared: () => number; asked: string[] } {
        const out: string[] = [];
        const asked: string[] = [];
        let cleared = 0;
        const pending = [...(keys ?? [])];
        return {
            entry: join(home, 'palmtop.mjs'),
            stdout: (text) => out.push(text),
            stderr: (text) => out.push(text),
            env: { PALMTOP_HOME: home },
            cwd: project,
            ...(keys && {
                tty: {
                    readKey: async () => pending.shift() ?? '\r',
                    clear: () => {
                        cleared += 1;
                    },
                },
            }),
            ...(options.confirm !== undefined && {
                confirm: async (question: string) => {
                    asked.push(question);
                    return options.confirm as boolean;
                },
            }),
            ...(options.ask !== undefined && {
                ask: async (question: string) => {
                    asked.push(question);
                    return options.ask as string;
                },
            }),
            out,
            asked,
            cleared: () => cleared,
        };
    }

    const linkIn = (text: string) => /#invite\?r=([\w-]+)&k=([\w-]+)/.exec(text);

    /** A device of the person opening the link, as the app does. */
    function open(roomId: string, key: string, deviceId = 'mario-phone') {
        return pairOverRelay({
            url: `ws://127.0.0.1:${relay.port}/ws?room=${roomId}`,
            roomId,
            pairKey: key,
            deviceId,
            name: 'iPhone · Safari',
        });
    }

    test('without a terminal, or with --json, nothing is created and nothing is shown', async () => {
        for (const [argv, terminal] of [
            [['invite', '--name', 'Mario'], io(null, { confirm: true })],
            [['invite', '--name', 'Mario', '--json'], io([], { confirm: true })],
            [['invite', '--name', 'Mario'], io([])],
        ] as const) {
            expect(await run([...argv], terminal)).not.toBe(0);
            expect(terminal.out.join('\n')).toContain('needs you at a terminal');
            expect(terminal.out.join('\n')).not.toContain('#invite');
        }
        expect(daemon.people.people()).toEqual([]);
        expect(daemon.guestRooms.hubOf).toBeDefined();
    });

    test('needs a name', async () => {
        const none = io([], { confirm: true });
        expect(await run(['invite'], none)).toBe(2);
        expect(none.out.join('\n')).toContain('--name');
        const extra = io([], { confirm: true });
        expect(await run(['invite', 'Mario', '--name', 'Mario'], extra)).toBe(2);
        expect(extra.out.join('\n')).toContain('invite takes');
    });

    test('shows the QR and the link, asks for the owner name once, clears the screen on close', async () => {
        const terminal = io([ESC], { confirm: true, ask: 'Grace (studio)' });
        expect(await run(['invite', '--name', 'Mario'], terminal)).toBe(0);
        const text = terminal.out.join('\n');

        expect(text).toContain(QR_COLOURS);
        const match = linkIn(text);
        expect(match).not.toBeNull();
        expect(text).toContain('Invite Mario');
        expect(text).toContain('It opens once, until');
        expect(text).toContain('palmtop share <checklist> --with Mario');
        expect(terminal.asked).toHaveLength(1);
        expect(terminal.asked[0]).toContain('How should the people you share with call you?');
        expect(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')).ownerName).toBe(
            'Grace (studio)',
        );
        // The screen is wiped, and the last line does not say the link again.
        expect(terminal.cleared()).toBe(1);
        expect(terminal.out.at(-1)).not.toContain('#invite');
        expect(terminal.out.at(-1)).toContain('ready until');

        // The link stays valid after the terminal was closed, for one device.
        const [, roomId, key] = match as RegExpExecArray;
        const first = await open(roomId as string, key as string);
        expect(first.kind).toBe('paired');
        expect(await open(roomId as string, key as string, 'intruder')).toMatchObject({
            kind: 'refused',
        });
        // Nobody else's key: the key of the invitation is not the room key.
        const person = daemon.people.findPerson('Mario');
        expect(text).not.toContain(person?.roomKey?.privateKey ?? 'no-key');
    });

    test('the owner name is not asked again, and people shows who joined', async () => {
        const terminal = io(null, { confirm: true });
        expect(await run(['people'], terminal)).toBe(0);
        const text = terminal.out.join('\n');
        expect(text).toContain('Mario');
        expect(text).toContain('iPhone · Safari');
        expect(text).toContain('0 of 0');
        expect(text).not.toContain('privateKey');
        expect(text).not.toContain('#invite');

        const json = io(null);
        await run(['people', '--json'], json);
        const parsed = JSON.parse(json.out.join('')) as Array<Record<string, unknown>>;
        expect(parsed[0]).toMatchObject({ name: 'Mario', invitedUntil: null });
        expect(JSON.stringify(parsed)).not.toContain('"key"');
    });

    test('a person with a device is asked about, and a no leaves everything as it was', async () => {
        const before = daemon.people.findPerson('mario')?.device;
        const no = io([ESC], { confirm: false });
        expect(await run(['invite', '--name', 'mario'], no)).not.toBe(0);
        expect(no.out.join('\n')).toContain('nothing changed');
        expect(no.asked.some((q) => q.includes('has a device already'))).toBe(true);
        expect(no.asked.some((q) => q.includes('How should the people'))).toBe(false);
        expect(no.out.join('\n')).not.toContain('#invite');
        expect(daemon.people.findPerson('Mario')?.device).toEqual(before);

        const yes = io([ESC], { confirm: true });
        expect(await run(['invite', '--name', 'mario'], yes)).toBe(0);
        expect(linkIn(yes.out.join('\n'))).not.toBeNull();
        expect(daemon.people.findPerson('Mario')?.device).toBeNull();
        expect(daemon.people.people()).toHaveLength(1);
    });

    test('people remove asks, and removes', async () => {
        const piped = io(null);
        expect(await run(['people', 'remove', 'Mario'], piped)).not.toBe(0);
        expect(piped.out.join('\n')).toContain('nothing deleted');
        expect(daemon.people.findPerson('Mario')).not.toBeNull();

        const sure = io(null);
        expect(await run(['people', 'remove', 'mario', '--yes'], sure)).toBe(0);
        expect(sure.out.join('\n')).toContain('Mario is not shared with any more.');
        expect(daemon.people.findPerson('Mario')).toBeNull();
        const empty = io(null);
        await run(['people'], empty);
        expect(empty.out.join('\n')).toContain('Nobody yet');
    });

    test('config owner-name shows, sets and resets the name', async () => {
        const show = io(null);
        await run(['config', 'owner-name'], show);
        expect(show.out.join('\n')).toContain('Owner name: Grace (studio)');

        await run(['config', 'owner-name', 'Grace'], io(null));
        const set = io(null);
        await run(['config', 'owner-name'], set);
        expect(set.out.join('\n')).toContain('Owner name: Grace');

        const reset = io(null);
        await run(['config', 'owner-name', '--reset'], reset);
        expect(reset.out.join('\n')).toContain('Owner name removed');
        expect(await run(['config', 'owner-name', 'A', '--reset'], io(null))).not.toBe(0);
        expect(await run(['config', 'owner-name', 'x'.repeat(41)], io(null))).not.toBe(0);
    });
});
