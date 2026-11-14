import type { ConnectionStatus } from '@palmtopai/client';
import { useEffect, useState } from 'react';

/** Shorter "not live" states are not shown: reconnecting would otherwise blink in the badge. */
export const STATUS_SETTLE_MS = 300;

/**
 * How long to wait before showing `next` instead of `shown`: 0 for states the user must see
 * at once (live, not paired, the first status after start), `STATUS_SETTLE_MS` for the
 * transient ones (connecting, offline, computer offline).
 */
export function statusDelay(shown: ConnectionStatus, next: ConnectionStatus): number {
    if (next === shown) return 0;
    if (next === 'online' || next === 'unauthorized' || next === 'stopped') return 0;
    if (shown === 'stopped') return 0;
    return STATUS_SETTLE_MS;
}

/** The connection status to display, debounced as described in `statusDelay`. */
export function useDisplayedStatus(status: ConnectionStatus): ConnectionStatus {
    const [shown, setShown] = useState(status);
    const delay = statusDelay(shown, status);

    useEffect(() => {
        if (status === shown) return;
        if (delay === 0) {
            setShown(status);
            return;
        }
        const timer = setTimeout(() => setShown(status), delay);
        return () => clearTimeout(timer);
    }, [status, shown, delay]);

    return delay === 0 ? status : shown;
}
