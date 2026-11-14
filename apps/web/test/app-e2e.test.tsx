import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDeviceKeys, queuedProjects } from '@palmtopai/client';
import { type Daemon, startDaemon } from '@palmtopai/daemon';
import {
    createId,
    exportPublicKey,
    getItem,
    listItems,
    listSessions,
    type ProjectState,
} from '@palmtopai/protocol';
import { type Relay, startRelay } from '@palmtopai/relay';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../src/App';
import { computerCache } from '../src/lib/cache';
import { loadStorageCleared } from '../src/lib/device-key';
import { consumeJoinLink } from '../src/lib/join';
import {
    loadPairings,
    rememberComputer,
    saveActiveComputer,
    saveActiveProject,
    upsertPairing,
} from '../src/lib/pairings';

/**
 * Full path in a DOM: pairing link → end-to-end pairing over a real relay against a real daemon
 * → pairing with the computer in localStorage, the device key in IndexedDB → project list → tap
 * on a status → op stored by the daemon → agent op shows up on screen.
 */
describe('web app through a real relay and daemon', () => {
    let home: string;
    let relay: Relay;
    let daemon: Daemon;
    let roomId: string;
    let computerId: string;
    let projectId: string;
    let otherProjectId: string;
    /** The one secret of the computer: never in the page or in the device's storage. */
    let privateKey: string;
    let pairFragment: string;
    let sessionId: string;
    let checklistId: string;
    let itemId: string;

    beforeAll(async () => {
        home = await mkdtemp(join(tmpdir(), 'palmtop-web-e2e-'));
        relay = startRelay({ port: 0, log: () => {} });
        await bootDaemon();
        ({ projectId } = await daemon.registry.resolve({ rootPath: '/tmp/e2e-repo' }));
        ({ projectId: otherProjectId } = await daemon.registry.resolve({
            rootPath: '/tmp/e2e-other',
        }));
        ({ roomId, computerId } = daemon.registry);
        for (let i = 0; i < 300 && !daemon.relay.isRoomOpen(roomId); i++) await Bun.sleep(10);
        const registry = JSON.parse(await readFile(join(home, 'projects.json'), 'utf8')) as {
            computer: { roomKey: { privateKey: string } };
        };
        privateKey = registry.computer.roomKey.privateKey;

        const room = await daemon.rooms.get(projectId);
        sessionId = createId();
        checklistId = createId();
        itemId = createId();
        await room?.submitLocal('session.upsert', sessionId, {
            title: 'main · e2e',
            startedAt: Date.now(),
        });
        await room?.submitLocal('checklist.create', sessionId, {
            checklistId,
            title: 'Refactor auth',
        });
        await room?.submitLocal('item.add', sessionId, {
            itemId,
            checklistId,
            text: 'Extract token service',
            order: 0,
        });

        // A real pairing link from the Local API (Bun's fetch: the DOM one is bound to the page
        // origin). The key is single-use and carries no token.
        const localKey = (await readFile(join(home, 'local.key'), 'utf8')).trim();
        const link = (await (
            await Bun.fetch(`http://127.0.0.1:${daemon.localPort}/pair/links`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-palmtop-key': localKey },
                body: '{}',
            })
        ).json()) as { url: string };
        pairFragment = new URL(link.url).hash;

        localStorage.clear();
        (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(
            `http://127.0.0.1:${relay.port}/${pairFragment}`,
        );
    });

    afterEach(cleanup);

    async function bootDaemon() {
        daemon = await startDaemon({
            home,
            localPort: 0,
            relayUrl: `ws://127.0.0.1:${relay.port}`,
            relayReconnectDelayMs: { min: 20, max: 200 },
            log: () => {},
        });
    }

    /**
     * This device paired with the computer, as a pairing leaves it: the device key (the one the
     * app loads from IndexedDB) registered on the daemon under each device id, the computer's key
     * in the pairing.
     */
    async function pairedHere(...deviceIds: string[]) {
        const keys = await loadDeviceKeys();
        const publicKey = await exportPublicKey(keys.publicKey);
        for (const deviceId of deviceIds) {
            await daemon.paired.add({ deviceId, name: 'Test device', publicKey });
        }
        upsertPairing({ computerId, roomId, computerKey: daemon.registry.roomPublicKey });
    }

    /** Picks a project by hand from the sheet behind the breadcrumb. */
    async function pickProject(name: string) {
        await userEvent.click(screen.getByRole('button', { name: /^Project .*, change$/ }));
        const sheet = await screen.findByRole('dialog');
        await userEvent.click(within(sheet).getByRole('button', { name: new RegExp(`^${name}`) }));
    }

    /** A pairing link of a daemon, from its Local API (the fragment only). */
    async function pairLink(target: Daemon, targetHome: string): Promise<string> {
        const localKey = (await readFile(join(targetHome, 'local.key'), 'utf8')).trim();
        const link = (await (
            await Bun.fetch(`http://127.0.0.1:${target.localPort}/pair/links`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-palmtop-key': localKey },
                body: '{}',
            })
        ).json()) as { url: string };
        return new URL(link.url).hash;
    }

    /** Entries in the device cache of the computer. */
    const cachedIds = async () => (await computerCache(computerId)?.projectIds()) ?? [];

    afterAll(async () => {
        await daemon.stop();
        await relay.stop();
        await rm(home, { recursive: true, force: true });
    });

    test('pairs from the link, syncs both ways and keeps the key out of the URL', async () => {
        const join = consumeJoinLink(window.location, window.history);
        expect(join).toMatchObject({ kind: 'pairing', roomId });
        expect(window.location.hash).toBe('');

        render(<App deviceId="web-e2etest00000000" join={join} />);

        await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Live'), {
            timeout: 3_000,
        });
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('e2e-repo');
        expect(screen.getByText(daemon.computerName)).toBeTruthy();
        // The session is selected in the render after the first sync: wait for its checklist.
        const checklist = await screen.findByRole('region', { name: 'Refactor auth' });

        await userEvent.click(within(checklist).getByRole('button', { name: 'Question' }));
        await userEvent.click(within(checklist).getByText('+ Add note'));
        await userEvent.type(within(checklist).getByRole('textbox'), 'which service?');
        await userEvent.click(within(checklist).getByRole('button', { name: 'Save note' }));

        const room = await daemon.rooms.get(projectId);
        await waitFor(
            () =>
                expect(getItem(room?.state as ProjectState, itemId)).toMatchObject({
                    status: 'question',
                    note: 'which service?',
                }),
            { timeout: 3_000 },
        );
        await waitFor(() =>
            expect(screen.getByRole('status').textContent).not.toContain('unsynced'),
        );

        await room?.submitLocal('item.add', sessionId, {
            itemId: createId(),
            checklistId,
            text: 'Add rate limit',
            order: 1,
        });
        await waitFor(() => expect(screen.getByText('Add rate limit')).toBeTruthy(), {
            timeout: 3_000,
        });
        expect(within(checklist).getByText('1/2 reviewed')).toBeTruthy();

        // The pairing is with the computer: every project of it is listed, not just this one.
        expect(loadPairings()[0]).toMatchObject({
            computerId,
            roomId,
            computerKey: daemon.registry.roomPublicKey,
        });
        expect(
            loadPairings()[0]
                ?.projects.map((entry) => entry.name)
                .sort(),
        ).toEqual(['e2e-other', 'e2e-repo']);
        expect(document.body.innerHTML).not.toContain(privateKey);
        // The daemon knows this device by the key it made at pairing.
        expect(daemon.paired.get('web-e2etest00000000')?.publicKey).toBe(
            await exportPublicKey((await loadDeviceKeys()).publicKey),
        );

        // What the user writes for the agent reaches the computer.
        await userEvent.click(within(checklist).getByRole('button', { name: '+ Add item' }));
        await userEvent.type(
            within(checklist).getByRole('textbox', { name: 'New item for Refactor auth' }),
            'Also test the logout{Enter}',
        );
        const notes = screen.getByRole('region', { name: 'Note for the agent' });
        await userEvent.click(within(notes).getByText('+ Write something for the agent'));
        await userEvent.type(within(notes).getByRole('textbox'), 'Deploy on Friday');
        await userEvent.click(within(notes).getByRole('button', { name: 'Save' }));
        await waitFor(
            () => {
                const state = room?.state as ProjectState;
                expect(
                    listItems(state, checklistId).find(
                        (item) => item.text === 'Also test the logout',
                    ),
                ).toMatchObject({ addedByUser: true });
                // The note is a list: one element, with its name.
                expect(listSessions(state).find((entry) => entry.id === sessionId)?.note).toMatch(
                    /^- Deploy on Friday \[#[a-z0-9]{4}\]$/,
                );
            },
            { timeout: 3_000 },
        );
        expect(await screen.findByText('Added by you · tap to edit')).toBeTruthy();

        await room?.submitLocal('session.message', sessionId, { message: 'Fixed, check again' });
        await waitFor(
            () =>
                expect(
                    screen.getByRole('region', { name: 'Message from the agent' }).textContent,
                ).toContain('Fixed, check again'),
            { timeout: 3_000 },
        );
    });

    test('a session deleted on one phone is deleted on the computer and on a second phone', async () => {
        await pairedHere('web-e2ephone0000000a', 'web-e2ephone0000000b');
        saveActiveProject(projectId);
        const room = await daemon.rooms.get(projectId);
        const doomedId = createId();
        await room?.submitLocal('session.upsert', doomedId, {
            title: 'feature · e2e',
            startedAt: Date.now(),
        });
        await room?.submitLocal('checklist.create', doomedId, {
            checklistId: createId(),
            title: 'Throwaway plan',
        });

        // Both phones follow the activity: the newest session is shown.
        const phone = within(
            render(<App deviceId="web-e2ephone0000000a" join={{ kind: 'none' }} />).container,
        );
        const other = within(
            render(<App deviceId="web-e2ephone0000000b" join={{ kind: 'none' }} />).container,
        );
        await phone.findByRole('region', { name: 'Throwaway plan' }, { timeout: 3_000 });
        await other.findByRole('region', { name: 'Throwaway plan' }, { timeout: 3_000 });

        const confirm = window.confirm;
        window.confirm = () => true;
        try {
            await userEvent.click(phone.getByRole('button', { name: 'Project menu' }));
            // The menu opens in a portal, outside the phone's container.
            await userEvent.click(
                await screen.findByRole('menuitem', { name: 'Delete this session…' }),
            );
        } finally {
            window.confirm = confirm;
        }

        // Both phones move to the remaining session.
        await phone.findByRole('region', { name: 'Refactor auth' });
        await other.findByRole('region', { name: 'Refactor auth' }, { timeout: 3_000 });
        expect(other.queryByRole('option', { name: 'feature · e2e' })).toBeNull();
        await waitFor(
            () =>
                expect(
                    listSessions(room?.state as ProjectState).map((session) => session.id),
                ).toEqual([sessionId]),
            { timeout: 3_000 },
        );
        await waitFor(() =>
            expect(phone.getByRole('status').textContent).not.toContain('unsynced'),
        );
        expect(phone.queryByText('A change was not accepted', { exact: false })).toBeNull();
    });

    test('the computer name shows under the project, changes live and is kept offline', async () => {
        localStorage.clear();
        await pairedHere('web-e2ecomputer0000');
        saveActiveProject(projectId);
        render(<App deviceId="web-e2ecomputer0000" join={{ kind: 'none' }} />);
        await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Live'), {
            timeout: 3_000,
        });
        try {
            await daemon.setComputerName('Office');
            await waitFor(() => expect(screen.getByText('Office')).toBeTruthy(), {
                timeout: 3_000,
            });
            expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('e2e-repo');
            // The sheet lists every project of the computer.
            await userEvent.click(screen.getByRole('button', { name: /^Project .*, change$/ }));
            const sheet = await screen.findByRole('dialog');
            expect(within(sheet).getByText('On Office')).toBeTruthy();
            expect(within(sheet).getByRole('button', { name: /^e2e-repo/ })).toBeTruthy();
            expect(within(sheet).getByRole('button', { name: /^e2e-other/ })).toBeTruthy();
            await userEvent.keyboard('{Escape}');
            expect(loadPairings()[0]).toMatchObject({ computerId, computer: 'Office' });
            expect(loadPairings()[0]?.projects.some((entry) => entry.id === otherProjectId)).toBe(
                true,
            );
        } finally {
            await daemon.setComputerName(null);
        }
    });

    test('follows the agent to another project of the computer, until a project is picked', async () => {
        localStorage.clear();
        await pairedHere('web-e2efollow00000a');
        saveActiveProject(projectId);
        render(<App deviceId="web-e2efollow00000a" join={{ kind: 'none' }} />);
        await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Live'), {
            timeout: 3_000,
        });
        await screen.findByRole('region', { name: 'Refactor auth' }, { timeout: 3_000 });

        // The agent starts working in the other project: this device moves there on its own.
        const other = await daemon.rooms.get(otherProjectId);
        const otherSessionId = createId();
        await other?.submitLocal('session.upsert', otherSessionId, {
            title: 'other · e2e',
            startedAt: Date.now(),
        });
        await other?.submitLocal('checklist.create', otherSessionId, {
            checklistId: createId(),
            title: 'Other plan',
        });
        await screen.findByRole('region', { name: 'Other plan' }, { timeout: 5_000 });

        // Picking a project by hand stops following: later activity elsewhere does not move it.
        await pickProject('e2e-repo');
        await screen.findByRole('region', { name: 'Refactor auth' });
        expect(screen.getByRole('button', { name: 'Follow activity' })).toBeTruthy();
        await other?.submitLocal('session.message', otherSessionId, { message: 'still here' });
        await Bun.sleep(1_500);
        expect(screen.getByRole('region', { name: 'Refactor auth' })).toBeTruthy();

        // Following again brings it back to the project the agent is working in.
        await userEvent.click(screen.getByRole('button', { name: 'Follow activity' }));
        await screen.findByRole('region', { name: 'Other plan' }, { timeout: 5_000 });
    }, 20_000);

    test('deletes a project from the app: it goes on the computer, the device stays paired', async () => {
        localStorage.clear();
        await pairedHere('web-e2edelete00000a');
        render(<App deviceId="web-e2edelete00000a" join={{ kind: 'none' }} />);
        await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Live'), {
            timeout: 3_000,
        });

        // A throwaway project with fresh activity: this device follows the agent there.
        const { projectId: doomedId } = await daemon.registry.resolve({
            rootPath: '/tmp/e2e-doomed',
        });
        const doomed = await daemon.rooms.get(doomedId);
        const doomedSession = createId();
        await doomed?.submitLocal('session.upsert', doomedSession, {
            title: 'doomed · e2e',
            startedAt: Date.now(),
        });
        await doomed?.submitLocal('checklist.create', doomedSession, {
            checklistId: createId(),
            title: 'Doomed plan',
        });
        await screen.findByRole('region', { name: 'Doomed plan' }, { timeout: 5_000 });

        const confirm = window.confirm;
        const asked: string[] = [];
        window.confirm = (message?: string) => {
            asked.push(message ?? '');
            return true;
        };
        try {
            await userEvent.click(screen.getByRole('button', { name: 'Project menu' }));
            await userEvent.click(screen.getByRole('menuitem', { name: 'Delete this project…' }));
        } finally {
            window.confirm = confirm;
        }
        expect(asked.join('')).toContain('files are not touched');

        await waitFor(() => expect(daemon.registry.has(doomedId)).toBe(false), { timeout: 3_000 });

        // The list without it reaches this device, which moves to another project of the computer.
        await waitFor(
            () => {
                expect(loadPairings()[0]?.projects.some((entry) => entry.id === doomedId)).toBe(
                    false,
                );
                expect(screen.getByRole('heading', { level: 1 }).textContent).not.toContain(
                    'doomed',
                );
            },
            { timeout: 5_000 },
        );
        expect(screen.queryByRole('region', { name: 'Doomed plan' })).toBeNull();
        // Its copy on this device goes with it.
        await waitFor(async () => expect(await cachedIds()).not.toContain(doomedId), {
            timeout: 3_000,
        });
        // Still paired with the computer.
        expect(loadPairings()).toHaveLength(1);
        await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Live'), {
            timeout: 5_000,
        });
    }, 20_000);

    test('unpairing from the Dashboard forgets the computer and disconnects this device', async () => {
        localStorage.clear();
        await pairedHere('web-e2eunpair000000');
        saveActiveProject(projectId);
        render(<App deviceId="web-e2eunpair000000" join={{ kind: 'none' }} />);
        await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Live'), {
            timeout: 3_000,
        });
        // Which project it follows depends on the activity: count the device on any of them.
        const connected = () =>
            daemon.devices.connectedDevices(projectId) +
            daemon.devices.connectedDevices(otherProjectId);
        // Live comes with the project list: following a project happens right after.
        await waitFor(() => expect(connected()).toBeGreaterThan(0), { timeout: 3_000 });
        await waitFor(async () => expect((await cachedIds()).length).toBeGreaterThan(0));

        const confirm = window.confirm;
        window.confirm = () => true;
        try {
            await userEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
            await userEvent.click(
                screen.getByRole('button', { name: `Menu of ${daemon.computerName}` }),
            );
            await userEvent.click(
                await screen.findByRole('menuitem', { name: 'Unpair this computer…' }),
            );
        } finally {
            window.confirm = confirm;
        }

        expect(
            await screen.findByText(/scan the QR code with this device/, undefined, {
                timeout: 5_000,
            }),
        ).toBeTruthy();
        expect(loadPairings()).toEqual([]);
        expect(JSON.stringify(localStorage)).not.toContain(daemon.registry.roomPublicKey);
        // The computer revoked this device, and said so: nothing left to do there.
        expect(daemon.paired.get('web-e2eunpair000000')).toBeNull();
        expect(screen.queryByText(/still accepts this device/)).toBeNull();
        await waitFor(() => expect(connected()).toBe(0), { timeout: 3_000 });
        // Nothing of the computer stays in the cache either.
        await waitFor(async () => expect(await cachedIds()).toEqual([]));
    });

    test('keys deleted by the browser: the computer refuses them and the app says the key was lost', async () => {
        localStorage.clear();
        await pairedHere('web-e2elostkey000000');
        saveActiveProject(projectId);
        render(<App deviceId="web-e2elostkey000000" join={{ kind: 'none' }} />);
        await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Live'), {
            timeout: 3_000,
        });
        // A pairing made before fingerprints were kept gets one once the computer accepts it.
        await waitFor(() => expect(loadPairings()[0]?.deviceKey).toBeString());
        const accepted = loadPairings()[0]?.deviceKey;
        expect(loadStorageCleared()).toBeNull();
        cleanup();
        // Back to a pairing from before this version, without a fingerprint: only the computer
        // can tell that the key is not the one it knows.
        upsertPairing({ computerId, roomId, computerKey: daemon.registry.roomPublicKey });
        expect(loadPairings()[0]?.deviceKey).toBeUndefined();

        // What Chrome does when space runs low: IndexedDB goes, localStorage stays.
        await new Promise<void>((resolve, reject) => {
            const deleting = indexedDB.deleteDatabase('palmtop-identity');
            deleting.onsuccess = () => resolve();
            deleting.onerror = () => reject(deleting.error);
        });
        render(<App deviceId="web-e2elostkey000000" join={{ kind: 'none' }} />);
        await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Key lost'), {
            timeout: 3_000,
        });
        expect(screen.getByText('This device lost its key.')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Remove from this device' })).toBeTruthy();
        // New keys were made and kept, and the deletion is recorded with them.
        const cleared = loadStorageCleared();
        expect(cleared?.key).toBeString();
        expect(cleared?.key).not.toBe(accepted);
        // The computer still has the old key: pairing again with the same id replaces it.
        expect(daemon.paired.get('web-e2elostkey000000')).not.toBeNull();
        // Above the project, why it happened and what to do; dismissed, it stays away.
        const notice = await screen.findByText(/Your browser deleted the data of this app/);
        expect(notice.textContent).toContain('pair this device again');
        await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
        expect(screen.queryByText(/Your browser deleted the data of this app/)).toBeNull();
    });

    test('archiving: a project leaves the Dashboard, waits in the archive, comes back', async () => {
        localStorage.clear();
        await pairedHere('web-e2earchive000000');
        saveActiveProject(projectId);
        render(<App deviceId="web-e2earchive000000" join={{ kind: 'none' }} />);
        await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Live'), {
            timeout: 3_000,
        });
        const room = await daemon.rooms.get(projectId);
        const archived = () => room?.state.sessions[sessionId]?.values.archived === true;
        // Polled by hand: the list of the computer changes from a timer of the daemon.
        const poll = async (condition: () => boolean, what: string) => {
            const deadline = Date.now() + 5_000;
            while (!condition()) {
                if (Date.now() > deadline) throw new Error(`the project never came ${what}`);
                await Bun.sleep(50);
            }
        };
        try {
            await userEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
            const card = () => screen.getByRole('listitem', { name: daemon.computerName });
            await userEvent.click(
                await within(card()).findByRole('button', { name: 'Menu of e2e-repo' }),
            );
            await userEvent.click(await screen.findByRole('menuitem', { name: 'Archive project' }));
            await waitFor(() => expect(archived()).toBe(true), { timeout: 3_000 });
            await poll(() => !within(card()).queryByRole('button', { name: /^e2e-repo/ }), 'gone');

            // In the archive, with its session; Restore brings it back on the computer too.
            await userEvent.click(screen.getByRole('button', { name: 'Archive' }));
            const sheet = await screen.findByRole('dialog');
            const group = within(sheet).getByRole('listitem', { name: 'e2e-repo' });
            expect(within(group).getByText('main · e2e')).toBeTruthy();
            await userEvent.click(
                within(group).getByRole('button', { name: 'Restore main · e2e' }),
            );
            await waitFor(() => expect(archived()).toBe(false), { timeout: 3_000 });
            await userEvent.keyboard('{Escape}');
            await poll(() => !!within(card()).queryByRole('button', { name: /^e2e-repo/ }), 'back');

            // Archived again, then the agent writes to it: out of the archive by itself.
            await userEvent.click(
                await within(card()).findByRole('button', { name: 'Menu of e2e-repo' }),
            );
            await userEvent.click(await screen.findByRole('menuitem', { name: 'Archive project' }));
            await waitFor(() => expect(archived()).toBe(true), { timeout: 3_000 });
            await room?.submitLocal('session.message', sessionId, { message: 'Ready to check' });
            await waitFor(() => expect(archived()).toBe(false), { timeout: 3_000 });
            await poll(() => !!within(card()).queryByRole('button', { name: /^e2e-repo/ }), 'back');
        } finally {
            if (archived())
                await room?.submitLocal('session.archive', sessionId, { archived: false });
            await room?.submitLocal('session.message', sessionId, { message: '' });
        }
    }, 20_000);

    test('Review done: the agent that waits is woken, the button comes back with what the agent writes', async () => {
        localStorage.clear();
        await pairedHere('web-e2edone0000000000');
        saveActiveProject(projectId);
        const view = render(<App deviceId="web-e2edone0000000000" join={{ kind: 'none' }} />);
        await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Live'), {
            timeout: 3_000,
        });
        const room = await daemon.rooms.get(projectId);
        const isDone = () => room?.state.sessions[sessionId]?.values.done === true;
        const localKey = (await readFile(join(home, 'local.key'), 'utf8')).trim();
        const waitUrl = `http://127.0.0.1:${daemon.localPort}/projects/${projectId}/sessions/${sessionId}/wait?client=e2e-agent&claim=1`;
        const confirm = window.confirm;
        let asked = '';
        window.confirm = (message?: string) => {
            asked = message ?? '';
            return true;
        };
        try {
            // The agent is waiting (the full id is a ref too).
            // Nobody waits yet: the button says so and does not go.
            const idle = (await view.findByRole('button', {
                name: 'Review done',
            })) as HTMLButtonElement;
            await waitFor(() => expect(idle.disabled).toBe(true), { timeout: 3_000 });
            expect(view.getByText(/The agent is not waiting for it/)).toBeTruthy();

            // The agent starts waiting: the button lights up by itself.
            const waiting = Bun.fetch(waitUrl, { headers: { 'x-palmtop-key': localKey } });
            await waitFor(
                () =>
                    expect(
                        (view.getByRole('button', { name: 'Review done' }) as HTMLButtonElement)
                            .disabled,
                    ).toBe(false),
                { timeout: 3_000 },
            );
            await userEvent.click(view.getByRole('button', { name: 'Review done' }));
            expect(asked).toContain('Tell the agent you finished reviewing this session?');
            const answer = (await (await waiting).json()) as { status: string };
            expect(answer.status).toBe('done');
            expect(isDone()).toBe(true);
            expect(await view.findByText('Marked as done')).toBeTruthy();
            expect(view.queryByRole('button', { name: 'Review done' })).toBeNull();

            // The agent writes again: the button is back, on this device too, off until a wait runs.
            await room?.submitLocal('item.add', sessionId, {
                itemId: createId(),
                checklistId,
                text: 'Also check the logout',
                order: 5,
            });
            await waitFor(() => expect(isDone()).toBe(false), { timeout: 3_000 });
            expect(await view.findByRole('button', { name: 'Review done' })).toBeTruthy();
        } finally {
            window.confirm = confirm;
            if (isDone()) await room?.submitLocal('session.done', sessionId, { done: false });
        }
    }, 20_000);

    test('unpairing a computer that is off: gone from here, and the app says what to run there', async () => {
        localStorage.clear();
        const deviceId = 'web-e2eunpairoff000';
        await pairedHere(deviceId);
        saveActiveProject(projectId);
        render(<App deviceId={deviceId} join={{ kind: 'none' }} />);
        await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Live'), {
            timeout: 3_000,
        });
        await waitFor(async () => expect((await cachedIds()).length).toBeGreaterThan(0));
        cleanup();

        await daemon.stop();
        render(<App deviceId={deviceId} join={{ kind: 'none' }} />);
        await waitFor(
            () => expect(screen.getByRole('status').textContent).toContain('PC offline'),
            { timeout: 3_000 },
        );
        const asked: string[] = [];
        const confirm = window.confirm;
        window.confirm = (message) => {
            asked.push(String(message));
            return true;
        };
        try {
            await userEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
            await userEvent.click(
                screen.getByRole('button', { name: `Menu of ${daemon.computerName}` }),
            );
            await userEvent.click(
                await screen.findByRole('menuitem', { name: 'Unpair this computer…' }),
            );
        } finally {
            window.confirm = confirm;
        }
        // Said before, and again after: the computer still accepts this device's key.
        expect(asked[0]).toContain('It is offline');
        const notice = await screen.findByText(/still accepts this device/, undefined, {
            timeout: 5_000,
        });
        expect(notice.textContent).toContain(daemon.computerName);
        expect(notice.textContent).toContain('palmtop devices remove');
        expect(loadPairings()).toEqual([]);

        await bootDaemon();
        expect(daemon.paired.get(deviceId)).not.toBeNull();
        await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
        expect(screen.queryByText(/still accepts this device/)).toBeNull();
    }, 20_000);

    test('reopened with the computer off: cached checklists, queued edits delivered when it is back', async () => {
        localStorage.clear();
        await pairedHere('web-e2ecache000000a');
        saveActiveProject(projectId);
        const deviceId = 'web-e2ecache000000a';
        render(<App deviceId={deviceId} join={{ kind: 'none' }} />);
        await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Live'), {
            timeout: 3_000,
        });
        // Picked by hand: the agent's activity elsewhere does not move it.
        await pickProject('e2e-repo');
        await screen.findByRole('region', { name: 'Refactor auth' }, { timeout: 3_000 });
        await waitFor(async () => expect(await cachedIds()).toContain(projectId));
        cleanup();

        // The computer goes off; the app is opened again.
        await daemon.stop();
        render(<App deviceId={deviceId} join={{ kind: 'none' }} />);
        const checklist = await screen.findByRole('region', { name: 'Refactor auth' });
        await waitFor(
            () => expect(screen.getByRole('status').textContent).toContain('PC offline'),
            {
                timeout: 3_000,
            },
        );
        expect(screen.getByText(/Last synced just now\./)).toBeTruthy();

        await userEvent.click(within(checklist).getByRole('button', { name: '+ Add item' }));
        await userEvent.type(within(checklist).getByRole('textbox'), 'Check the offline queue');
        await userEvent.click(within(checklist).getByRole('button', { name: 'Add' }));
        expect(screen.getByRole('status').textContent).toContain('1 unsynced');

        // Closed on another project before the computer came back.
        await pickProject('e2e-other');
        await waitFor(async () => {
            const cache = computerCache(computerId);
            expect(cache && (await queuedProjects(cache))).toEqual([projectId]);
        });
        cleanup();

        // Next launch follows the agent, but opens the project with the queued edit first.
        render(<App deviceId={deviceId} join={{ kind: 'none' }} />);
        await screen.findByRole('region', { name: 'Refactor auth' }, { timeout: 3_000 });
        expect(screen.getByText('Check the offline queue')).toBeTruthy();

        await bootDaemon();
        const room = await daemon.rooms.get(projectId);
        await waitFor(
            () =>
                expect(
                    listItems(room?.state as ProjectState, checklistId).map((item) => item.text),
                ).toContain('Check the offline queue'),
            { timeout: 5_000 },
        );
        await waitFor(
            () => expect(screen.getByRole('status').textContent).not.toContain('unsynced'),
            { timeout: 3_000 },
        );
        await waitFor(async () => {
            const cache = computerCache(computerId);
            expect(cache && (await queuedProjects(cache))).toEqual([]);
        });
    }, 20_000);

    test('scanning the QR of a second computer opens it, the first one stays paired', async () => {
        // A second computer on the same relay, with no projects yet.
        const secondHome = await mkdtemp(join(tmpdir(), 'palmtop-web-e2e-second-'));
        await Bun.write(
            join(secondHome, 'config.json'),
            JSON.stringify({ computerName: 'Second-PC' }),
        );
        let stopped = false;
        const second = await startDaemon({
            home: secondHome,
            localPort: 0,
            relayUrl: `ws://127.0.0.1:${relay.port}`,
            relayReconnectDelayMs: { min: 20, max: 200 },
            log: () => {},
        });
        try {
            const secondRoom = second.registry.roomId;
            for (let i = 0; i < 300 && !second.relay.isRoomOpen(secondRoom); i++) {
                await Bun.sleep(10);
            }

            // The device already follows a project of the first computer.
            localStorage.clear();
            await pairedHere('web-e2esecond00000a');
            rememberComputer(computerId, {
                computer: daemon.computerName,
                projects: [
                    { id: projectId, name: 'e2e-repo' },
                    { id: otherProjectId, name: 'e2e-other' },
                ],
            });
            saveActiveProject(projectId);
            saveActiveComputer(computerId);

            (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(
                `http://127.0.0.1:${relay.port}/${await pairLink(second, secondHome)}`,
            );
            const join = consumeJoinLink(window.location, window.history);
            render(<App deviceId="web-e2esecond00000a" join={join} />);

            // The new computer is the one shown, and it is live: its (empty) list arrived.
            expect(
                await screen.findByText(/No projects on this computer yet/, undefined, {
                    timeout: 3_000,
                }),
            ).toBeTruthy();
            expect(loadPairings().map((pairing) => pairing.computerId)).toEqual([
                computerId,
                second.registry.computerId,
            ]);

            // The Dashboard lists both, live: the new one empty, the first one with its projects.
            await userEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
            const secondCard = await screen.findByRole('listitem', { name: 'Second-PC' });
            await waitFor(() => expect(within(secondCard).getByText('Live')).toBeTruthy());
            expect(within(secondCard).getByText(/No projects yet/)).toBeTruthy();
            const firstCard = screen.getByRole('listitem', { name: daemon.computerName });
            await waitFor(() => expect(within(firstCard).getByText('Live')).toBeTruthy(), {
                timeout: 3_000,
            });
            expect(within(firstCard).getByRole('button', { name: /^e2e-other/ })).toBeTruthy();

            // A project of the first computer opened from there connects to that computer.
            await userEvent.click(within(firstCard).getByRole('button', { name: /^e2e-repo/ }));
            await screen.findByRole('region', { name: 'Refactor auth' }, { timeout: 3_000 });

            // The second computer, not open now, still shows live: off, then gone.
            await userEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
            await waitFor(
                () =>
                    expect(
                        within(screen.getByRole('listitem', { name: 'Second-PC' })).getByText(
                            'Live',
                        ),
                    ).toBeTruthy(),
                { timeout: 3_000 },
            );
            await second.stop();
            stopped = true;
            await waitFor(
                () =>
                    expect(
                        within(screen.getByRole('listitem', { name: 'Second-PC' })).getByText(
                            'PC offline',
                        ),
                    ).toBeTruthy(),
                { timeout: 3_000 },
            );

            // Unpairing a computer that is not open: this device forgets it.
            const originalConfirm = window.confirm;
            window.confirm = () => true;
            try {
                await userEvent.click(screen.getByRole('button', { name: 'Menu of Second-PC' }));
                await userEvent.click(
                    await screen.findByRole('menuitem', { name: 'Unpair this computer…' }),
                );
            } finally {
                window.confirm = originalConfirm;
            }
            await waitFor(() =>
                expect(screen.queryByRole('listitem', { name: 'Second-PC' })).toBeNull(),
            );
            expect(loadPairings().map((pairing) => pairing.computerId)).toEqual([computerId]);
        } finally {
            cleanup();
            localStorage.clear();
            if (!stopped) await second.stop();
            await rm(secondHome, { recursive: true, force: true });
        }
    }, 20_000);

    test('the app on the Home Screen pairs with a code typed on the computer', async () => {
        localStorage.clear();
        const matchMedia = window.matchMedia;
        window.matchMedia = ((query: string) => ({
            ...matchMedia.call(window, query),
            matches: query === '(display-mode: standalone)',
        })) as typeof window.matchMedia;
        try {
            render(<App deviceId="web-e2ecode00000000" join={{ kind: 'none' }} />);
            const shown = await screen.findByTestId('pair-code', {}, { timeout: 3_000 });
            const code = (shown.textContent ?? '').replace(' ', '');
            expect(screen.getByText(`palmtop pair ${code}`)).toBeTruthy();

            // What `palmtop pair CODE` does after the user confirms on the computer.
            const localKey = (await readFile(join(home, 'local.key'), 'utf8')).trim();
            const answer = await Bun.fetch(`http://127.0.0.1:${daemon.localPort}/pair/offer`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-palmtop-key': localKey },
                body: JSON.stringify({ code }),
            });
            const { id } = (await answer.json()) as { status: string; id: string };

            expect(await screen.findByText(`Pair with “${daemon.computerName}”?`)).toBeTruthy();
            expect(loadPairings()).toEqual([]);
            await userEvent.click(screen.getByRole('button', { name: 'Pair' }));

            // Both screens show the same number: the phone here, the terminal through the API.
            const number = (await screen.findByTestId('pair-number', {}, { timeout: 3_000 }))
                .textContent;
            const confirmation = async () =>
                (await (
                    await Bun.fetch(`http://127.0.0.1:${daemon.localPort}/pair/offers/${id}`, {
                        headers: { 'x-palmtop-key': localKey },
                    })
                ).json()) as { state: string; number?: string };
            await waitFor(async () => expect((await confirmation()).state).toBe('ready'));
            expect(
                `${(await confirmation()).number?.slice(0, 3)} ${(await confirmation()).number?.slice(3)}`,
            ).toBe(number as string);
            await userEvent.click(screen.getByRole('button', { name: 'Same number' }));
            // Nothing kept before the computer said yes too.
            expect(loadPairings()).toEqual([]);
            await Bun.fetch(`http://127.0.0.1:${daemon.localPort}/pair/offers/${id}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-palmtop-key': localKey },
                body: JSON.stringify({ accept: true }),
            });
            await waitFor(() => expect(loadPairings()).toHaveLength(1), { timeout: 3_000 });
            expect(loadPairings()[0]).toMatchObject({
                computerId,
                roomId,
                computerKey: daemon.registry.roomPublicKey,
            });
            await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Live'), {
                timeout: 5_000,
            });
        } finally {
            window.matchMedia = matchMedia;
            cleanup();
            localStorage.clear();
        }
    }, 20_000);

    test("an invitation opens a copy that is not the user's: answers go to the owner, a date makes it read-only", async () => {
        localStorage.clear();
        const invite = await daemon.guestRooms.invite('Mario');
        const room = await daemon.rooms.get(projectId);
        await daemon.sharing.share({
            room: room as NonNullable<typeof room>,
            sessionId,
            checklistRef: checklistId,
            personName: 'Mario',
        });
        await daemon.setOwnerName('Grace (studio)');
        (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(
            `http://127.0.0.1:${relay.port}/#invite?r=${invite.roomId}&k=${invite.key}`,
        );
        const join = consumeJoinLink(window.location, window.history);
        expect(join).toMatchObject({ kind: 'invite', roomId: invite.roomId });
        expect(window.location.hash).toBe('');

        try {
            render(<App deviceId="web-e2eguest0000000" join={join} />);
            await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Live'), {
                timeout: 5_000,
            });
            // What is shared: the copy, named after the session, under the name of the owner.
            expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('main · e2e');
            expect(screen.getByText('Grace (studio)')).toBeTruthy();
            const checklist = await screen.findByRole('region', { name: 'Refactor auth' });
            expect(within(checklist).getByText('Extract token service')).toBeTruthy();
            // Nothing of the user's: no other project of the computer, no computer name.
            expect(document.body.textContent).not.toContain('e2e-other');
            expect(document.body.textContent).not.toContain(daemon.computerName);
            expect(screen.queryByRole('button', { name: 'Project menu' })).toBeNull();
            expect(loadPairings()).toHaveLength(1);
            expect(loadPairings()[0]).toMatchObject({
                roomId: invite.roomId,
                guest: true,
                computer: 'Grace (studio)',
            });
            expect(loadPairings()[0]?.computerId).not.toBe(computerId);

            // An answer goes to the copy, not to the original.
            const row = within(
                within(checklist).getByText('Extract token service').closest('li') as HTMLElement,
            );
            await userEvent.click(row.getByRole('button', { name: 'Cancelled' }));
            await userEvent.click(row.getByText('+ Add note'));
            await userEvent.type(row.getByRole('textbox'), 'does not work');
            await userEvent.click(row.getByRole('button', { name: 'Save note' }));
            const share = daemon.people.shares()[0];
            await waitFor(
                async () => {
                    const view = await daemon.sharing.ownerView(projectId);
                    expect(view[0]?.people[0]?.items[itemId]).toMatchObject({
                        status: 'cancelled',
                        note: 'does not work',
                    });
                },
                { timeout: 3_000 },
            );
            const original = await daemon.rooms.get(projectId);
            expect(getItem(original?.state as ProjectState, itemId)?.status).not.toBe('cancelled');

            // Review done on the copy: the owner's view carries the mark, the original stays as it was.
            const confirmGuest = window.confirm;
            window.confirm = () => true;
            try {
                await userEvent.click(screen.getByRole('button', { name: 'Review done' }));
            } finally {
                window.confirm = confirmGuest;
            }
            expect(
                await screen.findByText('Grace (studio) sees it on their devices.'),
            ).toBeTruthy();
            await waitFor(
                async () => {
                    const view = await daemon.sharing.ownerView(projectId);
                    expect(view[0]?.people[0]?.done).toBe(true);
                },
                { timeout: 3_000 },
            );
            expect(original?.state.sessions[sessionId]?.values.done).not.toBe(true);

            // The copy stops taking answers at its date.
            await daemon.people.putShare({
                ...(share as NonNullable<typeof share>),
                expiresAt: Date.now() - 1_000,
            });
            daemon.guestRooms.refresh(invite.person.personId);
            expect(
                await screen.findByText(/It is read-only now/, {}, { timeout: 3_000 }),
            ).toBeTruthy();
            expect(within(checklist).queryByRole('button', { name: '+ Add item' })).toBeNull();

            // Taken away: it goes from the list.
            await daemon.sharing.close({ projectId, sessionId, personName: 'Mario' });
            expect(
                await screen.findByText(
                    'Nothing is shared with you right now.',
                    {},
                    { timeout: 3_000 },
                ),
            ).toBeTruthy();
            expect(screen.queryByRole('region', { name: 'Refactor auth' })).toBeNull();
        } finally {
            cleanup();
            localStorage.clear();
            await daemon.guestRooms.removePerson('Mario').catch(() => undefined);
        }
    }, 25_000);
});
