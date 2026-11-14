import {
    type ComputerInfo,
    DAEMON_PROTOCOL_VERSION,
    isReservedDeviceId,
    namedScreenshots,
    type ProjectSummary,
    type SeqOp,
    summarizeProject,
} from '@palmtopai/protocol';
import { DEFAULT_WAIT_HOLD_MS } from './agent-api';
import { BUILD_INFO } from './build-info';
import {
    appWebUrl,
    DEFAULT_RELAY_URL,
    defaultComputerName,
    loadConfig,
    pathsFor,
    relayWebUrl,
    resolveHome,
    resolveRelayUrl,
    saveComputerName,
    saveOwnerName,
} from './config';
import { DeviceHub } from './device-hub';
import { DeviceRegistry, type RegisteredDevice } from './device-registry';
import { DoneDeliveries, DoneWaiters } from './done-delivery';
import { ensurePrivateDir } from './fs-utils';
import { GuestRooms } from './guest-rooms';
import { resetOutdatedHome } from './home-reset';
import { GUEST_IMAGE_LIMITS, ImageStore } from './images';
import { type LocalApi, type PairLink, startLocalApi } from './local-api';
import { NoteDeliveries } from './note-delivery';
import { PairingCodes, PairingConfirmations, PairKeys } from './pairing';
import type { InviteResult, PersonView } from './people-api';
import { PeopleStore } from './people-store';
import { PushNotifier, type PushSender, webPushSender } from './push-notifier';
import { PushStore } from './push-store';
import { ProjectRegistry } from './registry';
import { RelayLink } from './relay-link';
import { RoomManager } from './rooms';
import { loadOrCreateLocalKey } from './secrets';
import { Sharing } from './sharing';
import { JsonStorage } from './storage/json-storage';

/** The answers of the people go to the owner's devices once in this window. */
const SHARES_DEBOUNCE_MS = 300;

export interface DaemonOptions {
    /** Defaults to `PALMTOP_HOME` or `~/.palmtopai`. */
    home?: string;
    /** Override `config.json`; `0` picks a free port (tests). */
    localPort?: number;
    /** Override `PALMTOP_RELAY_URL` and `config.json`. */
    relayUrl?: string;
    helloTimeoutMs?: number;
    /** Largest message sent to a device (tests; defaults to the relay's limit). */
    maxDeviceMessageBytes?: number;
    /** How long a silent device still counts as on screen for notifications (tests). */
    presenceTimeoutMs?: number;
    snapshotEvery?: number;
    pairingCodeTtlMs?: number;
    pairKeyTtlMs?: number;
    /** How long activity is coalesced before the project list is sent again (default 1 s). */
    projectsDebounceMs?: number;
    relayReconnectDelayMs?: { min: number; max: number };
    /** How long a request of `palmtop wait` holds before it answers `pending` (tests). */
    waitHoldMs?: number;
    /** Replaces `web-push` (tests). */
    pushSender?: PushSender;
    pushDelayMs?: number;
    /** Windows: set the ACL of the home (default). Tests turn it off: it runs two programs. */
    restrictHome?: boolean;
    /** Called by `POST /shutdown` (`palmtop stop`); `palmtop serve` stops the daemon cleanly. */
    onShutdown?: () => void;
    log?: (line: string) => void;
}

export interface Daemon {
    home: string;
    localPort: number;
    relayUrl: string;
    registry: ProjectRegistry;
    rooms: RoomManager;
    devices: DeviceHub;
    /** Paired devices and their public keys. */
    paired: DeviceRegistry;
    /** The people checklists are shared with. */
    people: PeopleStore;
    sharing: Sharing;
    /** Their rooms at the relay, and what their devices see. */
    guestRooms: GuestRooms;
    relay: RelayLink;
    push: PushStore;
    /** The requests of `palmtop wait` that are holding for a done. */
    doneWaiters: DoneWaiters;
    removeProject(projectId: string): Promise<void>;
    readonly computerName: string;
    /** Saves the computer name (`null`: back to the host name) and tells connected devices. */
    setComputerName(name: string | null): Promise<string>;
    /** Saves the name the copies give their owner (`null`: none) and tells the people. */
    setOwnerName(name: string | null): Promise<string | null>;
    stop(): Promise<void>;
}

/**
 * Starts the daemon: the Local API for the CLI on 127.0.0.1 and an outbound connection to the
 * relay for phones. Nothing listens on other interfaces.
 */
