import { describe, expect, test } from 'bun:test';
import {
    applyAll,
    createId,
    createOp,
    createProjectState,
    type Session,
} from '@palmtopai/protocol';
import { dimColor, dimThemeColor } from '@/lib/theme-color';
import { cn } from '@/lib/utils';
import {
    appScriptOf,
    appVersion,
    isUpdateAvailable,
    runningAppScript,
} from '../src/lib/app-update';
import { formatSyncedAt, pruneCachedImages } from '../src/lib/cache';
import { deviceName, getDeviceId, getStatsId } from '../src/lib/device';
import { loadStorageCleared, markStorageCleared, noteDeviceKey } from '../src/lib/device-key';
import { loadFeedbackEmail, saveFeedbackEmail, sendFeedback } from '../src/lib/feedback';
import {
    devicePlatform,
    FIRST_INSTALL_PROMPT_MS,
    INSTALL_PROMPT_MS,
    installPromptDelay,
    isInstalled,
    loadInstallPrompt,
    saveInstallPrompt,
    waitSocketUrl,
} from '../src/lib/install';
import { consumeJoinLink, parsePairFragment } from '../src/lib/join';
import { hasLinks, splitLinks } from '../src/lib/linkify';
import { parseInline, parseMarkdown, plainTitle, splitTitle } from '../src/lib/markdown';
import type { PairedProject } from '../src/lib/pairings';
import {
    isArchivedProject,
    loadActiveComputer,
    loadActiveProject,
    loadPairings,
    lostKey,
    openComputer,
    type Pairing,
    pairedProjectOf,
    pairingOfProject,
    rememberComputer,
    removePairing,
    saveActiveComputer,
    saveActiveProject,
    upsertPairing,
} from '../src/lib/pairings';
import {
    consumeOpenLink,
    currentPush,
    generateVapidKeys,
    loadPushSettings,
    pushSupport,
    savePushSettings,
} from '../src/lib/push';
import { completeListsLast } from '../src/lib/review-filter';
import {
    fitWithin,
    MAX_SIDE,
    prepareScreenshot,
    type ScreenshotCodec,
    ScreenshotError,
} from '../src/lib/screenshot';
import { enableSecureContextFeatures } from '../src/lib/secure-context';
import { followReducer, initialFollowState } from '../src/lib/session-follow';
import { dismissStorageNotice, storageNoticeOf } from '../src/lib/storage-notice';
import { deviceSocketUrl } from '../src/sync/use-project-sync';
import { MemoryStore, ThrowingStore } from './helpers';

const TOKEN = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0u_-'; // gitleaks:allow (placeholder, not a real token)
/** A computer's room key as a pairing keeps it (placeholder, 43 base64url characters). */
const COMPUTER_KEY = TOKEN;
const OTHER_KEY = [...TOKEN].reverse().join('');
const ROOM = 'R1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0u_-';

describe('pairing links', () => {
    const KEY = 'aaaaaaaaaaaaaaaaaaaaaa';

    test('parses room and single-use key, and ignores other fragments', () => {
        expect(parsePairFragment(`#pair?r=${ROOM}&k=${KEY}`)).toEqual({
            kind: 'pairing',
            roomId: ROOM,
            key: KEY,
        });
        expect(parsePairFragment('')).toEqual({ kind: 'none' });
        expect(parsePairFragment(`#join?r=${ROOM}`)).toEqual({ kind: 'none' });
    });

    test('an invitation is told from a pairing, with the same checks on the key', () => {
        expect(parsePairFragment(`#invite?r=${ROOM}&k=${KEY}`)).toEqual({
            kind: 'invite',
            roomId: ROOM,
            key: KEY,
        });
        expect(parsePairFragment(`#invite?r=${ROOM}`)).toEqual({ kind: 'invalid' });
        expect(parsePairFragment(`#invite?r=short&k=${KEY}`)).toEqual({ kind: 'invalid' });
        // Neither is taken for the other.
        expect(parsePairFragment(`#pair?r=${ROOM}&k=${KEY}`).kind).toBe('pairing');
    });

    test('an invitation is removed from the address bar too, and stores nothing', () => {
        const replaced: string[] = [];
        const result = consumeJoinLink(
            { hash: `#invite?r=${ROOM}&k=${KEY}`, pathname: '/', search: '' },
            { replaceState: (_data, _unused, url) => replaced.push(String(url)) },
        );
        expect(result.kind).toBe('invite');
        expect(replaced).toEqual(['/']);
    });

    test.each([
        ['missing key', `#pair?r=${ROOM}`],
        ['short key', `#pair?r=${ROOM}&k=tooshort`],
        ['key with spaces', `#pair?r=${ROOM}&k=${'a'.repeat(11)}%20${'b'.repeat(11)}`],
        ['missing room', `#pair?k=${KEY}`],
        ['bad room', `#pair?r=short&k=${KEY}`],
    ])('refuses a link with a %s', (_name, hash) => {
        expect(parsePairFragment(hash)).toEqual({ kind: 'invalid' });
    });

    test('stores nothing: the key is redeemed over the relay, and the URL is stripped', () => {
        const store = new MemoryStore();
        const replaced: string[] = [];
        const result = consumeJoinLink(
            { hash: `#pair?r=${ROOM}&k=${KEY}`, pathname: '/', search: '' },
            { replaceState: (_data, _unused, url) => replaced.push(String(url)) },
        );

        expect(result).toEqual({ kind: 'pairing', roomId: ROOM, key: KEY });
        expect(replaced).toEqual(['/']);
        expect(loadPairings(store)).toEqual([]);
    });

    test('an invalid link is also removed from the URL and stores nothing', () => {
        const store = new MemoryStore();
        const replaced: string[] = [];
        const result = consumeJoinLink(
            { hash: '#pair?r=short&k=nope', pathname: '/x', search: '?x=1' },
            { replaceState: (_data, _unused, url) => replaced.push(String(url)) },
        );
        expect(result.kind).toBe('invalid');
        expect(replaced).toEqual(['/x?x=1']);
        expect(loadPairings(store)).toEqual([]);
    });

    test('works on the real window: the address bar no longer contains the key', () => {
        window.history.replaceState(null, '', `/#pair?r=${ROOM}&k=${KEY}`);
        consumeJoinLink(window.location, window.history);
        expect(window.location.href).not.toContain(KEY);
        expect(window.location.hash).toBe('');
    });
});

