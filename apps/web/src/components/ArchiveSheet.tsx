import { ArchiveRestore } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    Drawer,
    DrawerContent,
    DrawerDescription,
    DrawerHeader,
    DrawerTitle,
} from '@/components/ui/drawer';
import { formatSyncedAt } from '@/lib/cache';
import { isArchivedProject, type PairedProject, type Pairing } from '@/lib/pairings';

/** One project with sessions in the archive, under the computer it belongs to. */
export interface ArchivedGroup {
    pairing: Pairing;
    project: PairedProject;
    /** The computer is connected and knows the archive: sessions can come out of it. */
    canRestore: boolean;
}

/** The projects of these computers that have sessions in the archive, as the sheet lists them. */
export function archivedGroups(
    pairings: Pairing[],
    projectsOf: (pairing: Pairing) => PairedProject[],
    canRestore: (pairing: Pairing) => boolean,
): ArchivedGroup[] {
    return pairings.flatMap((pairing) =>
        projectsOf(pairing)
            .filter((project) => (project.archived?.length ?? 0) > 0)
            .map((project) => ({ pairing, project, canRestore: canRestore(pairing) })),
    );
}

/**
 * The sessions put in the archive, by computer and project. A session opens from here as it is
 * (it stays archived), or comes back to the Dashboard with Restore.
 */
export function ArchiveSheet({
    open,
    onOpenChange,
    groups,
    now,
    onOpenSession,
    onRestore,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    groups: ArchivedGroup[];
    now: number;
    onOpenSession: (computerId: string, projectId: string, sessionId: string) => void;
    /** `sessionIds` absent: every session of the project. */
    onRestore: (computerId: string, projectId: string, sessionIds?: string[]) => void;
}) {
    return (
        <Drawer open={open} onOpenChange={onOpenChange}>
            <DrawerContent>
                <div className="mx-auto w-full max-w-lg overflow-y-auto px-4 pb-8">
                    <DrawerHeader className="px-0 text-left">
                        <DrawerTitle>Archive</DrawerTitle>
                        <DrawerDescription>
                            Sessions you put away. They come back by themselves when the agent
                            writes to them.
                        </DrawerDescription>
                    </DrawerHeader>
                    {groups.length === 0 ? (
                        <p className="py-6 text-center text-sm text-zinc-500">
                            Nothing in the archive.
                        </p>
                    ) : (
                        <ul className="flex flex-col gap-3">
                            {groups.map(({ pairing, project, canRestore }) => (
                                <li
                                    key={`${pairing.computerId}:${project.id}`}
                                    aria-label={project.name}
                                    className="rounded-xl border border-zinc-200 dark:border-zinc-800"
                                >
                                    <div className="flex items-center gap-2 py-1 pr-1 pl-4">
                                        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                                            {pairing.computer
                                                ? `${pairing.computer} › ${project.name}`
                                                : project.name}
                                        </span>
                                        {isArchivedProject(project) && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                disabled={!canRestore}
                                                onClick={() =>
                                                    onRestore(pairing.computerId, project.id)
                                                }
                                            >
                                                Restore all
                                            </Button>
                                        )}
                                    </div>
                                    <ul className="divide-y divide-zinc-100 border-t border-zinc-100 dark:divide-zinc-800 dark:border-zinc-800">
                                        {project.archived?.map((session) => (
                                            <li key={session.id} className="flex items-center">
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        onOpenSession(
                                                            pairing.computerId,
                                                            project.id,
                                                            session.id,
                                                        )
                                                    }
                                                    className="min-w-0 flex-1 px-4 py-2.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                                                >
                                                    <span className="line-clamp-2 break-words">
                                                        {session.title}
                                                    </span>
                                                    <span className="block text-xs text-zinc-500">
                                                        {session.lastActivityAt
                                                            ? formatSyncedAt(
                                                                  session.lastActivityAt,
                                                                  now,
                                                              )
                                                            : ''}
                                                    </span>
                                                </button>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    aria-label={`Restore ${session.title}`}
                                                    title={
                                                        canRestore
                                                            ? 'Back to the Dashboard'
                                                            : 'The computer is not connected'
                                                    }
                                                    disabled={!canRestore}
                                                    onClick={() =>
                                                        onRestore(pairing.computerId, project.id, [
                                                            session.id,
                                                        ])
                                                    }
                                                    className="mr-1 shrink-0 text-zinc-600 dark:text-zinc-300"
                                                >
                                                    <ArchiveRestore className="size-4" />
                                                </Button>
                                            </li>
                                        ))}
                                    </ul>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </DrawerContent>
        </Drawer>
    );
}
