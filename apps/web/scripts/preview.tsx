/**
 * Screenshots components of the app at phone width, without the daemon, the relay and a paired
 * device: the component is rendered to static HTML with the stylesheet of the last build, then
 * Chrome takes a picture of it in light and in dark.
 *
 *   bun run build:web                       # the stylesheet must be up to date
 *   bun run scripts/preview.tsx             # lists the scenes
 *   bun run scripts/preview.tsx checklist   # writes <out>/checklist-light.png and -dark.png
 *   bun run scripts/preview.tsx all --out ~/shots --width 520 --height 900
 *
 * Add what you are working on to SCENES at the bottom: that is the only part to edit. The page
 * is written inside `dist/app`, which is what the relay serves, and removed as soon as Chrome is
 * done.
 */

import { readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Checklist, type Item, joinNote } from '@palmtopai/protocol';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChecklistCard } from '../src/components/ChecklistCard';
import { ChoiceCarousel } from '../src/components/ChoiceCarousel';
import { Dashboard } from '../src/components/Dashboard';
import { ProjectView } from '../src/components/ProjectView';
import { ReviewDone } from '../src/components/ReviewDone';
import { AgentMessage, NoteForAgent } from '../src/components/SessionNotes';
import { PeopleResults, type PersonOutcome } from '../src/components/SharedOutcomes';
import { StorageNotice } from '../src/components/StorageNotice';

const dist = join(import.meta.dir, '..', 'dist', 'app');
const PAGE = join(dist, 'preview.html');
/** Chrome cannot shrink a headless window below ~500px: the scene is centred in a wider one. */
const DEFAULTS = { width: 520, height: 900, phone: 375 };

const CHROME = [
    'google-chrome-stable',
    'google-chrome',
    'chromium',
    'chromium-browser',
    'chrome',
] as const;

function chromePath(): string {
    for (const candidate of CHROME) {
        const found = Bun.which(candidate);
        if (found) return found;
    }
    throw new Error(`no Chrome found (tried ${CHROME.join(', ')})`);
}

function stylesheet(): string {
    const css = readdirSync(join(dist, 'assets')).find(
        (name) => name.startsWith('app-') && name.endsWith('.css'),
    );
    if (!css) throw new Error(`no app stylesheet in ${dist}/assets: run \`bun run build:web\``);
    return `./assets/${css}`;
}

function page(scene: ReactNode, phone: number): string {
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${stylesheet()}"></head>
<body class="bg-zinc-100 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
<div class="mx-auto flex w-[${phone}px] flex-col gap-4 p-4">${renderToStaticMarkup(scene)}</div>
</body></html>`;
}

/** One picture of the page, with the colour scheme forced (headless Chrome follows the system). */
function shoot(file: string, theme: 'light' | 'dark', size: { width: number; height: number }) {
    const result = Bun.spawnSync([
        chromePath(),
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        `--blink-settings=preferredColorScheme=${theme === 'light' ? 1 : 0}`,
        `--window-size=${size.width},${size.height}`,
        `--screenshot=${file}`,
        `file://${PAGE}`,
    ]);
    if (!result.success) {
        throw new Error(`chrome failed: ${result.stderr.toString().trim().split('\n').at(-1)}`);
    }
}

async function preview(name: string, scene: ReactNode, options: typeof DEFAULTS & { out: string }) {
    await Bun.write(PAGE, page(scene, options.phone));
    try {
        for (const theme of ['light', 'dark'] as const) {
            const file = join(options.out, `${name}-${theme}.png`);
            shoot(file, theme, options);
            console.log(file);
        }
    } finally {
        // `dist/app` is served by the relay: the page never stays there.
        await rm(PAGE, { force: true });
    }
}

// -- scenes -------------------------------------------------------------------------------------

const id = () => Math.random().toString(36).slice(2);

const item = (text: string, extra: Partial<Item> = {}): Item => ({
    id: id(),
    checklistId: 'c',
    text,
    order: 0,
    updatedAt: 1,
    updatedBy: 'palmtop-daemon',
    addedByUser: false,
    ...extra,
});

const noop = () => {};

