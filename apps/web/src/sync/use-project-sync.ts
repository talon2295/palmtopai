import {
    SyncClient as Client,
    type ClientCache,
    type SyncClient,
    type SyncSnapshot,
} from '@palmtopai/client';
import { RELAY_DEVICE_PATH, ROOM_QUERY_PARAM, STATS_ID_QUERY_PARAM } from '@palmtopai/protocol';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { getStatsId } from '../lib/device';
import type { DeviceIdentity } from '../lib/identity';
import type { Pairing } from '../lib/pairings';

/**
 * The web app is served by the relay: devices connect to the computer's room on the same host,
 * with the anonymous stats id of this device.
 */
export function deviceSocketUrl(
    location: Pick<Location, 'protocol' | 'host'>,
    roomId: string,
    statsId: string = getStatsId(),
): string {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const query = new URLSearchParams({
        [ROOM_QUERY_PARAM]: roomId,
        [STATS_ID_QUERY_PARAM]: statsId,
    });
    return `${scheme}://${location.host}${RELAY_DEVICE_PATH}?${query.toString()}`;
}

/**
 * One live SyncClient per paired computer, reconnecting when the device wakes up or goes
 * online. Changing project keeps the same connection. Without a project the client still
 * connects: it receives the computer's project list, which fills as soon as the agent starts a
 * session. With a `cache`, projects and queued edits survive a restart of the app.
 */
export function useProjectSync(
    pairing: Pairing,
    projectId: string | null,
    identity: DeviceIdentity,
    cache?: ClientCache,
): { client: SyncClient; snapshot: SyncSnapshot } {
    // The project is not part of the identity: `follow` moves the same client to another one.
    const initialProjectId = useRef(projectId);
    // A new client only for another computer key: the pairing object changes with every list.
    const { roomId, computerKey } = pairing;
    const client = useMemo(
        () =>
            new Client({
                url: deviceSocketUrl(window.location, roomId),
                ...(initialProjectId.current && { projectId: initialProjectId.current }),
                identity: identityFor({ roomId, computerKey }, identity),
                ...(cache && { cache }),
            }),
        [roomId, computerKey, identity, cache],
    );

    useEffect(() => {
        client.follow(projectId);
    }, [client, projectId]);

    useEffect(() => {
        client.start();
        client.setVisible(document.visibilityState === 'visible');
        const wake = () => {
            const visible = document.visibilityState === 'visible';
            client.setVisible(visible);
            if (visible) client.reconnectNow();
        };
        document.addEventListener('visibilitychange', wake);
        window.addEventListener('online', wake);
        return () => {
            document.removeEventListener('visibilitychange', wake);
            window.removeEventListener('online', wake);
            client.stop();
        };
    }, [client]);

    const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
    return { client, snapshot };
}

/** What a connection to a paired computer proves, and expects the computer to prove. */
export function identityFor(
    pairing: Pick<Pairing, 'roomId' | 'computerKey'>,
    identity: DeviceIdentity,
) {
    return {
        roomId: pairing.roomId,
        deviceId: identity.deviceId,
        deviceKey: identity.keys.privateKey,
        computerKey: pairing.computerKey,
    };
}