describe('push notifications', () => {
    test('VAPID keys are a P-256 pair in base64url, stored with the setting', async () => {
        const vapid = await generateVapidKeys();
        expect(vapid.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
        expect(vapid.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const store = new MemoryStore();
        expect(loadPushSettings(store)).toBeNull();
        savePushSettings({ enabled: true, vapid }, store);
        expect(loadPushSettings(store)).toEqual({ enabled: true, vapid });
    });

    test('iPhone browsers outside the Home Screen are told to add the app first', () => {
        const fake = (userAgent: string, extra: object = {}) =>
            ({
                isSecureContext: true,
                navigator: { userAgent, platform: 'iPhone', maxTouchPoints: 5 },
                ...extra,
            }) as unknown as Window;
        expect(pushSupport(fake('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)'))).toBe(
            'needs-home-screen',
        );
        expect(pushSupport(fake('Mozilla/5.0 (X11; Linux)'))).toBe('unsupported');
        const supported = {
            isSecureContext: true,
            PushManager: class {},
            Notification: class {},
            navigator: { userAgent: 'x', serviceWorker: {} },
        } as unknown as Window;
        expect(pushSupport(supported)).toBe('supported');
    });

    test('notifications on but without a subscription subscribe again, with the same keys', async () => {
        const vapid = await generateVapidKeys();
        const store = new MemoryStore();
        savePushSettings({ enabled: true, vapid }, store);
        const subscription = {
            toJSON: () => ({
                endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
                keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) },
            }),
        };
        let current: typeof subscription | null = subscription;
        const asked: unknown[] = [];
        let refuse = false;
        const environment = {
            supported: () => true,
            permission: () => 'granted' as NotificationPermission,
            manager: async () =>
                ({
                    getSubscription: async () => current,
                    subscribe: async (options: unknown) => {
                        asked.push(options);
                        if (refuse) throw new Error('a user gesture is required');
                        current = subscription;
                        return subscription;
                    },
                }) as unknown as PushManager,
        };
        // A subscription that is there is used as it is.
        expect((await currentPush(store, environment))?.vapid).toEqual(vapid);
        expect(asked).toHaveLength(0);
        // Gone (the browser deleted the app's data): subscribed again, nothing to tap.
        current = null;
        const again = await currentPush(store, environment);
        expect(again?.subscription.endpoint).toBe('https://fcm.googleapis.com/fcm/send/abc');
        expect(again?.vapid).toEqual(vapid);
        expect(asked).toHaveLength(1);
        // A browser that wants a tap: off, as before.
        current = null;
        refuse = true;
        expect(await currentPush(store, environment)).toBeNull();
        // Turned off by the user, or not allowed: never subscribed behind their back.
        savePushSettings({ enabled: false, vapid }, store);
        refuse = false;
        expect(await currentPush(store, environment)).toBeNull();
        savePushSettings({ enabled: true, vapid }, store);
        expect(await currentPush(store, { ...environment, permission: () => 'denied' })).toBeNull();
        expect(asked).toHaveLength(2);
    });

    test('a notification link selects its project and leaves the URL', () => {
        const projectId = createId();
        const replaced: string[] = [];
        const history = {
            replaceState: (_: unknown, __: string, url: string) => replaced.push(url),
        };
        expect(
            consumeOpenLink({ hash: `#open?p=${projectId}`, pathname: '/', search: '' }, history),
        ).toBe(projectId);
        expect(replaced).toEqual(['/']);
        expect(
            consumeOpenLink({ hash: '#open?p=nope', pathname: '/', search: '' }, history),
        ).toBeNull();
        expect(consumeOpenLink({ hash: '', pathname: '/', search: '' }, history)).toBeNull();
    });
});

describe('device key fingerprint', () => {
    test('the first key is only remembered; another one later is a deletion, recorded once', () => {
        const store = new MemoryStore();
        expect(noteDeviceKey('first-key-000000', store, 1)).toBe(false);
        expect(noteDeviceKey('first-key-000000', store, 2)).toBe(false);
        expect(loadStorageCleared(store)).toBeNull();
        expect(noteDeviceKey('second-key-00000', store, 3)).toBe(true);
        expect(loadStorageCleared(store)).toEqual({ at: 3, key: 'second-key-00000' });
        // Found again (a computer refusing the same keys): the date stays the first one.
        markStorageCleared('second-key-00000', store, 9);
        expect(loadStorageCleared(store)).toEqual({ at: 3, key: 'second-key-00000' });
        markStorageCleared('third-key-000000', store, 10);
        expect(loadStorageCleared(store)).toEqual({ at: 10, key: 'third-key-000000' });
    });

    test('without localStorage nothing is recorded, and nothing breaks', () => {
        expect(noteDeviceKey('first-key-000000', new ThrowingStore(), 1)).toBe(false);
        expect(loadStorageCleared(new ThrowingStore())).toBeNull();
    });
});

describe('app update', () => {
    const page = (script: string) =>
        `<!doctype html><head><link rel="manifest" href="/manifest.webmanifest"><script type="module" crossorigin src="${script}"></script></head>`;

    test('the script of a build is read from its page, wherever its attributes are', () => {
        expect(appScriptOf(page('/assets/app-CxDESbfa.js'))).toBe('/assets/app-CxDESbfa.js');
        expect(appScriptOf('<script src="/assets/app-x1.js" type="module"></script>')).toBe(
            '/assets/app-x1.js',
        );
        // The dev server and other scripts are not a build.
        expect(appScriptOf('<script type="module" src="/src/main.tsx"></script>')).toBeNull();
        expect(appScriptOf('<script src="/assets/legacy.js"></script>')).toBeNull();
    });

    test('another script on the server is a new version; the same, an error or offline is not', async () => {
        const served =
            (html: string, ok = true) =>
            async () =>
                new Response(html, { status: ok ? 200 : 500 });
        const running = '/assets/app-old00000.js';
        expect(await isUpdateAvailable(running, served(page('/assets/app-new00000.js')))).toBe(
            true,
        );
        expect(await isUpdateAvailable(running, served(page(running)))).toBe(false);
        expect(
            await isUpdateAvailable(running, served(page('/assets/app-new00000.js'), false)),
        ).toBe(false);
        expect(await isUpdateAvailable(running, served('<p>maintenance</p>'))).toBe(false);
        expect(
            await isUpdateAvailable(running, async () => {
                throw new TypeError('Failed to fetch');
            }),
        ).toBe(false);
        // Past every cache: an app on the Home Screen can stay open for days.
        const asked: RequestInit[] = [];
        await isUpdateAvailable(running, async (_, init) => {
            asked.push(init);
            return new Response(page(running));
        });
        expect(asked).toEqual([{ cache: 'no-store' }]);
    });

    test('the version at the foot of the app: palmtop and the build, or dev', () => {
        expect(appVersion('/assets/app-CxDESbfa.js', undefined)).toBe('dev');
        expect(appVersion('/assets/app-CxDESbfa.js', '0.19.1')).toBe('palmtop 0.19.1 · CxDESbfa');
        expect(appVersion(null, '0.19.1')).toBe('palmtop 0.19.1');
    });

    test('the running script is the one of this page', () => {
        const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
        expect(runningAppScript(parse('<p>no app</p>'))).toBeNull();
        expect(runningAppScript(parse(page('/assets/app-CxDESbfa.js')))).toBe(
            '/assets/app-CxDESbfa.js',
        );
    });
});

