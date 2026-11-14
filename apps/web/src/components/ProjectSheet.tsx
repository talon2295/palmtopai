import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    Drawer,
    DrawerContent,
    DrawerDescription,
    DrawerHeader,
    DrawerTitle,
} from '@/components/ui/drawer';
import { formatSyncedAt, useNow } from '@/lib/cache';
import type { PairedProject } from '@/lib/pairings';
import { cn } from '@/lib/utils';
import { PendingBadge, projectMeta } from './Dashboard';

/** A session as the sheet lists it. */
export interface SessionOption {
    id: string;
    title: string;
    lastActivityAt: number;
    /** Items in its checklists, and those still to review. */
    items: number;
    pending: number;
}

export type SheetLevel = 'projects' | 'sessions';

/**
 * The bottom sheet behind the breadcrumb: the projects of the open computer, and the sessions
 * of the open project, with what is known of each. Picking one closes it.
 */
export function ProjectSheet({
    level,
    onLevel,
    onClose,
    computerName,
    projects,
    selectedProjectId,
    projectName,
    sessions,
    selectedSessionId,
    onSelectProject,
    onSelectSession,
}: {
    /** `null` while closed. */
    level: SheetLevel | null;
    onLevel: (level: SheetLevel) => void;
    onClose: () => void;
    computerName: string | undefined;
    projects: PairedProject[];
    selectedProjectId: string | null;
    projectName: string;
    sessions: SessionOption[];
    selectedSessionId: string | null;
    onSelectProject: (projectId: string) => void;
    onSelectSession: (sessionId: string) => void;
}) {
    const now = useNow();

    return (
        <Drawer open={level !== null} onOpenChange={(open) => !open && onClose()}>
            <DrawerContent className="mx-auto max-w-2xl">
                {level === 'sessions' ? (
                    <>
                        <DrawerHeader className="items-center pt-2">
                            {/* On its own line: a long project name gets the whole width. */}
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => onLevel('projects')}
                                className="-ml-2 self-start text-emerald-700 hover:text-emerald-800 dark:text-emerald-300"
                            >
                                <ChevronLeft /> Projects
                            </Button>
                            <DrawerTitle className="line-clamp-2 break-words">
                                {projectName}
                            </DrawerTitle>
                            <DrawerDescription>Sessions</DrawerDescription>
                        </DrawerHeader>
                        <SheetList empty="No sessions yet. Checklists written by the agent will appear here.">
                            {sessions.map((session) => (
                                <SheetRow
                                    key={session.id}
                                    selected={session.id === selectedSessionId}
                                    title={session.title}
                                    meta={[
                                        formatSyncedAt(session.lastActivityAt, now),
                                        `${session.items} item${session.items === 1 ? '' : 's'}`,
                                    ].join(' · ')}
                                    pending={session.pending}
                                    onSelect={() => onSelectSession(session.id)}
                                />
                            ))}
                        </SheetList>
                    </>
                ) : (
                    <>
                        <DrawerHeader className="items-center">
                            <DrawerTitle>Projects</DrawerTitle>
                            <DrawerDescription>
                                {computerName ? `On ${computerName}` : 'On this computer'}
                            </DrawerDescription>
                        </DrawerHeader>
                        <SheetList empty="No projects on this computer yet.">
                            {projects.map((project) => (
                                <SheetRow
                                    key={project.id}
                                    selected={project.id === selectedProjectId}
                                    title={project.name}
                                    meta={projectMeta(project, now)}
                                    pending={project.pending}
                                    onSelect={() => onSelectProject(project.id)}
                                    // The sessions of the open project are one level down.
                                    {...(project.id === selectedProjectId && {
                                        onMore: () => onLevel('sessions'),
                                    })}
                                />
                            ))}
                        </SheetList>
                    </>
                )}
            </DrawerContent>
        </Drawer>
    );
}

function SheetList({ empty, children }: { empty: string; children: React.ReactNode[] }) {
    return (
        <div className="overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            {children.length === 0 ? (
                <p className="py-6 text-center text-sm text-zinc-500">{empty}</p>
            ) : (
                <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
                    {children}
                </ul>
            )}
        </div>
    );
}

function SheetRow({
    selected,
    title,
    meta,
    pending,
    onSelect,
    onMore,
}: {
    selected: boolean;
    title: string;
    meta: string;
    pending: number | undefined;
    onSelect: () => void;
    onMore?: () => void;
}) {
    return (
        <li className={cn('flex items-center', selected && 'bg-zinc-100 dark:bg-zinc-800/70')}>
            <button
                type="button"
                aria-current={selected || undefined}
                onClick={onSelect}
                className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left"
            >
                <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 font-medium break-words">{title}</span>
                    {meta && <span className="block text-xs text-zinc-500">{meta}</span>}
                </span>
                <PendingBadge count={pending} />
            </button>
            {onMore && (
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Sessions of ${title}`}
                    onClick={onMore}
                    className="mr-1"
                >
                    <ChevronRight />
                </Button>
            )}
        </li>
    );
}
