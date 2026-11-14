import type { Daemon } from '@palmtopai/daemon';
import { exportPublicKey, generateDeviceKeys } from '@palmtopai/protocol';
import type { DeviceIdentity, SocketLike } from '../src';

/** Keys of each test device, by home and device id: a restarted daemon still knows them. */
const known = new Map<string, Promise<DeviceIdentity>>();

/**
 * A device paired with the daemon, as a pairing would leave it: its key registered on the
 * computer, the computer's key pinned on the device.
 */
export function pairedIdentity(daemon: Daemon, deviceId: string): Promise<DeviceIdentity> {
    const id = `${daemon.home}:${deviceId}`;
    let identity = known.get(id);
    if (!identity) {
        identity = (async () => {
            const keys = await generateDeviceKeys();
            await daemon.paired.add({
                deviceId,
                name: `Test ${deviceId}`,
                publicKey: await exportPublicKey(keys.publicKey),
            });
            return {
                roomId: daemon.registry.roomId,
                deviceId,
                deviceKey: keys.privateKey,
                computerKey: daemon.registry.roomPublicKey,
            };
        })();
        known.set(id, identity);
    }
    return identity;
}

/** A device the computer has never seen: right room and computer key, unknown device key. */
export async function strangerIdentity(daemon: Daemon, deviceId: string): Promise<DeviceIdentity> {
    const keys = await generateDeviceKeys();
    return {
        roomId: daemon.registry.roomId,
        deviceId,
        deviceKey: keys.privateKey,
        computerKey: daemon.registry.roomPublicKey,
    };
}

/** For tests that script a fake daemon on a fake socket: no handshake, plain messages. */
export const plainTransport = (raw: SocketLike) => raw;

/** Placeholder identity for those tests: never used without the secure transport. */
export const scriptedIdentity = {
    roomId: 'r'.repeat(43),
    deviceId: 'phone',
    deviceKey: {} as CryptoKey,
    computerKey: 'k'.repeat(43),
} satisfies DeviceIdentity;
