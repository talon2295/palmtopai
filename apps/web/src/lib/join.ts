import { pairKeySchema, roomIdSchema } from '@palmtopai/protocol';

export type JoinResult =
    | { kind: 'none' }
    /** A pairing link: a single-use key the device proves it holds, without sending it. */
    | { kind: 'pairing'; roomId: string; key: string }
    /**
     * An invitation to look at the checklists somebody shares: the same single-use key, for a room
     * of its own that holds those checklists and nothing of the computer.
     */
    | { kind: 'invite'; roomId: string; key: string }
    | { kind: 'invalid' };

/**
 * Parses `#pair?r=<roomId>&k=<key>` (the computer's room and a single-use pairing key) and
 * `#invite?r=&k=` (the room of a person it shares with, and the key of their invitation).
 */
export function parsePairFragment(hash: string): JoinResult {
    const kind = hash.startsWith('#pair')
        ? 'pairing'
        : hash.startsWith('#invite')
          ? 'invite'
          : null;
    if (!kind) return { kind: 'none' };
    const prefix = kind === 'pairing' ? '#pair' : '#invite';
    const params = new URLSearchParams(hash.slice(prefix.length).replace(/^\?/, ''));
    const roomId = params.get('r') ?? '';
    const key = params.get('k') ?? '';
    const valid = roomIdSchema.safeParse(roomId).success && pairKeySchema.safeParse(key).success;
    return valid ? { kind, roomId, key } : { kind: 'invalid' };
}

/**
 * Handles a pairing link on page load and removes it from the address bar and the history
 * entry, so nothing lingers in the URL, bookmarks or screenshots.
 */
export function consumeJoinLink(
    location: Pick<Location, 'hash' | 'pathname' | 'search'>,
    history: Pick<History, 'replaceState'>,
): JoinResult {
    const pairing = parsePairFragment(location.hash);
    if (pairing.kind === 'none') return pairing;
    // Nothing is stored yet: the key is redeemed over the relay, then the pairing is saved.
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    return pairing;
}