describe('storage notice', () => {
    const own = { hasPairing: true, hasOwnPairing: true };

    test('a deletion first; the risk only with pairings of ones own; each until dismissed', () => {
        const store = new MemoryStore();
        const first = { at: 1, key: 'first-key-000000' };
        expect(storageNoticeOf({ cleared: null, persisted: true, ...own }, store)).toBeNull();
        // Not known (no API, or not answered yet): nothing.
        expect(storageNoticeOf({ cleared: null, persisted: undefined, ...own }, store)).toBeNull();
        expect(storageNoticeOf({ cleared: null, persisted: false, ...own }, store)).toBe('at-risk');
        expect(
            storageNoticeOf(
                { cleared: null, persisted: false, hasPairing: true, hasOwnPairing: false },
                store,
            ),
        ).toBeNull();
        expect(storageNoticeOf({ cleared: first, persisted: false, ...own }, store)).toBe(
            'cleared',
        );
        // Nothing paired: nothing lost, nothing to say.
        expect(
            storageNoticeOf(
                { cleared: first, persisted: false, hasPairing: false, hasOwnPairing: false },
                store,
            ),
        ).toBeNull();

        dismissStorageNotice('cleared', first, store);
        expect(storageNoticeOf({ cleared: first, persisted: false, ...own }, store)).toBe(
            'at-risk',
        );
        dismissStorageNotice('at-risk', first, store);
        expect(storageNoticeOf({ cleared: first, persisted: false, ...own }, store)).toBeNull();

        // A new deletion: both come back.
        const second = { at: 2, key: 'second-key-00000' };
        expect(storageNoticeOf({ cleared: second, persisted: false, ...own }, store)).toBe(
            'cleared',
        );
        dismissStorageNotice('cleared', second, store);
        expect(storageNoticeOf({ cleared: second, persisted: false, ...own }, store)).toBe(
            'at-risk',
        );
    });
});

