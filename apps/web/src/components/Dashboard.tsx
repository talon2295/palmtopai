import type {
    Pairing as ClientPairing,
    ConnectionStatus,
    UnauthorizedReason,
} from '@palmtopai/client';
import { Archive, Bell, BellOff, ChevronRight, Plus } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Drawer,
    DrawerContent,
    DrawerDescription,
    DrawerHeader,
    DrawerTitle,
} from '@/components/ui/drawer';
import { Toggle } from '@/components/ui/toggle';
import { appVersion } from '@/lib/app-update';
import { formatSyncedAt, useNow } from '@/lib/cache';
import { isArchivedProject, lostKey, type PairedProject, type Pairing } from '@/lib/pairings';
import { ArchiveSheet, archivedGroups } from './ArchiveSheet';
import { FeedbackSheet } from './FeedbackSheet';
import { Menu } from './Menu';
import { PairCode } from './PairCode';

/** The agent counts as working in a project touched this recently. */
export const WORKING_WINDOW_MS = 15 * 60_000;

/** A computer's live view, for the computers this device is connected to. */
export interface LiveComputer {
    status: ConnectionStatus;
    /** With `unauthorized`: why the computer refused this device. */
    unauthorizedReason?: UnauthorizedReason | null | undefined;
    /** Protocol of the daemon, once connected: the archive needs 5 (palmtop 0.20). */
    protocol?: number | null | undefined;
    /** Absent until the computer has sent its list. */
    projects?: PairedProject[] | undefined;
}

const STATUS: Record<ConnectionStatus, { label: string; dot: string }> = {
    connecting: { label: 'Connecting', dot: 'bg-amber-400 animate-pulse' },
    online: { label: 'Live', dot: 'bg-emerald-500' },
    offline: { label: 'Offline', dot: 'bg-zinc-400' },
    'daemon-offline': { label: 'PC offline', dot: 'bg-amber-500' },
    unauthorized: { label: 'Not paired', dot: 'bg-red-500' },
    stopped: { label: 'Not connected', dot: 'bg-zinc-400' },
};

/** `3 sessions · 5 min ago`, with what is known of the project. */
export function projectMeta(project: PairedProject, now: number): string {
    const parts: string[] = [];
    if (project.sessions !== undefined) {
        parts.push(
            project.sessions === 0
                ? 'no sessions'
                : `${project.sessions} session${project.sessions === 1 ? '' : 's'}`,
        );
    }
    if (project.lastActivityAt) parts.push(formatSyncedAt(project.lastActivityAt, now));
    return parts.join(' · ');
}

export function PendingBadge({ count }: { count: number | undefined }) {
    if (!count) return null;
    return (
        <Badge className="bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            {count} to review
        </Badge>
    );
}

/**
 * Every paired computer with its projects, the home of the app. The computer this device is
 * connected to shows live counts; the others the ones seen last.
 */
