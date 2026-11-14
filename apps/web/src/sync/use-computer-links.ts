import { SyncClient as Client, type SyncClient, type SyncSnapshot } from '@palmtopai/client';
import type { PushRegistration } from '@palmtopai/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveComputer } from '../components/Dashboard';
import { computerCache } from '../lib/cache';
import { markStorageCleared } from '../lib/device-key';
import type { DeviceIdentity } from '../lib/identity';
import { type Pairing, pairedProjectOf, rememberComputer } from '../lib/pairings';
import { deviceSocketUrl, identityFor } from './use-project-sync';

/**
 * One light connection to each paired computer that is not open: no project followed, only its
 * state and project list, for the Dashboard. Each also carries this device's notifications, so
 * every computer can notify it, not just the open one.
 */
export function useComputerLinks({
    pairings,
    openComputerId,
    identity,
    push,
    onPairings,
}: {
    pairings: Pairing[];
    /** The computer the open view is connected to on its own. */
    openComputerId: string | undefined;
    identity: DeviceIdentity;
    /** `undefined` while loading. */
    push: PushRegistration | null | undefined;
    onPairings: (pairings: Pairing[]) => void;
}): {
    live: Record<string, LiveComputer>;
    unpair: (computerId: string) => Promise<boolean>;
    /** Archives sessions on a computer that is not open (see `SyncClient.archive`). */
    archive: (
        computerId: string,
        projectId: string,
        archived: boolean,
        sessionIds?: string[],
    ) => boolean;
} {
    const clients = useRef(new Map<string, { computerKey: string; client: SyncClient }>());
    const [snapshots, setSnapshots] = useState<Record<string, SyncSnapshot>>({});
    const latestPush = useRef(push);
    latestPush.current = push;
    const latestOnPairings = useRef(onPairings);
    latestOnPairings.current = onPairings;

    const targets = pairings.filter((pairing) => pairing.computerId !== openComputerId);
    const latestTargets = useRef(targets);
    latestTargets.current = targets;
    // Connections change only with the set of computers (or a key), not on each list update.
    const key = targets.map((pairing) => `${pairing.computerId}:${pairing.computerKey}`).join(',');

    // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the targets.
    useEffect(() => {
        const wanted = new Map(
            latestTargets.current.map((pairing) => [pairing.computerId, pairing]),
        );
        for (const [computerId, entry] of clients.current) {
            if (wanted.get(computerId)?.computerKey === entry.computerKey) continue;
            entry.client.stop();
            clients.current.delete(computerId);
            setSnapshots(({ [computerId]: _, ...rest }) => rest);
        }
        for (const [computerId, pairing] of wanted) {
            if (clients.current.has(computerId)) continue;
            const client = new Client({
                url: deviceSocketUrl(window.location, pairing.roomId),
                identity: identityFor(pairing, identity),
            });
            let seen: SyncSnapshot['projects'] | null = null;
            client.subscribe(() => {
                const snapshot = client.getSnapshot();
                setSnapshots((current) => ({ ...current, [computerId]: snapshot }));
                // The computer refused the key of this device: the browser deleted the keys.
                if (snapshot.unauthorizedReason === 'key' && identity.fingerprint) {
                    markStorageCleared(identity.fingerprint);
                }
                // Remembered like the open computer's list: names and counts for later.
                if (snapshot.computer && snapshot.projects !== seen) {
                    seen = snapshot.projects;
                    latestOnPairings.current(
                        rememberComputer(computerId, {
                            computer: snapshot.computer.name,
                            deviceKey: identity.fingerprint,
                            projects: snapshot.projects.map(pairedProjectOf),
                        }),
                    );
                }
            });
            if (latestPush.current !== undefined) client.setPush(latestPush.current);
            client.setVisible(document.visibilityState === 'visible');
            client.start();
            clients.current.set(computerId, { computerKey: pairing.computerKey, client });
        }
    }, [key, identity]);

    // Every connection closes with the app.
    useEffect(() => {
        const current = clients.current;
        return () => {
            for (const entry of current.values()) entry.client.stop();
            current.clear();
        };
    }, []);

    useEffect(() => {
        if (push === undefined) return;
        for (const entry of clients.current.values()) entry.client.setPush(push);
    }, [push]);

    useEffect(() => {
        const wake = () => {
            const visible = document.visibilityState === 'visible';
            for (const entry of clients.current.values()) {
                entry.client.setVisible(visible);
                if (visible) entry.client.reconnectNow();
            }
        };
        document.addEventListener('visibilitychange', wake);
        window.addEventListener('online', wake);
        return () => {
            document.removeEventListener('visibilitychange', wake);
            window.removeEventListener('online', wake);
        };
    }, []);

    /**
     * Forgets a computer that is not open: the computer revokes this device (its key and its
     * notifications) if it is connected, and its copies on this device go. False when the
     * computer may still know this device (it was offline).
     */
    const unpair = useCallback(async (computerId: string) => {
        const entry = clients.current.get(computerId);
        let revoked = false;
        if (entry) {
            clients.current.delete(computerId);
            revoked =
                entry.client.getSnapshot().status === 'unauthorized' ||
                (await entry.client.unpair());
        }
        await computerCache(computerId)
            ?.clear()
            .catch(() => {});
        return revoked;
    }, []);

    const live: Record<string, LiveComputer> = {};
    for (const [computerId, snapshot] of Object.entries(snapshots)) {
        live[computerId] = {
            status: snapshot.status,
            unauthorizedReason: snapshot.unauthorizedReason,
            protocol: snapshot.daemonProtocol,
            ...(snapshot.computer && { projects: snapshot.projects }),
        };
    }
    const archive = useCallback(
        (computerId: string, projectId: string, archived: boolean, sessionIds?: string[]) =>
            clients.current.get(computerId)?.client.archive(projectId, archived, sessionIds) ??
            false,
        [],
    );
    return { live, unpair, archive };
}
