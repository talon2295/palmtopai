import { deviceKeyFingerprint, loadDeviceKeys } from '@palmtopai/client';
import { type DeviceKeyPair, isE2ESupported } from '@palmtopai/protocol';
import { createContext, useContext, useEffect, useState } from 'react';
import { noteDeviceKey } from './device-key';

/** This device as computers know it: its id and its key pair (end-to-end encryption). */
export interface DeviceIdentity {
    deviceId: string;
    keys: DeviceKeyPair;
    /**
     * Fingerprint of the public key (`deviceKeyFingerprint`), kept with each pairing: another one
     * than a pairing's means the browser deleted the keys it was made with.
     */
    fingerprint?: string;
}

export type UnsupportedReason = 'insecure' | 'browser' | 'storage';

export type IdentityState =
    | { status: 'loading' }
    /**
     * palmtop can't encrypt here: the page is not on HTTPS (`insecure`, WebCrypto only exists in
     * a secure context), the browser lacks Ed25519 or X25519 (`browser`), or the keys of this
     * device can't be read or saved (`storage`: IndexedDB failing, the app may work after a
     * restart).
     */
    | { status: 'unsupported'; reason: UnsupportedReason }
    | { status: 'ready'; identity: DeviceIdentity };

/** Loads (or makes, the first time) the key pair of this device. */
export function useDeviceIdentity(
    deviceId: string,
    load: () => Promise<DeviceKeyPair> = loadDeviceKeys,
    supported: () => Promise<boolean> = isE2ESupported,
): IdentityState {
    const [state, setState] = useState<IdentityState>({ status: 'loading' });
    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (globalThis.isSecureContext === false) {
                return { status: 'unsupported', reason: 'insecure' } as const;
            }
            if (!(await supported())) return { status: 'unsupported', reason: 'browser' } as const;
            const keys = await load();
            const fingerprint = await deviceKeyFingerprint(keys.publicKey);
            noteDeviceKey(fingerprint);
            return { status: 'ready', identity: { deviceId, keys, fingerprint } } as const;
        })().then(
            (next) => {
                if (!cancelled) setState(next);
            },
            () => {
                // The browser can encrypt (checked above): what failed is its storage.
                if (!cancelled) setState({ status: 'unsupported', reason: 'storage' });
            },
        );
        return () => {
            cancelled = true;
        };
    }, [deviceId, load, supported]);
    return state;
}

const IdentityContext = createContext<DeviceIdentity | null>(null);

export const IdentityProvider = IdentityContext.Provider;

/** The identity of this device, for components that pair (`PairCode`). */
export function useIdentity(): DeviceIdentity {
    const identity = useContext(IdentityContext);
    if (!identity) throw new Error('useIdentity outside of IdentityProvider');
    return identity;
}
