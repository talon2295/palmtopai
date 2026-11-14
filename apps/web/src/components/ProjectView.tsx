import type { SyncSnapshot } from '@palmtopai/client';
import {
    createId,
    hasUndeliveredSessionNote,
    type Item,
    isDaemonOutdated,
    listChecklists,
    listItems,
    listSessions,
    pendingReviews,
    type Session,
} from '@palmtopai/protocol';
import { ChevronDown, House } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { type ImagesApi, ImagesProvider } from '@/lib/images';
import { cn } from '@/lib/utils';
import { formatSyncedAt, useNow } from '../lib/cache';
import { useDisplayedStatus } from '../lib/displayed-status';
import type { PairedProject } from '../lib/pairings';
import {
    completeListsLast,
    HIDE_DELAY_MS,
    loadHideResults,
    loadHideReviewed,
    saveHideResults,
    saveHideReviewed,
    useCountdowns,
} from '../lib/review-filter';
import { followReducer, initialFollowState } from '../lib/session-follow';
import { ChecklistCard } from './ChecklistCard';
import { ChoiceCarousel } from './ChoiceCarousel';
import { ConnectionBadge } from './ConnectionBadge';
import type { ItemChange } from './ItemRow';
import { Menu } from './Menu';
import { ProjectSheet, type SessionOption, type SheetLevel } from './ProjectSheet';
import { ReviewDone } from './ReviewDone';
import { AgentMessage, NoteForAgent } from './SessionNotes';
import { PeopleResults, type PersonOutcome } from './SharedOutcomes';

export interface ProjectViewProps {
    snapshot: SyncSnapshot;
    /** Name of the project until the computer sends it. */
    fallbackName: string;
    /** Last known name of the computer. */
    computerName?: string | undefined;
    /** Projects of the computer, for the sheet behind the breadcrumb. */
    projects?: PairedProject[];
    selectedProjectId?: string | null;
    onSelectProject?: (projectId: string) => void;
    onItemChange: (sessionId: string, itemId: string, change: ItemChange) => void;
    onAddItem: (
        sessionId: string,
        item: { itemId: string; checklistId: string; text: string; order: number },
    ) => void;
    onRemoveItem: (sessionId: string, itemId: string) => void;
    onSessionNote: (sessionId: string, note: string) => void;
    onRemoveSession: (sessionId: string) => void;
    onDismissError: () => void;
    onUnpair: () => void;
    /** Deletes the project shown, on the computer and on every device. */
    onRemoveProject?: () => void;
    /** True while this device follows the agent: the newest session is selected on its own. */
    follow?: boolean;
    /** Called when the user picks a session by hand, which stops following the agent. */
    onPauseFollow?: () => void;
    /** Follows the agent again, across projects and sessions. */
    onFollow?: () => void;
    /** Back to the Dashboard. */
    onHome?: () => void;
    /** Paired with an invitation: what is shown is shared by somebody, not the user's own. */
    guest?: boolean;
    /** This device no longer has the key it paired with (the browser deleted this app's data). */
    keyLost?: boolean;
    /** Shown at the top (e.g. the browser deleted this app's data). */
    notice?: ReactNode;
    /** A session to open, opened from the archive (`at` tells a new request from the same one). */
    openSession?: { sessionId: string; at: number };
    /**
     * Tells the agent the user finished reviewing the session (on a copy shared with a person, tells
     * the owner). Absent when the computer does not know it (needs `palmtop update`).
     */
    onDone?: (sessionId: string) => void;
    /** Archives sessions of this project, or takes them out (`undefined`: all of them). */
    onArchive?: (sessionIds: string[] | undefined, archived: boolean) => void;
    /**
     * Screenshots of the notes: sending one for a session, and loading one to show. Without it
     * the notes have no screenshots (a copy shared with a person, a computer too old for them).
     */
    images?: {
        enabled: boolean;
        online: boolean;
        unavailable?: string;
        send: (sessionId: string, file: Blob) => Promise<string>;
        load: ImagesApi['load'];
    };
    confirm?: (message: string) => boolean;
    /** How long an item reviewed here stays visible while reviewed items are hidden. */
    hideDelayMs?: number;
}