export function Dashboard({
    pairings,
    live,
    notifications,
    onOpenProject,
    onOpenComputer,
    onFollow,
    onUnpair,
    onPairedByCode,
    onInstall,
    notice,
    deviceKey,
    onUpdate,
    archive,
    confirm = (message) => window.confirm(message),
}: {
    pairings: Pairing[];
    /** Fingerprint of this device's key: a pairing made with another one lost its key. */
    deviceKey?: string | undefined;
    /** A new version of the app is on the server: reloads into it. */
    onUpdate?: (() => void) | undefined;
    /** The archive of sessions: absent, no archive button. */
    archive?: DashboardArchive | undefined;
    /** Live views by computer id. */
    live: Record<string, LiveComputer>;
    /** Absent while the state of notifications is loading. */
    notifications?: { on: boolean; onToggle: () => void };
    onOpenProject: (computerId: string, projectId: string) => void;
    onOpenComputer: (computerId: string) => void;
    /** Opens the project where the agent is working, following its activity. */
    onFollow: (computerId: string) => void;
    onUnpair: (computerId: string) => void;
    /** In the app on the Home Screen: "Pair a computer" shows a code instead of the QR steps. */
    onPairedByCode?: (roomId: string, pairing: ClientPairing) => void;
    /** In the browser: "Install app" in the menu shows how to add palmtop to the Home Screen. */
    onInstall?: () => void;
    /** Shown above the computers (a computer that may still accept this device). */
    notice?: ReactNode;
    confirm?: (message: string) => boolean;
}) {
    const now = useNow();
    const version = useMemo(() => appVersion(), []);
    const [pairOpen, setPairOpen] = useState(false);
    const [archiveOpen, setArchiveOpen] = useState(false);
    const projectsOf = (pairing: Pairing) => live[pairing.computerId]?.projects ?? pairing.projects;
    const [feedbackOpen, setFeedbackOpen] = useState(false);
    const working = pairings
        .flatMap((pairing) => {
            // "Working now" is the agent of this user: not what somebody else shares.
            if (pairing.guest) return [];
            const view = live[pairing.computerId];
            const top = view?.status === 'online' ? view.projects?.[0] : undefined;
            return top?.lastActivityAt && now - top.lastActivityAt < WORKING_WINDOW_MS
                ? [{ pairing, project: top, at: top.lastActivityAt }]
                : [];
        })
        .sort((a, b) => b.at - a.at)[0];

    return (
        <div className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-4 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            <header className="flex items-center justify-between gap-3">
                <h1 className="text-lg font-semibold">Dashboard</h1>
                <span className="flex items-center gap-2">
                    {archive && (
                        <Button
                            variant="outline"
                            size="icon"
                            aria-label="Archive"
                            title="Archive"
                            onClick={() => setArchiveOpen(true)}
                            className="size-9 rounded-lg border-zinc-300 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
                        >
                            <Archive />
                        </Button>
                    )}
                    {notifications && (
                        <Toggle
                            variant="outline"
                            aria-label="Notifications"
                            title={notifications.on ? 'Notifications on' : 'Notifications off'}
                            pressed={notifications.on}
                            onPressedChange={notifications.onToggle}
                            className="size-9 rounded-lg border-zinc-300 text-zinc-500 data-[state=on]:border-emerald-600/40 data-[state=on]:bg-emerald-50 data-[state=on]:text-emerald-700 dark:border-zinc-700 dark:text-zinc-400 dark:data-[state=on]:bg-emerald-950 dark:data-[state=on]:text-emerald-300"
                        >
                            {notifications.on ? <Bell /> : <BellOff />}
                        </Toggle>
                    )}
                    <Menu
                        label="App menu"
                        buttonClassName="size-9 rounded-lg border border-zinc-300 dark:border-zinc-700"
                        actions={[
                            ...(onUpdate
                                ? [
                                      {
                                          label: 'New version available',
                                          onSelect: onUpdate,
                                          attention: true,
                                      },
                                  ]
                                : []),
                            ...(onInstall ? [{ label: 'Install app', onSelect: onInstall }] : []),
                            { label: 'Send feedback', onSelect: () => setFeedbackOpen(true) },
                        ]}
                    />
                </span>
            </header>

            {notice}

            {working && (
                <button
                    type="button"
                    onClick={() => onFollow(working.pairing.computerId)}
                    className="flex items-center gap-3 rounded-xl border border-emerald-600/30 bg-emerald-50 px-4 py-3 text-left dark:bg-emerald-950"
                >
                    <span className="min-w-0 flex-1">
                        <span className="block text-xs font-semibold tracking-wide text-emerald-700 uppercase dark:text-emerald-300">
                            Working now
                        </span>
                        <span className="line-clamp-2 font-medium break-words">
                            {working.pairing.computer
                                ? `${working.pairing.computer} › ${working.project.name}`
                                : working.project.name}
                        </span>
                        <span className="block text-xs text-zinc-600 dark:text-zinc-400">
                            {formatSyncedAt(working.at, now)} · follow the agent
                        </span>
                    </span>
                    <ChevronRight className="size-5 shrink-0 text-emerald-700 dark:text-emerald-300" />
                </button>
            )}

            <ul className="flex flex-col gap-3">
                {pairings.map((pairing) => (
                    <ComputerCard
                        key={pairing.computerId}
                        pairing={pairing}
                        live={live[pairing.computerId]}
                        keyLost={isKeyLost(pairing, live[pairing.computerId], deviceKey)}
                        {...(archive?.can(pairing.computerId) &&
                            !pairing.guest && {
                                onArchiveProject: (projectId: string) =>
                                    archive.set(pairing.computerId, projectId, true),
                            })}
                        now={now}
                        onOpenProject={(projectId) => onOpenProject(pairing.computerId, projectId)}
                        onOpen={() => onOpenComputer(pairing.computerId)}
                        onUnpair={() => {
                            if (pairing.guest) {
                                const owner = pairing.computer ?? 'the owner';
                                if (
                                    confirm(
                                        `Remove "${owner}" from this device? You lose the checklists shared with you here, and changes not synced yet. To get them back, ask ${owner} for a new invitation.`,
                                    )
                                ) {
                                    onUnpair(pairing.computerId);
                                }
                                return;
                            }
                            const name = pairing.computer ?? 'this computer';
                            // Offline it can't revoke this device now: say so before, not after.
                            // A key that was lost opens nothing any more: nothing to say then.
                            const offline =
                                live[pairing.computerId]?.status === 'online' ||
                                isKeyLost(pairing, live[pairing.computerId], deviceKey)
                                    ? ''
                                    : ' It is offline: it keeps accepting this device until you run palmtop devices remove on it.';
                            if (
                                confirm(
                                    `Remove "${name}" from this device? You lose every project of that computer here, and changes not synced yet. To pair it again, scan the QR code from palmtop pair.${offline}`,
                                )
                            ) {
                                onUnpair(pairing.computerId);
                            }
                        }}
                    />
                ))}
            </ul>

            <Button
                variant="ghost"
                onClick={() => setPairOpen(true)}
                className="self-start text-emerald-700 hover:text-emerald-800 dark:text-emerald-300"
            >
                <Plus /> Pair a computer
            </Button>

            <p className="mt-auto pt-6 text-center text-xs text-zinc-400 opacity-70 dark:text-zinc-600">
                {version}
            </p>

            <FeedbackSheet open={feedbackOpen} onOpenChange={setFeedbackOpen} />

            {archive && (
                <ArchiveSheet
                    open={archiveOpen}
                    onOpenChange={setArchiveOpen}
                    now={now}
                    groups={archivedGroups(
                        pairings.filter((pairing) => !pairing.guest),
                        projectsOf,
                        (pairing) => archive.can(pairing.computerId),
                    )}
                    onOpenSession={(computerId, projectId, sessionId) => {
                        setArchiveOpen(false);
                        archive.openSession(computerId, projectId, sessionId);
                    }}
                    onRestore={(computerId, projectId, sessionIds) =>
                        archive.set(computerId, projectId, false, sessionIds)
                    }
                />
            )}

            <Drawer open={pairOpen} onOpenChange={setPairOpen}>
                <DrawerContent>
                    {onPairedByCode ? (
                        <div className="mx-auto w-full max-w-lg px-4 pb-8 text-center">
                            <DrawerHeader>
                                <DrawerTitle>Pair a computer</DrawerTitle>
                                <DrawerDescription>
                                    It shows up here with the others.
                                </DrawerDescription>
                            </DrawerHeader>
                            {pairOpen && (
                                <PairCode
                                    onPaired={(roomId, pairing) => {
                                        setPairOpen(false);
                                        onPairedByCode(roomId, pairing);
                                    }}
                                />
                            )}
                        </div>
                    ) : (
                        <DrawerHeader className="pb-8">
                            <DrawerTitle>Pair a computer</DrawerTitle>
                            <DrawerDescription>
                                On the computer run{' '}
                                <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
                                    palmtop pair
                                </code>{' '}
                                and scan the QR code with this device. It shows up here with the
                                others.
                            </DrawerDescription>
                        </DrawerHeader>
                    )}
                </DrawerContent>
            </Drawer>
        </div>
    );
}

