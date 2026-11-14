import {
    type ClientCache,
    type Pairing as ClientPairing,
    pairDevice,
    queuedProjects,
    type SyncClient,
} from '@palmtopai/client';
import { createId, type ProjectSummary, type PushRegistration } from '@palmtopai/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dashboard, isKeyLost, type LiveComputer } from './components/Dashboard';
import { EmptyState } from './components/EmptyState';
import { InstallPrompt, useInstallPrompt } from './components/InstallPrompt';
import { ProjectView } from './components/ProjectView';
import { StillPairedNotice } from './components/StillPairedNotice';
import { StorageNotice, useStorageNotice } from './components/StorageNotice';
import { useAppUpdate } from './lib/app-update';
import { computerCache, pruneCachedImages } from './lib/cache';
import { deviceName } from './lib/device';
import { markStorageCleared } from './lib/device-key';
import { type DeviceIdentity, IdentityProvider, useDeviceIdentity } from './lib/identity';
import { devicePlatform, isInstalled } from './lib/install';
import type { JoinResult } from './lib/join';
import {
    loadActiveComputer,
    loadActiveProject,
    loadPairings,
    openComputer,
    type Pairing,
    pairedProjectOf,
    pairingOfProject,
    rememberComputer,
    removePairing,
    saveActiveComputer,
    saveActiveProject,
    upsertPairing,
} from './lib/pairings';
import { currentPush, disablePush, enablePush, pushSupport } from './lib/push';
import { prepareScreenshot } from './lib/screenshot';
import { useComputerLinks } from './sync/use-computer-links';
import { deviceSocketUrl, useProjectSync } from './sync/use-project-sync';

function samePush(
    a: PushRegistration | null | undefined,
    b: PushRegistration | null | undefined,
): boolean {
    return (
        a === b ||
        (a != null &&
            b != null &&
            a.subscription.endpoint === b.subscription.endpoint &&
            a.subscription.keys.p256dh === b.subscription.keys.p256dh &&
            a.vapid.publicKey === b.vapid.publicKey)
    );
}

/** Notifications of this device: `undefined` while loading, `null` when off. */
function usePush() {
    const [push, setPush] = useState<PushRegistration | null | undefined>(undefined);
    useEffect(() => {
        let cancelled = false;
        // At start a failure means off; later it leaves things as they are (a passing error
        // must not stop the computers' notifications).
        const check = (onError: () => PushRegistration | null | undefined) => {
            currentPush()
                .catch(() => onError())
                .then((current) => {
                    if (current === undefined) return;
                    // The same subscription: nothing to send the computers again.
                    if (!cancelled)
                        setPush((known) => (samePush(known, current) ? known : current));
                });
        };
        check(() => null);
        // Back on screen: a subscription the browser dropped meanwhile is made again.
        const visible = () => {
            if (document.visibilityState === 'visible') check(() => undefined);
        };
        document.addEventListener('visibilitychange', visible);
        return () => {
            cancelled = true;
            document.removeEventListener('visibilitychange', visible);
        };
    }, []);

    const toggle = useCallback(async () => {
        try {
            if (push) {
                await disablePush();
                setPush(null);
                return;
            }
            const support = pushSupport();
            if (support === 'needs-home-screen') {
                window.alert(
                    'On iPhone and iPad, notifications work in the app added to the Home Screen: tap Share, then Add to Home Screen, and open PalmtopAI from there.',
                );
                return;
            }
            if (support === 'unsupported') {
                window.alert('This browser does not support notifications.');
                return;
            }
            setPush(await enablePush());
        } catch (error) {
            window.alert((error as Error).message);
        }
    }, [push]);

    return { push, toggle };
}

export function App({
    deviceId,
    join,
    loadIdentity,
}: {
    deviceId: string;
    join: JoinResult;
    /** Tests: the keys of this device, instead of IndexedDB. */
    loadIdentity?: Parameters<typeof useDeviceIdentity>[1];
}) {
    const identityState = useDeviceIdentity(deviceId, loadIdentity);
    if (identityState.status === 'loading') return null;
    if (identityState.status === 'unsupported') {
        return <EmptyState unsupported={identityState.reason} />;
    }
    return (
        <IdentityProvider value={identityState.identity}>
            <PairedApp identity={identityState.identity} join={join} />
        </IdentityProvider>
    );
}