describe('pairings storage', () => {
    const COMPUTER = createId();

    test('the archive of a project is kept with the pairing, and a change of it is saved', () => {
        const store = new MemoryStore();
        upsertPairing({ computerId: COMPUTER, roomId: ROOM, computerKey: COMPUTER_KEY }, store, 1);
        const id = createId();
        const old = { id: createId(), title: 'Old work', lastActivityAt: 5 };
        const project = {
            id,
            name: 'repo',
            lastActivityAt: 0,
            sessions: 0,
            pending: 0,
            archived: [old],
        };
        expect(pairedProjectOf({ ...project, archived: [] })).not.toHaveProperty('archived');
        rememberComputer(COMPUTER, { projects: [pairedProjectOf(project)] }, store);
        const [kept] = loadPairings(store)[0]?.projects ?? [];
        expect(kept?.archived).toEqual([old]);
        expect(isArchivedProject(kept as PairedProject)).toBe(true);
        // Out of the archive: the change is saved even if the counts look the same.
        rememberComputer(
            COMPUTER,
            { projects: [{ ...project, sessions: 1, archived: undefined }] },
            store,
        );
        const [back] = loadPairings(store)[0]?.projects ?? [];
        expect(back?.archived).toBeUndefined();
        expect(isArchivedProject(back as PairedProject)).toBe(false);
        // A project without any session is not archived, only empty.
        expect(isArchivedProject({ id, name: 'repo', sessions: 0 })).toBe(false);
    });

    test('the key a pairing was made with: kept, filled in later, dropped when pairing again', () => {
        const store = new MemoryStore();
        upsertPairing({ computerId: COMPUTER, roomId: ROOM, computerKey: COMPUTER_KEY }, store, 1);
        const [old] = loadPairings(store);
        expect(old?.deviceKey).toBeUndefined();
        // Unknown: no reason to say the key was lost, unless the computer says so.
        expect(lostKey(old as Pairing, 'now-key-0000000')).toBe(false);
        expect(lostKey(old as Pairing, 'now-key-0000000', 'key')).toBe(true);
        // A connection the computer accepted fills it in.
        rememberComputer(COMPUTER, { projects: [], deviceKey: 'now-key-0000000' }, store);
        const [known] = loadPairings(store);
        expect(known?.deviceKey).toBe('now-key-0000000');
        expect(lostKey(known as Pairing, 'now-key-0000000')).toBe(false);
        expect(lostKey(known as Pairing, 'new-key-0000000')).toBe(true);
        // Paired again: the earlier key goes, the new one (if given) is kept.
        upsertPairing({ computerId: COMPUTER, roomId: ROOM, computerKey: COMPUTER_KEY }, store, 2);
        expect(loadPairings(store)[0]?.deviceKey).toBeUndefined();
        upsertPairing(
            {
                computerId: COMPUTER,
                roomId: ROOM,
                computerKey: COMPUTER_KEY,
                deviceKey: 'new-key-0000000',
            },
            store,
            3,
        );
        expect(loadPairings(store)[0]?.deviceKey).toBe('new-key-0000000');
    });

    test('a pairing made with an invitation is remembered as one, and a new pairing is not', () => {
        const store = new MemoryStore();
        upsertPairing(
            { computerId: COMPUTER, roomId: ROOM, computerKey: COMPUTER_KEY, guest: true },
            store,
            1,
        );
        expect(loadPairings(store)[0]?.guest).toBe(true);
        const other = createId();
        upsertPairing({ computerId: other, roomId: ROOM, computerKey: OTHER_KEY }, store, 2);
        expect(
            loadPairings(store).find((entry) => entry.computerId === other)?.guest,
        ).toBeUndefined();
        // Pairings written before guests existed still read.
        store.setItem(
            'palmtop.pairings.v3',
            JSON.stringify([
                { computerId: other, roomId: ROOM, computerKey: OTHER_KEY, pairedAt: 1 },
            ]),
        );
        expect(loadPairings(store)).toHaveLength(1);
    });

    test('upsert refreshes the key of a paired computer and keeps its projects', () => {
        const store = new MemoryStore();
        const projects = [{ id: createId(), name: 'repo' }];
        upsertPairing({ computerId: COMPUTER, roomId: ROOM, computerKey: COMPUTER_KEY }, store, 1);
        rememberComputer(COMPUTER, { computer: 'Office', projects }, store);
        const next = upsertPairing(
            { computerId: COMPUTER, roomId: ROOM, computerKey: OTHER_KEY },
            store,
            2,
        );
        expect(next).toEqual([
            {
                computerId: COMPUTER,
                roomId: ROOM,
                computerKey: OTHER_KEY,
                computer: 'Office',
                projects,
                pairedAt: 2,
            },
        ]);
        expect(removePairing(COMPUTER, store)).toEqual([]);
    });

    test('the project list is remembered, and the name is kept when it is not sent again', () => {
        const store = new MemoryStore();
        const first = { id: createId(), name: 'repo' };
        const second = { id: createId(), name: 'other' };
        upsertPairing({ computerId: COMPUTER, roomId: ROOM, computerKey: COMPUTER_KEY }, store, 1);
        expect(
            rememberComputer(COMPUTER, { computer: 'Office', projects: [first] }, store),
        ).toEqual([
            {
                computerId: COMPUTER,
                roomId: ROOM,
                computerKey: COMPUTER_KEY,
                computer: 'Office',
                projects: [first],
                pairedAt: 1,
            },
        ]);
        expect(rememberComputer(COMPUTER, { projects: [second, first] }, store)[0]).toMatchObject({
            computer: 'Office',
            projects: [second, first],
        });
        expect(loadPairings(store)[0]?.computer).toBe('Office');

        // An unknown computer is never added by a list update.
        expect(rememberComputer(createId(), { projects: [first] }, store)).toHaveLength(1);
        expect(pairingOfProject(loadPairings(store), first.id)?.computerId).toBe(COMPUTER);
        expect(pairingOfProject(loadPairings(store), createId())).toBeNull();
        expect(pairingOfProject(loadPairings(store), null)).toBeNull();
    });

    test('the open computer: the one opened last, else the project owner, else the last paired', () => {
        const store = new MemoryStore();
        const other = createId();
        const project = { id: createId(), name: 'repo' };
        upsertPairing({ computerId: COMPUTER, roomId: ROOM, computerKey: COMPUTER_KEY }, store, 1);
        rememberComputer(COMPUTER, { projects: [project] }, store);
        // Just paired, no projects yet.
        upsertPairing({ computerId: other, roomId: ROOM, computerKey: COMPUTER_KEY }, store, 2);
        const pairings = loadPairings(store);

        expect(openComputer(pairings, other, project.id)?.computerId).toBe(other);
        expect(openComputer(pairings, null, project.id)?.computerId).toBe(COMPUTER);
        expect(openComputer(pairings, createId(), project.id)?.computerId).toBe(COMPUTER);
        expect(openComputer(pairings, null, null)?.computerId).toBe(other);
        expect(openComputer([], other, null)).toBeNull();

        expect(loadActiveComputer(store)).toBeNull();
        saveActiveComputer(other, store);
        expect(loadActiveComputer(store)).toBe(other);
        expect(loadActiveComputer(new ThrowingStore())).toBeNull();
    });

    test('corrupted or tampered storage is ignored', () => {
        const store = new MemoryStore();
        store.setItem('palmtop.pairings.v2', '{not json');
        expect(loadPairings(store)).toEqual([]);
        store.setItem('palmtop.pairings.v3', '{not json');
        expect(loadPairings(store)).toEqual([]);
        // Pairings with the computer token (before end-to-end encryption) are not read: the
        // device pairs again.
        store.setItem(
            'palmtop.pairings.v2',
            JSON.stringify([
                { computerId: COMPUTER, roomId: ROOM, token: TOKEN, projects: [], pairedAt: 1 },
            ]),
        );
        expect(loadPairings(store)).toEqual([]);
        // Pairings of the per-project versions live under another key and are not read.
        store.setItem(
            'palmtop.pairings.v1',
            JSON.stringify([{ projectId: createId(), roomId: ROOM, token: TOKEN, pairedAt: 1 }]),
        );
        expect(loadPairings(store)).toEqual([]);
    });

    test('a throwing or missing localStorage does not break the app', () => {
        const projectId = createId();
        expect(loadPairings(new ThrowingStore())).toEqual([]);
        expect(
            upsertPairing(
                { computerId: COMPUTER, roomId: ROOM, computerKey: COMPUTER_KEY },
                new ThrowingStore(),
            ),
        ).toHaveLength(1);
        expect(loadPairings(null)).toEqual([]);
        saveActiveProject(projectId, new ThrowingStore());
        expect(loadActiveProject(new ThrowingStore())).toBeNull();
    });
});

describe('device id', () => {
    test('is generated once and reused', () => {
        const store = new MemoryStore();
        const id = getDeviceId(store);
        expect(id).toMatch(/^web-[a-z0-9]{16}$/);
        expect(getDeviceId(store)).toBe(id);
    });

    test('never uses the reserved daemon prefix and survives broken storage', () => {
        const store = new MemoryStore();
        store.setItem('palmtop.deviceId', 'palmtop-daemon');
        expect(getDeviceId(store)).toStartWith('web-');
        expect(getDeviceId(new ThrowingStore())).toStartWith('web-');
    });

    test('works without crypto.randomUUID (insecure context)', () => {
        const original = globalThis.crypto.randomUUID;
        Object.defineProperty(globalThis.crypto, 'randomUUID', {
            value: undefined,
            configurable: true,
        });
        try {
            expect(getDeviceId(new MemoryStore())).toMatch(/^web-[a-z0-9]{16}$/);
        } finally {
            Object.defineProperty(globalThis.crypto, 'randomUUID', {
                value: original,
                configurable: true,
            });
        }
    });
});

describe('secure-context features', () => {
    test('the manifest is only added in a secure context', () => {
        const fake = (secure: boolean) =>
            ({ isSecureContext: secure, document }) as unknown as Window;
        document.head.innerHTML = '';
        expect(enableSecureContextFeatures(fake(false))).toEqual({ manifest: false });
        expect(document.querySelector('link[rel="manifest"]')).toBeNull();
        expect(enableSecureContextFeatures(fake(true))).toEqual({ manifest: true });
        enableSecureContextFeatures(fake(true));
        expect(document.querySelectorAll('link[rel="manifest"]')).toHaveLength(1);
    });
});

