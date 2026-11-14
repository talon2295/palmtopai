import { readFile } from 'node:fs/promises';
import { deviceIdSchema, deviceNameSchema, type PairedDevice } from '@palmtopai/protocol';
import { z } from 'zod';
import { isErrnoException, writeFileAtomic } from './fs-utils';

const deviceSchema = z.object({
    deviceId: deviceIdSchema,
    name: deviceNameSchema,
    /** Raw Ed25519 public key, base64url: what the device proves at every connection. */
    publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    pairedAt: z.number().int().nonnegative(),
    lastSeenAt: z.number().int().nonnegative().nullable(),
});

const fileSchema = z.object({ devices: z.array(z.unknown()) });

export type RegisteredDevice = z.infer<typeof deviceSchema>;

/** `lastSeenAt` is written at most this often per device: it is shown, not used for security. */
const SEEN_WRITE_INTERVAL_MS = 60_000;

/**
 * The devices paired with this computer, in `devices.json` (mode 600): the public key each one
 * proves at every connection (end-to-end encryption, `e2e.ts`). There is no token any more: a
 * device removed from here can no longer connect. Public keys only, nothing secret.
 */
export class DeviceRegistry {
    readonly #path: string;
    readonly #devices: Map<string, RegisteredDevice>;
    readonly #now: () => number;
    #writes: Promise<void> = Promise.resolve();

    private constructor(path: string, devices: Map<string, RegisteredDevice>, now: () => number) {
        this.#path = path;
        this.#devices = devices;
        this.#now = now;
    }

    /** Invalid entries (e.g. from another version) are skipped, never fatal. */
    static async open(path: string, now: () => number = Date.now): Promise<DeviceRegistry> {
        const devices = new Map<string, RegisteredDevice>();
        let raw: unknown = null;
        try {
            raw = JSON.parse(await readFile(path, 'utf8'));
        } catch (error) {
            if (!isErrnoException(error, 'ENOENT') && !(error instanceof SyntaxError)) throw error;
        }
        const parsed = fileSchema.safeParse(raw);
        for (const value of parsed.success ? parsed.data.devices : []) {
            const device = deviceSchema.safeParse(value);
            if (device.success) devices.set(device.data.deviceId, device.data);
        }
        return new DeviceRegistry(path, devices, now);
    }

    list(): RegisteredDevice[] {
        return [...this.#devices.values()].sort((a, b) => a.pairedAt - b.pairedAt);
    }

    get(deviceId: string): RegisteredDevice | null {
        return this.#devices.get(deviceId) ?? null;
    }

    /** Registers a device that paired; pairing again with the same id replaces its key. */
    async add(device: PairedDevice): Promise<RegisteredDevice> {
        const registered: RegisteredDevice = {
            ...device,
            pairedAt: this.#now(),
            lastSeenAt: null,
        };
        await this.#write(device.deviceId, registered);
        return registered;
    }

    /** Puts back a registration as it was (a pairing that replaced it was abandoned). */
    restore(device: RegisteredDevice): Promise<void> {
        return this.#write(device.deviceId, device);
    }

    /** Forgets a device: it can't connect any more. True if it was registered. */
    async remove(deviceId: string): Promise<boolean> {
        if (!this.#devices.has(deviceId)) return false;
        await this.#write(deviceId, undefined);
        return true;
    }

    /** Notes that a device connected (shown by `palmtop devices`). */
    async seen(deviceId: string): Promise<void> {
        const device = this.#devices.get(deviceId);
        const now = this.#now();
        if (
            !device ||
            (device.lastSeenAt !== null && now - device.lastSeenAt < SEEN_WRITE_INTERVAL_MS)
        ) {
            return;
        }
        await this.#write(deviceId, { ...device, lastSeenAt: now });
    }

    /**
     * Changes one entry and saves. If the file cannot be written the entry goes back to what it
     * was: what the daemon believes is what the next start will find.
     */
    async #write(deviceId: string, value: RegisteredDevice | undefined): Promise<void> {
        const had = this.#devices.has(deviceId);
        const previous = this.#devices.get(deviceId);
        if (value === undefined) this.#devices.delete(deviceId);
        else this.#devices.set(deviceId, value);
        try {
            await this.#save();
        } catch (error) {
            if (had) this.#devices.set(deviceId, previous as RegisteredDevice);
            else this.#devices.delete(deviceId);
            throw error;
        }
    }

    #save(): Promise<void> {
        const data = `${JSON.stringify({ devices: this.list() }, null, 4)}\n`;
        const run = this.#writes.then(() => writeFileAtomic(this.#path, data));
        // One failed write must not make every later one fail: each caller sees its own.
        this.#writes = run.catch(() => undefined);
        return run;
    }
}