function PairedApp({ identity, join }: { identity: DeviceIdentity; join: JoinResult }) {
    const [pairings, setPairings] = useState(loadPairings);
    const { push, toggle: togglePush } = usePush();
    const [activeId, setActiveId] = useState<string | null>(loadActiveProject);
    const [activeComputerId, setActiveComputerId] = useState<string | null>(loadActiveComputer);
    /** While following, this device moves to the project the agent is working in. */
    const [follow, setFollow] = useState(true);
    /** The Dashboard, or the open computer with its project. */
    const [view, setView] = useState<'dashboard' | 'computer'>('computer');
    /** Live projects of the connected computer, most recently active first. */
    const [summaries, setSummaries] = useState<ProjectSummary[]>([]);
    /** Projects of the computer with edits it has not received yet. */
    const [queued, setQueued] = useState<string[]>([]);
    const [pairing, setPairing] = useState(join.kind === 'pairing' || join.kind === 'invite');
    const [pairFailed, setPairFailed] = useState(false);
    /** A computer removed here that may still accept this device: its name. */
    const [stillPaired, setStillPaired] = useState<string | null>(null);
    const redeemed = useRef(false);

    const openComputerId = useCallback((computerId: string) => {
        saveActiveComputer(computerId);
        setActiveComputerId(computerId);
    }, []);

    /** Saves a pairing (from a link or a code) and opens that computer. */
    const paired = useCallback(
        (roomId: string, result: ClientPairing, guest = false) => {
            setPairings(
                upsertPairing({
                    computerId: result.computerId,
                    roomId,
                    computerKey: result.computerKey,
                    // The key this device paired with: another one later means it was lost.
                    ...(identity.fingerprint && { deviceKey: identity.fingerprint }),
                    computer: result.computer,
                    ...(guest && { guest: true }),
                }),
            );
            // The computer just paired opens, following its agent: it is where the user is
            // looking now, and connecting to it is how its projects become known.
            openComputerId(result.computerId);
            setFollow(true);
            setView('computer');
            setPairing(false);
            setPairFailed(false);
        },
        [openComputerId, identity.fingerprint],
    );
    const installed = useMemo(() => isInstalled(), []);
    const platform = useMemo(() => devicePlatform(), []);
    // The app on the Home Screen of an iPhone does not see the pairing made in Safari, and a
    // guest cannot pair it by code: no invitation to install it for somebody who only looks.
    const install = useInstallPrompt({
        installed,
        platform,
        paired: pairings.some((entry) => !entry.guest),
    });

    // A pairing link carries a single-use key: the device proves it on a connection of its own,
    // once (the ref also covers the double effect of StrictMode). The key is in the fragment,
    // the relay never sees it: no number to compare.
    useEffect(() => {
        if ((join.kind !== 'pairing' && join.kind !== 'invite') || redeemed.current) return;
        redeemed.current = true;
        let cancelled = false;
        pairDevice({
            url: deviceSocketUrl(window.location, join.roomId),
            roomId: join.roomId,
            pairKey: join.key,
            deviceId: identity.deviceId,
            name: deviceName(),
            deviceKeys: identity.keys,
        }).then(
            (result) => {
                if (!cancelled) paired(join.roomId, result, join.kind === 'invite');
            },
            () => {
                if (cancelled) return;
                setPairFailed(true);
                setPairing(false);
            },
        );
        return () => {
            cancelled = true;
        };
    }, [join, paired, identity]);

    /** Removes a computer from this device; `revoked`: it confirmed it forgot this device. */
    const forget = useCallback(
        (id: string, revoked: boolean) => {
            if (!revoked) {
                const name = pairings.find((entry) => entry.computerId === id)?.computer;
                setStillPaired(name ?? 'The computer');
            }
            setPairings(removePairing(id));
        },
        [pairings],
    );
    const storage = useStorageNotice(pairings);
    const appUpdate = useAppUpdate();
    const storageNotice = storage.kind && (
        <StorageNotice
            kind={storage.kind}
            guestOnly={storage.guestOnly}
            installed={installed}
            platform={platform}
            onDismiss={storage.dismiss}
        />
    );
    const notice = (stillPaired || storageNotice) && (
        <>
            {storageNotice}
            {stillPaired && (
                <StillPairedNotice computer={stillPaired} onDismiss={() => setStillPaired(null)} />
            )}
        </>
    );

    const computer = useMemo(
        () => openComputer(pairings, activeComputerId, activeId),
        [pairings, activeComputerId, activeId],
    );
    const computerId = computer?.computerId;
    const links = useComputerLinks({
        pairings,
        openComputerId: computerId,
        identity,
        push,
        onPairings: setPairings,
    });
    const cache = useMemo(() => (computerId ? computerCache(computerId) : undefined), [computerId]);
    useEffect(() => {
        setQueued([]);
        if (!cache) return;
        let cancelled = false;
        queuedProjects(cache).then((ids) => {
            if (!cancelled) setQueued(ids);
        });
        return () => {
            cancelled = true;
        };
    }, [cache]);

    /** Followed project: the selected one when it is on this computer, else its first. */
    const projectId = useMemo(() => {
        if (!computer) return null;
        const known = computer.projects.some((project) => project.id === activeId);
        return known ? activeId : (computer.projects[0]?.id ?? null);
    }, [computer, activeId]);

    const select = useCallback((selected: string) => {
        saveActiveProject(selected);
        setActiveId(selected);
    }, []);

    /** A project picked by hand stops the app from following the agent. */
    const pick = useCallback(
        (selected: string) => {
            setFollow(false);
            const owner = pairingOfProject(pairings, selected);
            if (owner) openComputerId(owner.computerId);
            select(selected);
        },
        [pairings, openComputerId, select],
    );

    // Following the agent: the daemon sorts its projects by activity, the first one is where
    // the work is happening now. Edits made offline go first: a project's queue reaches the
    // computer only while the app follows that project.
    useEffect(() => {
        if (!follow) return;
        const waiting = queued.find((id) =>
            computer?.projects.some((project) => project.id === id),
        );
        const target = waiting ?? summaries[0]?.id;
        if (!target || target === activeId) return;
        select(target);
    }, [follow, queued, computer, summaries, activeId, select]);

    /** From the Dashboard: a project picked by hand, or a computer, following its agent. */
    const openProject = useCallback(
        (projectId: string) => {
            pick(projectId);
            setView('computer');
        },
        [pick],
    );
    /** A session opened from the archive: its project, then the session itself (it stays archived). */
    const [openSession, setOpenSession] = useState<{
        projectId: string;
        sessionId: string;
        at: number;
    } | null>(null);
    const openArchivedSession = useCallback(
        (computerId: string, projectId: string, sessionId: string) => {
            openComputerId(computerId);
            pick(projectId);
            setView('computer');
            setOpenSession({ projectId, sessionId, at: Date.now() });
        },
        [openComputerId, pick],
    );
    const followComputer = useCallback(
        (id: string) => {
            openComputerId(id);
            setFollow(true);
            setView('computer');
        },
        [openComputerId],
    );

    // A notification tapped while the app is already open.
    useEffect(() => {
        const worker = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
        if (!worker) return;
        const open = (event: MessageEvent) => {
            const data = event.data as { type?: unknown; projectId?: unknown } | null;
            if (data?.type === 'palmtop.open' && typeof data.projectId === 'string') {
                openProject(data.projectId);
            }
        };
        worker.addEventListener('message', open);
        return () => worker.removeEventListener('message', open);
    }, [openProject]);

    if (pairing) return <EmptyState pairing invitation={join.kind === 'invite'} />;
    if (!computer) {
        return (
            <EmptyState
                invalidLink={join.kind === 'invalid' || pairFailed}
                invitation={join.kind === 'invite'}
                notice={notice}
                onPairedByCode={installed ? paired : undefined}
            />
        );
    }

    return (
        <>
            {install.shown && (
                <InstallPrompt
                    platform={platform}
                    onClose={install.close}
                    onNever={install.never}
                />
            )}
            <ActiveProject
                // A new client per paired computer (and per key after pairing again).
                key={`${computer.computerId}:${computer.computerKey}`}
                pairing={computer}
                projectId={projectId}
                identity={identity}
                cache={cache}
                follow={follow}
                onFollow={() => setFollow(true)}
                onPauseFollow={() => setFollow(false)}
                onSelectProject={pick}
                push={push}
                onProjects={setPairings}
                onSummaries={setSummaries}
                onQueued={setQueued}
                onUnpair={(revoked) => forget(computer.computerId, revoked)}
                notice={storageNotice || undefined}
                view={view}
                onHome={() => setView('dashboard')}
                openSession={openSession}
                dashboard={(live, unpairConnected, archiveHere) => (
                    <Dashboard
                        notice={notice}
                        deviceKey={identity.fingerprint}
                        onUpdate={appUpdate.available ? appUpdate.update : undefined}
                        archive={
                            // Only once a computer knows the archive, or something is in it.
                            Object.values({ ...links.live, ...live }).some(
                                (view) => (view.protocol ?? 0) >= 5,
                            ) ||
                            pairings.some((entry) =>
                                entry.projects.some(
                                    (project) => (project.archived?.length ?? 0) > 0,
                                ),
                            )
                                ? {
                                      can: (id) => {
                                          const view = { ...links.live, ...live }[id];
                                          return (
                                              view?.status === 'online' && (view.protocol ?? 0) >= 5
                                          );
                                      },
                                      set: (id, projectId, archived, sessionIds) => {
                                          if (id === computer.computerId) {
                                              archiveHere(projectId, archived, sessionIds);
                                          } else {
                                              links.archive(id, projectId, archived, sessionIds);
                                          }
                                      },
                                      openSession: openArchivedSession,
                                  }
                                : undefined
                        }
                        pairings={pairings}
                        live={{ ...links.live, ...live }}
                        {...(push !== undefined && {
                            notifications: { on: Boolean(push), onToggle: togglePush },
                        })}
                        onOpenProject={(_, projectId) => openProject(projectId)}
                        onOpenComputer={followComputer}
                        onFollow={followComputer}
                        {...(installed ? { onPairedByCode: paired } : { onInstall: install.open })}
                        onUnpair={(id) => {
                            if (id === computer.computerId) return unpairConnected();
                            void links.unpair(id).then((revoked) => forget(id, revoked));
                        }}
                    />
                )}
            />
        </>
    );
}

