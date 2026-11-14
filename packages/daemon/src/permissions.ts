import {
    getChecklist,
    getItem,
    isAddedByUser,
    isReservedDeviceId,
    listChecklists,
    listItems,
    type Op,
    type ProjectState,
    RESERVED_DEVICE_PREFIX,
} from '@palmtopai/protocol';

export { isReservedDeviceId, RESERVED_DEVICE_PREFIX };

/**
 * How far ahead of the room's own clock a device's op may be. A device that was offline is
 * behind, never far ahead; one that jumps would win every later write and, past 2^53, make the
 * daemon's own ops fail to validate.
 */
export const MAX_CLOCK_JUMP = 1_000_000;
/** Items the devices may add to one session: the people it is shared with included. */
export const MAX_DEVICE_ITEMS = 200;

export interface Rejection {
    code: 'forbidden';
    message: string;
}

function forbidden(message: string): Rejection {
    return { code: 'forbidden', message };
}

/**
 * Paired devices can review (status and note of an item), add items to a checklist (and change
 * the text of or remove the items added on devices), write the session note for the agent, mark
 * a session done and delete a session. Everything else (sessions, checklists, agent items, the agent message,
 * feedback deliveries) is authored by the agent through the Local API.
 */
export function authorizeDeviceOp(state: ProjectState, op: Op, deviceId: string): Rejection | null {
    if (op.projectId !== state.projectId) return forbidden('op targets another project');
    if (op.clock.deviceId !== deviceId) {
        return forbidden('op clock device id does not match the connection');
    }
    if (op.clock.lamport > state.lamport + MAX_CLOCK_JUMP) {
        return forbidden('op clock is too far ahead of the room');
    }
    switch (op.type) {
        case 'session.done': {
            // Only the user finishes a review; the computer takes it back when the agent writes.
            if (!op.payload.done) return forbidden('devices can only mark a session done');
            const session = state.sessions[op.sessionId];
            return session && !session.removed ? null : forbidden('unknown session');
        }

        case 'session.remove':
        case 'session.note': {
            const session = state.sessions[op.sessionId];
            return session && !session.removed ? null : forbidden('unknown session');
        }

        case 'item.add': {
            const { itemId, checklistId, status, note, origin } = op.payload;
            if (status !== undefined || note !== undefined) {
                return forbidden('items added on devices start without a review');
            }
            // Only the computer links a copy to the original: a device could pose as a copy.
            if (origin !== undefined) return forbidden('devices cannot copy items');
            // An existing id would let the add overwrite fields of another item.
            if (state.items[itemId]) return forbidden('item already exists');
            if (getChecklist(state, checklistId)?.sessionId !== op.sessionId) {
                return forbidden('unknown checklist in this session');
            }
            const added = listChecklists(state, op.sessionId)
                .flatMap((list) => listItems(state, list.id))
                .filter((item) => item.addedByUser).length;
            if (added >= MAX_DEVICE_ITEMS) return forbidden('too many items added on devices');
            return null;
        }

        case 'item.update':
        case 'item.remove': {
            const { itemId } = op.payload;
            const item = getItem(state, itemId);
            if (!item) return forbidden('unknown item');
            if (getChecklist(state, item.checklistId)?.sessionId !== op.sessionId) {
                return forbidden('op session does not match the item session');
            }
            const ownItem = isAddedByUser(state.items[itemId]);
            if (op.type === 'item.remove') {
                return ownItem ? null : forbidden('devices can only remove items added on devices');
            }
            if (op.payload.order !== undefined) return forbidden('devices cannot reorder items');
            if ((op.payload.text !== undefined || op.payload.detail !== undefined) && !ownItem) {
                return forbidden('devices can only change status and note of agent items');
            }
            return null;
        }

        default:
            return forbidden(`devices cannot send ${op.type}`);
    }
}