export async function startDaemon(options: DaemonOptions = {}): Promise<Daemon> {
    const home = options.home ?? resolveHome();
    const paths = pathsFor(home);
    const log = options.log ?? ((line: string) => console.error(`[palmtop] ${line}`));

    // Windows: the home is limited to the user once (the CLI usually does it first).
    const homeAcl = await ensurePrivateDir(
        home,
        options.restrictHome === false ? {} : { marker: paths.acl },
    );
    if (homeAcl.aclError) log(`could not limit ${home} to your Windows user: ${homeAcl.aclError}`);
    await resetOutdatedHome(paths, log);
    await ensurePrivateDir(paths.data);
    const config = await loadConfig(paths.config);
    const relayUrl = options.relayUrl ?? resolveRelayUrl();
    const key = await loadOrCreateLocalKey(paths.localKey);
    const storage = new JsonStorage(paths.data);
    const registry = await ProjectRegistry.open(paths.projects, storage);
    let computerName = config.computerName ?? defaultComputerName();
    let ownerName: string | undefined = config.ownerName;
    const push = await PushStore.open(paths.push);
    const paired = await DeviceRegistry.open(paths.devices);
    const people = await PeopleStore.open(paths.people);
    const noteDeliveries = await NoteDeliveries.open(paths.noteDelivered);
    const doneDeliveries = await DoneDeliveries.open(paths.doneDelivered);
    const doneWaiters = new DoneWaiters({
        graceMs: (options.waitHoldMs ?? DEFAULT_WAIT_HOLD_MS) + 10_000,
    });
    /** The sessions of a project an agent waits in, as the devices are told. */
    const waitingMessage = (projectId: string) => ({
        type: 'waiting' as const,
        projectId,
        sessionIds: doneWaiters.waitingIn(projectId),
    });
    doneWaiters.onChange((projectId) => devices.publish(projectId, waitingMessage(projectId)));
    const images = new ImageStore(paths.images);
    const guestPush = await PushStore.open(paths.pushGuests);

    const pairKeyTtl = options.pairKeyTtlMs !== undefined ? { ttlMs: options.pairKeyTtlMs } : {};
    const pairKeys = new PairKeys(pairKeyTtl);
    const confirmations = new PairingConfirmations(pairKeyTtl);

    const rooms = new RoomManager(storage, {
        ...(options.snapshotEvery !== undefined && { snapshotEvery: options.snapshotEvery }),
        onApplied: (projectId, entry) => {
            devices.publish(projectId, { type: 'op', ...entry });
            notifier.observe(projectId, entry);
            guestRooms.publish(projectId, { type: 'op', ...entry });
            guestNotifier.observe(projectId, entry);
            onAgentNews(projectId, entry);
            // A done, or a session that goes, ends the wait of the agent on that session.
            if (entry.op.type === 'session.done' || entry.op.type === 'session.remove') {
                doneWaiters.notify();
            }
            // A person who finishes reviewing their copy is told to the owner, never to the agent.
            if (entry.op.type === 'session.done' && entry.op.payload.done) {
                announceGuestDone(projectId, entry);
            }
            // What a person answers on their copy shows on the devices following the original.
            const copy = people.share(projectId);
            if (copy) scheduleShares(copy.sourceProjectId);
            // The copies shared with other people go with the session they come from, and so
            // does what is known of the notes the agent read.
            if (entry.op.type === 'session.remove') {
                images.removeSession(projectId, entry.op.sessionId).catch((error: unknown) => {
                    log(`screenshots not removed with their session: ${(error as Error).message}`);
                });
                doneDeliveries
                    .removeSession(projectId, entry.op.sessionId)
                    .catch((error: unknown) => {
                        log(
                            `done records not removed with their session: ${(error as Error).message}`,
                        );
                    });
                noteDeliveries
                    .removeSession(projectId, entry.op.sessionId)
                    .catch((error: unknown) => {
                        log(
                            `note records not removed with their session: ${(error as Error).message}`,
                        );
                    });
                sharing.dropSession(projectId, entry.op.sessionId).catch((error: unknown) => {
                    log(`copies not removed with their session: ${(error as Error).message}`);
                });
            }
            // Activity moves a project up the list on every device: often, so not on every op.
            scheduleProjectsBroadcast();
        },
        // Only the projects of this computer carry its name. A copy shared with someone carries
        // the name its owner chose for it, and anything else none: they must not learn the name
        // of the computer.
        sharedUntil: (projectId) => people.share(projectId)?.expiresAt,
        computerName: (projectId) =>
            registry.has(projectId)
                ? computerName
                : people.isShareProject(projectId)
                  ? guestRooms.ownerNameOf(projectId)
                  : undefined,
        log,
    });

    /**
     * What the agent writes in a session devices are notified of (a checklist, items, a message)
     * takes it out of the archive, on every device. Anything new it writes for the user to look
     * at, an edited item included, takes the done back: there is something to review again.
     */
    const onAgentNews = (projectId: string, { op }: SeqOp) => {
        if (!isReservedDeviceId(op.clock.deviceId)) return;
        const unarchive =
            op.type === 'checklist.create' ||
            op.type === 'item.add' ||
            (op.type === 'session.message' && op.payload.message !== '');
        const reopen = unarchive || op.type === 'item.update';
        if (!reopen) return;
        void rooms
            .get(projectId)
            .then((room) =>
                room?.transact(async (tx) => {
                    const values = tx.state.sessions[op.sessionId]?.values;
                    if (unarchive && values?.archived) {
                        await tx.submit('session.archive', op.sessionId, { archived: false });
                    }
                    // A done written after the user saw this news (a later clock) is theirs: kept.
                    const doneStamp = tx.state.sessions[op.sessionId]?.clocks.done;
                    if (values?.done && doneStamp && doneStamp.lamport <= op.clock.lamport) {
                        await tx.submit('session.done', op.sessionId, { done: false });
                    }
                }),
            )
            .catch((error: unknown) => {
                log(`session not reopened: ${(error as Error).message}`);
            });
    };

    /** The owner's devices hear that a person marked their copy done (a push, and a mark in the app). */
    const announceGuestDone = (projectId: string, { op }: SeqOp) => {
        const share = people.share(projectId);
        if (!share || isReservedDeviceId(op.clock.deviceId)) return;
        const person = people.person(share.personId);
        if (!person) return;
        void rooms
            .get(projectId)
            .then((room) => {
                const title = room?.state.sessions[op.sessionId]?.values.title;
                return notifier.announce({
                    title: 'Palmtop',
                    body: `${person.name} finished reviewing${title ? ` · ${title}` : ''}`,
                    tag: `palmtop-done-${share.shareId}`,
                });
            })
            .catch((error: unknown) => log(`done notice not sent: ${(error as Error).message}`));
    };

    const sharing = new Sharing({
        people,
        rooms,
        storage,
        images,
        projectName: (projectId) => registry.info(projectId)?.name ?? null,
        beforeShare: (personId) => guestRooms.ensureRoom(personId),
        onChange: (personId, sourceProjectId) => {
            guestRooms.refresh(personId);
            if (sourceProjectId) scheduleShares(sourceProjectId);
        },
        onOwnerName: (shareId) => {
            guestRooms.republishProject(shareId).catch((error: unknown) => {
                log(`owner name not sent: ${(error as Error).message}`);
            });
        },
        log,
    });

    /** What every device sees of this computer: its projects, sorted by last activity. */
    const projectList = async (): Promise<{
        computer: ComputerInfo;
        projects: ProjectSummary[];
    }> => {
        const projects: ProjectSummary[] = [];
        for (const project of registry.list()) {
            const room = await rooms.get(project.projectId);
            const counts = room
                ? summarizeProject(room.state)
                : { lastActivityAt: 0, sessions: 0, pending: 0 };
            projects.push({ id: project.projectId, name: project.name, ...counts });
        }
        projects.sort(
            (a, b) => b.lastActivityAt - a.lastActivityAt || a.name.localeCompare(b.name),
        );
        return { computer: { id: registry.computerId, name: computerName }, projects };
    };

    const devices = new DeviceHub({
        scope: registry,
        devices: paired,
        rooms,
        projectList,
        syncExtras: async (projectId) => {
            const sessions = await sharing.ownerView(projectId);
            // Only what there is: a device knows an empty list from the protocol of the computer.
            const waiting = waitingMessage(projectId);
            return [
                ...(sessions.length > 0 ? [{ type: 'shares' as const, projectId, sessions }] : []),
                ...(waiting.sessionIds.length > 0 ? [waiting] : []),
            ];
        },
        removeProject: (projectId) => removeProject(projectId),
        images: {
            put: (...args) => images.put(...args),
            // What the people wrote on their copies of a project is shown with the project.
            read: async (projectId, imageId) => {
                const own = await images.read(projectId, imageId);
                if (own) return own;
                for (const share of people.sharesOfProject(projectId)) {
                    const found = await images.read(share.shareId, imageId);
                    if (found) return found;
                }
                return null;
            },
            sweep: (projectId, state) => images.sweep(projectId, namedScreenshots(state)),
        },
        push,
        pairKeys,
        confirmations,
        ...(options.helloTimeoutMs !== undefined && { helloTimeoutMs: options.helloTimeoutMs }),
        ...(options.presenceTimeoutMs !== undefined && {
            presenceTimeoutMs: options.presenceTimeoutMs,
        }),
        ...(options.maxDeviceMessageBytes !== undefined && {
            maxMessageBytes: options.maxDeviceMessageBytes,
        }),
        log,
    });

    // What the people answered goes to the owner's devices a moment after the last answer.
    const sharesTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const scheduleShares = (projectId: string) => {
        if (sharesTimers.has(projectId)) return;
        sharesTimers.set(
            projectId,
            setTimeout(() => {
                sharesTimers.delete(projectId);
                sharing
                    .ownerView(projectId)
                    .then((sessions) =>
                        devices.publish(projectId, { type: 'shares', projectId, sessions }),
                    )
                    .catch((error: unknown) =>
                        log(`answers not sent: ${(error as Error).message}`),
                    );
            }, SHARES_DEBOUNCE_MS),
        );
    };

    let projectsTimer: ReturnType<typeof setTimeout> | undefined;
    const broadcastProjects = () => {
        clearTimeout(projectsTimer);
        projectsTimer = undefined;
        devices.publishProjects().catch((error: unknown) => {
            log(`project list not sent: ${(error as Error).message}`);
        });
        guestRooms.publishProjects().catch((error: unknown) => {
            log(`project list of the guests not sent: ${(error as Error).message}`);
        });
    };
    /** Coalesces the activity of a busy session into one list update per second. */
    const scheduleProjectsBroadcast = () => {
        if (projectsTimer !== undefined) return;
        projectsTimer = setTimeout(broadcastProjects, options.projectsDebounceMs ?? 1_000);
    };
    // A project created by the agent shows up on the devices right away.
    registry.onCreated(() => broadcastProjects());
    const relay = new RelayLink({
        url: relayUrl,
        registry,
        hub: devices,
        log,
        ...(options.relayReconnectDelayMs && {
            minReconnectDelayMs: options.relayReconnectDelayMs.min,
            maxReconnectDelayMs: options.relayReconnectDelayMs.max,
        }),
    });

    const pushSender = options.pushSender ?? webPushSender(pushSubject(relayUrl));
    const notifier = new PushNotifier({
        store: push,
        sender: pushSender,
        projectLabel: (projectId) => {
            const info = registry.info(projectId);
            return info ? `${computerName} - ${info.name}` : null;
        },
        isVisible: (projectId, deviceId) => devices.isVisible(projectId, deviceId),
        ...(options.pushDelayMs !== undefined && { delayMs: options.pushDelayMs }),
        log,
    });

    // The people checklists are shared with hear of their copies, and of nothing else.
    const guestNotifier = new PushNotifier({
        store: guestPush,
        sender: pushSender,
        projectLabel: (projectId) =>
            people.isShareProject(projectId) ? guestRooms.ownerNameOf(projectId) : null,
        isVisible: (projectId, deviceId) => guestRooms.isVisible(projectId, deviceId),
        recipients: (projectId, deviceId) => guestRooms.isRecipient(projectId, deviceId),
        ...(options.pushDelayMs !== undefined && { delayMs: options.pushDelayMs }),
        log,
    });

    const guestRooms = new GuestRooms({
        people,
        rooms,
        relay,
        push: guestPush,
        ownerName: () => ownerName,
        closeShares: (personId) => sharing.closeAllOf(personId),
        images: {
            // A copy holds far less than a project of the computer.
            put: (projectId, sessionId, imageId, mime, bytes) =>
                images.put(projectId, sessionId, imageId, mime, bytes, GUEST_IMAGE_LIMITS),
            read: (projectId, imageId) => images.read(projectId, imageId),
            sweep: (projectId, state) => images.sweep(projectId, namedScreenshots(state)),
        },
        onJoin: (person, device) => {
            log(`${person.name} opened their invitation`);
            void notifier
                .announce({
                    title: 'Palmtop',
                    body: `${person.name} joined · ${device.name}`,
                    tag: `palmtop-joined-${person.personId}`,
                })
                .catch((error: unknown) =>
                    log(`join notice not sent: ${(error as Error).message}`),
                );
        },
        ...(options.helloTimeoutMs !== undefined && { helloTimeoutMs: options.helloTimeoutMs }),
        ...(options.presenceTimeoutMs !== undefined && {
            presenceTimeoutMs: options.presenceTimeoutMs,
        }),
        ...(options.maxDeviceMessageBytes !== undefined && {
            maxMessageBytes: options.maxDeviceMessageBytes,
        }),
        log,
    });

    /** Deletes a project: registry entry, room and data. Devices stay paired with the computer. */
    const removeProject = async (projectId: string) => {
        // Registry first: from here on the project can no longer be followed.
        await registry.remove(projectId);
        devices.clearProject(projectId);
        await sharing.dropProject(projectId);
        await rooms.discard(projectId);
        await storage.deleteProject(projectId);
        await noteDeliveries.removeProject(projectId);
        await doneDeliveries.removeProject(projectId);
        doneWaiters.notify();
        await images.removeProject(projectId);
        broadcastProjects();
        log(`project ${projectId} removed`);
    };

    const setComputerName = async (name: string | null) => {
        const saved = await saveComputerName(paths.config, name);
        computerName = saved ?? defaultComputerName();
        // Devices syncing from now on read the new name; the ones already connected are told.
        for (const room of await rooms.loaded()) {
            devices.publish(room.projectId, { type: 'project', project: room.project });
        }
        broadcastProjects();
        return computerName;
    };

    const setOwnerName = async (name: string | null) => {
        const saved = await saveOwnerName(paths.config, name);
        ownerName = saved ?? undefined;
        for (const share of people.shares()) {
            await guestRooms.republishProject(share.shareId).catch(() => undefined);
        }
        return saved;
    };

    const personView = (personId: string): PersonView => {
        const person = people.person(personId);
        if (!person) throw new Error('unknown person');
        const shares = people.shares().filter((share) => share.personId === personId);
        return {
            name: person.name,
            device: person.device
                ? {
                      name: person.device.name,
                      pairedAt: person.device.pairedAt,
                      lastSeenAt: person.device.lastSeenAt,
                      connected:
                          guestRooms.hubOf(personId)?.isConnected(person.device.deviceId) ?? false,
                  }
                : null,
            invitedUntil:
                person.invite && person.invite.expiresAt > Date.now()
                    ? person.invite.expiresAt
                    : null,
            copies: {
                open: shares.filter((share) => share.closedAt === null).length,
                total: shares.length,
            },
        };
    };

    /** A fresh single-use pairing link: the QR, the terminal and the pairing page all use one. */
    const pairLink = (): PairLink => {
        const { key, expiresAt } = pairKeys.create();
        return {
            url: pairUrl(appWebUrl(relayUrl), { roomId: registry.roomId, key }),
            key,
            expiresAt,
            computerName,
            relayHost: new URL(relayWebUrl(relayUrl)).host,
            ...(relay.status !== 'connected' && {
                warning: `This computer is not connected to the relay (${relayUrl}) right now: devices can pair, but they will show "PC offline" until it connects.`,
            }),
        };
    };

    const localApi: LocalApi = await startLocalApi({
        port: options.localPort ?? config.localPort,
        key,
        ...(options.onShutdown && { shutdown: options.onShutdown }),
        registry,
        rooms,
        connectedDevices: (projectId) => devices.connectedDevices(projectId),
        removeProject,
        sharing,
        noteDeliveries,
        doneDeliveries,
        doneWaiters,
        ...(options.waitHoldMs !== undefined && { waitHoldMs: options.waitHoldMs }),
        images,
        people: {
            list: () =>
                people
                    .people()
                    .filter((person) => !person.removedAt)
                    .map((person) => personView(person.personId)),
            invite: async (name, replace): Promise<InviteResult> => {
                const replaced = people.findPerson(name)?.device != null;
                const invite = await guestRooms.invite(name, { replace });
                return {
                    name: invite.person.name,
                    url: inviteUrl(appWebUrl(relayUrl), { roomId: invite.roomId, key: invite.key }),
                    expiresAt: invite.expiresAt,
                    replaced,
                    ...(relay.status !== 'connected' && {
                        warning: `This computer is not connected to the relay (${relayUrl}) right now: ${invite.person.name} will find it offline until it connects.`,
                    }),
                };
            },
            remove: async (name) => {
                const removed = await guestRooms.removePerson(name);
                return personView(removed.personId);
            },
            ownerName: () => ownerName ?? null,
            setOwnerName,
        },
        computerName: () => ({
            name: computerName,
            default: defaultComputerName(),
        }),
        setComputerName,
        pairingCodes: new PairingCodes(
            options.pairingCodeTtlMs !== undefined ? { ttlMs: options.pairingCodeTtlMs } : {},
        ),
        pairLink,
        revokePairKey: (key) => pairKeys.revoke(key),
        offerPairing: async (code) => {
            // The key goes through the relay: the user confirms the number before registering.
            const { key } = pairKeys.create({ confirm: true });
            const status = await relay.offerPairing({ code, key, computer: computerName });
            // Not delivered: nobody holds the key, it must not stay valid.
            if (status !== 'delivered') {
                pairKeys.revoke(key);
                return { status };
            }
            return { status, id: confirmations.create(key).id };
        },
        pairConfirmation: (id) => confirmations.get(id),
        confirmPairing: (id, accepted) => confirmations.decide(id, accepted),
        listDevices: () =>
            paired.list().map((device: RegisteredDevice) => ({
                deviceId: device.deviceId,
                name: device.name,
                pairedAt: device.pairedAt,
                lastSeenAt: device.lastSeenAt,
                connected: devices.isConnected(device.deviceId),
            })),
        revokeDevice: (deviceId) => devices.revoke(deviceId),
        pairPage: () => {
            // One key per target: scanning the QR must not consume the one behind the button.
            const { url, ...rest } = pairLink();
            return { ...rest, qrUrl: url, openUrl: pairLink().url };
        },
        status: () => ({
            ...BUILD_INFO,
            protocol: DAEMON_PROTOCOL_VERSION,
            localPort: localApi.port,
            computerName,
            relay: { url: relayUrl, status: relay.status, release: relay.release },
        }),
    });
    // A copy whose original is gone (a deletion cut short) goes before anyone can see it.
    await sharing
        .cleanOrphans((projectId) => registry.has(projectId))
        .catch((error: unknown) => log(`copies not cleaned: ${(error as Error).message}`));
    await guestRooms
        .reconcile()
        .catch((error: unknown) => log(`guest rooms not opened: ${(error as Error).message}`));
    relay.start();

    let stopping: Promise<void> | undefined;
    return {
        home,
        localPort: localApi.port,
        relayUrl,
        registry,
        rooms,
        devices,
        paired,
        people,
        sharing,
        guestRooms,
        relay,
        push,
        doneWaiters,
        removeProject,
        get computerName() {
            return computerName;
        },
        setComputerName,
        setOwnerName,
        stop() {
            stopping ??= (async () => {
                clearTimeout(projectsTimer);
                for (const timer of sharesTimers.values()) clearTimeout(timer);
                relay.stop();
                guestRooms.stop();
                notifier.stop();
                guestNotifier.stop();
                doneWaiters.stop();
                await localApi.stop();
                await rooms.closeAll();
            })();
            return stopping;
        },
    };
}

/** VAPID contact of the pushes: the relay page, or the public relay when it is not https. */
function pushSubject(relayUrl: string): string {
    const web = relayWebUrl(relayUrl);
    return web.startsWith('https://') ? web : relayWebUrl(DEFAULT_RELAY_URL);
}

/**
 * Pairing link for a QR code, a terminal or the pairing page: it carries the room and a single-use
 * key. Everything is in the fragment, which browsers never send to the server: the relay never
 * sees the key, the device only proves it holds it (`e2e.ts`).
 */
export function pairUrl(appUrl: string, target: { roomId: string; key: string }): string {
    const params = new URLSearchParams({ r: target.roomId, k: target.key });
    return `${appUrl}/#pair?${params.toString()}`;
}

/**
 * Link of an invitation for a QR code or a terminal. The room is the person's own, so what the
 * link opens is their copies and nothing else; the key opens once, within a day.
 */
export function inviteUrl(appUrl: string, target: { roomId: string; key: string }): string {
    const params = new URLSearchParams({ r: target.roomId, k: target.key });
    return `${appUrl}/#invite?${params.toString()}`;
}
