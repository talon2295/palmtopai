import { readFile } from 'node:fs/promises';
import { deviceIdSchema, type PushRegistration, pushRegistrationSchema } from '@palmtopai/protocol';
import { z } from 'zod';
import { isErrnoException, writeFileAtomic } from './fs-utils';

const fileSchema = z.object({ devices: z.record(z.string(), z.unknown()) });

export interface PushTarget {
    deviceId: string;
    registration: PushRegistration;
}

/**
 * Push subscriptions of the devices paired with this computer, in `push.json` (mode 600). One
 * per device, valid for every project: a device pairs with the computer and is notified about
 * all of its work. They contain the device's VAPID private key: they stay on this computer and
 * are never part of the project state sent to devices.
 */
export class PushStore {
    readonly #path: string;
    readonly #devices: Map<string, PushRegistration>;
    #writes: Promise<void> = Promise.resolve();

    private constructor(path: string, devices: Map<string, PushRegistration>) {
        this.#path = path;
        this.#devices = devices;
    }

    /** Invalid entries (e.g. from another version) are skipped, never fatal. */
    static async open(path: string): Promise<PushStore> {
        const devices = new Map<string, PushRegistration>();
        let raw: unknown;
        try {
            raw = JSON.parse(await readFile(path, 'utf8'));
        } catch (error) {
            if (isErrnoException(error, 'ENOENT')) return new PushStore(path, devices);
            raw = null;
        }
        const parsed = fileSchema.safeParse(raw);
        if (parsed.success) {
            for (const [deviceId, value] of Object.entries(parsed.data.devices)) {
                if (!deviceIdSchema.safeParse(deviceId).success) continue;
                const registration = pushRegistrationSchema.safeParse(value);
                if (registration.success) devices.set(deviceId, registration.data);
            }
        }
        return new PushStore(path, devices);
    }

    /** Every device to notify about anything happening on this computer. */
    list(): PushTarget[] {
        return [...this.#devices].map(([deviceId, registration]) => ({ deviceId, registration }));
    }

    /** One subscription per browser: the same endpoint under another device id is replaced. */
    set(deviceId: string, registration: PushRegistration): Promise<void> {
        for (const [otherId, other] of this.#devices) {
            if (other.subscription.endpoint === registration.subscription.endpoint) {
                this.#devices.delete(otherId);
            }
        }
        this.#devices.set(deviceId, registration);
        return this.#save();
    }

    remove(deviceId: string): Promise<void> {
        if (!this.#devices.delete(deviceId)) return this.#writes;
        return this.#save();
    }

    /** Removes a subscription the push service reported as expired, whatever device holds it. */
    removeEndpoint(endpoint: string): Promise<void> {
        for (const [deviceId, registration] of this.#devices) {
            if (registration.subscription.endpoint === endpoint) return this.remove(deviceId);
        }
        return this.#writes;
    }

    #save(): Promise<void> {
        const data = `${JSON.stringify({ devices: Object.fromEntries(this.#devices) }, null, 4)}\n`;
        this.#writes = this.#writes
            .catch(() => undefined)
            .then(() => writeFileAtomic(this.#path, data));
        return this.#writes;
    }
}
