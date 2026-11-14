import { computerNameSchema } from '@palmtopai/protocol';
import type { Hono } from 'hono';
import { z } from 'zod';
import { parseBody } from './agent-api';
import { personNameSchema } from './people-store';

/** A person the owner shares with, as `palmtop people` lists it. Public facts only: no keys. */
export interface PersonView {
    name: string;
    /** The device they paired, once they opened their invitation. */
    device: {
        name: string;
        pairedAt: number;
        lastSeenAt: number | null;
        connected: boolean;
    } | null;
    /** The invitation still open, until when. */
    invitedUntil: number | null;
    /** Copies they can see now, among those they were given. */
    copies: { open: number; total: number };
}

/** An invitation: the link is a secret that opens once. Callers show it on a terminal only. */
export interface InviteResult {
    name: string;
    url: string;
    expiresAt: number;
    /** The person had a device, which is unpaired by this invitation. */
    replaced: boolean;
    warning?: string;
}

export interface PeopleApiOptions {
    list: () => PersonView[];
    invite: (name: string, replace: boolean) => Promise<InviteResult>;
    remove: (name: string) => Promise<PersonView>;
    /** `null`: no name set, the copies say "Shared checklists". */
    ownerName: () => string | null;
    setOwnerName: (name: string | null) => Promise<string | null>;
}

const bodies = {
    invite: z.object({ name: personNameSchema, replace: z.boolean().optional() }),
    ownerName: z.object({ name: computerNameSchema.nullable() }),
};

/**
 * Endpoints of the people checklists are shared with. `POST /people/invite` answers with the
 * link of the invitation, like `POST /pair/links` does for a pairing: only a terminal shows it.
 */
export function registerPeopleRoutes(app: Hono, options: PeopleApiOptions): void {
    app.get('/people', (c) => c.json({ people: options.list() }));

    app.post('/people/invite', async (c) => {
        const body = await parseBody(c, bodies.invite);
        return c.json(await options.invite(body.name, body.replace ?? false), 201);
    });

    app.delete('/people/:name', async (c) => c.json(await options.remove(c.req.param('name'))));

    app.get('/config/owner-name', (c) => c.json({ name: options.ownerName() }));

    app.put('/config/owner-name', async (c) => {
        const body = await parseBody(c, bodies.ownerName);
        return c.json({ name: await options.setOwnerName(body.name) });
    });
}