describe('socket url', () => {
    test('uses the page host (the relay), ws/wss, the room and the stats id', () => {
        const stats = 'abcdefgh12345678';
        expect(deviceSocketUrl({ protocol: 'http:', host: '127.0.0.1:8787' }, ROOM, stats)).toBe(
            `ws://127.0.0.1:8787/ws?room=${ROOM}&d=${stats}`,
        );
        expect(deviceSocketUrl({ protocol: 'https:', host: 'relay.example' }, ROOM, stats)).toBe(
            `wss://relay.example/ws?room=${ROOM}&d=${stats}`,
        );
    });
});

describe('stats id', () => {
    test('is random, stored once and separate from the device id', () => {
        const store = new MemoryStore();
        const id = getStatsId(store);
        expect(id).toMatch(/^[a-z0-9]{16}$/);
        expect(getStatsId(store)).toBe(id);
        expect(getDeviceId(store)).not.toContain(id);
        expect(getStatsId(new MemoryStore())).not.toBe(id);
        expect(getStatsId(new ThrowingStore())).toMatch(/^[a-z0-9]{16}$/);
    });
});

describe('session auto-follow', () => {
    const session = (id: string, lastActivityAt: number): Session => ({
        id,
        projectId: 'p',
        title: id,
        startedAt: 0,
        lastActivityAt,
    });
    const byActivity = (...sessions: Session[]) =>
        [...sessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt);

    test('follows the session with the latest activity', () => {
        let state = followReducer(initialFollowState, {
            type: 'sessions',
            sessions: byActivity(session('a', 1)),
        });
        expect(state).toEqual({ follow: true, selectedSessionId: 'a' });
        state = followReducer(state, {
            type: 'sessions',
            sessions: byActivity(session('a', 1), session('b', 2)),
        });
        expect(state.selectedSessionId).toBe('b');
    });

    test('a manual selection pauses following until it is turned back on', () => {
        const sessions = byActivity(session('a', 1), session('b', 2));
        let state = followReducer(initialFollowState, { type: 'sessions', sessions });
        state = followReducer(state, { type: 'select', sessionId: 'a', sessions });
        expect(state).toEqual({ follow: false, selectedSessionId: 'a' });

        const busier = byActivity(session('a', 1), session('b', 2), session('c', 3));
        state = followReducer(state, { type: 'sessions', sessions: busier });
        expect(state.selectedSessionId).toBe('a');

        state = followReducer(state, { type: 'follow', sessions: busier });
        expect(state).toEqual({ follow: true, selectedSessionId: 'c' });
    });

    test('unchanged input returns the same state object; unknown selections are ignored', () => {
        const sessions = byActivity(session('a', 1));
        const state = followReducer(initialFollowState, { type: 'sessions', sessions });
        expect(followReducer(state, { type: 'sessions', sessions })).toBe(state);
        expect(followReducer(state, { type: 'select', sessionId: 'ghost', sessions })).toBe(state);
    });
});

describe('last synced', () => {
    test('minutes and hours, then the date', () => {
        const now = Date.UTC(2026, 8, 22, 12, 0);
        expect(formatSyncedAt(now - 20_000, now)).toBe('just now');
        // A clock that went back does not show a negative time.
        expect(formatSyncedAt(now + 60_000, now)).toBe('just now');
        expect(formatSyncedAt(now - 5 * 60_000, now)).toBe('5 min ago');
        expect(formatSyncedAt(now - 3 * 3_600_000 - 1, now)).toBe('3 h ago');
        expect(formatSyncedAt(now - 2 * 86_400_000, now)).toMatch(/^on .*20/);
    });
});

describe('class names', () => {
    test('the later Tailwind class wins over a conflicting one', () => {
        expect(cn('px-2 text-sm', false && 'hidden', 'px-4')).toBe('text-sm px-4');
    });
});

