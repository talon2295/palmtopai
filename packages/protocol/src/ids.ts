import { monotonicFactory } from 'ulid';

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Generates ULIDs that stay sortable even when created within the same millisecond. */
export const createId: () => string = monotonicFactory();

export function isId(value: string): boolean {
    return ULID_PATTERN.test(value);
}

export { ULID_PATTERN };

/** Device ids starting with this prefix are reserved for ops authored by the daemon (the agent). */
export const RESERVED_DEVICE_PREFIX = 'palmtop-';

export function isReservedDeviceId(deviceId: string): boolean {
    return deviceId.startsWith(RESERVED_DEVICE_PREFIX);
}
