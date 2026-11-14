import { describe, expect, test } from 'bun:test';
import { compareStamps, createId, isId, LamportClock } from '../src';

describe('LamportClock', () => {
    test('tick increments and carries the device id', () => {
        const clock = new LamportClock('phone');
        expect(clock.tick()).toEqual({ lamport: 1, deviceId: 'phone' });
        expect(clock.tick()).toEqual({ lamport: 2, deviceId: 'phone' });
        expect(clock.lamport).toBe(2);
    });

    test('observe only moves forward', () => {
        const clock = new LamportClock('laptop', 5);
        clock.observe(3);
        expect(clock.lamport).toBe(5);
        clock.observe(10);
        expect(clock.tick().lamport).toBe(11);
    });
});

describe('compareStamps', () => {
    const opId = createId();

    test('orders by lamport first', () => {
        expect(
            compareStamps({ lamport: 1, deviceId: 'z', opId }, { lamport: 2, deviceId: 'a', opId }),
        ).toBeLessThan(0);
    });

    test('breaks lamport ties by device id, then op id', () => {
        expect(
            compareStamps(
                { lamport: 3, deviceId: 'laptop', opId },
                { lamport: 3, deviceId: 'phone', opId },
            ),
        ).toBeLessThan(0);
        const [first, second] = [createId(), createId()] as [string, string];
        expect(
            compareStamps(
                { lamport: 3, deviceId: 'phone', opId: second },
                { lamport: 3, deviceId: 'phone', opId: first },
            ),
        ).toBeGreaterThan(0);
        expect(
            compareStamps(
                { lamport: 3, deviceId: 'phone', opId },
                { lamport: 3, deviceId: 'phone', opId },
            ),
        ).toBe(0);
    });
});

describe('ids', () => {
    test('createId returns unique, sortable ULIDs', () => {
        const ids = Array.from({ length: 1_000 }, () => createId());
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.every(isId)).toBe(true);
        expect([...ids].sort()).toEqual(ids);
    });

    test('isId rejects non-ULID strings', () => {
        expect(isId('not-an-id')).toBe(false);
        expect(isId('01ARZ3NDEKTSV4RRFFQ69G5FAU')).toBe(false); // contains U
        expect(isId('01arz3ndektsv4rrffq69g5fav')).toBe(false); // lowercase
    });
});