/** What the Dashboard needs to archive sessions and show the archive. */
export interface DashboardArchive {
    /** The computer is connected and knows the archive. */
    can: (computerId: string) => boolean;
    /** `sessionIds` absent: every session of the project. */
    set: (computerId: string, projectId: string, archived: boolean, sessionIds?: string[]) => void;
    /** Opens a session from the archive, which stays archived. */
    openSession: (computerId: string, projectId: string, sessionId: string) => void;
}

/** The computer refused this device's key, or the pairing was made with another one. */
export function isKeyLost(
    pairing: Pairing,
    live: LiveComputer | undefined,
    deviceKey: string | undefined,
): boolean {
    return live?.status !== 'online' && lostKey(pairing, deviceKey, live?.unauthorizedReason);
}

function ComputerCard({
    pairing,
    live,
    keyLost,
    now,
    onOpenProject,
    onOpen,
    onUnpair,
    onArchiveProject,
}: {
    pairing: Pairing;
    live: LiveComputer | undefined;
    keyLost: boolean;
    now: number;
    onOpenProject: (projectId: string) => void;
    onOpen: () => void;
    onUnpair: () => void;
    /** Present when the computer can archive now. */
    onArchiveProject?: (projectId: string) => void;
}) {
    const guest = pairing.guest === true;
    const name = pairing.computer ?? (guest ? 'Shared with you' : 'Computer');
    const base = STATUS[live?.status ?? 'stopped'];
    const listed = live?.projects ?? pairing.projects;
    // A project whose sessions are all archived is only in the archive.
    const projects = listed.filter((project) => !isArchivedProject(project));
    // The owner closes the room when nothing is shared with a person: that is not "offline".
    const nothingShared = guest && projects !== undefined && projects.length === 0;
    const status = keyLost
        ? { label: 'Key lost', dot: 'bg-red-500' }
        : guest && live?.status === 'daemon-offline'
          ? nothingShared
              ? { label: 'Nothing shared', dot: 'bg-zinc-400' }
              : { ...base, label: 'Owner offline' }
          : base;

    return (
        <li
            aria-label={name}
            className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
        >
            <div className="flex items-center gap-2 py-1 pr-1 pl-4">
                <button
                    type="button"
                    onClick={onOpen}
                    className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left"
                >
                    <span className={`size-2 shrink-0 rounded-full ${status.dot}`} />
                    <span className="truncate font-semibold">{name}</span>
                    <span className="shrink-0 text-xs text-zinc-500">{status.label}</span>
                </button>
                <Menu
                    label={`Menu of ${name}`}
                    buttonClassName=""
                    actions={[
                        {
                            label: guest ? 'Remove from this device…' : 'Unpair this computer…',
                            onSelect: onUnpair,
                            destructive: true,
                        },
                    ]}
                />
            </div>
            {projects.length === 0 ? (
                <p className="border-t border-zinc-100 px-4 py-3 text-sm text-zinc-500 dark:border-zinc-800">
                    {guest
                        ? 'Nothing is shared with you right now.'
                        : listed.length > 0
                          ? 'Every project of this computer is in the archive.'
                          : 'No projects yet. They show up when your agent starts working in a folder.'}
                </p>
            ) : (
                <ul className="divide-y divide-zinc-100 border-t border-zinc-100 dark:divide-zinc-800 dark:border-zinc-800">
                    {projects.map((project) => (
                        <li key={project.id} className="flex items-center">
                            <button
                                type="button"
                                onClick={() => onOpenProject(project.id)}
                                className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                            >
                                <span className="min-w-0 flex-1">
                                    <span className="line-clamp-2 break-words">{project.name}</span>
                                    <span className="block text-xs text-zinc-500">
                                        {projectMeta(project, now)}
                                    </span>
                                </span>
                                <PendingBadge count={project.pending} />
                                <ChevronRight className="size-4 shrink-0 text-zinc-400" />
                            </button>
                            {onArchiveProject && (project.sessions ?? 0) > 0 && (
                                <Menu
                                    label={`Menu of ${project.name}`}
                                    buttonClassName="mr-1"
                                    actions={[
                                        {
                                            label: 'Archive project',
                                            onSelect: () => onArchiveProject(project.id),
                                        },
                                    ]}
                                />
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </li>
    );
}
