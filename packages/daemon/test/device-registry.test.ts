import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DeviceRegistry } from '../src';
import { createTempHome } from './helpers';

const phone = { deviceId: 'phone1', name: 'iPhone · Safari', publicKey: 'A'.repeat(43) };
const tablet = { deviceId: 'tablet1', name: 'iPad · Safari', publicKey: 'B'.repeat(43) };

describe('DeviceRegistry', () => {
    let home: string;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
        ({ home, cleanup } = await createTempHome());
    });
    afterEach(() => cleanup());

    test('a write that fails does not keep later writes from working', async () => {
        const folder = join(home, 'later');
        const registry = await DeviceRegistry.open(join(folder, 'devices.json'));

        // The folder is missing: the write fails, and the device is not believed to be paired.
        await expect(registry.add(phone)).rejects.toThrow();
        expect(registry.get('phone1')).toBeNull();

        // The problem goes away: the next write works, and so does `seen`.
        await mkdir(folder);
        await registry.add(tablet);
        await registry.seen('tablet1');
        const saved = JSON.parse(await readFile(join(folder, 'devices.json'), 'utf8')) as {
            devices: Array<{ deviceId: string }>;
        };
        expect(saved.devices.map((device) => device.deviceId)).toEqual(['tablet1']);
    });

    test('a failed write leaves the registry as the file says', async () => {
        const folder = join(home, 'devices');
        await mkdir(folder);
        const registry = await DeviceRegistry.open(join(folder, 'devices.json'));
        await registry.add(phone);

        await rm(folder, { recursive: true });
        await expect(registry.remove('phone1')).rejects.toThrow();
        expect(registry.get('phone1')).not.toBeNull();
        await expect(registry.add(tablet)).rejects.toThrow();
        expect(registry.get('tablet1')).toBeNull();
    });
});
