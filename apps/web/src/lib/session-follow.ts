import type { Session } from '@palmtopai/protocol';

export interface FollowState {
    /** When true the selection jumps to the session with the most recent activity. */
    follow: boolean;
    selectedSessionId: string | null;
}

export type FollowAction =
    | { type: 'sessions'; sessions: Session[] }
    | { type: 'select'; sessionId: string; sessions: Session[] }
    | { type: 'follow'; sessions: Session[] };

export const initialFollowState: FollowState = { follow: true, selectedSessionId: null };

/** `sessions` must be sorted by `lastActivityAt` desc, as returned by `listSessions`. */
export function followReducer(state: FollowState, action: FollowAction): FollowState {
    const mostRecent = action.sessions[0]?.id ?? null;
    switch (action.type) {
        case 'sessions': {
            if (state.follow) {
                return state.selectedSessionId === mostRecent
                    ? state
                    : { ...state, selectedSessionId: mostRecent };
            }
            const stillExists = action.sessions.some((s) => s.id === state.selectedSessionId);
            return stillExists ? state : { ...state, selectedSessionId: mostRecent };
        }
        case 'select':
            // A manual choice pauses auto-follow until the user turns it back on.
            if (!action.sessions.some((s) => s.id === action.sessionId)) return state;
            return { follow: false, selectedSessionId: action.sessionId };
        case 'follow':
            return { follow: true, selectedSessionId: mostRecent };
    }
}
