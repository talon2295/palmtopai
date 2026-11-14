import type { ConnectionStatus } from '@palmtopai/client';
import { Badge } from '@/components/ui/badge';

const LABELS: Record<ConnectionStatus, string> = {
    connecting: 'Connecting',
    online: 'Live',
    offline: 'Offline',
    'daemon-offline': 'PC offline',
    unauthorized: 'Not paired',
    stopped: 'Stopped',
};

const DOT: Record<ConnectionStatus, string> = {
    connecting: 'bg-amber-400 animate-pulse',
    online: 'bg-emerald-500',
    offline: 'bg-zinc-400',
    'daemon-offline': 'bg-amber-500',
    unauthorized: 'bg-red-500',
    stopped: 'bg-zinc-400',
};

export function ConnectionBadge({
    status,
    pendingCount,
    guest = false,
    nothingShared = false,
    keyLost = false,
}: {
    status: ConnectionStatus;
    pendingCount: number;
    /** Looking at what somebody shares: it is their computer that is off, not "your PC". */
    guest?: boolean;
    /** A guest whose copies are all gone: the computer closes their room, it is not offline. */
    nothingShared?: boolean;
    /** This device no longer has the key it paired with: the browser deleted it. */
    keyLost?: boolean;
}) {
    const idle = guest && nothingShared && status === 'daemon-offline';
    return (
        <Badge
            variant="secondary"
            role="status"
            aria-live="polite"
            className="gap-1.5 px-2.5 py-1 text-zinc-700 dark:text-zinc-300"
        >
            <span
                className={`size-2 rounded-full ${idle ? 'bg-zinc-400' : keyLost ? 'bg-red-500' : DOT[status]}`}
                aria-hidden="true"
            />
            {keyLost
                ? 'Key lost'
                : idle
                  ? 'Nothing shared'
                  : guest && status === 'daemon-offline'
                    ? 'Owner offline'
                    : LABELS[status]}
            {pendingCount > 0 && (
                <span className="text-zinc-500 dark:text-zinc-400">· {pendingCount} unsynced</span>
            )}
        </Badge>
    );
}