function ActiveProject({
    pairing,
    projectId,
    identity,
    cache,
    follow,
    onFollow,
    onPauseFollow,
    onSelectProject,
    push,
    onProjects,
    onSummaries,
    onQueued,
    onUnpair,
    view,
    onHome,
    notice,
    openSession,
    dashboard,
}: {
    pairing: Pairing;
    projectId: string | null;
    identity: DeviceIdentity;
    cache: ClientCache | undefined;
    follow: boolean;
    onFollow: () => void;
    onPauseFollow: () => void;
    onSelectProject: (projectId: string) => void;
    push: PushRegistration | null | undefined;
    onProjects: (pairings: Pairing[]) => void;
    onSummaries: (projects: ProjectSummary[]) => void;
    onQueued: (projectIds: string[]) => void;
    /** `revoked`: the computer confirmed it forgot this device. */
    onUnpair: (revoked: boolean) => void;
    view: 'dashboard' | 'computer';
    onHome: () => void;
    /** Shown above the project (the browser deleted this app's data). */
    notice?: React.ReactNode;
    /** A session to open (from the archive) once its project is followed. */
    openSession?: { projectId: string; sessionId: string; at: number } | null;
    /** The Dashboard, with the live view of this computer and how to unpair it. */
    dashboard: (
        live: Record<string, LiveComputer>,
        unpair: () => void,
        archive: (projectId: string, archived: boolean, sessionIds?: string[]) => void,
    ) => React.ReactNode;
}) {
    const { client, snapshot } = useProjectSync(pairing, projectId, identity, cache);
    useCacheUpkeep(client, cache, snapshot, onQueued);
    useEffect(() => {
        if (push !== undefined) client.setPush(push);
    }, [client, push]);

    // Screenshots of the notes: sent to the computer (online, and one that knows them) and shown
    // from this device or from the computer. A person with a shared copy has them too.
    // Offline too, once the computer was seen to take them: the picture is kept here and sent when
    // it is back. A computer never seen, or too old, cannot be promised anything.
    const imagesOnline = snapshot.status === 'online';
    const imagesKnown = (snapshot.daemonProtocol ?? 0) >= 6;
    const imagesUnavailable =
        snapshot.daemonProtocol !== null && snapshot.daemonProtocol < 6
            ? 'This computer needs `palmtop update` to take screenshots.'
            : 'Needs the computer to be online once, to know it takes screenshots.';
    const loadImage = useCallback((imageId: string) => client.getImage(imageId), [client]);
    const sendImage = useCallback(
        async (sessionId: string, file: Blob) => {
            const prepared = await prepareScreenshot(file);
            const imageId = createId();
            await client.putImage(sessionId, imageId, prepared);
            return imageId;
        },
        [client],
    );

    // The computer keeps the list up to date: remember it, so it also shows while it is offline.
    const { computer, projects } = snapshot;
    useEffect(() => {
        if (!computer) return;
        onSummaries(projects);
        onProjects(
            rememberComputer(computer.id, {
                computer: computer.name,
                deviceKey: identity.fingerprint,
                projects: projects.map(pairedProjectOf),
            }),
        );
    }, [computer, projects, onProjects, onSummaries, identity.fingerprint]);

    // The computer refused the key of this device: the browser deleted the keys.
    useEffect(() => {
        if (snapshot.unauthorizedReason === 'key' && identity.fingerprint) {
            markStorageCleared(identity.fingerprint);
        }
    }, [snapshot.unauthorizedReason, identity.fingerprint]);

    const name =
        snapshot.project?.name ?? pairing.projects.find((entry) => entry.id === projectId)?.name;

    const unpair = () => {
        // The computer revokes this device: its key and its notifications go. Then nothing of
        // the computer stays here, queued edits included. A computer that already refused this
        // device has nothing left to revoke.
        let revoked = snapshot.status === 'unauthorized';
        void client
            .unpair()
            .then((done) => {
                revoked ||= done;
            })
            .then(() => client.whenSaved())
            .then(() => cache?.clear())
            .catch(() => {})
            .finally(() => onUnpair(revoked));
    };

    if (view === 'dashboard') {
        return dashboard(
            {
                [pairing.computerId]: {
                    status: snapshot.status,
                    unauthorizedReason: snapshot.unauthorizedReason,
                    protocol: snapshot.daemonProtocol,
                    projects: computer ? projects : pairing.projects,
                },
            },
            unpair,
            (target, archived, sessionIds) => client.archive(target, archived, sessionIds),
        );
    }

    return (
        <ProjectView
            snapshot={snapshot}
            fallbackName={name ?? 'No project'}
            computerName={pairing.computer}
            projects={pairing.projects}
            selectedProjectId={projectId}
            onSelectProject={onSelectProject}
            follow={follow}
            onFollow={onFollow}
            onPauseFollow={onPauseFollow}
            onItemChange={(sessionId, itemId, change) =>
                client.updateItem(sessionId, { itemId, ...change })
            }
            onAddItem={(sessionId, item) => client.addItem(sessionId, item)}
            onRemoveItem={(sessionId, itemId) => client.removeItem(sessionId, itemId)}
            onSessionNote={(sessionId, note) => client.setSessionNote(sessionId, note)}
            onRemoveSession={(sessionId) => client.removeSession(sessionId)}
            onDismissError={() => client.dismissError()}
            {...(projectId &&
                !pairing.guest && { onRemoveProject: () => client.removeProject(projectId) })}
            guest={pairing.guest === true}
            notice={notice}
            {...(openSession &&
                openSession.projectId === projectId && {
                    openSession: { sessionId: openSession.sessionId, at: openSession.at },
                })}
            images={{
                enabled: imagesKnown,
                online: imagesOnline,
                ...(!imagesKnown && { unavailable: imagesUnavailable }),
                send: sendImage,
                load: loadImage,
            }}
            {...((snapshot.daemonProtocol ?? 0) >= 7 && {
                onDone: (sessionId: string) => client.markSessionDone(sessionId),
            })}
            {...(projectId &&
                !pairing.guest &&
                snapshot.status === 'online' &&
                (snapshot.daemonProtocol ?? 0) >= 5 && {
                    onArchive: (sessionIds: string[] | undefined, archived: boolean) =>
                        client.archive(projectId, archived, sessionIds),
                })}
            keyLost={isKeyLost(
                pairing,
                { status: snapshot.status, unauthorizedReason: snapshot.unauthorizedReason },
                identity.fingerprint,
            )}
            onUnpair={unpair}
            onHome={onHome}
        />
    );
}