export function ProjectView({
    snapshot,
    fallbackName,
    computerName,
    projects = [],
    selectedProjectId = null,
    onSelectProject,
    onItemChange,
    onAddItem,
    onRemoveItem,
    onSessionNote,
    onRemoveSession,
    onDismissError,
    onUnpair,
    onRemoveProject,
    follow = true,
    onPauseFollow,
    onHome,
    onFollow,
    guest = false,
    keyLost = false,
    notice,
    openSession,
    onDone,
    onArchive,
    images,
    confirm = (message) => window.confirm(message),
    hideDelayMs = HIDE_DELAY_MS,
}: ProjectViewProps) {
    const { state, pendingCount, lastError } = snapshot;
    const status = useDisplayedStatus(snapshot.status);
    const allSessions = useMemo(() => (state ? listSessions(state) : []), [state]);
    // An archived session is out of the way, unless it was opened from the archive.
    const [shownArchived, setShownArchived] = useState<string | null>(null);
    const sessions = useMemo(
        () => allSessions.filter((session) => !session.archived || session.id === shownArchived),
        [allSessions, shownArchived],
    );
    const [sessionFollow, dispatch] = useReducer(followReducer, initialFollowState);
    const [hideReviewed, setHideReviewed] = useState(() => loadHideReviewed());
    const countdowns = useCountdowns(hideDelayMs);
    // Items with an open note editor stay visible whatever the filter.
    const [editingIds, setEditingIds] = useState<ReadonlySet<string>>(() => new Set());
    const projectName = snapshot.project?.name ?? fallbackName;
    // A copy shared with somebody says its own owner name; the list says the one of the person.
    const sharedUntil = snapshot.project?.sharedUntil;
    const isGuest = guest || sharedUntil !== undefined;
    const computer = isGuest
        ? (snapshot.project?.computer ?? snapshot.computer?.name ?? computerName)
        : (snapshot.computer?.name ?? snapshot.project?.computer ?? computerName);
    /** How the owner of what is shared is called in the texts of a guest. */
    const owner = computer ?? 'the owner';
    const now = useNow();
    const readOnly = sharedUntil !== undefined && now >= sharedUntil;
    const [hideResults, setHideResults] = useState(() => loadHideResults());
    const [sheet, setSheet] = useState<SheetLevel | null>(null);

    useEffect(() => {
        dispatch({ type: 'sessions', sessions });
    }, [sessions]);

    // Opened from the archive: that session, once its project has arrived, and no following the
    // agent away from it. Each request (`at`) is applied once.
    const appliedOpen = useRef<number | null>(null);
    useEffect(() => {
        if (!openSession || appliedOpen.current === openSession.at) return;
        if (!allSessions.some((session) => session.id === openSession.sessionId)) return;
        appliedOpen.current = openSession.at;
        setShownArchived(openSession.sessionId);
        dispatch({ type: 'select', sessionId: openSession.sessionId, sessions: allSessions });
    }, [openSession, allSessions]);

    // Sessions follow the agent with the switch of the project bar: one control for both.
    const latestSessions = useRef(sessions);
    latestSessions.current = sessions;
    useEffect(() => {
        if (follow) dispatch({ type: 'follow', sessions: latestSessions.current });
    }, [follow]);

    const selectedSessionId = sessionFollow.selectedSessionId;
    const selectedSession = sessions.find((session) => session.id === selectedSessionId);
    // The screenshots of the notes belong to the session on screen.
    const sendImage = images?.send;
    const loadImage = images?.load;
    const imagesEnabled = images?.enabled ?? false;
    const imagesOnline = images?.online ?? false;
    const imagesUnavailable = images?.unavailable;
    const openSessionId = selectedSession?.id;
    const sessionImages = useMemo<ImagesApi | null>(() => {
        if (!sendImage || !loadImage) return null;
        return {
            enabled: imagesEnabled && openSessionId !== undefined,
            online: imagesOnline,
            ...(imagesUnavailable !== undefined && { unavailable: imagesUnavailable }),
            send: (file) => {
                if (!openSessionId) return Promise.reject(new Error('No session is open.'));
                return sendImage(openSessionId, file);
            },
            load: loadImage,
        };
    }, [sendImage, loadImage, imagesEnabled, imagesOnline, imagesUnavailable, openSessionId]);
    const checklists = useMemo(
        () =>
            state && selectedSessionId
                ? listChecklists(state, selectedSessionId).map((checklist) => ({
                      checklist,
                      items: listItems(state, checklist.id),
                  }))
                : [],
        [state, selectedSessionId],
    );
    /** Every session with its item counts, for the sheet. */
    const sessionOptions = useMemo<SessionOption[]>(
        () =>
            state
                ? sessions.map((session) => {
                      const lists = listChecklists(state, session.id).map((checklist) => ({
                          checklist,
                          items: listItems(state, checklist.id),
                      }));
                      return {
                          id: session.id,
                          title: session.title,
                          lastActivityAt: session.lastActivityAt,
                          items: lists.reduce((count, { items }) => count + items.length, 0),
                          pending: lists.reduce(
                              (count, list) => count + pendingReviews(list.checklist, list.items),
                              0,
                          ),
                      };
                  })
                : [],
        [state, sessions],
    );
    // One question is one thing to answer, and stops counting once answered.
    const toReview = checklists.reduce(
        (count, { checklist, items }) => count + pendingReviews(checklist, items),
        0,
    );

    // The answers of the people the selected session is shared with (the owner's devices only).
    const sessionShares =
        snapshot.shares.find((entry) => entry.sessionId === selectedSessionId)?.people ?? [];
    const outcomes = useMemo(() => {
        if (sessionShares.length === 0) return undefined;
        const byItem = new Map<string, PersonOutcome[]>();
        for (const { checklist, items } of checklists) {
            if (checklist.kind === 'choice') continue;
            for (const item of items) {
                // A person gets a chip only where the checklist was given to them.
                byItem.set(
                    item.id,
                    sessionShares
                        .filter((person) => person.checklists.includes(checklist.id))
                        .map((person) => ({
                            person: person.name,
                            state: person.state,
                            status: person.items[item.id]?.status,
                            note: person.items[item.id]?.note,
                        })),
                );
            }
        }
        return byItem;
    }, [checklists, sessionShares]);

    const toggleHideResults = () => {
        setHideResults(!hideResults);
        saveHideResults(!hideResults);
    };

    const toggleHideReviewed = () => {
        setHideReviewed(!hideReviewed);
        saveHideReviewed(!hideReviewed);
        countdowns.clear();
    };

    const isVisible = (item: Item) =>
        !hideReviewed || !item.status || countdowns.runs.has(item.id) || editingIds.has(item.id);

    // With reviewed items hidden, finished lists go last (once their last item has settled).
    const shownLists = hideReviewed
        ? completeListsLast(
              checklists,
              (itemId) => countdowns.runs.has(itemId) || editingIds.has(itemId),
          )
        : checklists;

    const changeItem = (sessionId: string, item: Item, change: ItemChange) => {
        onItemChange(sessionId, item.id, change);
        // Reviewed here while reviewed items are hidden: visible a few seconds more, for a note.
        if (change.status === null) countdowns.stop(item.id);
        else if (change.status && hideReviewed && !editingIds.has(item.id)) {
            countdowns.start(item.id);
        }
    };

    const setEditing = (item: Item, editing: boolean) => {
        setEditingIds((current) => {
            const next = new Set(current);
            if (editing) next.add(item.id);
            else next.delete(item.id);
            return next;
        });
        if (editing) countdowns.stop(item.id);
        else if (hideReviewed && item.status) countdowns.start(item.id);
    };

    const deleteSession = (session: Session) => {
        if (
            confirm(
                `Delete the session "${session.title}"? Its checklists and reviews are deleted on your computer too.`,
            )
        ) {
            onRemoveSession(session.id);
        }
    };

    const removeProject = () => {
        const where = computer ? ` on ${computer}` : '';
        if (
            confirm(
                `Delete the project "${snapshot.project?.name ?? projectName}"${where}? Its sessions, checklists and reviews are deleted on the computer too. The folder and its files are not touched.`,
            )
        ) {
            onRemoveProject?.();
        }
    };

    const unpair = () => {
        const text = isGuest
            ? `Remove "${owner}" from this device? You lose the checklists shared with you here, and changes not synced yet. To get them back, ask ${owner} for a new invitation.`
            : `Remove "${computer ?? projectName}" from this device? You lose every project of that computer here, and changes not synced yet. To pair it again, scan the QR code from palmtop pair.`;
        if (confirm(text)) onUnpair();
    };

    // A guest takes part in a session, the owner ends it: nothing to delete.
    const menuActions = isGuest
        ? []
        : [
              ...(selectedSession && onArchive
                  ? [
                        selectedSession.archived
                            ? {
                                  label: 'Restore this session',
                                  onSelect: () => onArchive([selectedSession.id], false),
                              }
                            : {
                                  label: 'Archive this session',
                                  onSelect: () => onArchive([selectedSession.id], true),
                              },
                    ]
                  : []),
              ...(onArchive && sessions.some((session) => !session.archived)
                  ? [{ label: 'Archive this project', onSelect: () => onArchive(undefined, true) }]
                  : []),
              ...(selectedSession
                  ? [
                        {
                            label: 'Delete this session…',
                            onSelect: () => deleteSession(selectedSession),
                            destructive: true,
                        },
                    ]
                  : []),
              ...(onRemoveProject && snapshot.project
                  ? [{ label: 'Delete this project…', onSelect: removeProject, destructive: true }]
                  : []),
          ];

    return (
        <ImagesProvider value={sessionImages}>
            <div className="mx-auto flex min-h-dvh max-w-2xl flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
                <header className="flex flex-col gap-2 pb-4">
                    <div className="flex items-center gap-2">
                        {onHome && (
                            <Button
                                variant="outline"
                                size="icon"
                                aria-label="Dashboard"
                                onClick={onHome}
                                className="rounded-lg border-zinc-300 dark:border-zinc-700"
                            >
                                <House />
                            </Button>
                        )}
                        <h1 className="min-w-0 flex-1 text-lg leading-snug font-semibold">
                            <button
                                type="button"
                                aria-label={`Project ${projectName}, change`}
                                onClick={() => setSheet('projects')}
                                className="flex max-w-full items-center gap-1 rounded-md text-left"
                            >
                                <span className="line-clamp-2 break-words">{projectName}</span>
                                <ChevronDown className="size-4 shrink-0 text-zinc-500" />
                            </button>
                        </h1>
                        {menuActions.length > 0 && (
                            <Menu
                                label="Project menu"
                                buttonClassName="hover:bg-zinc-200/60 dark:hover:bg-zinc-800"
                                actions={menuActions}
                            />
                        )}
                    </div>
                    {selectedSession && (
                        // Second line of the path: the session, under the project name.
                        <button
                            type="button"
                            aria-label={`Session ${selectedSession.title}, change`}
                            onClick={() => setSheet('sessions')}
                            className={cn(
                                'flex max-w-full items-center gap-1 self-start rounded-md text-left leading-snug text-zinc-700 dark:text-zinc-300',
                                onHome && 'ml-11',
                            )}
                        >
                            <span className="line-clamp-2 break-words">
                                {selectedSession.title}
                            </span>
                            <ChevronDown className="size-4 shrink-0 text-zinc-500" />
                        </button>
                    )}
                    <div className="flex items-center gap-2">
                        <ConnectionBadge
                            status={status}
                            pendingCount={pendingCount}
                            guest={isGuest}
                            nothingShared={
                                snapshot.computer !== null && snapshot.projects.length === 0
                            }
                            keyLost={keyLost}
                        />
                        {computer && (
                            <span className="min-w-0 truncate text-xs text-zinc-500">
                                {computer}
                            </span>
                        )}
                        {!isGuest && (
                            <Button
                                variant="outline"
                                size="sm"
                                aria-pressed={follow}
                                onClick={onFollow}
                                disabled={follow}
                                className={cn(
                                    'ml-auto',
                                    // Following is a state, not a disabled control: full colour.
                                    follow &&
                                        'border-emerald-600/40 bg-emerald-50 text-emerald-700 disabled:opacity-100 dark:bg-emerald-950 dark:text-emerald-300',
                                )}
                            >
                                {follow ? 'Following activity' : 'Follow activity'}
                            </Button>
                        )}
                    </div>
                    <ProjectSheet
                        level={sheet}
                        onLevel={setSheet}
                        onClose={() => setSheet(null)}
                        computerName={computer}
                        projects={projects}
                        selectedProjectId={selectedProjectId}
                        projectName={projectName}
                        sessions={sessionOptions}
                        selectedSessionId={selectedSessionId}
                        onSelectProject={(projectId) => {
                            setSheet(null);
                            if (projectId !== selectedProjectId) onSelectProject?.(projectId);
                        }}
                        onSelectSession={(sessionId) => {
                            setSheet(null);
                            if (sessionId === selectedSessionId) return;
                            dispatch({ type: 'select', sessionId, sessions });
                            onPauseFollow?.();
                        }}
                    />
                </header>

                {snapshot.daemonProtocol !== null && isDaemonOutdated(snapshot.daemonProtocol) && (
                    <Alert role="alert" variant="warning" className="mb-3">
                        {isGuest ? (
                            <>
                                Palmtop on {owner}&apos;s computer is out of date. Ask them to
                                update it.
                            </>
                        ) : (
                            <>
                                Palmtop on your computer is out of date. Run{' '}
                                <code className="font-mono">palmtop update</code> there.
                            </>
                        )}
                    </Alert>
                )}

                {readOnly && (
                    <Alert className="mb-3">
                        {owner} shared this until{' '}
                        {sharedUntil !== undefined && new Date(sharedUntil).toLocaleDateString()}.
                        It is read-only now: you can still read it.
                    </Alert>
                )}

                {status === 'offline' && state && (
                    <Alert className="mb-3">
                        Offline. Changes are kept on this device and sync when the connection is
                        back.
                        <LastSynced at={snapshot.syncedAt} />
                    </Alert>
                )}

                {status === 'daemon-offline' && state && (
                    <Alert variant="warning" className="mb-3">
                        <p>
                            {isGuest ? `${owner}'s computer` : 'Your computer'} is offline. Changes
                            are kept on this device and sync when it is back.
                            <LastSynced at={snapshot.syncedAt} />
                        </p>
                        {!isGuest && <RemovedProjectHint onRemove={unpair} />}
                    </Alert>
                )}

                {lastError && (
                    <Alert
                        role="alert"
                        variant="destructive"
                        className="mb-3 flex items-start gap-3"
                    >
                        <p className="flex-1">
                            {lastError.opId ? 'A change was not accepted: ' : 'Error: '}
                            {lastError.message}
                        </p>
                        <button type="button" onClick={onDismissError} className="font-medium">
                            Dismiss
                        </button>
                    </Alert>
                )}

                {notice && <div className="mb-3">{notice}</div>}

                <main className="flex-1">
                    {status === 'unauthorized' || keyLost ? (
                        <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
                            <p className="font-medium">
                                {keyLost
                                    ? 'This device lost its key.'
                                    : isGuest
                                      ? `${owner} is not sharing with this device any more.`
                                      : snapshot.unauthorizedReason === 'computer-key'
                                        ? 'This computer has a new key.'
                                        : 'This device is no longer paired with the project.'}
                            </p>
                            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                                {keyLost
                                    ? 'The browser deleted the data of this app, the key included: it can happen when the device is low on space. '
                                    : !isGuest && snapshot.unauthorizedReason === 'computer-key'
                                      ? 'palmtop was installed again there, or its data was reset. '
                                      : ''}
                                {isGuest ? (
                                    `Ask ${owner} for a new invitation if you need it again.`
                                ) : keyLost || snapshot.unauthorizedReason === 'computer-key' ? (
                                    <>
                                        Remove it from this device, then pair again with{' '}
                                        <code>palmtop pair</code> on the computer.
                                    </>
                                ) : (
                                    <>
                                        Scan the QR code again from <code>palmtop pair</code> on
                                        your computer.
                                    </>
                                )}
                            </p>
                            <Button onClick={onUnpair} className="mt-3 px-3">
                                Remove from this device
                            </Button>
                        </div>
                    ) : !state ? (
                        <div className="py-12 text-center text-sm text-zinc-500">
                            {status === 'daemon-offline' &&
                            !(isGuest && snapshot.computer && snapshot.projects.length === 0) ? (
                                <>
                                    <p>
                                        {isGuest ? `${owner}'s computer` : 'Your computer'} is
                                        offline. Waiting for it to connect…
                                    </p>
                                    {!isGuest && (
                                        <div className="mx-auto mt-8 max-w-xs">
                                            <RemovedProjectHint onRemove={unpair} />
                                        </div>
                                    )}
                                </>
                            ) : snapshot.computer && snapshot.projects.length === 0 ? (
                                <p>
                                    {isGuest
                                        ? 'Nothing is shared with you right now.'
                                        : 'No projects on this computer yet. They show up here as soon as your agent starts working in a folder.'}
                                </p>
                            ) : (
                                <p>
                                    {isGuest
                                        ? 'Opening the checklists…'
                                        : 'Connecting to your computer…'}
                                </p>
                            )}
                        </div>
                    ) : sessions.length === 0 && allSessions.length > 0 ? (
                        <p className="py-12 text-center text-sm text-zinc-500">
                            Every session of this project is in the archive: open one from the
                            archive of the Dashboard.
                        </p>
                    ) : sessions.length === 0 ? (
                        <p className="py-12 text-center text-sm text-zinc-500">
                            No sessions yet. Checklists written by the agent will appear here.
                        </p>
                    ) : (
                        <div className="flex flex-col gap-4">
                            {selectedSession?.message && (
                                <AgentMessage
                                    text={selectedSession.message.text}
                                    at={selectedSession.message.at}
                                    {...(isGuest && { from: owner })}
                                />
                            )}
                            {checklists.length === 0 && (
                                <p className="py-8 text-center text-sm text-zinc-500">
                                    No checklists in this session yet.
                                </p>
                            )}
                            {checklists.length > 0 && (
                                <div className="flex items-center justify-between gap-3">
                                    <p className="text-sm text-zinc-600 dark:text-zinc-400">
                                        {toReview === 0
                                            ? 'Nothing left to review'
                                            : `${toReview} to review`}
                                    </p>
                                    <span className="flex items-center gap-2">
                                        {sessionShares.length > 0 && (
                                            <Toggle
                                                variant="outline"
                                                size="sm"
                                                pressed={hideResults}
                                                onPressedChange={toggleHideResults}
                                                className="rounded-lg px-3 text-zinc-700 data-[state=on]:border-zinc-900 data-[state=on]:bg-zinc-900 data-[state=on]:text-white dark:text-zinc-300 dark:data-[state=on]:border-zinc-100 dark:data-[state=on]:bg-zinc-100 dark:data-[state=on]:text-zinc-900"
                                            >
                                                Hide results
                                            </Toggle>
                                        )}
                                        <Toggle
                                            variant="outline"
                                            size="sm"
                                            pressed={hideReviewed}
                                            onPressedChange={toggleHideReviewed}
                                            className="rounded-lg px-3 text-zinc-700 data-[state=on]:border-zinc-900 data-[state=on]:bg-zinc-900 data-[state=on]:text-white dark:text-zinc-300 dark:data-[state=on]:border-zinc-100 dark:data-[state=on]:bg-zinc-100 dark:data-[state=on]:text-zinc-900"
                                        >
                                            Hide reviewed
                                        </Toggle>
                                    </span>
                                </div>
                            )}
                            {shownLists.map(({ checklist, items }) => {
                                if (checklist.kind === 'choice') {
                                    return (
                                        <ChoiceCarousel
                                            key={checklist.id}
                                            title={checklist.title}
                                            pick={checklist.pick}
                                            options={items}
                                            onChange={(item, change) => {
                                                onItemChange(checklist.sessionId, item.id, change);
                                                // Answered: the question waits a few seconds
                                                // before it goes last, for a note.
                                                if (change.status === null)
                                                    countdowns.stop(item.id);
                                                else if (change.status && hideReviewed) {
                                                    countdowns.start(item.id);
                                                }
                                            }}
                                            onAddOption={(text) =>
                                                onAddItem(checklist.sessionId, {
                                                    itemId: createId(),
                                                    checklistId: checklist.id,
                                                    text,
                                                    order:
                                                        Math.max(
                                                            -1,
                                                            ...items.map((item) => item.order),
                                                        ) + 1,
                                                })
                                            }
                                            onRemoveOption={(item) =>
                                                onRemoveItem(checklist.sessionId, item.id)
                                            }
                                            confirm={confirm}
                                        />
                                    );
                                }
                                return (
                                    <ChecklistCard
                                        key={checklist.id}
                                        checklist={checklist}
                                        items={items}
                                        visible={items.filter(isVisible)}
                                        countdowns={countdowns.runs}
                                        hideDelayMs={hideDelayMs}
                                        onChange={(item, change) =>
                                            changeItem(checklist.sessionId, item, change)
                                        }
                                        onEditingChange={setEditing}
                                        readOnly={readOnly}
                                        outcomes={hideResults ? undefined : outcomes}
                                        onRemove={(item) =>
                                            onRemoveItem(checklist.sessionId, item.id)
                                        }
                                        canAdd={!isGuest}
                                        onAdd={(text) =>
                                            onAddItem(checklist.sessionId, {
                                                itemId: createId(),
                                                checklistId: checklist.id,
                                                text,
                                                order:
                                                    Math.max(
                                                        -1,
                                                        ...items.map((item) => item.order),
                                                    ) + 1,
                                            })
                                        }
                                        confirm={confirm}
                                    />
                                );
                            })}
                            {selectedSession && state && (
                                <NoteForAgent
                                    note={selectedSession.note ?? ''}
                                    delivered={
                                        !hasUndeliveredSessionNote(state, selectedSession.id)
                                    }
                                    onSave={(note) => onSessionNote(selectedSession.id, note)}
                                    readOnly={readOnly}
                                    {...(isGuest && { to: owner })}
                                />
                            )}
                            {!hideResults && <PeopleResults people={sessionShares} now={now} />}
                            {selectedSession &&
                                onDone &&
                                !readOnly &&
                                (checklists.length > 0 || selectedSession.message) && (
                                    <ReviewDone
                                        done={selectedSession.done === true}
                                        online={status === 'online'}
                                        toReview={toReview}
                                        waiting={
                                            isGuest || snapshot.waiting === null
                                                ? undefined
                                                : snapshot.waiting.includes(selectedSession.id)
                                        }
                                        {...(isGuest && { owner })}
                                        onMark={() => onDone(selectedSession.id)}
                                        confirm={confirm}
                                    />
                                )}
                        </div>
                    )}
                </main>
            </div>
        </ImagesProvider>
    );
}

/** When the computer last confirmed what is on screen (the app may show it from the cache). */
function LastSynced({ at }: { at: number | null }) {
    const now = useNow();
    if (at === null) return null;
    return <> Last synced {formatSyncedAt(at, now)}.</>;
}

/** Projects removed on the computer look like a computer that is off: the relay cannot tell. */
function RemovedProjectHint({ onRemove }: { onRemove: () => void }) {
    return (
        <p className="mt-2 text-xs opacity-80">
            If that computer is gone for good (or you deleted the palmtop folder on it), it will not
            come back.{' '}
            <button type="button" onClick={onRemove} className="py-2 font-medium underline">
                Remove from this device
            </button>
        </p>
    );
}
