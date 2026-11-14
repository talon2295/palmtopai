import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Daemon, startDaemon } from '@palmtopai/daemon';
import { type Relay, startRelay } from '@palmtopai/relay';
import { type CliIo, run } from '../src/cli';
import { pairOverRelay } from './e2e-device';

const ESC = '';
/** Start of the colours that make the QR code white on black, whatever the terminal theme. */
const QR_COLOURS = `${ESC}[97;40m`;

/** `palmtop pair` on a terminal: the QR code, the link, and the key revoked on exit. */
/** The fake browser is a `#!/bin/sh` script, which Windows cannot run: those tests are skipped. */
const NO_SH = process.platform === 'win32';

describe('pair in the terminal', () => {
    let home: string;
    let project: string;
    let relay: Relay;
    let daemon: Daemon;
    let opened: string;
    let opener: string;

    function freePort(): number {
        const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
        const port = server.port as number;
        server.stop(true);
        return port;
    }

    beforeAll(async () => {
        home = await mkdtemp(join(tmpdir(), 'palmtop-pair-'));
        project = await mkdtemp(join(tmpdir(), 'palmtop-repo-'));
        opened = join(home, 'opened-url');
        opener = join(home, 'fake-open.sh');
        await writeFile(opener, `#!/bin/sh\nprintf '%s' "$1" > '${opened}'\n`);
        await chmod(opener, 0o700);

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
        /** One answer for every question, or one per question in order. */
        answer?: boolean | boolean[],
    ): CliIo & { out: string[]; cleared: () => number; asked: string[] } {
        const answers = Array.isArray(answer) ? [...answer] : null;
        const out: string[] = [];
        const asked: string[] = [];
        let cleared = 0;
        const pending = [...(keys ?? [])];
        return {
            entry: join(home, 'palmtop.mjs'),
            stdout: (text) => out.push(text),
            stderr: (text) => out.push(text),
            env: { PALMTOP_HOME: home, PALMTOP_OPEN: opener },
            cwd: project,
            ...(keys && {
                tty: {
                    readKey: async () => pending.shift() ?? '\r',
                    clear: () => {
                        cleared += 1;
                    },
                },
            }),
            ...(answer !== undefined && {
                confirm: async (question: string) => {
                    asked.push(question);
                    return answers ? (answers.shift() ?? false) : (answer as boolean);
                },
            }),
            out,
            asked,
            cleared: () => cleared,
        };
    }

    /** An app on a Home Screen, waiting on the relay with the code it shows. */
    async function waitingApp() {
        const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/wait`);
        const messages: Array<{ type: string; code?: string; key?: string; computer?: string }> =
            [];
        ws.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data))));
        for (let i = 0; i < 100 && messages.length === 0; i++) await Bun.sleep(10);
        const code = messages.shift()?.code as string;
        return { ws, code, messages };
    }

    const offersTo = (app: Awaited<ReturnType<typeof waitingApp>>) =>
        app.messages.filter((message) => message.type === 'pair.offer');

    /** Pairs a device with a key through the relay, end to end as the app does. */
    function pairWith(key: string, deviceId = 'web-phone1', onNumber?: (number: string) => void) {
        const { roomId } = daemon.registry;
        return pairOverRelay({
            url: `ws://127.0.0.1:${relay.port}/ws?room=${roomId}`,
            roomId,
            pairKey: key,
            deviceId,
            name: 'iPhone · Safari',
            ...(onNumber && { onNumber }),
        });
    }

    /** The one secret of the computer: no output may contain it. */
    async function roomPrivateKey(): Promise<string> {
        const file = JSON.parse(await readFile(join(home, 'projects.json'), 'utf8')) as {
            computer: { roomKey: { privateKey: string } };
        };
        return file.computer.roomKey.privateKey;
    }

    /** The URL the fake browser was opened with, once it has written it. */
    async function openedUrl(timeoutMs = 5_000): Promise<string> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const file = Bun.file(opened);
            if (await file.exists()) {
                const url = await file.text();
                if (url) return url;
            }
            await Bun.sleep(20);
        }
        throw new Error('the pairing page was never opened');
    }

    const linkIn = (text: string) => /#pair\?r=[\w-]+&k=([\w-]+)/.exec(text);

    test('shows the QR code and the link, then revokes the key when the QR is closed', async () => {
        const terminal = io(['x', ESC]);
        expect(await run(['pair'], terminal)).toBe(0);
        const text = terminal.out.join('\n');

        expect(text).toContain(QR_COLOURS);
        const match = linkIn(text);
        expect(match).not.toBeNull();
        // The device is paired with the computer, and gets every project of it.
        expect(text).toContain(`Pair a device with "${daemon.computerName}"`);
        expect(text).toContain('with every project');
        expect(text).toContain('Press y to open the pairing page in a browser');
        expect(text).not.toContain(await roomPrivateKey());
        // Screen and scrollback are wiped, and the key that was on them pairs nothing any more.
        expect(terminal.cleared()).toBe(1);
        expect(await pairWith(match?.[1] as string)).toMatchObject({
            kind: 'refused',
            error: { type: 'error', code: 'unauthorized' },
        });
    });

    test.skipIf(NO_SH)(
        'y opens the pairing page in the browser, and the QR stays until Esc',
        async () => {
            const terminal = io(['y', '\r']);
            expect(await run(['pair'], terminal)).toBe(0);
            // The browser is started in the background: on a busy machine it can take a while.
            const url = await openedUrl();
            expect(url).toContain('/pair?code=');
            // The page URL carries a single-use code: it goes to the browser, never to the output.
            expect(terminal.out.join('\n')).not.toContain(url);
        },
        10_000,
    );

    test.skipIf(NO_SH)('without a terminal only the browser sees a link', async () => {
        const piped = io(null);
        expect(await run(['pair'], piped)).toBe(0);
        const text = piped.out.join('\n');
        expect(text).toContain(`Opened the pairing page for "${daemon.computerName}"`);
        expect(linkIn(text)).toBeNull();
        expect(piped.cleared()).toBe(0);
    });

    /** The app takes the key `palmtop pair CODE` sent it and pairs; returns what it shows. */
    async function appPairs(app: Awaited<ReturnType<typeof waitingApp>>, deviceId = 'web-phone1') {
        for (let i = 0; i < 300 && offersTo(app).length === 0; i++) await Bun.sleep(10);
        const [offer] = offersTo(app);
        let shown = '';
        const attempt = await pairWith(offer?.key as string, deviceId, (number) => {
            shown = number;
        });
        return { offer, attempt, shown };
    }

    test('pair CODE asks, sends a single-use key, and pairs once the numbers match', async () => {
        const app = await waitingApp();
        const terminal = io([], true);
        const running = run(['pair', app.code.toLowerCase()], terminal);
        const { offer, attempt, shown } = await appPairs(app);
        expect(offer?.computer).toBe(daemon.computerName);
        expect(attempt.kind).toBe('paired');
        expect(await running).toBe(0);

        expect(terminal.asked).toEqual([
            `Pair "${daemon.computerName}" with the device showing ${app.code}? It will see every project of this computer. [y/N] `,
            'Is it the same number on the device? [y/N] ',
        ]);
        const out = terminal.out.join('\n');
        // The terminal shows the number the phone shows, and the phone's name.
        expect(out).toContain(`The device "iPhone · Safari" shows:`);
        expect(out).toContain(`${shown.slice(0, 3)} ${shown.slice(3)}`);
        expect(out).toContain('Paired "iPhone · Safari". Confirm on the device to finish.');
        // The key never shows in the terminal.
        expect(out).not.toContain(offer?.key as string);
        expect(out).not.toContain(await roomPrivateKey());
        if (attempt.kind === 'paired') {
            for (let i = 0; i < 200 && attempt.device.messages.length === 0; i++) {
                await Bun.sleep(10);
            }
            expect(attempt.device.messages[0]).toMatchObject({ type: 'paired' });
            attempt.device.close();
        }
        expect(daemon.paired.get('web-phone1')).not.toBeNull();
        app.ws.close();
    });

    test('pair CODE: a different number pairs nothing, and says why', async () => {
        const app = await waitingApp();
        const terminal = io([], [true, false]);
        const running = run(['pair', app.code], terminal);
        const { attempt } = await appPairs(app, 'web-phone2');
        expect(await running).toBe(1);
        expect(terminal.out.join('\n')).toContain('not paired: the numbers must match');
        if (attempt.kind === 'paired') {
            expect(await attempt.device.closed).toBe(4401);
        }
        expect(daemon.paired.get('web-phone2')).toBeNull();
        app.ws.close();
    });

    test('pair CODE: nothing is sent without a yes, a terminal, or with --json', async () => {
        const app = await waitingApp();
        const no = io([], false);
        expect(await run(['pair', app.code], no)).toBe(1);
        expect(no.out.join('\n')).toContain('nothing sent');

        // Agents and scripts: no terminal, a terminal without a way to confirm, or --json.
        for (const [runIo, argv] of [
            [io(null), ['pair', app.code]],
            [io(null, true), ['pair', app.code, '--yes']],
            [io([]), ['pair', app.code]],
            [io([], true), ['pair', app.code, '--json']],
        ] as const) {
            expect(await run([...argv], runIo)).toBe(1);
            expect(runIo.out.join('\n')).toContain('needs you at a terminal');
            expect(runIo.asked).toEqual([]);
        }
        await Bun.sleep(50);
        expect(offersTo(app)).toEqual([]);
        app.ws.close();
    });

    test('pair CODE: invalid and unknown codes', async () => {
        const invalid = io([], true);
        expect(await run(['pair', 'abc'], invalid)).toBe(1);
        expect(invalid.out.join('\n')).toContain('is not a pairing code');
        expect(invalid.asked).toEqual([]);

        const unknown = io([], true);
        expect(await run(['pair', 'ZZZZZZ'], unknown)).toBe(1);
        expect(unknown.out.join('\n')).toContain('no device is showing ZZZZZZ');

        expect(await run(['pair', 'ZZZZZZ', 'more'], io([], true))).toBe(2);
    });

    test.skipIf(NO_SH)('pairing never registers the folder it runs in', async () => {
        // Every run above happened in `project`, which is not a palmtop project and must stay
        // unknown: pairing is with the computer, projects are created by `session start`.
        expect(await daemon.registry.find(project)).toBeNull();
        expect(daemon.registry.list()).toEqual([]);

        const piped = io(null);
        expect(await run(['pair', '--json'], piped)).toBe(0);
        expect(JSON.parse(piped.out.join(''))).toEqual({
            opened: true,
            computer: daemon.computerName,
        });
        expect(daemon.registry.list()).toEqual([]);
    });
});