describe('status bar color under a sheet', () => {
    test('darkens like a black layer and puts the colors back', () => {
        expect(dimColor('#f7f7f8', 0.5)).toBe('#7c7c7c');
        expect(dimColor('#0b0d12', 0.5)).toBe('#060709');
        expect(dimColor('not a color', 0.5)).toBe('not a color');

        document.head.innerHTML =
            '<meta name="theme-color" content="#f7f7f8" media="(prefers-color-scheme: light)">' +
            '<meta name="theme-color" content="#0b0d12" media="(prefers-color-scheme: dark)">';
        const colors = () =>
            [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map(
                (meta) => meta.content,
            );
        const restore = dimThemeColor(document, 0.5);
        expect(colors()).toEqual(['#7c7c7c', '#060709']);
        restore();
        expect(colors()).toEqual(['#f7f7f8', '#0b0d12']);
        document.head.innerHTML = '';
    });
});

describe('feedback', () => {
    test('posts JSON to /feedback and maps the answer', async () => {
        const feedback = { type: 'bug' as const, message: 'x', email: 'a@b.co', page: '/app/' };
        const requests: Array<{ url: string; init: RequestInit }> = [];
        const answer = (status: number) => async (url: string, init: RequestInit) => {
            requests.push({ url, init });
            return new Response('{}', { status });
        };
        expect(await sendFeedback(feedback, answer(201))).toBe('sent');
        expect(requests[0]).toMatchObject({ url: '/feedback', init: { method: 'POST' } });
        expect(JSON.parse(String(requests[0]?.init.body))).toEqual(feedback);
        expect(await sendFeedback(feedback, answer(429))).toBe('rate_limited');
        expect(await sendFeedback(feedback, answer(400))).toBe('invalid');
        expect(await sendFeedback(feedback, answer(502))).toBe('error');
        expect(
            await sendFeedback(feedback, async () => {
                throw new TypeError('offline');
            }),
        ).toBe('network');
    });

    test('the email is remembered on this device, broken storage included', () => {
        const store = new MemoryStore();
        expect(loadFeedbackEmail(store)).toBe('');
        saveFeedbackEmail('a@b.co', store);
        expect(loadFeedbackEmail(store)).toBe('a@b.co');
        expect(loadFeedbackEmail(new ThrowingStore())).toBe('');
        saveFeedbackEmail('a@b.co', new ThrowingStore());
    });
});

describe('install', () => {
    const fakeWindow = (options: {
        userAgent?: string;
        platform?: string;
        maxTouchPoints?: number;
        standaloneQuery?: boolean;
        navigatorStandalone?: boolean;
    }) =>
        ({
            matchMedia: (query: string) => ({
                matches: query === '(display-mode: standalone)' && Boolean(options.standaloneQuery),
            }),
            navigator: {
                userAgent: options.userAgent ?? '',
                platform: options.platform ?? '',
                maxTouchPoints: options.maxTouchPoints ?? 0,
                ...(options.navigatorStandalone !== undefined && {
                    standalone: options.navigatorStandalone,
                }),
            },
        }) as unknown as Window;

    test('installed: display-mode standalone, or the iOS navigator.standalone', () => {
        expect(isInstalled(fakeWindow({}))).toBe(false);
        expect(isInstalled(fakeWindow({ standaloneQuery: true }))).toBe(true);
        expect(isInstalled(fakeWindow({ navigatorStandalone: true }))).toBe(true);
        expect(isInstalled(fakeWindow({ navigatorStandalone: false }))).toBe(false);
    });

    test('platform: iPhone, iPad as a Mac with touch, Android, the rest', () => {
        expect(
            devicePlatform(fakeWindow({ userAgent: 'Mozilla (iPhone; CPU iPhone OS 18_0)' })),
        ).toBe('ios');
        expect(devicePlatform(fakeWindow({ platform: 'MacIntel', maxTouchPoints: 5 }))).toBe('ios');
        expect(devicePlatform(fakeWindow({ platform: 'MacIntel' }))).toBe('other');
        expect(devicePlatform(fakeWindow({ userAgent: 'Mozilla (Linux; Android 15)' }))).toBe(
            'android',
        );
    });

    test('the waiting room is on the host that served the app', () => {
        expect(waitSocketUrl({ protocol: 'https:', host: 'palmtop.example' })).toBe(
            'wss://palmtop.example/wait',
        );
        expect(waitSocketUrl({ protocol: 'http:', host: '127.0.0.1:8787' })).toBe(
            'ws://127.0.0.1:8787/wait',
        );
    });
});

describe('install prompt timing', () => {
    const base = { installed: false, platform: 'ios' as const, paired: true, now: 1_000_000 };

    test('first time two minutes after the first pairing, then 30 s after every opening', () => {
        expect(installPromptDelay({ ...base, state: null })).toBe(FIRST_INSTALL_PROMPT_MS);
        const state = { pairedAt: base.now - 60_000, never: false };
        expect(installPromptDelay({ ...base, state })).toBe(FIRST_INSTALL_PROMPT_MS - 60_000);
        const later = { pairedAt: base.now - 3_600_000, never: false };
        expect(installPromptDelay({ ...base, state: later })).toBe(INSTALL_PROMPT_MS);
        expect(installPromptDelay({ ...base, platform: 'android', state: later })).toBe(
            INSTALL_PROMPT_MS,
        );
    });

    test('never when installed, on a computer, without a pairing or after "Don\'t show again"', () => {
        const state = { pairedAt: 0, never: false };
        expect(installPromptDelay({ ...base, installed: true, state })).toBeNull();
        expect(installPromptDelay({ ...base, platform: 'other', state })).toBeNull();
        expect(installPromptDelay({ ...base, paired: false, state })).toBeNull();
        expect(installPromptDelay({ ...base, state: { pairedAt: 0, never: true } })).toBeNull();
    });

    test('the choice is kept in this browser', () => {
        expect(loadInstallPrompt()).toBeNull();
        saveInstallPrompt({ pairedAt: 5, never: true });
        expect(loadInstallPrompt()).toEqual({ pairedAt: 5, never: true });
        localStorage.clear();
    });
});

describe('device name', () => {
    test('the kind of device and the browser, nothing more precise', () => {
        const cases: Array<[string, number, string]> = [
            [
                'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
                5,
                'iPhone · Safari',
            ],
            [
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
                5,
                'iPad · Safari',
            ],
            [
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
                0,
                'Mac · Safari',
            ],
            [
                'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
                5,
                'Android · Chrome',
            ],
            [
                'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1',
                5,
                'iPhone · Chrome',
            ],
            [
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
                0,
                'Windows · Edge',
            ],
            [
                'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
                0,
                'Linux · Firefox',
            ],
            ['', 0, 'Device · Browser'],
        ];
        for (const [userAgent, touchPoints, name] of cases) {
            expect(deviceName(userAgent, touchPoints)).toBe(name);
        }
    });
});

describe('finished lists last', () => {
    const checks = (name: string, ...statuses: Array<'done' | undefined>) => ({
        name,
        checklist: { kind: 'checks' as const },
        items: statuses.map((status, i) => ({ id: `${name}${i}`, ...(status && { status }) })),
    });
    const question = (name: string, ...statuses: Array<'done' | undefined>) => ({
        ...checks(name, ...statuses),
        checklist: { kind: 'choice' as const },
    });
    const names = (lists: Array<{ name: string }>) => lists.map((list) => list.name);

    test('an answered question and a list with every check marked go last; an empty one stays', () => {
        const lists = [
            checks('done', 'done', 'done'),
            question('answered', 'done', undefined),
            checks('empty'),
            question('open', undefined, undefined),
            checks('half', 'done', undefined),
        ];
        expect(names(completeListsLast(lists, () => false))).toEqual([
            'empty',
            'open',
            'half',
            'done',
            'answered',
        ]);
    });

    test('a list whose item is still counting down stays where it is', () => {
        const lists = [checks('done', 'done'), checks('open', undefined)];
        expect(names(completeListsLast(lists, (id) => id === 'done0'))).toEqual(['done', 'open']);
        expect(names(completeListsLast(lists, () => false))).toEqual(['open', 'done']);
    });
});

describe('splitLinks', () => {
    const links = (text: string) =>
        splitLinks(text)
            .filter((part) => part.url !== undefined)
            .map((part) => part.url);

    test('a text without addresses is a single plain part', () => {
        expect(splitLinks('nothing to open')).toEqual([{ text: 'nothing to open', offset: 0 }]);
        expect(splitLinks('')).toEqual([]);
        expect(hasLinks('nothing to open')).toBe(false);
    });

    test('an address in a sentence is cut out with the text around it', () => {
        expect(splitLinks('Check https://example.com/a?b=1 please')).toEqual([
            { text: 'Check ', offset: 0 },
            { text: 'https://example.com/a?b=1', url: 'https://example.com/a?b=1', offset: 6 },
            { text: ' please', offset: 31 },
        ]);
        expect(hasLinks('see http://localhost:3000/x')).toBe(true);
    });

    test('punctuation that ends the sentence is not part of the address', () => {
        expect(links('Open https://example.com/page.')).toEqual(['https://example.com/page']);
        expect(links('(see https://example.com/page)')).toEqual(['https://example.com/page']);
        expect(links('is it https://example.com/page?')).toEqual(['https://example.com/page']);
        expect(links('https://example.com/a, https://example.com/b;')).toEqual([
            'https://example.com/a',
            'https://example.com/b',
        ]);
    });

    test('quotes around an address, straight or typographic, are not part of it', () => {
        expect(links('«vedi https://example.com/a.»')).toEqual(['https://example.com/a']);
        expect(links('“https://example.com/a”')).toEqual(['https://example.com/a']);
        expect(links('"https://example.com/a",')).toEqual(['https://example.com/a']);
        expect(links('‘https://example.com/a’.')).toEqual(['https://example.com/a']);
        expect(links('https://example.com/a…')).toEqual(['https://example.com/a']);
    });

    test('a bracket that was opened inside the address stays', () => {
        expect(links('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual([
            'https://en.wikipedia.org/wiki/Foo_(bar)',
        ]);
        expect(links('(https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual([
            'https://en.wikipedia.org/wiki/Foo_(bar)',
        ]);
    });

    test('a domain without a scheme is a link too, opened with https://', () => {
        expect(splitLinks('Open vicoverde.it now')).toEqual([
            { text: 'Open ', offset: 0 },
            { text: 'vicoverde.it', url: 'https://vicoverde.it', offset: 5 },
            { text: ' now', offset: 17 },
        ]);
        expect(links('www.mtwa.it')).toEqual(['https://www.mtwa.it']);
        expect(links('see mtwa.it/page?x=1#top, and Example.COM.')).toEqual([
            'https://mtwa.it/page?x=1#top',
            'https://Example.COM',
        ]);
        expect(links('shop.example.co.uk:8080/a')).toEqual(['https://shop.example.co.uk:8080/a']);
        expect(links('(mtwa.it)')).toEqual(['https://mtwa.it']);
        expect(links('«mtwa.it»')).toEqual(['https://mtwa.it']);
    });

    test('a domain inside something else is not a link of its own', () => {
        expect(links('mario@example.com')).toEqual([]);
        expect(links('ftp://example.com/file')).toEqual([]);
        expect(links('/usr/local/example.com')).toEqual([]);
        expect(links('a.b.example.com/x and https://c.it')).toEqual([
            'https://a.b.example.com/x',
            'https://c.it',
        ]);
    });

    test('the file names of code and numbers are not domains', () => {
        expect(links('Update README.md, main.py, install.sh, lib.rs and a.pl')).toEqual([]);
        expect(links('Node.js, Next.js and user.name')).toEqual([]);
        expect(links('version 1.2.3 costs 3.50 e.g. i.e.')).toEqual([]);
        expect(links('app.ts and index.html and styles.css')).toEqual([]);
    });

    test('only web addresses are links', () => {
        expect(links('javascript:alert(1)')).toEqual([]);
        expect(links('data:text/html,<b>x</b>')).toEqual([]);
        expect(links('ftp://example.com/file')).toEqual([]);
        expect(links('http:// and https://')).toEqual([]);
        expect(links('[click](https://example.com)')).toEqual(['https://example.com']);
    });
});

describe('screenshots, before they are sent', () => {
    test('a picture is shrunk to fit the longer side, never enlarged', () => {
        expect(fitWithin(3200, 1600, MAX_SIDE)).toEqual({ width: 1600, height: 800 });
        expect(fitWithin(1000, 3000, 1500)).toEqual({ width: 500, height: 1500 });
        expect(fitWithin(800, 600, MAX_SIDE)).toEqual({ width: 800, height: 600 });
        expect(fitWithin(1, 5000, 1600)).toEqual({ width: 1, height: 1600 });
    });

    /** A codec whose pictures are `width * height * quality / 20` bytes: smaller means lighter. */
    const codec = (
        size = { width: 4000, height: 2000 },
        tried: Array<[number, number, number]> = [],
    ): ScreenshotCodec => ({
        decode: async () => size,
        encode: async (width, height, quality) => {
            tried.push([width, height, quality]);
            return new Uint8Array(Math.round((width * height * quality) / 20));
        },
    });

    test('a small picture is taken as it is, at the best quality', async () => {
        const tried: Array<[number, number, number]> = [];
        const prepared = await prepareScreenshot(
            new Blob(['x']),
            codec({ width: 400, height: 300 }, tried),
            140_000,
        );
        expect(prepared.mime).toBe('image/jpeg');
        expect(tried).toEqual([[400, 300, 0.82]]);
    });

    test('a big one comes down in quality, then in size, until it fits', async () => {
        const tried: Array<[number, number, number]> = [];
        const prepared = await prepareScreenshot(
            new Blob(['x']),
            codec({ width: 4000, height: 2000 }, tried),
            10_000,
        );
        expect(prepared.bytes.length).toBeLessThanOrEqual(10_000);
        expect(tried.at(-1)?.[0]).toBeLessThan(1600);
        // It never exceeds the longest side, and it tried the better qualities before shrinking.
        expect(tried[0]).toEqual([1600, 800, 0.82]);
        expect(tried.slice(0, 4).map((entry) => entry[2])).toEqual([0.82, 0.7, 0.58, 0.46]);
        expect(Math.max(...tried.map((entry) => entry[0]))).toBeLessThanOrEqual(MAX_SIDE);
    });

    test('a picture that cannot be read, or cannot be made small enough, says so', async () => {
        const unreadable: ScreenshotCodec = {
            decode: async () => {
                throw new Error('not an image');
            },
            encode: async () => new Uint8Array(),
        };
        await expect(prepareScreenshot(new Blob(['x']), unreadable)).rejects.toThrow(
            ScreenshotError,
        );
        const heavy: ScreenshotCodec = {
            decode: async () => ({ width: 4000, height: 3000 }),
            encode: async () => new Uint8Array(1_000_000),
        };
        await expect(prepareScreenshot(new Blob(['x']), heavy, 140_000)).rejects.toThrow(
            /too detailed/,
        );
        const broken: ScreenshotCodec = {
            decode: async () => ({ width: 10, height: 10 }),
            encode: async () => {
                throw new Error('no JPEG');
            },
        };
        await expect(prepareScreenshot(new Blob(['x']), broken)).rejects.toThrow(
            /could not prepare/,
        );
    });
});

describe('the screenshots this device keeps', () => {
    const [named, inShare, queued, stale] = [createId(), createId(), createId(), createId()];
    const token = (id: string) => `[screenshot:${id}]`;

    test('the ones a note names stay, and the rest go, however the note is held', async () => {
        const projectId = createId();
        const sessionId = createId();
        const op = (type: string, payload: object, lamport: number) =>
            createOp({
                projectId,
                sessionId,
                type,
                payload,
                clock: { lamport, deviceId: 'phone' },
            } as never);
        const state = applyAll(createProjectState(projectId), [
            op('session.upsert', { title: 't', branch: 'b', startedAt: 1 }, 1),
            op('session.note', { note: `- a\n  ${token(named)}` }, 2),
        ] as never);
        const kept: string[][] = [];
        const cache = {
            projectIds: async () => [projectId],
            load: async () => ({
                projectId,
                project: null,
                state,
                seq: 1,
                syncedAt: 1,
                shares: [
                    {
                        sessionId,
                        people: [
                            {
                                name: 'Mario',
                                state: 'open',
                                expiresAt: 5,
                                checklists: [],
                                items: { [createId()]: { status: 'done', note: token(inShare) } },
                            },
                        ],
                    },
                ],
                pending: [op('session.note', { note: token(queued) }, 3)],
            }),
            pruneImages: async (keep: ReadonlySet<string>) => {
                kept.push([...keep].sort());
            },
        };
        await pruneCachedImages(cache as never);
        expect(kept).toEqual([[named, inShare, queued].sort()]);
        expect(kept[0]).not.toContain(stale);
    });

    test('a cache that cannot be read keeps everything, and one without screenshots is left alone', async () => {
        let pruned = false;
        await pruneCachedImages({
            projectIds: async () => {
                throw new Error('blocked');
            },
            pruneImages: async () => {
                pruned = true;
            },
        } as never);
        expect(pruned).toBe(false);
        await pruneCachedImages({ projectIds: async () => [] } as never);
    });
});

describe('markdown', () => {
    const kinds = (text: string) => parseInline(text).map((node) => node.kind);

    test('plain text stays plain, and addresses are still links', () => {
        expect(parseInline('Wrong password shows an error')).toEqual([
            { kind: 'text', text: 'Wrong password shows an error' },
        ]);
        expect(kinds('Open https://example.com/a now')).toEqual(['text', 'link', 'text']);
    });

    test('bold, italic and code', () => {
        expect(kinds('a **b** c *d* e `f`')).toEqual([
            'text',
            'bold',
            'text',
            'italic',
            'text',
            'code',
        ]);
        expect(parseInline('`a *b* https://example.com`')).toEqual([
            { kind: 'code', text: 'a *b* https://example.com' },
        ]);
    });

    test('a marker that is never closed, or has a space inside, is the character', () => {
        expect(parseInline('2 * 3 * 4')).toEqual([{ kind: 'text', text: '2 * 3 * 4' }]);
        expect(parseInline('**open')).toEqual([{ kind: 'text', text: '**open' }]);
        expect(parseInline('a `open')).toEqual([{ kind: 'text', text: 'a `open' }]);
        expect(parseInline('snake_case_name and _x_')).toEqual([
            { kind: 'text', text: 'snake_case_name and _x_' },
        ]);
    });

    test('[text](address) is a link only for an http(s) address', () => {
        expect(parseInline('[notes](https://example.com/n)')).toEqual([
            {
                kind: 'link',
                text: 'notes',
                url: 'https://example.com/n',
                label: true,
                host: 'example.com',
            },
        ]);
        for (const bad of [
            '[x](javascript:alert(1))',
            '[x](data:text/html,hi)',
            '[x](ftp://example.com)',
            '[x]( https://example.com)',
            '[](https://example.com)',
        ]) {
            expect(parseInline(bad).some((node) => node.kind === 'link' && node.label)).toBe(false);
        }
    });

    test('HTML and images are not markup', () => {
        expect(parseInline('<b>x</b> <script>y</script>')).toEqual([
            { kind: 'text', text: '<b>x</b> <script>y</script>' },
        ]);
        // An image is not an image and not a labelled link: the characters stay as typed.
        const image = parseInline('![alt](https://example.com/a.png)');
        expect(image.some((node) => node.kind === 'link' && node.label)).toBe(false);
        expect(plainTitle('![alt](https://example.com/a.png)')).toBe(
            '![alt](https://example.com/a.png)',
        );
        expect(parseMarkdown('# Title')).toEqual([
            { kind: 'paragraph', children: [{ kind: 'text', text: '# Title' }] },
        ]);
    });

    test('blocks: paragraphs with breaks, lists and code', () => {
        const blocks = parseMarkdown(
            'First\nsecond line\n\n- one\n- two\n  more\n\n1. a\n2. b\n\n```sh\nls -la\n\nexit\n```\nafter',
        );
        expect(blocks.map((block) => block.kind)).toEqual([
            'paragraph',
            'list',
            'list',
            'code',
            'paragraph',
        ]);
        expect(blocks[0]).toEqual({
            kind: 'paragraph',
            children: [
                { kind: 'text', text: 'First' },
                { kind: 'break' },
                { kind: 'text', text: 'second line' },
            ],
        });
        expect(blocks[1]).toMatchObject({
            ordered: false,
            items: [expect.any(Array), expect.any(Array)],
        });
        expect(blocks[2]).toMatchObject({ ordered: true, start: 1 });
        expect(blocks[3]).toEqual({ kind: 'code', text: 'ls -la\n\nexit' });
    });

    test('a code block that is never closed runs to the end, and an empty one is dropped', () => {
        expect(parseMarkdown('```\nrm -rf build')).toEqual([
            { kind: 'code', text: 'rm -rf build' },
        ]);
        expect(parseMarkdown('```\n```')).toEqual([]);
        expect(parseMarkdown('')).toEqual([]);
    });

    test('markdown inside a code block is code', () => {
        expect(parseMarkdown('```\n**a** - b\n```')).toEqual([{ kind: 'code', text: '**a** - b' }]);
    });

    test('the title is the first line; a text that opens with code has none', () => {
        expect(splitTitle('Only a title')).toEqual({ title: 'Only a title', rest: '' });
        expect(splitTitle('Title\n\nMore\nlines')).toEqual({
            title: 'Title',
            rest: '\nMore\nlines',
        });
        expect(splitTitle('```\nls\n```').title).toBe('');
        expect(plainTitle('Run `bun test` **now**\nrest')).toBe('Run bun test now');
    });
});