/**
 * Keeps the cache in step with the computer: projects it no longer has are dropped (with their
 * queue, which could never be delivered), and the list of queued projects is refreshed once
 * the followed project has delivered its own.
 */
function useCacheUpkeep(
    client: SyncClient,
    cache: ClientCache | undefined,
    snapshot: ReturnType<SyncClient['getSnapshot']>,
    onQueued: (projectIds: string[]) => void,
) {
    const { computer, projects, status, pendingCount, projectId, state } = snapshot;
    useEffect(() => {
        if (!cache || !computer) return;
        const live = new Set(projects.map((project) => project.id));
        cache
            .projectIds()
            .then((ids) => Promise.all(ids.filter((id) => !live.has(id)).map(cache.remove)))
            .catch(() => {});
    }, [cache, computer, projects]);

    // Also on every project switch: the one reached may have nothing left to deliver.
    const delivered = status === 'online' && pendingCount === 0 && state !== null;
    useEffect(() => {
        if (!cache || !delivered || !projectId) return;
        let cancelled = false;
        client
            .whenSaved()
            .then(() => queuedProjects(cache))
            .then((ids) => {
                if (!cancelled) onQueued(ids);
            })
            .then(() => pruneCachedImages(cache));
        return () => {
            cancelled = true;
        };
    }, [client, cache, delivered, projectId, onQueued]);
}