/** What can be screenshot, by name. Edit, add and remove these freely. */
const SCENES: Record<string, () => ReactNode> = {
    checklist: () => {
        const checklist: Checklist = {
            id: 'c',
            sessionId: 's',
            title: 'Carosello sul telefono',
            createdAt: 1,
            updatedAt: 1,
            kind: 'checks',
            pick: 'one',
        };
        const items = [
            item('Le opzioni scorrono con lo swipe, con le frecce e con i puntini.'),
            item('La nota su un’opzione resta dopo aver chiuso e riaperto la app.', {
                status: 'done',
                note: 'Ok, e si riapre dalla riga.',
            }),
            item('Il dettaglio di ogni opzione si legge sotto il titolo.'),
        ];
        return (
            <ChecklistCard
                checklist={checklist}
                items={items}
                visible={items}
                countdowns={new Map()}
                hideDelayMs={5_000}
                onChange={noop}
                onEditingChange={noop}
                onRemove={noop}
                onAdd={noop}
            />
        );
    },

    // What the owner sees when the checklist is shared with two people.
    shared: () => {
        const checklist: Checklist = {
            id: 'c',
            sessionId: 's',
            title: 'Login',
            createdAt: 1,
            updatedAt: 1,
            kind: 'checks',
            pick: 'one',
        };
        const first = item('Right password opens the dashboard', { status: 'done' });
        const second = item('Wrong password shows an error', { status: 'done' });
        const third = item('Logout clears the session');
        const items = [first, second, third];
        const answers: Record<string, PersonOutcome[]> = {
            [first.id]: [
                { person: 'Mario', status: 'done', state: 'open' },
                { person: 'Luca', status: 'done', state: 'open' },
            ],
            [second.id]: [
                { person: 'Mario', status: 'done', state: 'open' },
                {
                    person: 'Luca',
                    status: 'cancelled',
                    note: 'No error is shown, the page just reloads.',
                    state: 'open',
                },
            ],
            [third.id]: [
                { person: 'Mario', state: 'open' },
                { person: 'Luca', status: 'question', note: 'Which session?', state: 'open' },
            ],
        };
        return (
            <>
                <ChecklistCard
                    checklist={checklist}
                    items={items}
                    visible={items}
                    countdowns={new Map()}
                    hideDelayMs={5_000}
                    onChange={noop}
                    onEditingChange={noop}
                    onRemove={noop}
                    onAdd={noop}
                    outcomes={new Map(Object.entries(answers))}
                />
                <PeopleResults
                    now={Date.now()}
                    people={[
                        {
                            name: 'Mario',
                            state: 'open',
                            expiresAt: Date.now() + 5 * 86_400_000,
                            items: {},
                            additions: [
                                {
                                    checklist: 'Login',
                                    text: 'Also try Safari',
                                    status: 'cancelled',
                                },
                            ],
                            note: 'Looks fine otherwise.',
                        },
                        { name: 'Luca', state: 'closed', expiresAt: 1, items: {}, additions: [] },
                    ]}
                />
            </>
        );
    },

    // What the person sees on their copy: the owner's message, the checklist, a note for the owner.
    // The end of a review: the button, offline, and once pressed.
    done: () => (
        <div className="flex flex-col gap-4 p-4">
            <ReviewDone done={false} online toReview={3} onMark={noop} confirm={() => true} />
            <ReviewDone done={false} online={false} toReview={3} onMark={noop} />
            <ReviewDone done={false} online waiting={false} toReview={3} onMark={noop} />
            <ReviewDone done online toReview={0} onMark={noop} />
        </div>
    ),

    // The note for the agent as a list, with an element that has a link and a long one.
    'note-list': () => (
        <NoteForAgent
            delivered={false}
            onSave={noop}
            note={joinNote([
                { id: 'k3f9', text: 'The header is wrong on mobile' },
                {
                    id: 'a81x',
                    text: 'Compare with https://staging.example.com/home\nafter the fix',
                },
                { id: 'b2c4', text: 'Footer links point to the old domain' },
            ])}
        />
    ),

    // Addresses in the agent message, in items, in notes and under a person's answer.
    links: () => {
        const checklist: Checklist = {
            id: 'c',
            sessionId: 's',
            title: 'Staging',
            createdAt: 1,
            updatedAt: 1,
            kind: 'checks',
            pick: 'one',
        };
        const items = [
            item('Open https://staging.example.com/login and sign in.'),
            item('The footer links to the privacy page', {
                status: 'cancelled',
                note: 'Broken: https://staging.example.com/privacy (404).',
            }),
            item('Check the (new) pricing at https://example.com/pricing.', {
                addedByUser: true,
            }),
        ];
        return (
            <>
                <AgentMessage
                    at={Date.now()}
                    text="Ready on https://staging.example.com. Start from the login page."
                />
                <ChecklistCard
                    checklist={checklist}
                    items={items}
                    visible={items}
                    countdowns={new Map()}
                    hideDelayMs={5_000}
                    onChange={noop}
                    onEditingChange={noop}
                    onRemove={noop}
                    onAdd={noop}
                />
                <NoteForAgent
                    note="Also see https://example.com/report?id=42"
                    delivered={false}
                    onSave={noop}
                />
            </>
        );
    },

    markdown: () => {
        const checklist: Checklist = {
            id: 'c',
            sessionId: 's',
            title: 'Login on staging',
            createdAt: 1,
            updatedAt: 1,
            kind: 'checks',
            pick: 'one',
        };
        const items = [
            item('Wrong password shows an error on the login page'),
            item(
                'Sign in with the test account\n\nYou land on the dashboard. Reset the data first, then reload:\n\n```\nbun run seed --reset && bun run dev\n```\n\nThen check **three** things:\n- the greeting uses `displayName`\n- the *last login* date is today\n- https://staging.example.com/account opens',
            ),
            item('```\nbun run dev\n```'),
            item('Run this one-liner first:\n\n```\nbun run seed --reset && bun run dev\n```'),
            item('Read the [release notes](https://example.com/notes/0.25) first', {
                status: 'done',
                note: 'Done, with *stars* and `ticks` kept as I typed them.',
            }),
            item('Check *this* and `that` (added by you)', { addedByUser: true }),
        ];
        const options = [
            item('**Redis**', {
                detail: 'One more service. Start it with:\n\n```\nredis-server\n```',
            }),
            item('In memory, per process'),
        ];
        return (
            <>
                <AgentMessage
                    at={Date.now()}
                    text={
                        '5 checks ready\n1. Update the app and reopen it\n2. Run `palmtop status`\n3. Tell me when you are done'
                    }
                />
                <ChecklistCard
                    checklist={checklist}
                    items={items}
                    visible={items}
                    countdowns={new Map()}
                    hideDelayMs={5_000}
                    onChange={noop}
                    onEditingChange={noop}
                    onRemove={noop}
                    onAdd={noop}
                />
                <ChoiceCarousel
                    title="Which `cache`?"
                    pick="one"
                    options={options}
                    onChange={noop}
                    onAddOption={noop}
                    onRemoveOption={noop}
                />
            </>
        );
    },

    guest: () => {
        const checklist: Checklist = {
            id: 'c',
            sessionId: 's',
            title: 'Login',
            createdAt: 1,
            updatedAt: 1,
            kind: 'checks',
            pick: 'one',
        };
        const items = [
            item('Right password opens the dashboard', { status: 'done' }),
            item('Wrong password shows an error', {
                status: 'cancelled',
                note: 'No error is shown.',
            }),
            item('Logout clears the session'),
        ];
        return (
            <>
                <AgentMessage
                    from="Grace (studio)"
                    at={Date.now()}
                    text="Please start with the login: that is what changed."
                />
                <ChecklistCard
                    checklist={checklist}
                    items={items}
                    visible={items}
                    countdowns={new Map()}
                    hideDelayMs={5_000}
                    onChange={noop}
                    onEditingChange={noop}
                    onRemove={noop}
                    onAdd={noop}
                />
                <NoteForAgent to="Grace (studio)" note="" delivered={false} onSave={noop} />
            </>
        );
    },

    keylost: () => {
        const projects = [
            {
                id: 'p1',
                name: 'mappa-3d',
                lastActivityAt: Date.now() - 3_600_000,
                sessions: 1,
                pending: 8,
            },
            { id: 'p2', name: 'palmtopai', lastActivityAt: Date.now() - 7_200_000, sessions: 6 },
        ];
        return (
            <Dashboard
                pairings={[
                    {
                        computerId: 'a',
                        roomId: 'r',
                        computerKey: 'k',
                        computer: 'ada-laptop',
                        projects,
                        pairedAt: 1,
                    },
                    {
                        computerId: 'b',
                        roomId: 's',
                        computerKey: 'l',
                        computer: 'Mac-mini',
                        projects: [],
                        pairedAt: 2,
                    },
                ]}
                live={{
                    a: { status: 'unauthorized', unauthorizedReason: 'key' },
                    b: { status: 'unauthorized', unauthorizedReason: 'not-paired' },
                }}
                notice={
                    <StorageNotice
                        kind="cleared"
                        guestOnly={false}
                        installed
                        platform="android"
                        onDismiss={noop}
                    />
                }
                onOpenProject={noop}
                onOpenComputer={noop}
                onFollow={noop}
                onUnpair={noop}
                onUpdate={noop}
            />
        );
    },

    archive: () => {
        const projects = [
            {
                id: 'p1',
                name: 'mappa-3d',
                lastActivityAt: Date.now() - 3_600_000,
                sessions: 2,
                pending: 8,
            },
            { id: 'p2', name: 'palmtopai', lastActivityAt: Date.now() - 7_200_000, sessions: 6 },
            {
                id: 'p3',
                name: 'old-site',
                lastActivityAt: 0,
                sessions: 0,
                pending: 0,
                archived: [
                    { id: 's1', title: 'Landing page', lastActivityAt: Date.now() - 86_400_000 },
                ],
            },
        ];
        return (
            <Dashboard
                pairings={[
                    {
                        computerId: 'a',
                        roomId: 'r',
                        computerKey: 'k',
                        computer: 'ada-laptop',
                        projects,
                        pairedAt: 1,
                    },
                ]}
                live={{ a: { status: 'online', protocol: 5, projects } }}
                notifications={{ on: true, onToggle: noop }}
                archive={{ can: () => true, set: noop, openSession: noop }}
                onOpenProject={noop}
                onOpenComputer={noop}
                onFollow={noop}
                onUnpair={noop}
            />
        );
    },

    'keylost-project': () => (
        <ProjectView
            snapshot={{
                status: 'unauthorized',
                unauthorizedReason: 'key',
                projectId: null,
                project: null,
                computer: null,
                projects: [],
                state: null,
                shares: [],
                seq: 0,
                pendingCount: 0,
                lastError: null,
                daemonProtocol: null,
                syncedAt: null,
            }}
            fallbackName="mappa-3d"
            computerName="ada-laptop"
            keyLost
            notice={
                <StorageNotice
                    kind="at-risk"
                    guestOnly={false}
                    installed={false}
                    platform="android"
                    onDismiss={noop}
                />
            }
            onItemChange={noop}
            onAddItem={noop}
            onRemoveItem={noop}
            onSessionNote={noop}
            onRemoveSession={noop}
            onDismissError={noop}
            onUnpair={noop}
        />
    ),

    choice: () => (
        <ChoiceCarousel
            title="Quale cache per la coda offline?"
            pick="one"
            options={[
                item('IndexedDB', {
                    detail: 'La coda sopravvive alla chiusura della app. Uno schema in più da migrare.',
                }),
                item('Solo in memoria', {
                    detail: 'Il più semplice, ma la coda si perde quando la app si chiude.',
                }),
            ]}
            onChange={noop}
            onAddOption={noop}
            onRemoveOption={noop}
        />
    ),

    answered: () => (
        <ChoiceCarousel
            title="Quale cache per la coda offline?"
            pick="one"
            options={[
                item('IndexedDB', { status: 'done', note: 'Sì, e teniamo la coda piccola.' }),
                item('Solo in memoria', { status: 'cancelled' }),
            ]}
            onChange={noop}
            onAddOption={noop}
            onRemoveOption={noop}
        />
    ),
};

// -- arguments ----------------------------------------------------------------------------------

const names: string[] = [];
const flags: Record<string, string> = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith('--')) flags[arg.slice(2)] = argv[++i] ?? '';
    else names.push(arg);
}

const wanted = names.length === 0 || names[0] === 'all' ? Object.keys(SCENES) : names;
if (names.length === 0) console.log(`scenes: ${Object.keys(SCENES).join(', ')}, or "all"`);

const number = (name: keyof typeof DEFAULTS) => Number(flags[name] ?? DEFAULTS[name]);
const options = {
    out: flags.out ?? join(tmpdir(), 'palmtop-preview'),
    width: number('width'),
    height: number('height'),
    phone: number('phone'),
};

for (const name of wanted) {
    const scene = SCENES[name];
    if (!scene) throw new Error(`unknown scene "${name}": ${Object.keys(SCENES).join(', ')}`);
    await preview(name, scene(), options);
}
