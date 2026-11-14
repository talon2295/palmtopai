import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import type { pairDevice, SyncSnapshot, waitForPairing } from '@palmtopai/client';
import {
    applyAll,
    type Checklist,
    createId,
    createOp,
    createProjectState,
    DAEMON_PROTOCOL_VERSION,
    generateDeviceKeys,
    type Item,
    joinNote,
    type Op,
    type OpOf,
    type OpType,
    type ProjectState,
    screenshotToken,
    splitNote,
} from '@palmtopai/protocol';
import {
    act,
    cleanup,
    fireEvent,
    render,
    renderHook,
    screen,
    waitFor,
    within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { ChecklistCard } from '../src/components/ChecklistCard';
import { ChoiceCarousel, type ChoiceCarouselProps } from '../src/components/ChoiceCarousel';
import { Dashboard, projectMeta } from '../src/components/Dashboard';
import { EmptyState } from '../src/components/EmptyState';
import { FeedbackSheet } from '../src/components/FeedbackSheet';
import { InstallPrompt } from '../src/components/InstallPrompt';
import { ItemRow } from '../src/components/ItemRow';
import { Markdown } from '../src/components/Markdown';
import { PairCode } from '../src/components/PairCode';
import { ProjectView, type ProjectViewProps } from '../src/components/ProjectView';
import { AgentMessage, NoteForAgent } from '../src/components/SessionNotes';
import { PeopleResults } from '../src/components/SharedOutcomes';
import { StorageNotice } from '../src/components/StorageNotice';
import { STATUS_SETTLE_MS, statusDelay } from '../src/lib/displayed-status';
import { type DeviceIdentity, IdentityProvider, useDeviceIdentity } from '../src/lib/identity';
import { type ImagesApi, ImagesProvider } from '../src/lib/images';
import type { PairedProject, Pairing } from '../src/lib/pairings';
import { loadHideResults, loadHideReviewed } from '../src/lib/review-filter';

afterEach(() => {
    cleanup();
    localStorage.clear();
});

const baseItem: Item = {
    id: createId(),
    checklistId: createId(),
    text: 'Extract token service',
    order: 0,
    updatedAt: 1,
    updatedBy: 'palmtop-daemon',
    addedByUser: false,
};

describe('ItemRow', () => {
    test('a reviewed item shows only its status; tapping it opens the other choices', async () => {
        const onChange = mock();
        const onEditingChange = mock();
        render(
            <ItemRow
                item={{ ...baseItem, status: 'question' }}
                onChange={onChange}
                onEditingChange={onEditingChange}
            />,
        );

        const question = screen.getByRole('button', { name: 'Question' });
        expect(question.getAttribute('aria-pressed')).toBe('true');
        expect(question.getAttribute('aria-expanded')).toBe('false');
        expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();

        await userEvent.click(question);
        expect(onChange).not.toHaveBeenCalled();
        expect(onEditingChange).toHaveBeenLastCalledWith(true);
        expect(question.getAttribute('aria-expanded')).toBe('true');
        const done = screen.getByRole('button', { name: 'Done' });
        expect(done.getAttribute('aria-pressed')).toBe('false');

        // Another status keeps the note and closes the choices.
        await userEvent.click(done);
        expect(onEditingChange).toHaveBeenLastCalledWith(false);
        expect(onChange).toHaveBeenCalledWith({ status: 'done' });
        expect(screen.queryByRole('button', { name: 'Cancelled' })).toBeNull();
    });

    test('an unreviewed item shows every status and no note controls', async () => {
        const onChange = mock();
        render(<ItemRow item={baseItem} onChange={onChange} />);
        for (const name of ['Done', 'Cancelled', 'Question']) {
            expect(screen.getByRole('button', { name }).getAttribute('aria-pressed')).toBe('false');
        }
        expect(screen.queryByText('+ Add note')).toBeNull();
        expect(screen.queryByRole('textbox')).toBeNull();

        await userEvent.click(screen.getByRole('button', { name: 'Cancelled' }));
        expect(onChange).toHaveBeenCalledWith({ status: 'cancelled' });
    });

    test('the choices close on Escape, a tap outside and a reset from another device', async () => {
        const onChange = mock();
        const onEditingChange = mock();
        const row = (item: Item) => (
            <>
                <ItemRow item={item} onChange={onChange} onEditingChange={onEditingChange} />
                <p>outside</p>
            </>
        );
        const { rerender } = render(row({ ...baseItem, status: 'done' }));
        const done = screen.getByRole('button', { name: 'Done' });

        await userEvent.click(done);
        expect(screen.getByRole('button', { name: 'Question' })).toBeTruthy();
        await userEvent.keyboard('{Escape}');
        expect(screen.queryByRole('button', { name: 'Question' })).toBeNull();
        expect(onEditingChange).toHaveBeenLastCalledWith(false);

        await userEvent.click(done);
        await userEvent.click(screen.getByText('outside'));
        expect(screen.queryByRole('button', { name: 'Question' })).toBeNull();
        expect(onEditingChange).toHaveBeenLastCalledWith(false);

        await userEvent.click(done);
        expect(onEditingChange).toHaveBeenLastCalledWith(true);
        rerender(row(baseItem));
        await waitFor(() => expect(onEditingChange).toHaveBeenLastCalledWith(false));
        await userEvent.click(screen.getByRole('button', { name: 'Question' }));
        expect(onChange).toHaveBeenCalledWith({ status: 'question' });
        // Three openings and three closings; a status on an unreviewed item reports nothing.
        expect(onEditingChange).toHaveBeenCalledTimes(6);
    });

    test('tapping the status again once the choices are open resets it, no question without a note', async () => {
        const onChange = mock();
        const confirm = mock(() => true);
        render(
            <ItemRow
                item={{ ...baseItem, status: 'done' }}
                onChange={onChange}
                confirm={confirm}
            />,
        );
        await userEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(onChange).not.toHaveBeenCalled();
        await userEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(confirm).not.toHaveBeenCalled();
        expect(onChange).toHaveBeenCalledWith({ status: null });
    });

    test('resetting a status that has a note asks first', async () => {
        const onChange = mock();
        const item = { ...baseItem, status: 'cancelled' as const, note: 'not needed' };
        const { rerender } = render(
            <ItemRow item={item} onChange={onChange} confirm={() => false} />,
        );
        await userEvent.click(screen.getByRole('button', { name: 'Cancelled' }));
        await userEvent.click(screen.getByRole('button', { name: 'Cancelled' }));
        expect(onChange).not.toHaveBeenCalled();

        // Still open after saying no.
        rerender(<ItemRow item={item} onChange={onChange} confirm={() => true} />);
        await userEvent.click(screen.getByRole('button', { name: 'Cancelled' }));
        expect(onChange).toHaveBeenCalledWith({ status: null });
    });

    test('adding, editing and clearing a note', async () => {
        const onChange = mock();
        const { rerender } = render(
            <ItemRow item={{ ...baseItem, status: 'question' }} onChange={onChange} />,
        );

        await userEvent.click(screen.getByText('+ Add note'));
        await userEvent.type(screen.getByRole('textbox'), '  which limit?  ');
        await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
        expect(onChange).toHaveBeenLastCalledWith({ note: 'which limit?' });

        rerender(
            <ItemRow
                item={{ ...baseItem, status: 'question', note: 'which limit?' }}
                onChange={onChange}
            />,
        );
        await userEvent.click(screen.getByText('which limit?'));
        await userEvent.clear(screen.getByRole('textbox'));
        await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
        expect(onChange).toHaveBeenLastCalledWith({ note: null });
    });

    test('cancel or an unchanged note sends nothing', async () => {
        const onChange = mock();
        render(<ItemRow item={{ ...baseItem, status: 'done', note: 'ok' }} onChange={onChange} />);
        await userEvent.click(screen.getByText('ok'));
        await userEvent.type(screen.getByRole('textbox'), ' more');
        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await userEvent.click(screen.getByText('ok'));
        await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
        expect(onChange).not.toHaveBeenCalled();
    });

    test('a countdown bar is shown only while counting down', () => {
        const { rerender } = render(<ItemRow item={baseItem} onChange={mock()} />);
        expect(screen.queryByTestId('hide-countdown')).toBeNull();
        rerender(
            <ItemRow item={baseItem} onChange={mock()} countdown={{ run: 1, durationMs: 5_000 }} />,
        );
        const bar = screen.getByTestId('hide-countdown');
        expect(bar.style.animationDuration).toBe('5000ms');
        expect(bar.className).toContain('absolute');
    });

    test('opening and closing the note editor is reported', async () => {
        const onEditingChange = mock();
        render(
            <ItemRow
                item={{ ...baseItem, status: 'done' }}
                onChange={mock()}
                onEditingChange={onEditingChange}
            />,
        );
        expect(onEditingChange).not.toHaveBeenCalled();
        await userEvent.click(screen.getByText('+ Add note'));
        expect(onEditingChange).toHaveBeenLastCalledWith(true);
        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onEditingChange).toHaveBeenLastCalledWith(false);
        expect(onEditingChange).toHaveBeenCalledTimes(2);
    });

    test('an item added by the user can be edited and deleted; agent items cannot', async () => {
        const onChange = mock();
        const onRemove = mock();
        const onEditingChange = mock();
        const item = { ...baseItem, addedByUser: true };
        const { rerender } = render(
            <ItemRow
                item={item}
                onChange={onChange}
                onRemove={onRemove}
                onEditingChange={onEditingChange}
                confirm={() => true}
            />,
        );
        expect(screen.getByText('Added by you · tap to edit')).toBeTruthy();

        await userEvent.click(screen.getByRole('button', { name: `Edit ${item.text}` }));
        expect(onEditingChange).toHaveBeenLastCalledWith(true);
        // The status buttons make room for the editor.
        expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
        const textbox = screen.getByRole('textbox', { name: 'Text of the item' });
        await userEvent.clear(textbox);
        await userEvent.type(textbox, 'Check the logout too');
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(onChange).toHaveBeenCalledWith({ text: 'Check the logout too' });
        expect(onEditingChange).toHaveBeenLastCalledWith(false);

        await userEvent.click(screen.getByRole('button', { name: `Edit ${item.text}` }));
        await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
        expect(onRemove).toHaveBeenCalledTimes(1);

        rerender(<ItemRow item={baseItem} onChange={onChange} />);
        expect(screen.queryByText('Added by you · tap to edit')).toBeNull();
        expect(screen.queryByRole('button', { name: `Edit ${item.text}` })).toBeNull();
    });

    test('a remote note update does not overwrite text being typed', async () => {
        const item = { ...baseItem, status: 'question' as const, note: 'first' };
        const { rerender } = render(<ItemRow item={item} onChange={mock()} />);
        await userEvent.click(screen.getByText('first'));
        await userEvent.type(screen.getByRole('textbox'), ' draft');
        rerender(<ItemRow item={{ ...item, note: 'changed elsewhere' }} onChange={mock()} />);
        expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('first draft');
    });
});

describe('ChoiceCarousel', () => {
    const checklistId = createId();
    const option = (text: string, extra: Partial<Item> = {}): Item => ({
        id: createId(),
        checklistId,
        text,
        order: 0,
        updatedAt: 1,
        updatedBy: 'palmtop-daemon',
        addedByUser: false,
        ...extra,
    });

    /** Opens the deck when the question arrives already answered, so it shows only its row. */
    async function openDeck() {
        const row = screen.queryByRole('button', { expanded: false });
        if (row) await userEvent.click(row);
    }

    function carousel(options: Item[], props: Partial<ChoiceCarouselProps> = {}) {
        return (
            <ChoiceCarousel
                title="Which cache?"
                pick="one"
                options={options}
                onChange={mock()}
                onAddOption={mock()}
                onRemoveOption={mock()}
                confirm={() => true}
                closeDelayMs={20}
                {...props}
            />
        );
    }

    test('shows the question, one card at a time, with a dot per option and the own answer', () => {
        const options = [option('Redis', { detail: 'One more service' }), option('In memory')];
        render(carousel(options));

        expect(screen.getByRole('region', { name: 'Which cache?' })).toBeTruthy();
        expect(screen.getByText('Pick one')).toBeTruthy();
        const first = screen.getByRole('article', { name: 'Option 1 of 2' });
        expect(within(first).getByText('Redis')).toBeTruthy();
        expect(within(first).getByText('One more service')).toBeTruthy();
        expect(screen.getByRole('article', { name: 'Option 2 of 2' })).toBeTruthy();
        expect(screen.getByRole('article', { name: 'Your own answer' })).toBeTruthy();
        // Two options and the card of the own answer: three dots, the first one current.
        expect(screen.getByRole('button', { name: 'Option 1' }).getAttribute('aria-current')).toBe(
            'true',
        );
        expect(
            screen.getByRole('button', { name: 'Previous option' }).hasAttribute('disabled'),
        ).toBe(true);
        expect(screen.queryByTestId('close-countdown')).toBeNull();
    });

    test('the arrows and the dots move the deck', async () => {
        render(carousel([option('Redis'), option('In memory')]));
        await userEvent.click(screen.getByRole('button', { name: 'Next option' }));
        expect(screen.getByRole('button', { name: 'Option 2' }).getAttribute('aria-current')).toBe(
            'true',
        );
        await userEvent.click(screen.getByRole('button', { name: 'Your own answer' }));
        expect(screen.getByRole('button', { name: 'Next option' }).hasAttribute('disabled')).toBe(
            true,
        );
    });

    test('choosing one option refuses the one chosen before, and only in pick one', async () => {
        const chosen = option('Redis', { status: 'done' });
        const other = option('In memory');
        const onChange = mock();
        const { rerender } = render(carousel([chosen, other], { onChange }));
        await openDeck();

        await userEvent.click(
            within(screen.getByRole('article', { name: 'Option 2 of 2' })).getByRole('button', {
                name: 'Pick',
            }),
        );
        expect(onChange.mock.calls).toEqual([
            [chosen, { status: 'cancelled' }],
            [other, { status: 'done' }],
        ]);

        onChange.mockClear();
        rerender(carousel([chosen, other], { onChange, pick: 'any' }));
        await userEvent.click(
            within(screen.getByRole('article', { name: 'Option 2 of 2' })).getByRole('button', {
                name: 'Pick',
            }),
        );
        expect(onChange.mock.calls).toEqual([[other, { status: 'done' }]]);
    });

    test('tapping the answer again clears it, and a note is confirmed first', async () => {
        const answered = option('Redis', { status: 'done', note: 'with a short TTL' });
        const onChange = mock();
        const confirm = mock(() => false);
        const { rerender } = render(
            carousel([answered, option('In memory')], { onChange, confirm }),
        );
        await openDeck();
        const first = () =>
            within(screen.getByRole('article', { name: 'Option 1 of 2' })).getByRole('button', {
                name: 'Pick',
            });
        await userEvent.click(first());
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(onChange).not.toHaveBeenCalled();

        rerender(carousel([answered, option('In memory')], { onChange, confirm: () => true }));
        await userEvent.click(first());
        expect(onChange).toHaveBeenCalledWith(answered, { status: null });
    });

    test('an answered question is closed into a row with the chosen option, and opens again', async () => {
        const chosen = option('Redis', { status: 'done' });
        render(carousel([chosen, option('In memory', { status: 'cancelled' })]));

        // Closed on arrival: no cards, the question and its answer in a row.
        expect(screen.queryByRole('article', { name: 'Option 1 of 2' })).toBeNull();
        const row = screen.getByRole('button', { expanded: false });
        expect(row.textContent).toContain('Which cache?');
        expect(row.textContent).toContain('Redis');

        await userEvent.click(row);
        expect(screen.getByRole('article', { name: 'Option 1 of 2' })).toBeTruthy();
        // Opened by hand: it stays open, with no countdown running.
        expect(screen.queryByTestId('close-countdown')).toBeNull();
    });

    test('answering here keeps the deck open for a moment, then closes it', async () => {
        const first = option('Redis');
        const { rerender } = render(carousel([first, option('In memory')]));
        await userEvent.click(
            within(screen.getByRole('article', { name: 'Option 1 of 2' })).getByRole('button', {
                name: 'Pick',
            }),
        );
        // The answer comes back from the computer: the deck is still open, counting down.
        rerender(carousel([{ ...first, status: 'done' }, option('In memory')]));
        expect(screen.getByTestId('close-countdown')).toBeTruthy();
        expect(screen.getByRole('article', { name: 'Option 1 of 2' })).toBeTruthy();

        await waitFor(() => expect(screen.getByRole('button', { expanded: false })).toBeTruthy());
        expect(screen.queryByRole('article', { name: 'Option 1 of 2' })).toBeNull();
    });

    test('with pick any the deck closes only once every option has an answer', async () => {
        const chosen = option('One', { status: 'done' });
        const open = option('Two');
        const { rerender } = render(carousel([chosen, open], { pick: 'any' }));
        expect(screen.getByRole('article', { name: 'Option 1 of 2' })).toBeTruthy();

        rerender(carousel([chosen, { ...open, status: 'cancelled' }], { pick: 'any' }));
        expect(screen.getByRole('button', { expanded: false }).textContent).toContain('One');
    });

    test('a note can follow the answer, and the deck waits while it is written', async () => {
        const answered = option('Redis', { status: 'done' });
        const onChange = mock();
        render(carousel([answered, option('In memory')], { onChange }));
        await userEvent.click(screen.getByRole('button', { expanded: false }));

        await userEvent.click(screen.getByText('+ Add note'));
        await userEvent.type(
            screen.getByRole('textbox', { name: 'Note for Redis' }),
            'but keep the TTL short',
        );
        await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
        expect(onChange).toHaveBeenCalledWith(answered, { note: 'but keep the TTL short' });
    });

    test('the user writes an answer of their own, the deck moves to it, and it can be deleted', async () => {
        const onAddOption = mock();
        const onRemoveOption = mock();
        const options = [option('Redis'), option('In memory')];
        const mine = option('Neither, keep it in the daemon', { addedByUser: true });
        const { rerender } = render(carousel(options, { onAddOption, onRemoveOption }));
        await userEvent.click(screen.getByRole('button', { name: '+ Add your own answer' }));
        await userEvent.type(
            screen.getByRole('textbox', { name: 'Your own answer to Which cache?' }),
            'Neither, keep it in the daemon{Enter}',
        );
        expect(onAddOption).toHaveBeenCalledWith('Neither, keep it in the daemon');

        // The computer sends the new option back: the deck moves to it, not to the empty card.
        rerender(carousel([...options, mine], { onAddOption, onRemoveOption }));
        expect(screen.getByRole('button', { name: 'Option 3' }).getAttribute('aria-current')).toBe(
            'true',
        );
        const card = screen.getByRole('article', { name: 'Option 3 of 3' });
        expect(within(card).getByText('Added by you')).toBeTruthy();
        await userEvent.click(within(card).getByRole('button', { name: 'Delete' }));
        expect(onRemoveOption).toHaveBeenCalledWith(mine);
    });
});

// -- ProjectView ------------------------------------------------------------------------------

const projectId = createId();
const computerId = createId();
let lamport = 0;

function op<T extends OpType>(
    sessionId: string,
    type: T,
    payload: OpOf<T>['payload'],
    ts: number,
): Op {
    lamport += 1;
    return createOp({
        projectId,
        sessionId,
        type,
        payload,
        clock: { lamport, deviceId: 'palmtop-daemon' },
        ts,
    });
}

function sessionWithChecklist(title: string, ts: number) {
    const sessionId = createId();
    const checklistId = createId();
    const itemId = createId();
    const ops = [
        op(sessionId, 'session.upsert', { title, startedAt: ts }, ts),
        op(sessionId, 'checklist.create', { checklistId, title: `${title} checklist` }, ts),
        op(sessionId, 'item.add', { itemId, checklistId, text: `${title} item`, order: 0 }, ts),
    ];
    return { sessionId, checklistId, itemId, ops };
}

/** A session with one question and two options, as `palmtop choice create` writes it. */
function sessionWithChoice(question: string, ts: number) {
    const sessionId = createId();
    const checklistId = createId();
    const [first, second] = [createId(), createId()];
    const ops = [
        op(sessionId, 'session.upsert', { title: 'alpha', startedAt: ts }, ts),
        op(sessionId, 'checklist.create', { checklistId, title: question, kind: 'choice' }, ts),
        op(
            sessionId,
            'item.add',
            {
                itemId: first as string,
                checklistId,
                text: 'Redis',
                detail: 'One more service',
                order: 0,
            },
            ts,
        ),
        op(
            sessionId,
            'item.add',
            { itemId: second as string, checklistId, text: 'In memory', order: 1 },
            ts,
        ),
    ];
    return { sessionId, checklistId, first: first as string, second: second as string, ops };
}

function snapshotOf(
    state: ProjectState | null,
    overrides: Partial<SyncSnapshot> = {},
): SyncSnapshot {
    return {
        status: 'online',
        unauthorizedReason: null,
        projectId,
        project: { id: projectId, name: 'palmtopai' },
        computer: { id: computerId, name: 'Office' },
        projects: [
            { id: projectId, name: 'palmtopai', lastActivityAt: 1, sessions: 1, pending: 0 },
        ],
        state,
        shares: [],
        waiting: null,
        seq: 1,
        pendingCount: 0,
        lastError: null,
        daemonProtocol: DAEMON_PROTOCOL_VERSION,
        syncedAt: 1,
        ...overrides,
    };
}

function view(snapshot: SyncSnapshot, props: Partial<ProjectViewProps> = {}) {
    return (
        <ProjectView
            snapshot={snapshot}
            fallbackName="fallback"
            onItemChange={mock()}
            onAddItem={mock()}
            onRemoveItem={mock()}
            onSessionNote={mock()}
            onRemoveSession={mock()}
            onDismissError={mock()}
            onUnpair={mock()}
            {...props}
        />
    );
}

describe('ProjectView with archived sessions', () => {
    const alpha = sessionWithChecklist('alpha', 1_000);
    const beta = sessionWithChecklist('beta', 2_000);
    const archived = (...ids: string[]) =>
        applyAll(createProjectState(projectId), [
            ...alpha.ops,
            ...beta.ops,
            ...ids.map((id) => op(id, 'session.archive', { archived: true }, 3_000)),
        ]);

    test('an archived session is out of the way; the menu archives a session or the project', async () => {
        const onArchive = mock();
        const { rerender } = render(
            view(snapshotOf(archived(beta.sessionId)), { onArchive, follow: true }),
        );
        // beta is the most recent, but archived: alpha is the one shown.
        expect(screen.getByRole('button', { name: 'Session alpha, change' })).toBeTruthy();
        await userEvent.click(screen.getByRole('button', { name: 'Project menu' }));
        await userEvent.click(
            await screen.findByRole('menuitem', { name: 'Archive this session' }),
        );
        expect(onArchive).toHaveBeenLastCalledWith([alpha.sessionId], true);
        await userEvent.click(screen.getByRole('button', { name: 'Project menu' }));
        await userEvent.click(
            await screen.findByRole('menuitem', { name: 'Archive this project' }),
        );
        expect(onArchive).toHaveBeenLastCalledWith(undefined, true);

        // Opened from the archive: that session, which can come back from the menu.
        rerender(
            view(snapshotOf(archived(beta.sessionId)), {
                onArchive,
                follow: true,
                openSession: { sessionId: beta.sessionId, at: 1 },
            }),
        );
        expect(await screen.findByRole('button', { name: 'Session beta, change' })).toBeTruthy();
        await userEvent.click(screen.getByRole('button', { name: 'Project menu' }));
        await userEvent.click(
            await screen.findByRole('menuitem', { name: 'Restore this session' }),
        );
        expect(onArchive).toHaveBeenLastCalledWith([beta.sessionId], false);
    });

    test('every session archived: the project says so; no archive without a computer that can', async () => {
        render(view(snapshotOf(archived(alpha.sessionId, beta.sessionId))));
        expect(screen.getByText(/Every session of this project is in the archive/)).toBeTruthy();
        // No computer that can archive (and no session shown): no menu to archive from.
        expect(screen.queryByRole('button', { name: 'Project menu' })).toBeNull();
    });
});

describe('ProjectView with a session to mark done', () => {
    const alpha = sessionWithChecklist('alpha', 1_000);
    const state = (...more: Op[]) =>
        applyAll(createProjectState(projectId), [...alpha.ops, ...more]);

    test('the button asks first, says how many items are left, and sends the session', async () => {
        const onDone = mock();
        const confirm = mock(() => true);
        render(view(snapshotOf(state()), { onDone, confirm }));
        await userEvent.click(screen.getByRole('button', { name: 'Review done' }));
        expect(confirm).toHaveBeenCalledWith(
            'Tell the agent you finished reviewing this session? 1 item is not reviewed yet.',
        );
        expect(onDone).toHaveBeenCalledWith(alpha.sessionId);

        // Declined: nothing is sent.
        const declined = mock();
        cleanup();
        render(view(snapshotOf(state()), { onDone: declined, confirm: () => false }));
        await userEvent.click(screen.getByRole('button', { name: 'Review done' }));
        expect(declined).not.toHaveBeenCalled();
    });

    test('with everything reviewed the question has no warning', async () => {
        const confirm = mock(() => false);
        const reviewed = state(
            op(alpha.sessionId, 'item.update', { itemId: alpha.itemId, status: 'done' }, 2_000),
        );
        render(view(snapshotOf(reviewed), { onDone: mock(), confirm }));
        await userEvent.click(screen.getByRole('button', { name: 'Review done' }));
        expect(confirm).toHaveBeenCalledWith('Tell the agent you finished reviewing this session?');
    });

    test('once marked it turns off, and it comes back when the agent writes again', () => {
        const done = state(op(alpha.sessionId, 'session.done', { done: true }, 3_000));
        const { rerender } = render(view(snapshotOf(done), { onDone: mock() }));
        expect(screen.queryByRole('button', { name: 'Review done' })).toBeNull();
        expect(screen.getByText('Marked as done')).toBeTruthy();
        expect(screen.getByText(/Otherwise tell it in the chat/)).toBeTruthy();

        const again = applyAll(done, [op(alpha.sessionId, 'session.done', { done: false }, 4_000)]);
        rerender(view(snapshotOf(again), { onDone: mock() }));
        expect(screen.getByRole('button', { name: 'Review done' })).toBeTruthy();
        expect(screen.queryByText('Marked as done')).toBeNull();
    });

    test('with a computer that says who waits, the button goes only while an agent waits', async () => {
        const button = () =>
            screen.getByRole('button', { name: 'Review done' }) as HTMLButtonElement;
        const { rerender } = render(view(snapshotOf(state(), { waiting: [] }), { onDone: mock() }));
        expect(button().disabled).toBe(true);
        expect(
            screen.getByText(/The agent is not waiting for it: tell it in the chat/),
        ).toBeTruthy();

        rerender(view(snapshotOf(state(), { waiting: [alpha.sessionId] }), { onDone: mock() }));
        expect(button().disabled).toBe(false);
        expect(screen.queryByText(/The agent is not waiting for it/)).toBeNull();

        // Another session waiting is not this one; a computer that does not say changes nothing.
        rerender(view(snapshotOf(state(), { waiting: [createId()] }), { onDone: mock() }));
        expect(button().disabled).toBe(true);
        rerender(view(snapshotOf(state(), { waiting: null }), { onDone: mock() }));
        expect(button().disabled).toBe(false);

        // Offline says it needs the computer, not that nobody waits.
        cleanup();
        render(
            view(snapshotOf(state(), { waiting: [], status: 'daemon-offline' }), {
                onDone: mock(),
            }),
        );
        expect(screen.getByText(/Needs your computer online/)).toBeTruthy();
        expect(screen.queryByText(/The agent is not waiting for it/)).toBeNull();
    });

    test('a person with a shared copy tells the owner, not the agent', async () => {
        const onDone = mock();
        const confirm = mock(() => true);
        const copy = snapshotOf(state(), {
            project: {
                id: projectId,
                name: 'palmtopai',
                computer: 'Grace',
                sharedUntil: Date.now() + 1e9,
            },
        });
        // The owner has no agent to wait for them: a copy never depends on who waits.
        render(view({ ...copy, waiting: [] }, { onDone, confirm, guest: true }));
        await userEvent.click(screen.getByRole('button', { name: 'Review done' }));
        expect(confirm).toHaveBeenCalledWith(
            'Tell Grace you finished reviewing? 1 item is not reviewed yet.',
        );
        expect(onDone).toHaveBeenCalledWith(alpha.sessionId);
        cleanup();
        const done = state(op(alpha.sessionId, 'session.done', { done: true }, 3_000));
        render(view({ ...copy, state: done }, { onDone, guest: true }));
        expect(screen.getByText('Grace sees it on their devices.')).toBeTruthy();
    });

    test('the owner sees who finished reviewing their copy', () => {
        const people = [
            {
                name: 'Mario',
                state: 'open' as const,
                expiresAt: Date.now() + 86_400_000,
                checklists: [],
                items: {},
                done: true,
            },
            {
                name: 'Luca',
                state: 'open' as const,
                expiresAt: Date.now() + 86_400_000,
                checklists: [],
                items: {},
            },
        ];
        render(<PeopleResults people={people} now={Date.now()} />);
        const text = screen.getByLabelText('From the people you share with').textContent ?? '';
        expect(text).toMatch(/Mario \(open until [^)]*, finished reviewing\)/);
        expect(text).toMatch(/Luca \(open until [^)]*\)/);
    });

    test('offline it waits for the computer; not offered to old computers or without lists', async () => {
        const offline = render(
            view(snapshotOf(state(), { status: 'daemon-offline' }), { onDone: mock() }),
        );
        const button = screen.getByRole('button', { name: 'Review done' }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        expect(screen.getByText(/Needs your computer online/)).toBeTruthy();
        offline.unmount();

        // No `onDone`: a computer without the protocol, or a guest's copy.
        const old = render(view(snapshotOf(state(), { daemonProtocol: 6 })));
        expect(screen.queryByRole('button', { name: 'Review done' })).toBeNull();
        old.unmount();

        // A session the agent has not written anything in yet: nothing to be done with.
        const empty = applyAll(createProjectState(projectId), [alpha.ops[0] as Op]);
        render(view(snapshotOf(empty), { onDone: mock() }));
        expect(screen.queryByRole('button', { name: 'Review done' })).toBeNull();
    });
});

describe('ProjectView', () => {
    test('shows the project, connection and the checklist of the active session', () => {
        const a = sessionWithChecklist('alpha', 1_000);
        render(
            view(snapshotOf(applyAll(createProjectState(projectId), a.ops), { pendingCount: 2 })),
        );

        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('palmtopai');
        expect(screen.getByRole('status').textContent).toContain('Live');
        const checklist = screen.getByRole('region', { name: 'alpha checklist' });
        expect(within(checklist).getByText('alpha item')).toBeTruthy();
        expect(within(checklist).getByText('0/1 reviewed')).toBeTruthy();
    });

    test('the project is the title, the computer sits under it, also in the offline fallback', () => {
        const state = applyAll(createProjectState(projectId), sessionWithChecklist('alpha', 1).ops);
        render(
            view(
                snapshotOf(state, {
                    project: { id: projectId, name: 'palmtopai', computer: 'Office' },
                }),
            ),
        );
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('palmtopai');
        expect(screen.getByText('Office')).toBeTruthy();
        cleanup();
        render(
            view(snapshotOf(null, { status: 'offline', project: null, computer: null }), {
                fallbackName: 'palmtopai',
                computerName: 'Home',
            }),
        );
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('palmtopai');
        expect(screen.getByText('Home')).toBeTruthy();
    });

    test('adding an item to a checklist sends it after the last one', async () => {
        const a = sessionWithChecklist('alpha', 1_000);
        const onAddItem = mock();
        render(view(snapshotOf(applyAll(createProjectState(projectId), a.ops)), { onAddItem }));
        const checklist = screen.getByRole('region', { name: 'alpha checklist' });
        await userEvent.click(within(checklist).getByRole('button', { name: '+ Add item' }));
        await userEvent.type(
            within(checklist).getByRole('textbox', { name: 'New item for alpha checklist' }),
            'Also check the login{Enter}',
        );
        expect(onAddItem).toHaveBeenCalledWith(a.sessionId, {
            itemId: expect.any(String),
            checklistId: a.checklistId,
            text: 'Also check the login',
            order: 1,
        });
        // The form closes and can be opened again.
        expect(within(checklist).getByRole('button', { name: '+ Add item' })).toBeTruthy();
    });

    test('a question of the agent is a deck of options, answered through the same op', async () => {
        const choice = sessionWithChoice('Which cache?', 1_000);
        const onItemChange = mock();
        const onAddItem = mock();
        render(
            view(snapshotOf(applyAll(createProjectState(projectId), choice.ops)), {
                onItemChange,
                onAddItem,
            }),
        );

        // No checklist of checks: the question is shown as its own deck.
        expect(screen.queryByText('0/2 reviewed')).toBeNull();
        expect(screen.getByRole('region', { name: 'Which cache?' })).toBeTruthy();
        // One question, one thing to answer, whatever the number of options.
        expect(screen.getByText('1 to review')).toBeTruthy();
        const first = screen.getByRole('article', { name: 'Option 1 of 2' });
        expect(within(first).getByText('One more service')).toBeTruthy();

        await userEvent.click(within(first).getByRole('button', { name: 'Pick' }));
        expect(onItemChange).toHaveBeenCalledWith(choice.sessionId, choice.first, {
            status: 'done',
        });

        await userEvent.click(screen.getByRole('button', { name: '+ Add your own answer' }));
        await userEvent.type(
            screen.getByRole('textbox', { name: 'Your own answer to Which cache?' }),
            'Neither{Enter}',
        );
        expect(onAddItem).toHaveBeenCalledWith(choice.sessionId, {
            itemId: expect.any(String),
            checklistId: choice.checklistId,
            text: 'Neither',
            order: 2,
        });
    });

    test('an answered question stops counting in "to review"', async () => {
        const choice = sessionWithChoice('Which cache?', 1_000);
        const checks = sessionWithChecklist('alpha', 1_000);
        // Same session: one checklist of checks and one question.
        const ops = [
            ...choice.ops,
            op(
                choice.sessionId,
                'checklist.create',
                { checklistId: checks.checklistId, title: 'Checks' },
                1_000,
            ),
            op(
                choice.sessionId,
                'item.add',
                {
                    itemId: checks.itemId,
                    checklistId: checks.checklistId,
                    text: 'A check',
                    order: 0,
                },
                1_000,
            ),
        ];
        const state = applyAll(createProjectState(projectId), ops);
        const { rerender } = render(view(snapshotOf(state)));
        // The question counts as one, plus the check.
        expect(screen.getByText('2 to review')).toBeTruthy();

        const answered = applyAll(state, [
            op(choice.sessionId, 'item.update', { itemId: choice.first, status: 'done' }, 2_000),
        ]);
        rerender(view(snapshotOf(answered)));
        expect(screen.getByText('1 to review')).toBeTruthy();
    });

    test('the agent message is shown and the note for the agent is saved with its status', async () => {
        const a = sessionWithChecklist('alpha', 1_000);
        const onSessionNote = mock();
        const state = applyAll(createProjectState(projectId), [
            ...a.ops,
            op(a.sessionId, 'session.message', { message: 'Plan ready' }, 2_000),
        ]);
        const { rerender } = render(view(snapshotOf(state), { onSessionNote }));
        const message = screen.getByRole('region', { name: 'Message from the agent' });
        expect(message.textContent).toContain('Plan ready');

        const notes = screen.getByRole('region', { name: 'Note for the agent' });
        await userEvent.click(within(notes).getByText('+ Write something for the agent'));
        await userEvent.type(within(notes).getByRole('textbox'), 'Use staging');
        await userEvent.click(within(notes).getByRole('button', { name: 'Save' }));
        expect(onSessionNote).toHaveBeenCalledWith(
            a.sessionId,
            expect.stringMatching(/^- Use staging \[#[a-z0-9]{4}\]$/),
        );

        const noteOp = createOp({
            projectId,
            sessionId: a.sessionId,
            type: 'session.note',
            payload: { note: 'Use staging' },
            clock: { lamport: 900, deviceId: 'phone' },
        });
        const withNote = applyAll(state, [noteOp]);
        rerender(view(snapshotOf(withNote), { onSessionNote }));
        expect(screen.getByText('The agent reads it with the next feedback.')).toBeTruthy();
        const delivered = applyAll(withNote, [
            op(a.sessionId, 'feedback.deliver', { items: [], sessionNote: noteOp.opId }, 3_000),
        ]);
        rerender(view(snapshotOf(delivered), { onSessionNote }));
        expect(screen.getByText('Read by the agent.')).toBeTruthy();
    });

    test('item changes are reported with the session of the checklist', async () => {
        const a = sessionWithChecklist('alpha', 1_000);
        const onItemChange = mock();
        render(view(snapshotOf(applyAll(createProjectState(projectId), a.ops)), { onItemChange }));
        await userEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(onItemChange).toHaveBeenCalledWith(a.sessionId, a.itemId, { status: 'done' });
    });

    test('follows the session sending data, stops on a manual pick and resumes when told', async () => {
        const a = sessionWithChecklist('alpha', 1_000);
        const b = sessionWithChecklist('beta', 2_000);
        let state = applyAll(createProjectState(projectId), [...a.ops, ...b.ops]);
        const onPauseFollow = mock();
        const { rerender } = render(view(snapshotOf(state), { follow: true, onPauseFollow }));
        expect(screen.getByRole('region', { name: 'beta checklist' })).toBeTruthy();

        // Activity in alpha: following jumps there.
        state = applyAll(state, [
            op(a.sessionId, 'item.update', { itemId: a.itemId, note: 'x' }, 3_000),
        ]);
        rerender(view(snapshotOf(state), { follow: true, onPauseFollow }));
        expect(screen.getByRole('region', { name: 'alpha checklist' })).toBeTruthy();

        // A manual pick of beta in the sheet stops following.
        await userEvent.click(screen.getByRole('button', { name: 'Session alpha, change' }));
        await userEvent.click(await screen.findByRole('button', { name: /^beta/ }));
        expect(screen.getByRole('region', { name: 'beta checklist' })).toBeTruthy();
        expect(onPauseFollow).toHaveBeenCalledTimes(1);

        state = applyAll(state, [
            op(a.sessionId, 'item.update', { itemId: a.itemId, note: 'y' }, 4_000),
        ]);
        rerender(view(snapshotOf(state), { follow: false, onPauseFollow }));
        expect(screen.getByRole('region', { name: 'beta checklist' })).toBeTruthy();

        // Following again: back to the session with the newest activity.
        rerender(view(snapshotOf(state), { follow: true, onPauseFollow }));
        expect(screen.getByRole('region', { name: 'alpha checklist' })).toBeTruthy();
    });

    test('the breadcrumb opens the sheet: projects of the computer, then sessions of the project', async () => {
        const a = sessionWithChecklist('alpha', 1_000);
        const b = sessionWithChecklist('beta', 2_000);
        const state = applyAll(createProjectState(projectId), [
            ...a.ops,
            ...b.ops,
            op(a.sessionId, 'item.update', { itemId: a.itemId, status: 'done' }, 3_000),
        ]);
        const other = createId();
        const onSelectProject = mock();
        render(
            view(snapshotOf(state), {
                projects: [
                    { id: projectId, name: 'palmtopai', sessions: 2, pending: 1 },
                    { id: other, name: 'site', sessions: 0 },
                ],
                selectedProjectId: projectId,
                onSelectProject,
            }),
        );

        await userEvent.click(screen.getByRole('button', { name: 'Project palmtopai, change' }));
        const sheet = await screen.findByRole('dialog');
        expect(within(sheet).getByText('On Office')).toBeTruthy();
        expect(within(sheet).getByText('2 sessions')).toBeTruthy();
        expect(within(sheet).getByText('1 to review')).toBeTruthy();
        expect(within(sheet).getByText('no sessions')).toBeTruthy();

        // One level down: the sessions of the open project, with their counts.
        await userEvent.click(within(sheet).getByRole('button', { name: 'Sessions of palmtopai' }));
        expect(within(sheet).getByText('Sessions')).toBeTruthy();
        // Alpha has the newest activity: it is the one followed, all reviewed.
        const alpha = within(sheet).getByRole('button', { name: /^alpha/ });
        expect(alpha.getAttribute('aria-current')).toBe('true');
        expect(alpha.textContent).toContain('1 item');
        expect(within(alpha).queryByText(/to review/)).toBeNull();
        const beta = within(sheet).getByRole('button', { name: /^beta/ });
        expect(beta.getAttribute('aria-current')).toBeNull();
        expect(within(beta).getByText('1 to review')).toBeTruthy();

        // Back up, and another project.
        await userEvent.click(within(sheet).getByRole('button', { name: 'Projects' }));
        await userEvent.click(within(sheet).getByRole('button', { name: /^site/ }));
        expect(onSelectProject).toHaveBeenCalledWith(other);
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    test('following the agent is a switch next to the computer name', async () => {
        const onFollow = mock();
        const state = applyAll(createProjectState(projectId), sessionWithChecklist('a', 1).ops);
        const { rerender } = render(view(snapshotOf(state), { follow: false, onFollow }));
        const button = screen.getByRole('button', { name: 'Follow activity' });
        expect(button.getAttribute('aria-pressed')).toBe('false');
        await userEvent.click(button);
        expect(onFollow).toHaveBeenCalledTimes(1);
        rerender(view(snapshotOf(state), { follow: true, onFollow }));
        expect(
            screen.getByRole('button', { name: 'Following activity' }).getAttribute('aria-pressed'),
        ).toBe('true');
    });

    test('deleting the selected session from the menu asks first', async () => {
        const a = sessionWithChecklist('alpha', 1_000);
        const b = sessionWithChecklist('beta', 2_000);
        const onRemoveSession = mock();
        const confirm = mock(() => false);
        const state = applyAll(createProjectState(projectId), [...a.ops, ...b.ops]);
        const { rerender } = render(view(snapshotOf(state), { onRemoveSession, confirm }));

        const menuButton = screen.getByRole('button', { name: 'Project menu' });
        await userEvent.click(menuButton);
        expect(menuButton.getAttribute('aria-expanded')).toBe('true');
        await userEvent.click(screen.getByRole('menuitem', { name: 'Delete this session…' }));
        expect(confirm).toHaveBeenCalledWith(
            'Delete the session "beta"? Its checklists and reviews are deleted on your computer too.',
        );
        expect(onRemoveSession).not.toHaveBeenCalled();
        expect(screen.queryByRole('menu')).toBeNull();

        rerender(view(snapshotOf(state), { onRemoveSession, confirm: () => true }));
        await userEvent.click(menuButton);
        await userEvent.click(screen.getByRole('menuitem', { name: 'Delete this session…' }));
        expect(onRemoveSession).toHaveBeenCalledWith(b.sessionId);

        // Once removed (even only locally, while offline) the view moves to another session.
        const removed = applyAll(state, [op(b.sessionId, 'session.remove', {}, 3_000)]);
        rerender(view(snapshotOf(removed, { status: 'offline', pendingCount: 1 })));
        expect(await screen.findByRole('region', { name: 'alpha checklist' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Session alpha, change' })).toBeTruthy();
    });

    test('the menu closes on Escape and outside taps', async () => {
        const state = applyAll(createProjectState(projectId), sessionWithChecklist('a', 1).ops);
        render(view(snapshotOf(state)));
        await userEvent.click(screen.getByRole('button', { name: 'Project menu' }));
        await userEvent.keyboard('{Escape}');
        expect(screen.queryByRole('menu')).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: 'Project menu' }));
        await userEvent.click(screen.getByRole('status'));
        expect(screen.queryByRole('menu')).toBeNull();
    });

    test('the project menu deletes the project after saying what goes and what stays', async () => {
        const onRemoveProject = mock();
        const confirm = mock(() => false);
        const state = applyAll(createProjectState(projectId), sessionWithChecklist('a', 1).ops);
        const { rerender } = render(view(snapshotOf(state), { onRemoveProject, confirm }));

        await userEvent.click(screen.getByRole('button', { name: 'Project menu' }));
        await userEvent.click(screen.getByRole('menuitem', { name: 'Delete this project…' }));
        expect(confirm).toHaveBeenCalledWith(
            'Delete the project "palmtopai" on Office? Its sessions, checklists and reviews are deleted on the computer too. The folder and its files are not touched.',
        );
        expect(onRemoveProject).not.toHaveBeenCalled();

        rerender(view(snapshotOf(state), { onRemoveProject, confirm: () => true }));
        await userEvent.click(screen.getByRole('button', { name: 'Project menu' }));
        await userEvent.click(screen.getByRole('menuitem', { name: 'Delete this project…' }));
        expect(onRemoveProject).toHaveBeenCalledTimes(1);

        // Nothing to delete before the first sync: no menu at all.
        rerender(
            view(snapshotOf(null, { status: 'connecting', project: null }), {
                onRemoveProject,
            }),
        );
        expect(screen.queryByRole('button', { name: 'Project menu' })).toBeNull();
    });

    test('hiding reviewed items keeps checklist titles and is remembered on this device', async () => {
        const a = sessionWithChecklist('alpha', 1_000);
        const second = createId();
        const otherChecklist = createId();
        const otherItem = createId();
        const state = applyAll(createProjectState(projectId), [
            ...a.ops,
            op(
                a.sessionId,
                'item.add',
                { itemId: second, checklistId: a.checklistId, text: 'second', order: 1 },
                1_000,
            ),
            op(a.sessionId, 'item.update', { itemId: a.itemId, status: 'done' }, 1_000),
            op(
                a.sessionId,
                'checklist.create',
                { checklistId: otherChecklist, title: 'other' },
                1_000,
            ),
            op(
                a.sessionId,
                'item.add',
                {
                    itemId: otherItem,
                    checklistId: otherChecklist,
                    text: 'other item',
                    order: 0,
                    status: 'cancelled',
                },
                1_000,
            ),
        ]);
        render(view(snapshotOf(state)));
        expect(screen.getByText('1 to review')).toBeTruthy();
        expect(screen.getByText('alpha item')).toBeTruthy();

        const toggle = screen.getByRole('button', { name: 'Hide reviewed' });
        await userEvent.click(toggle);
        expect(toggle.getAttribute('aria-pressed')).toBe('true');
        expect(screen.queryByText('alpha item')).toBeNull();
        expect(screen.getByText('second')).toBeTruthy();
        const other = screen.getByRole('region', { name: 'other' });
        expect(within(other).getByText('1/1 reviewed')).toBeTruthy();
        expect(within(other).queryByRole('list')).toBeNull();
        expect(loadHideReviewed()).toBe(true);

        cleanup();
        render(view(snapshotOf(state)));
        expect(
            screen.getByRole('button', { name: 'Hide reviewed' }).getAttribute('aria-pressed'),
        ).toBe('true');
        expect(screen.queryByText('alpha item')).toBeNull();

        await userEvent.click(screen.getByRole('button', { name: 'Hide reviewed' }));
        expect(screen.getByText('alpha item')).toBeTruthy();
        expect(loadHideReviewed()).toBe(false);
    });

    test('with reviewed items hidden, finished lists go last, each group in its order', async () => {
        const a = sessionWithChecklist('alpha', 1_000);
        const list = (title: string, status?: 'done' | 'cancelled') => {
            const checklistId = createId();
            const itemId = createId();
            return {
                itemId,
                ops: [
                    op(a.sessionId, 'checklist.create', { checklistId, title }, 1_000),
                    op(
                        a.sessionId,
                        'item.add',
                        {
                            itemId,
                            checklistId,
                            text: `${title} item`,
                            order: 0,
                            ...(status && { status }),
                        },
                        1_000,
                    ),
                ],
            };
        };
        const bravo = list('bravo');
        const charlie = list('charlie', 'cancelled');
        const delta = list('delta');
        const state = applyAll(createProjectState(projectId), [
            ...a.ops,
            op(a.sessionId, 'item.update', { itemId: a.itemId, status: 'done' }, 1_000),
            ...bravo.ops,
            ...charlie.ops,
            ...delta.ops,
        ]);
        const order = () =>
            screen
                .getAllByRole('region')
                .map((region) => region.getAttribute('aria-labelledby') ?? '')
                .filter((id) => id.startsWith('checklist-'))
                .map((id) => document.getElementById(id)?.textContent);

        const onItemChange = mock();
        const props = { onItemChange, hideDelayMs: 150 };
        const { rerender } = render(view(snapshotOf(state), props));
        expect(order()).toEqual(['alpha checklist', 'bravo', 'charlie', 'delta']);

        await userEvent.click(screen.getByRole('button', { name: 'Hide reviewed' }));
        expect(order()).toEqual(['bravo', 'delta', 'alpha checklist', 'charlie']);

        // Bravo finished here: it waits for its countdown, then goes after the others.
        await userEvent.click(
            within(screen.getByRole('region', { name: 'bravo' })).getByRole('button', {
                name: 'Done',
            }),
        );
        const reviewed = applyAll(state, [
            op(a.sessionId, 'item.update', { itemId: bravo.itemId, status: 'done' }, 2_000),
        ]);
        rerender(view(snapshotOf(reviewed), props));
        expect(order()).toEqual(['bravo', 'delta', 'alpha checklist', 'charlie']);
        await waitFor(() =>
            expect(order()).toEqual(['delta', 'alpha checklist', 'bravo', 'charlie']),
        );

        await userEvent.click(screen.getByRole('button', { name: 'Hide reviewed' }));
        expect(order()).toEqual(['alpha checklist', 'bravo', 'charlie', 'delta']);
    });

    test('an item reviewed while hiding stays for a moment, and while its note is edited', async () => {
        localStorage.setItem('palmtop.hideReviewed', 'true');
        const a = sessionWithChecklist('alpha', 1_000);
        let state = applyAll(createProjectState(projectId), a.ops);
        const onItemChange = mock();
        const props = { onItemChange, hideDelayMs: 150 };
        const { rerender } = render(view(snapshotOf(state), props));
        expect(screen.queryByTestId('hide-countdown')).toBeNull();

        await userEvent.click(screen.getByRole('button', { name: 'Question' }));
        expect(onItemChange).toHaveBeenCalledWith(a.sessionId, a.itemId, { status: 'question' });
        state = applyAll(state, [
            op(a.sessionId, 'item.update', { itemId: a.itemId, status: 'question' }, 2_000),
        ]);
        rerender(view(snapshotOf(state), props));
        expect(screen.getByText('Nothing left to review')).toBeTruthy();
        expect(screen.getByTestId('hide-countdown')).toBeTruthy();

        // Editing the note holds the item with no countdown.
        await userEvent.click(screen.getByText('+ Add note'));
        expect(screen.queryByTestId('hide-countdown')).toBeNull();
        await Bun.sleep(250);
        await userEvent.type(screen.getByRole('textbox'), 'why?');
        await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
        state = applyAll(state, [
            op(a.sessionId, 'item.update', { itemId: a.itemId, note: 'why?' }, 3_000),
        ]);
        rerender(view(snapshotOf(state), props));

        // Closing the editor restarts the countdown, then the item is hidden.
        expect(screen.getByTestId('hide-countdown')).toBeTruthy();
        // textContent: a failing matcher on an element prints the whole DOM, too slow to retry.
        await waitFor(() => expect(screen.queryByText('alpha item')?.textContent).toBeUndefined());
        expect(screen.getByRole('region', { name: 'alpha checklist' })).toBeTruthy();
    });

    test('an item reviewed while hiding stays while its status choices are open', async () => {
        localStorage.setItem('palmtop.hideReviewed', 'true');
        const a = sessionWithChecklist('alpha', 1_000);
        const state = applyAll(createProjectState(projectId), a.ops);
        const onItemChange = mock();
        const props = { onItemChange, hideDelayMs: 150 };
        const { rerender } = render(view(snapshotOf(state), props));

        await userEvent.click(screen.getByRole('button', { name: 'Done' }));
        const done = applyAll(state, [
            op(a.sessionId, 'item.update', { itemId: a.itemId, status: 'done' }, 2_000),
        ]);
        rerender(view(snapshotOf(done), props));
        expect(screen.getByTestId('hide-countdown')).toBeTruthy();

        await userEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(screen.queryByTestId('hide-countdown')).toBeNull();
        await Bun.sleep(250);
        expect(screen.getByText('alpha item')).toBeTruthy();

        // Picking another status starts the countdown again.
        await userEvent.click(screen.getByRole('button', { name: 'Cancelled' }));
        expect(onItemChange).toHaveBeenLastCalledWith(a.sessionId, a.itemId, {
            status: 'cancelled',
        });
        rerender(
            view(
                snapshotOf(
                    applyAll(done, [
                        op(
                            a.sessionId,
                            'item.update',
                            { itemId: a.itemId, status: 'cancelled' },
                            3_000,
                        ),
                    ]),
                ),
                props,
            ),
        );
        expect(screen.getByTestId('hide-countdown')).toBeTruthy();
        await waitFor(() => expect(screen.queryByText('alpha item')?.textContent).toBeUndefined());
    });

    test('items reviewed elsewhere are hidden at once; resetting a status stops the countdown', async () => {
        localStorage.setItem('palmtop.hideReviewed', 'true');
        const a = sessionWithChecklist('alpha', 1_000);
        const state = applyAll(createProjectState(projectId), a.ops);
        const props = { hideDelayMs: 150 };
        const { rerender } = render(view(snapshotOf(state), props));

        // Reviewed here and reset right away: no countdown left on an unreviewed item.
        await userEvent.click(screen.getByRole('button', { name: 'Done' }));
        const done = applyAll(state, [
            op(a.sessionId, 'item.update', { itemId: a.itemId, status: 'done' }, 2_000),
        ]);
        rerender(view(snapshotOf(done), props));
        expect(screen.getByTestId('hide-countdown')).toBeTruthy();
        await userEvent.click(screen.getByRole('button', { name: 'Done' }));
        await userEvent.click(screen.getByRole('button', { name: 'Done' }));
        const reset = applyAll(done, [
            op(a.sessionId, 'item.update', { itemId: a.itemId, status: null }, 3_000),
        ]);
        rerender(view(snapshotOf(reset), props));
        expect(screen.queryByTestId('hide-countdown')).toBeNull();
        await Bun.sleep(250);
        expect(screen.getByText('alpha item')).toBeTruthy();

        // A review from another device: hidden with no countdown.
        rerender(
            view(
                snapshotOf(
                    applyAll(reset, [
                        op(a.sessionId, 'item.update', { itemId: a.itemId, status: 'done' }, 4_000),
                    ]),
                ),
                props,
            ),
        );
        expect(screen.queryByText('alpha item')).toBeNull();
    });

    test('with the computer offline the project can be removed from this device', async () => {
        const onUnpair = mock();
        const confirm = mock(() => false);
        const props = { onUnpair, confirm };
        const { rerender } = render(view(snapshotOf(null, { status: 'daemon-offline' }), props));

        const remove = await screen.findByRole('button', { name: 'Remove from this device' });
        expect(screen.getByText(/If that computer is gone for good/)).toBeTruthy();
        await userEvent.click(remove);
        expect(confirm).toHaveBeenCalledWith(
            'Remove "Office" from this device? You lose every project of that computer here, and changes not synced yet. To pair it again, scan the QR code from palmtop pair.',
        );
        expect(onUnpair).not.toHaveBeenCalled();

        // Also from the notice shown above a loaded session.
        const state = applyAll(createProjectState(projectId), sessionWithChecklist('a', 1).ops);
        rerender(
            view(snapshotOf(state, { status: 'daemon-offline' }), {
                onUnpair,
                confirm: () => true,
            }),
        );
        await userEvent.click(screen.getByRole('button', { name: 'Remove from this device' }));
        expect(onUnpair).toHaveBeenCalledTimes(1);

        rerender(view(snapshotOf(state, { status: 'offline' }), props));
        await waitFor(() =>
            expect(
                screen.queryByRole('button', { name: 'Remove from this device' })?.textContent,
            ).toBeUndefined(),
        );
    });

    test('an outdated daemon asks to run palmtop update on the computer', () => {
        const state = applyAll(createProjectState(projectId), sessionWithChecklist('a', 1_000).ops);
        const { rerender } = render(view(snapshotOf(state)));
        expect(screen.queryByText(/out of date/)).toBeNull();
        rerender(view(snapshotOf(state, { daemonProtocol: 0 })));
        expect(screen.getByRole('alert').textContent).toContain('Run palmtop update there');
    });

    test('offline, computer offline, rejected change, not paired and empty states', async () => {
        const a = sessionWithChecklist('alpha', 1_000);
        const state = applyAll(createProjectState(projectId), a.ops);
        const { rerender } = render(view(snapshotOf(state, { status: 'offline' })));
        expect(screen.getByText(/Offline\. Changes are kept on this device/)).toBeTruthy();

        rerender(
            view(
                snapshotOf(state, { status: 'daemon-offline', syncedAt: Date.now() - 5 * 60_000 }),
            ),
        );
        // Transient states are shown once they last STATUS_SETTLE_MS.
        expect(await screen.findByText(/Your computer is offline\. Changes are kept/)).toBeTruthy();
        expect(screen.getByText(/Last synced 5 min ago\./)).toBeTruthy();
        expect(screen.getByRole('status').textContent).toContain('PC offline');

        rerender(
            view(
                snapshotOf(state, {
                    lastError: { code: 'forbidden', message: 'unknown item', opId: createId() },
                }),
            ),
        );
        expect(screen.getByRole('alert').textContent).toContain(
            'A change was not accepted: unknown item',
        );

        rerender(view(snapshotOf(null, { status: 'unauthorized', project: null })));
        expect(screen.getByText('This device is no longer paired with the project.')).toBeTruthy();
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('fallback');

        rerender(
            view(snapshotOf(null, { status: 'unauthorized', project: null }), { keyLost: true }),
        );
        expect(screen.getByText('This device lost its key.')).toBeTruthy();
        expect(screen.getByText(/browser deleted the data of this app/)).toBeTruthy();
        expect(screen.getByRole('status').textContent).toContain('Key lost');
        rerender(
            view(
                snapshotOf(null, {
                    status: 'unauthorized',
                    unauthorizedReason: 'computer-key',
                    project: null,
                }),
            ),
        );
        expect(screen.getByText('This computer has a new key.')).toBeTruthy();
        expect(screen.getByRole('status').textContent).toContain('Not paired');

        rerender(view(snapshotOf(null, { status: 'connecting' })));
        expect(await screen.findByText('Connecting to your computer…')).toBeTruthy();
        rerender(view(snapshotOf(null, { status: 'daemon-offline' })));
        expect(await screen.findByText(/Your computer is offline\. Waiting for it/)).toBeTruthy();

        rerender(view(snapshotOf(createProjectState(projectId))));
        expect(screen.getByText(/No sessions yet/)).toBeTruthy();
    });

    test('short reconnect states do not blink in the badge; live shows at once', async () => {
        const state = createProjectState(projectId);
        const { rerender } = render(view(snapshotOf(state, { status: 'offline' })));
        const badge = () => screen.getByRole('status').textContent;
        expect(badge()).toContain('Offline');

        rerender(view(snapshotOf(state, { status: 'connecting' })));
        await Bun.sleep(100);
        rerender(view(snapshotOf(state, { status: 'daemon-offline' })));
        await Bun.sleep(100);
        rerender(view(snapshotOf(state, { status: 'offline' })));
        expect(badge()).toContain('Offline');
        await Bun.sleep(STATUS_SETTLE_MS + 100);
        expect(badge()).toContain('Offline');

        rerender(view(snapshotOf(state, { status: 'daemon-offline' })));
        expect(badge()).toContain('Offline');
        await Bun.sleep(STATUS_SETTLE_MS + 100);
        expect(badge()).toContain('PC offline');

        rerender(view(snapshotOf(state, { status: 'online' })));
        expect(badge()).toContain('Live');
    });
});

describe('statusDelay', () => {
    test('waits only before transient states', () => {
        expect(statusDelay('offline', 'connecting')).toBe(STATUS_SETTLE_MS);
        expect(statusDelay('connecting', 'daemon-offline')).toBe(STATUS_SETTLE_MS);
        expect(statusDelay('online', 'offline')).toBe(STATUS_SETTLE_MS);
        expect(statusDelay('offline', 'online')).toBe(0);
        expect(statusDelay('connecting', 'unauthorized')).toBe(0);
        expect(statusDelay('stopped', 'connecting')).toBe(0);
        expect(statusDelay('offline', 'offline')).toBe(0);
    });
});

describe('Dashboard', () => {
    const now = Date.now();
    const office: Pairing = {
        computerId: createId(),
        roomId: 'r'.repeat(22),
        computerKey: 't'.repeat(43),
        computer: 'Office',
        projects: [
            {
                id: createId(),
                name: 'palmtopai',
                lastActivityAt: now - 4 * 60_000,
                sessions: 2,
                pending: 3,
            },
            {
                id: createId(),
                name: 'site',
                lastActivityAt: now - 3 * 3_600_000,
                sessions: 1,
                pending: 0,
            },
        ],
        pairedAt: 1,
    };
    const laptop: Pairing = {
        computerId: createId(),
        roomId: 's'.repeat(22),
        computerKey: 'u'.repeat(43),
        computer: 'Laptop',
        projects: [],
        pairedAt: 2,
    };
    const live = { [office.computerId]: { status: 'online' as const, projects: office.projects } };

    function renderDashboard(overrides: Partial<Parameters<typeof Dashboard>[0]> = {}) {
        const props = {
            pairings: [office, laptop],
            live,
            onOpenProject: mock(),
            onOpenComputer: mock(),
            onFollow: mock(),
            onUnpair: mock(),
            ...overrides,
        };
        render(<Dashboard {...props} />);
        return props;
    }

    test('the archive: archived projects leave the cards, and come back from the sheet', async () => {
        const archivedSession = {
            id: createId(),
            title: 'Old login',
            lastActivityAt: now - 60_000,
        };
        const shelved = {
            ...office,
            projects: [
                {
                    ...(office.projects[0] as PairedProject),
                    sessions: 0,
                    pending: 0,
                    archived: [archivedSession],
                },
                office.projects[1] as PairedProject,
            ],
        };
        const archive = { can: () => true, set: mock(), openSession: mock() };
        renderDashboard({ pairings: [shelved, laptop], live: {}, archive });
        const card = screen.getByRole('listitem', { name: 'Office' });
        expect(within(card).queryByRole('button', { name: /^palmtopai/ })).toBeNull();
        expect(within(card).getByRole('button', { name: /^site/ })).toBeTruthy();

        // A project with sessions can be archived from its menu.
        await userEvent.click(within(card).getByRole('button', { name: 'Menu of site' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: 'Archive project' }));
        expect(archive.set).toHaveBeenLastCalledWith(
            office.computerId,
            office.projects[1]?.id,
            true,
        );

        await userEvent.click(screen.getByRole('button', { name: 'Archive' }));
        const sheet = await screen.findByRole('dialog');
        const group = within(sheet).getByRole('listitem', { name: 'palmtopai' });
        expect(within(group).getByText('Office › palmtopai')).toBeTruthy();
        await userEvent.click(within(group).getByRole('button', { name: 'Restore Old login' }));
        expect(archive.set).toHaveBeenLastCalledWith(
            office.computerId,
            office.projects[0]?.id,
            false,
            [archivedSession.id],
        );
        await userEvent.click(within(group).getByRole('button', { name: 'Restore all' }));
        expect(archive.set).toHaveBeenLastCalledWith(
            office.computerId,
            office.projects[0]?.id,
            false,
            undefined,
        );
        await userEvent.click(within(group).getByRole('button', { name: /^Old login/ }));
        expect(archive.openSession).toHaveBeenCalledWith(
            office.computerId,
            office.projects[0]?.id,
            archivedSession.id,
        );
    });

    test('a computer that can not archive now: nothing to archive, restoring waits for it', async () => {
        const archivedSession = { id: createId(), title: 'Old login', lastActivityAt: 1 };
        const shelved = {
            ...office,
            projects: [
                {
                    ...(office.projects[0] as PairedProject),
                    sessions: 0,
                    archived: [archivedSession],
                },
            ],
        };
        renderDashboard({
            pairings: [shelved],
            live: {},
            archive: { can: () => false, set: mock(), openSession: mock() },
        });
        const card = screen.getByRole('listitem', { name: 'Office' });
        expect(
            within(card).getByText('Every project of this computer is in the archive.'),
        ).toBeTruthy();
        await userEvent.click(screen.getByRole('button', { name: 'Archive' }));
        const sheet = await screen.findByRole('dialog');
        expect(
            (within(sheet).getByRole('button', { name: 'Restore Old login' }) as HTMLButtonElement)
                .disabled,
        ).toBe(true);
        cleanup();
        // No archive: no button (a computer before 0.20 knows nothing of it).
        renderDashboard();
        expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    });

    test('a lost key says so, from the computer or from the fingerprint of the pairing', () => {
        renderDashboard({
            pairings: [office, { ...laptop, deviceKey: 'old-key-00000000' }],
            deviceKey: 'new-key-00000000',
            live: {
                [office.computerId]: { status: 'unauthorized', unauthorizedReason: 'key' },
                [laptop.computerId]: { status: 'connecting' },
            },
        });
        const card = screen.getByRole('listitem', { name: 'Office' });
        expect(within(card).getByText('Key lost')).toBeTruthy();
        expect(
            within(screen.getByRole('listitem', { name: 'Laptop' })).getByText('Key lost'),
        ).toBeTruthy();
        cleanup();
        // Another refusal is still "Not paired"; the same key, or none known, is not lost.
        renderDashboard({
            pairings: [office, { ...laptop, deviceKey: 'new-key-00000000' }],
            deviceKey: 'new-key-00000000',
            live: {
                [office.computerId]: { status: 'unauthorized', unauthorizedReason: 'not-paired' },
                [laptop.computerId]: { status: 'online', projects: [] },
            },
        });
        expect(
            within(screen.getByRole('listitem', { name: 'Office' })).getByText('Not paired'),
        ).toBeTruthy();
        expect(
            within(screen.getByRole('listitem', { name: 'Laptop' })).getByText('Live'),
        ).toBeTruthy();
    });

    test('one card per computer with its projects, counts and state', () => {
        renderDashboard();
        const card = screen.getByRole('listitem', { name: 'Office' });
        expect(within(card).getByText('Live')).toBeTruthy();
        expect(within(card).getByText('2 sessions · 4 min ago')).toBeTruthy();
        expect(within(card).getByText('3 to review')).toBeTruthy();
        expect(within(card).getByText('1 session · 3 h ago')).toBeTruthy();
        // A computer just paired is there too, with no projects.
        const empty = screen.getByRole('listitem', { name: 'Laptop' });
        expect(within(empty).getByText('Not connected')).toBeTruthy();
        expect(within(empty).getByText(/No projects yet/)).toBeTruthy();
    });

    test('opens a project, a computer, or the project where the agent is working', async () => {
        const props = renderDashboard();
        await userEvent.click(screen.getByRole('button', { name: /^site/ }));
        expect(props.onOpenProject).toHaveBeenCalledWith(office.computerId, office.projects[1]?.id);
        await userEvent.click(screen.getByRole('button', { name: /^Laptop/ }));
        expect(props.onOpenComputer).toHaveBeenCalledWith(laptop.computerId);
        await userEvent.click(screen.getByRole('button', { name: /Working now/ }));
        expect(props.onFollow).toHaveBeenCalledWith(office.computerId);
    });

    test('no "Working now" without recent activity on a live computer', () => {
        renderDashboard({ live: {} });
        expect(screen.queryByText('Working now')).toBeNull();
    });

    test('the notifications toggle shows their state and switches them', async () => {
        const onToggle = mock();
        renderDashboard({ notifications: { on: false, onToggle } });
        const toggle = screen.getByRole('button', { name: 'Notifications' });
        expect(toggle.getAttribute('aria-pressed')).toBe('false');
        await userEvent.click(toggle);
        expect(onToggle).toHaveBeenCalledTimes(1);
        cleanup();
        renderDashboard({ notifications: { on: true, onToggle } });
        expect(
            screen.getByRole('button', { name: 'Notifications' }).getAttribute('aria-pressed'),
        ).toBe('true');
    });

    test('unpairs a computer from its menu after a confirmation', async () => {
        const confirm = mock(() => false);
        const props = renderDashboard({ confirm });
        const openMenu = async () => {
            await userEvent.click(screen.getByRole('button', { name: 'Menu of Laptop' }));
            await userEvent.click(
                await screen.findByRole('menuitem', { name: 'Unpair this computer…' }),
            );
        };
        await openMenu();
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(props.onUnpair).not.toHaveBeenCalled();
        confirm.mockImplementation(() => true);
        await openMenu();
        expect(props.onUnpair).toHaveBeenCalledWith(laptop.computerId);
    });

    test('the app menu opens the feedback form', async () => {
        renderDashboard();
        await userEvent.click(screen.getByRole('button', { name: 'App menu' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: 'Send feedback' }));
        expect(await screen.findByRole('heading', { name: 'Send feedback' })).toBeTruthy();
    });

    test('"Pair a computer" explains how', async () => {
        renderDashboard();
        await userEvent.click(screen.getByRole('button', { name: 'Pair a computer' }));
        expect(await screen.findByText(/scan the QR code with this device/)).toBeTruthy();
    });

    test('project meta says what is known', () => {
        expect(projectMeta({ id: createId(), name: 'x' }, now)).toBe('');
        expect(projectMeta({ id: createId(), name: 'x', sessions: 0 }, now)).toBe('no sessions');
    });
});

describe('FeedbackSheet', () => {
    test('sends type, message, email and page, then thanks and remembers the email', async () => {
        const send = mock(async () => 'sent' as const);
        render(<FeedbackSheet open onOpenChange={() => {}} send={send} />);
        await userEvent.click(screen.getByRole('button', { name: 'Feature request' }));
        expect(
            screen.getByRole('button', { name: 'Feature request' }).getAttribute('aria-pressed'),
        ).toBe('true');
        await userEvent.type(screen.getByLabelText('Message'), 'Group checks by screen');
        await userEvent.type(screen.getByLabelText('Email'), ' tester@example.com ');
        await userEvent.click(screen.getByRole('button', { name: 'Send feedback' }));

        expect(send).toHaveBeenCalledWith({
            type: 'feature',
            message: 'Group checks by screen',
            email: 'tester@example.com',
            page: '/app/',
        });
        expect((await screen.findByRole('status')).textContent).toContain('Thanks');
        expect(localStorage.getItem('palmtop.feedbackEmail')).toBe('tester@example.com');
    });

    test('keeps the message and explains the error when sending fails', async () => {
        const send = mock(async () => 'rate_limited' as const);
        render(<FeedbackSheet open onOpenChange={() => {}} send={send} />);
        await userEvent.type(screen.getByLabelText('Message'), 'Crash on pairing');
        await userEvent.type(screen.getByLabelText('Email'), 'tester@example.com');
        await userEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
        expect((await screen.findByRole('alert')).textContent).toContain('try again in a minute');
        expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe(
            'Crash on pairing',
        );
    });

    test('an unpaired device can send feedback too', async () => {
        render(<EmptyState />);
        await userEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
        expect(await screen.findByRole('heading', { name: 'Send feedback' })).toBeTruthy();
    });
});

describe('PairCode', () => {
    const ROOM = 'r'.repeat(43);
    const KEY = 'k'.repeat(22);
    let identity: DeviceIdentity;

    beforeAll(async () => {
        identity = { deviceId: 'web-test', keys: await generateDeviceKeys() };
    });

    /** Pairing needs this device's identity, as the app provides it. */
    const withIdentity = (ui: React.ReactNode) => (
        <IdentityProvider value={identity}>{ui}</IdentityProvider>
    );

    /** A fake relay wait: the test pushes states and offers into the component. */
    function fakeWait() {
        const control: {
            options?: Parameters<typeof waitForPairing>[0];
            stopped: boolean;
        } = { stopped: false };
        const wait = ((options: Parameters<typeof waitForPairing>[0]) => {
            control.options = options;
            return {
                stop: () => {
                    control.stopped = true;
                },
            };
        }) as typeof waitForPairing;
        const push = (fn: (options: Parameters<typeof waitForPairing>[0]) => void) =>
            act(() => fn(control.options as Parameters<typeof waitForPairing>[0]));
        return { wait, control, push };
    }

    /** A fake `pairDevice`: it shows the number like the real one, and answers after it. */
    function fakePair(number = '482913') {
        return mock(async (options: Parameters<typeof pairDevice>[0]) => {
            const same = (await options.confirmNumber?.(number)) ?? true;
            if (!same) throw new Error('the numbers did not match');
            return { computerId: createId(), computer: 'MAC', computerKey: 'c'.repeat(43) };
        });
    }

    test('shows the code and the command, asks before pairing, then the number to compare', async () => {
        const { wait, control, push } = fakeWait();
        const pair = fakePair();
        const onPaired = mock();
        const { unmount } = render(
            withIdentity(<PairCode wait={wait} pair={pair as never} onPaired={onPaired} />),
        );
        expect(screen.getByText('Getting a pairing code…')).toBeTruthy();
        expect(control.options?.url).toMatch(/^wss?:\/\/.+\/wait$/);

        push((options) => options.onState({ status: 'waiting', code: 'ABC123', expiresAt: 1 }));
        expect(screen.getByTestId('pair-code').textContent).toBe('ABC 123');
        expect(screen.getByText('palmtop pair ABC123')).toBeTruthy();

        push((options) => options.onOffer({ room: ROOM, key: KEY, computer: 'MAC' }));
        expect(screen.getByText('Pair with “MAC”?')).toBeTruthy();
        await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
        expect(pair).not.toHaveBeenCalled();
        expect(screen.getByTestId('pair-code')).toBeTruthy();

        push((options) => options.onOffer({ room: ROOM, key: KEY, computer: 'MAC' }));
        await userEvent.click(screen.getByRole('button', { name: 'Pair' }));
        // The number, until the user compares it with the computer's.
        expect((await screen.findByTestId('pair-number')).textContent).toBe('482 913');
        expect(onPaired).not.toHaveBeenCalled();
        await userEvent.click(screen.getByRole('button', { name: 'Same number' }));
        await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));

        const [call] = pair.mock.calls;
        expect(call?.[0]).toMatchObject({
            roomId: ROOM,
            pairKey: KEY,
            deviceId: identity.deviceId,
            deviceKeys: identity.keys,
            timeoutMs: 300_000,
        });
        expect(call?.[0].url).toContain(`/ws?room=${ROOM}`);
        expect(call?.[0].name).toContain(' · ');
        expect(onPaired.mock.calls[0]?.[0]).toBe(ROOM);

        unmount();
        expect(control.stopped).toBe(true);
    });

    test('a different number pairs nothing and says why', async () => {
        const { wait, push } = fakeWait();
        const onPaired = mock();
        render(
            withIdentity(<PairCode wait={wait} pair={fakePair() as never} onPaired={onPaired} />),
        );
        push((options) => options.onState({ status: 'waiting', code: 'ABC123', expiresAt: 1 }));
        push((options) => options.onOffer({ room: ROOM, key: KEY, computer: 'MAC' }));
        await userEvent.click(screen.getByRole('button', { name: 'Pair' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Different' }));
        expect((await screen.findByRole('alert')).textContent).toContain(
            'The numbers did not match, so nothing was paired',
        );
        expect(onPaired).not.toHaveBeenCalled();
        expect(screen.getByTestId('pair-code')).toBeTruthy();
    });

    test('a key that does not work says so and goes back to the code', async () => {
        const { wait, push } = fakeWait();
        const pair = mock(async () => {
            throw new Error('expired');
        });
        render(withIdentity(<PairCode wait={wait} pair={pair as never} onPaired={mock()} />));
        push((options) => options.onState({ status: 'waiting', code: 'ABC123', expiresAt: 1 }));
        push((options) => options.onOffer({ room: ROOM, key: KEY, computer: 'MAC' }));
        await userEvent.click(screen.getByRole('button', { name: 'Pair' }));
        expect((await screen.findByRole('alert')).textContent).toContain('Pairing did not work');
        expect(screen.getByTestId('pair-code')).toBeTruthy();
        push((options) => options.onState({ status: 'offline' }));
        expect(screen.getByText('No connection to palmtop: retrying…')).toBeTruthy();
    });

    test('the installed app pairs with a code: empty state and "Pair a computer"', async () => {
        // No relay here: a socket that never opens keeps the code loading.
        const RealWebSocket = globalThis.WebSocket;
        const opened: string[] = [];
        globalThis.WebSocket = class {
            constructor(url: string) {
                opened.push(url);
            }
            close() {}
        } as unknown as typeof WebSocket;
        try {
            await pairingScreens();
        } finally {
            globalThis.WebSocket = RealWebSocket;
        }
        expect(opened).toHaveLength(2);
        expect(opened[0]).toMatch(/\/wait$/);
    });

    test('the QR pairing screen says the relay cannot read the checklists', () => {
        render(<EmptyState />);
        expect(screen.getByText(/End-to-end encrypted/)).toBeTruthy();
    });

    async function pairingScreens() {
        render(withIdentity(<EmptyState onPairedByCode={mock()} />));
        expect(screen.getByText('Getting a pairing code…')).toBeTruthy();
        expect(screen.queryByText(/scan the QR code/)).toBeNull();
        expect(screen.getByText(/End-to-end encrypted/)).toBeTruthy();
        cleanup();

        render(
            withIdentity(
                <Dashboard
                    pairings={[]}
                    live={{}}
                    onOpenProject={mock()}
                    onOpenComputer={mock()}
                    onFollow={mock()}
                    onUnpair={mock()}
                    onPairedByCode={mock()}
                />,
            ),
        );
        await userEvent.click(screen.getByRole('button', { name: /Pair a computer/ }));
        expect(await screen.findByText('Getting a pairing code…')).toBeTruthy();
        cleanup();
    }
});

describe('StorageNotice', () => {
    test('after a deletion: what happened and what to do, for computers or invitations', async () => {
        const onDismiss = mock();
        const where = { installed: false, platform: 'android' as const };
        render(<StorageNotice kind="cleared" guestOnly={false} {...where} onDismiss={onDismiss} />);
        expect(screen.getByRole('alert').textContent).toContain('pair this device again');
        await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
        expect(onDismiss).toHaveBeenCalledTimes(1);
        cleanup();
        render(<StorageNotice kind="cleared" guestOnly {...where} onDismiss={mock()} />);
        expect(screen.getByRole('alert').textContent).toContain('ask for a new invitation');
        cleanup();
        render(<StorageNotice kind="at-risk" guestOnly={false} {...where} onDismiss={mock()} />);
        expect(screen.getByRole('status').textContent).toContain('Home Screen');
        cleanup();
        // On a computer there is no Home Screen; in the installed app, nothing to install.
        const at = (installed: boolean, platform: 'other' | 'android') => {
            render(
                <StorageNotice
                    kind="at-risk"
                    guestOnly={false}
                    installed={installed}
                    platform={platform}
                    onDismiss={mock()}
                />,
            );
            const text = screen.getByRole('status').textContent;
            cleanup();
            return text;
        };
        expect(at(false, 'other')).toContain('Install app');
        expect(at(true, 'android')).toContain('Keep some free space');
        expect(at(true, 'android')).not.toContain('Home Screen');
    });
});

describe('EmptyState without encryption', () => {
    test('not on HTTPS, or a browser too old: says which, and what to do', () => {
        render(<EmptyState unsupported="insecure" />);
        expect(screen.getByRole('alert').textContent).toContain('https://');
        cleanup();
        render(<EmptyState unsupported="browser" />);
        expect(screen.getByRole('alert').textContent).toContain(
            'Safari 17, Chrome 137, Firefox 130',
        );
        expect(screen.queryByText(/End-to-end encrypted/)).toBeNull();
    });

    test('keys that cannot be read: says to reopen the app, and offers to try again', () => {
        render(<EmptyState unsupported="storage" />);
        expect(screen.getByRole('alert').textContent).toContain('Close the app completely');
        expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
        expect(screen.queryByText(/palmtop pair/)).toBeNull();
    });

    test('keys that fail to load are a storage problem, not an old browser', async () => {
        const failing = () => Promise.reject(new Error('Internal error opening backing store'));
        const yes = async () => true;
        const no = async () => false;
        const storage = renderHook(() => useDeviceIdentity('web-0123456789abcdef', failing, yes));
        await waitFor(() =>
            expect(storage.result.current).toEqual({ status: 'unsupported', reason: 'storage' }),
        );
        storage.unmount();
        const old = renderHook(() => useDeviceIdentity('web-0123456789abcdef', failing, no));
        await waitFor(() =>
            expect(old.result.current).toEqual({ status: 'unsupported', reason: 'browser' }),
        );
    });
});

describe('InstallPrompt', () => {
    test("iPhone: Share, Add to Home Screen, then the code; Close and Don't show again", async () => {
        const onClose = mock();
        const onNever = mock();
        render(<InstallPrompt platform="ios" onClose={onClose} onNever={onNever} />);
        const prompt = screen.getByRole('region', { name: 'Install palmtop' });
        expect(within(prompt).getByText(/Safari clears it after 7 days/)).toBeTruthy();
        expect(within(prompt).getByText('Add to Home Screen')).toBeTruthy();
        expect(within(prompt).getByText('palmtop pair CODE')).toBeTruthy();
        await userEvent.click(within(prompt).getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        await userEvent.click(within(prompt).getByRole('button', { name: "Don't show again" }));
        expect(onNever).toHaveBeenCalledTimes(1);
    });

    test('Android without the browser prompt: the steps of the menu', () => {
        render(<InstallPrompt platform="android" onClose={mock()} onNever={mock()} />);
        expect(screen.getByText('Install app')).toBeTruthy();
        expect(screen.queryByText(/Safari/)).toBeNull();
    });

    test('the Dashboard menu has "Install app" only in the browser', async () => {
        const onInstall = mock();
        const props = {
            pairings: [],
            live: {},
            onOpenProject: mock(),
            onOpenComputer: mock(),
            onFollow: mock(),
            onUnpair: mock(),
        };
        render(<Dashboard {...props} onInstall={onInstall} />);
        await userEvent.click(screen.getByRole('button', { name: 'App menu' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: 'Install app' }));
        expect(onInstall).toHaveBeenCalledTimes(1);
        cleanup();

        render(<Dashboard {...props} />);
        await userEvent.click(screen.getByRole('button', { name: 'App menu' }));
        await screen.findByRole('menuitem', { name: 'Send feedback' });
        expect(screen.queryByRole('menuitem', { name: 'Install app' })).toBeNull();
    });

    test('a new version of the app: a yellow dot on the ⋯, and a tap reloads into it', async () => {
        const props = {
            pairings: [],
            live: {},
            onOpenProject: mock(),
            onOpenComputer: mock(),
            onFollow: mock(),
            onUnpair: mock(),
        };
        render(<Dashboard {...props} />);
        expect(screen.queryByTestId('menu-attention')).toBeNull();
        cleanup();

        const onUpdate = mock();
        render(<Dashboard {...props} onUpdate={onUpdate} />);
        expect(screen.getByTestId('menu-attention')).toBeTruthy();
        await userEvent.click(screen.getByRole('button', { name: 'App menu' }));
        await userEvent.click(
            await screen.findByRole('menuitem', { name: 'New version available' }),
        );
        expect(onUpdate).toHaveBeenCalledTimes(1);
    });
});

describe('the answers of the people a session is shared with', () => {
    type Given = { itemId: string; checklistId: string };
    const mario = ({ itemId, checklistId }: Given, extra: Record<string, unknown> = {}) => ({
        name: 'Mario',
        state: 'open' as const,
        expiresAt: Date.now() + 86_400_000,
        checklists: [checklistId],
        items: { [itemId]: { status: 'done' as const } },
        ...extra,
    });
    const luca = ({ itemId, checklistId }: Given) => ({
        name: 'Luca',
        state: 'open' as const,
        expiresAt: Date.now() + 86_400_000,
        checklists: [checklistId],
        items: { [itemId]: { status: 'cancelled' as const, note: 'no error is shown' } },
    });

    test('an item shows a chip with the name of each person and what they answered', () => {
        render(
            <ul>
                <ItemRow
                    item={baseItem}
                    onChange={mock()}
                    outcomes={[
                        { person: 'Mario', status: 'done', state: 'open' },
                        {
                            person: 'Luca',
                            status: 'cancelled',
                            note: 'no error is shown',
                            state: 'open',
                        },
                        { person: 'Ada', state: 'open' },
                    ]}
                />
            </ul>,
        );
        const chips = within(screen.getByRole('list', { name: 'Answers of the people' }));
        expect(chips.getByText('Mario').closest('li')?.textContent).toContain('✓');
        expect(chips.getByText('Luca').closest('li')?.textContent).toContain('✕');
        // Somebody who has not answered yet is shown too, as waiting.
        expect(chips.getByText('Ada').closest('li')?.textContent).toContain('…');
        expect(chips.getByText('Ada').closest('li')?.textContent).toContain('has not answered');
        expect(screen.getByText('no error is shown').closest('p')?.textContent).toContain('Luca:');
    });

    test('an item nobody is asked about shows no chips', () => {
        render(
            <ul>
                <ItemRow item={baseItem} onChange={mock()} />
            </ul>,
        );
        expect(screen.queryByRole('list', { name: 'Answers of the people' })).toBeNull();
    });

    test('the chips come with the checklist, and "Hide results" takes them away and is remembered', async () => {
        const a = sessionWithChecklist('alpha', 1_000);
        const state = applyAll(createProjectState(projectId), a.ops);
        const snapshot = snapshotOf(state, {
            shares: [
                {
                    sessionId: a.sessionId,
                    people: [mario(a), luca(a)],
                },
            ],
        });
        render(view(snapshot));

        const checklist = screen.getByRole('region', { name: 'alpha checklist' });
        expect(within(checklist).getByRole('list', { name: 'Answers of the people' })).toBeTruthy();
        expect(screen.getByRole('region', { name: 'From the people you share with' })).toBeTruthy();

        await userEvent.click(screen.getByRole('button', { name: 'Hide results' }));
        expect(screen.queryByRole('list', { name: 'Answers of the people' })).toBeNull();
        expect(screen.queryByRole('region', { name: 'From the people you share with' })).toBeNull();
        expect(loadHideResults()).toBe(true);

        // A new visit starts with the choice made.
        cleanup();
        render(view(snapshot));
        expect(screen.queryByRole('list', { name: 'Answers of the people' })).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: 'Hide results' }));
        expect(screen.getByRole('list', { name: 'Answers of the people' })).toBeTruthy();
        expect(loadHideResults()).toBe(false);
    });

    test('with nothing shared there is no button and no section', () => {
        const a = sessionWithChecklist('alpha', 1_000);
        render(view(snapshotOf(applyAll(createProjectState(projectId), a.ops))));
        expect(screen.queryByRole('button', { name: 'Hide results' })).toBeNull();
        expect(screen.queryByRole('region', { name: 'From the people you share with' })).toBeNull();
    });

    test('shows who it is shared with and the notes they wrote', () => {
        const a = sessionWithChecklist('alpha', 1_000);
        const state = applyAll(createProjectState(projectId), a.ops);
        render(
            view(
                snapshotOf(state, {
                    shares: [
                        {
                            sessionId: a.sessionId,
                            people: [
                                mario(a, {
                                    note: 'Looks fine otherwise',
                                }),
                                { ...luca(a), state: 'closed' as const },
                            ],
                        },
                    ],
                }),
            ),
        );
        const section = screen.getByRole('region', { name: 'From the people you share with' });
        expect(section.textContent).toContain('Mario (open until');
        expect(section.textContent).toContain('Luca (closed)');
        expect(section.textContent).toContain('Mario: Looks fine otherwise');
    });

    test('a person gets chips only on the checklists given to them', () => {
        const a = sessionWithChecklist('alpha', 1_000);
        const second = createId();
        const secondItem = createId();
        const ops = [
            ...a.ops,
            op(
                a.sessionId,
                'checklist.create',
                { checklistId: second, title: 'beta checklist' },
                1_001,
            ),
            op(
                a.sessionId,
                'item.add',
                { itemId: secondItem, checklistId: second, text: 'beta item', order: 0 },
                1_001,
            ),
        ];
        render(
            view(
                snapshotOf(applyAll(createProjectState(projectId), ops), {
                    shares: [{ sessionId: a.sessionId, people: [mario(a)] }],
                }),
            ),
        );
        const given = screen.getByRole('region', { name: 'alpha checklist' });
        expect(within(given).getByRole('list', { name: 'Answers of the people' })).toBeTruthy();
        const other = screen.getByRole('region', { name: 'beta checklist' });
        expect(within(other).queryByRole('list', { name: 'Answers of the people' })).toBeNull();
    });

    test('other sessions have their own people', () => {
        const a = sessionWithChecklist('alpha', 1_000);
        render(
            view(
                snapshotOf(applyAll(createProjectState(projectId), a.ops), {
                    shares: [{ sessionId: createId(), people: [mario(a)] }],
                }),
            ),
        );
        expect(screen.queryByRole('list', { name: 'Answers of the people' })).toBeNull();
    });
});

describe('what somebody shares with this device', () => {
    const shared = (extra: Partial<SyncSnapshot> = {}, until = Date.now() + 86_400_000) => {
        const a = sessionWithChecklist('Release', 1_000);
        const reviewed = op(
            a.sessionId,
            'item.update',
            { itemId: a.itemId, status: 'done', note: 'works for me' },
            5_000,
        );
        return {
            a,
            snapshot: snapshotOf(applyAll(createProjectState(projectId), [...a.ops, reviewed]), {
                project: {
                    id: projectId,
                    name: 'Release',
                    computer: 'Grace (studio)',
                    sharedUntil: until,
                },
                computer: { id: computerId, name: 'Grace (studio)' },
                ...extra,
            }),
        };
    };

    test('has nothing to delete and nothing about "your computer"', () => {
        render(view(shared().snapshot, { onRemoveProject: mock() }));
        expect(screen.queryByRole('button', { name: 'Project menu' })).toBeNull();
        expect(
            screen.queryByRole('button', { name: /Follow activity|Following activity/ }),
        ).toBeNull();
        expect(screen.getByText('Grace (studio)')).toBeTruthy();
    });

    test('the note and the message are with the owner, not "the agent"', () => {
        const { a, snapshot } = shared();
        const withMessage = applyAll(snapshot.state as ProjectState, [
            op(a.sessionId, 'session.message', { message: 'Start with the login' }, 6_000),
        ]);
        render(view({ ...snapshot, state: withMessage }));
        expect(screen.getByRole('region', { name: 'Message from Grace (studio)' })).toBeTruthy();
        const note = screen.getByRole('region', { name: 'Note for Grace (studio)' });
        expect(within(note).getByText('+ Write something for Grace (studio)')).toBeTruthy();
        expect(screen.queryByText(/the agent/)).toBeNull();
    });

    test('with nothing left shared the badge says so, not that the owner is offline', () => {
        const { snapshot } = shared({ status: 'daemon-offline', projects: [] });
        render(view(snapshot));
        expect(screen.getByRole('status').textContent).toContain('Nothing shared');
        expect(screen.queryByText('Owner offline')).toBeNull();
    });

    test('says whose computer is off, and not that "your computer" is', () => {
        const { snapshot } = shared({ status: 'daemon-offline' });
        render(view(snapshot));
        expect(screen.getByRole('status').textContent).toContain('Owner offline');
        expect(screen.getByText(/Grace \(studio\)'s computer is offline/)).toBeTruthy();
        expect(screen.queryByText(/Your computer/)).toBeNull();
        expect(screen.queryByText(/palmtopai on it/)).toBeNull();
        expect(screen.queryByRole('button', { name: 'Remove from this device' })).toBeNull();
    });

    test('when the owner stopped sharing it asks for a new invitation', () => {
        render(view(shared({ status: 'unauthorized', state: null }).snapshot, { guest: true }));
        expect(screen.getByText(/is not sharing with this device any more/)).toBeTruthy();
        expect(screen.getByText(/Ask Grace \(studio\) for a new invitation/)).toBeTruthy();
        expect(screen.queryByText(/palmtop pair/)).toBeNull();
    });

    test("takes answers until the owner's date, then it is read-only", async () => {
        const open = shared();
        const { unmount } = render(view(open.snapshot));
        const list = screen.getByRole('region', { name: 'Release checklist' });
        // A guest reviews and writes notes: there is no way to add an item.
        expect(within(list).queryByRole('button', { name: '+ Add item' })).toBeNull();
        expect(
            within(list).getAllByRole('button', { name: /Done|Cancelled|Question/ })[0],
        ).toHaveProperty('disabled', false);
        expect(screen.queryByText(/read-only now/)).toBeNull();
        unmount();

        render(view(shared({}, Date.now() - 1_000).snapshot));
        const closed = screen.getByRole('region', { name: 'Release checklist' });
        expect(screen.getByText(/It is read-only now/)).toBeTruthy();
        expect(within(closed).queryByRole('button', { name: '+ Add item' })).toBeNull();
        const buttons = within(closed).getAllByRole('button', { name: /Done|Cancelled|Question/ });
        expect(buttons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
        // What was answered can be read, but not changed.
        expect(within(closed).getByText('works for me')).toBeTruthy();
        expect(within(closed).queryByText('+ Add note')).toBeNull();
        expect(screen.getByRole('button', { name: /No note|Write something/ })).toHaveProperty(
            'disabled',
            true,
        );
    });

    test('leaving asks in the words of a guest', async () => {
        const confirm = mock(() => false);
        render(
            view(shared({ status: 'unauthorized', state: null }).snapshot, {
                guest: true,
                confirm,
            }),
        );
        const onUnpair = mock();
        cleanup();
        render(
            view(shared({ status: 'unauthorized', state: null }).snapshot, {
                guest: true,
                onUnpair,
                confirm,
            }),
        );
        await userEvent.click(screen.getByRole('button', { name: 'Remove from this device' }));
        expect(onUnpair).toHaveBeenCalled();
    });
});

describe('Dashboard with a guest pairing', () => {
    const guestPairing: Pairing = {
        computerId: createId(),
        roomId: 'r'.repeat(43),
        computerKey: 'k'.repeat(43),
        computer: 'Grace (studio)',
        projects: [{ id: createId(), name: 'Release', sessions: 1, pending: 2 }],
        pairedAt: 1,
        guest: true,
    };

    test('is not "working now", and leaving is not "unpairing a computer"', async () => {
        const confirm = mock((_message: string) => true);
        const onUnpair = mock();
        render(
            <Dashboard
                pairings={[guestPairing]}
                live={{
                    [guestPairing.computerId]: {
                        status: 'online',
                        projects: [{ id: createId(), name: 'Release', lastActivityAt: Date.now() }],
                    },
                }}
                onOpenProject={mock()}
                onOpenComputer={mock()}
                onFollow={mock()}
                onUnpair={onUnpair}
                confirm={confirm}
            />,
        );
        expect(screen.queryByText('Working now')).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: 'Menu of Grace (studio)' }));
        await userEvent.click(screen.getByRole('menuitem', { name: 'Remove from this device…' }));
        expect(confirm.mock.calls[0]?.[0]).toContain('ask Grace (studio) for a new invitation');
        expect(onUnpair).toHaveBeenCalledWith(guestPairing.computerId);
    });

    test('a guest with nothing shared is told so, not that the owner is offline', () => {
        render(
            <Dashboard
                pairings={[{ ...guestPairing, projects: [] }]}
                live={{ [guestPairing.computerId]: { status: 'daemon-offline', projects: [] } }}
                onOpenProject={mock()}
                onOpenComputer={mock()}
                onFollow={mock()}
                onUnpair={mock()}
            />,
        );
        expect(screen.getByText('Nothing shared')).toBeTruthy();
        expect(screen.queryByText('Owner offline')).toBeNull();
    });

    test('says the owner is offline, not the PC', () => {
        render(
            <Dashboard
                pairings={[guestPairing]}
                live={{ [guestPairing.computerId]: { status: 'daemon-offline' } }}
                onOpenProject={mock()}
                onOpenComputer={mock()}
                onFollow={mock()}
                onUnpair={mock()}
            />,
        );
        expect(screen.getByText('Owner offline')).toBeTruthy();
        expect(screen.queryByText('PC offline')).toBeNull();
    });
});

describe('EmptyState for an invitation', () => {
    test('opening and refusing say it is an invitation', () => {
        render(<EmptyState pairing invitation />);
        expect(screen.getByText('Opening what was shared with you…')).toBeTruthy();
        cleanup();
        render(<EmptyState invalidLink invitation />);
        expect(screen.getByRole('alert').textContent).toContain('That invitation is not valid');
        expect(screen.getByRole('alert').textContent).toContain('Ask the person who sent it');
        cleanup();
        render(<EmptyState invalidLink />);
        expect(screen.getByRole('alert').textContent).toContain('pairing link');
    });
});

describe('links in texts', () => {
    const address = 'https://staging.example.com/login';

    test('the agent message opens its address in a new tab', () => {
        render(<AgentMessage text={`Try ${address}.`} at={1} />);
        const link = screen.getByRole('link', { name: address });
        expect(link.getAttribute('href')).toBe(address);
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    });

    test('the title of a checklist has a link', () => {
        const checklist: Checklist = {
            id: createId(),
            sessionId: createId(),
            title: `Checks on ${address}`,
            createdAt: 1,
            updatedAt: 1,
            kind: 'checks',
            pick: 'one',
        };
        render(
            <ChecklistCard
                checklist={checklist}
                items={[baseItem]}
                visible={[baseItem]}
                countdowns={new Map()}
                hideDelayMs={5_000}
                onChange={mock()}
                onEditingChange={mock()}
                onRemove={mock()}
                onAdd={mock()}
            />,
        );
        expect(screen.getByRole('link', { name: address })).toBeTruthy();
        expect(screen.getByRole('region', { name: `Checks on ${address}` })).toBeTruthy();
    });

    test('an item of the agent has a link', () => {
        render(<ItemRow item={{ ...baseItem, text: `Open ${address}` }} onChange={mock()} />);
        expect(screen.getByRole('link', { name: address })).toBeTruthy();
    });

    test('a note with an address has an Edit button and the link does not open the editor', async () => {
        const onSave = mock();
        render(<NoteForAgent note={`See ${address}`} delivered={false} onSave={onSave} />);
        const link = screen.getByRole('link', { name: address });
        // Nothing in a button: the link is a link, the editor opens from its own button.
        expect(link.closest('button')).toBeNull();
        link.addEventListener('click', (event) => event.preventDefault());
        await userEvent.click(link);
        expect(screen.queryByRole('textbox')).toBeNull();

        await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
        expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(`See ${address}`);
    });

    test('a note without an address keeps opening the editor when tapped', async () => {
        render(<NoteForAgent note="Use staging" delivered={false} onSave={mock()} />);
        expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
        await userEvent.click(screen.getByText('Use staging'));
        expect(screen.getByRole('textbox')).toBeTruthy();
    });

    test('a note that cannot be written has links and no Edit button', () => {
        render(<NoteForAgent note={`See ${address}`} delivered readOnly onSave={mock()} />);
        expect(screen.getByRole('link', { name: address })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    });

    test('an item added by the user with an address is edited from its own button', async () => {
        const item = { ...baseItem, text: `Check ${address}`, addedByUser: true };
        render(<ItemRow item={item} onChange={mock()} onRemove={mock()} />);
        expect(screen.getByRole('link', { name: address }).closest('button')).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: `Edit ${item.text}` }));
        expect(screen.getByRole('textbox', { name: 'Text of the item' })).toBeTruthy();
    });

    test('the note of a reviewed item with an address has a link', () => {
        render(
            <ItemRow
                item={{ ...baseItem, status: 'cancelled', note: `Broken on ${address}` }}
                onChange={mock()}
            />,
        );
        expect(screen.getByRole('link', { name: address })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    });
});

describe('the note for the agent as a list', () => {
    const list = (...texts: string[]) =>
        joinNote(texts.map((text, index) => ({ id: `id0${index}`, text })));

    test('elements are added one by one, each with its own name', async () => {
        const onSave = mock();
        const { rerender } = render(<NoteForAgent note="" delivered={false} onSave={onSave} />);
        await userEvent.click(screen.getByText('+ Write something for the agent'));
        await userEvent.type(screen.getByRole('textbox'), '  Header is wrong ');
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));
        const first = onSave.mock.calls[0]?.[0] as string;
        expect(splitNote(first)).toEqual([
            { id: expect.stringMatching(/^[a-z0-9]{4}$/), text: 'Header is wrong' },
        ]);

        rerender(<NoteForAgent note={first} delivered={false} onSave={onSave} />);
        expect(screen.getByText('Header is wrong')).toBeTruthy();
        await userEvent.click(screen.getByText('+ Add another'));
        await userEvent.type(screen.getByRole('textbox'), 'Check the footer');
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));
        const entries = splitNote(onSave.mock.calls[1]?.[0] as string);
        expect(entries.map((entry) => entry.text)).toEqual(['Header is wrong', 'Check the footer']);
        // The first one keeps its name: the computer tells it from a new one by it.
        expect(entries[0]?.id).toBe(splitNote(first)[0]?.id as string);
        expect(entries[1]?.id).not.toBe(entries[0]?.id as string);
    });

    test('an element is edited in place and the others stay as they are', async () => {
        const onSave = mock();
        const note = list('one', 'two', 'three');
        render(<NoteForAgent note={note} delivered={false} onSave={onSave} />);
        await userEvent.click(screen.getByText('two'));
        const field = screen.getByRole('textbox');
        expect((field as HTMLTextAreaElement).value).toBe('two');
        await userEvent.clear(field);
        await userEvent.type(field, 'two and a half');
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(onSave).toHaveBeenCalledWith(list('one', 'two and a half', 'three'));
    });

    test('an element is deleted, or removed by saving it empty', async () => {
        const onSave = mock();
        const note = list('one', 'two');
        render(<NoteForAgent note={note} delivered={false} onSave={onSave} />);
        await userEvent.click(screen.getByText('one'));
        await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
        expect(onSave).toHaveBeenLastCalledWith(joinNote([{ id: 'id01', text: 'two' }]));

        await userEvent.click(screen.getByText('two'));
        await userEvent.clear(screen.getByRole('textbox'));
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(onSave).toHaveBeenLastCalledWith(joinNote([{ id: 'id00', text: 'one' }]));
    });

    test('cancelling, or saving the same text, changes nothing', async () => {
        const onSave = mock();
        render(<NoteForAgent note={list('one')} delivered={false} onSave={onSave} />);
        await userEvent.click(screen.getByText('one'));
        await userEvent.type(screen.getByRole('textbox'), ' more');
        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await userEvent.click(screen.getByText('one'));
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(onSave).not.toHaveBeenCalled();
    });

    test('a note that is not a list is shown as one element and becomes a list when edited', async () => {
        const onSave = mock();
        render(<NoteForAgent note="Use staging" delivered={false} onSave={onSave} />);
        await userEvent.click(screen.getByText('Use staging'));
        await userEvent.type(screen.getByRole('textbox'), ' please');
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(onSave).toHaveBeenCalledWith(
            expect.stringMatching(/^- Use staging please \[#[a-z0-9]{4}\]$/),
        );
    });

    test('a note too long for the whole is refused where it is written', async () => {
        const onSave = mock();
        const big = 'x'.repeat(9_990);
        render(<NoteForAgent note={list(big)} delivered={false} onSave={onSave} />);
        await userEvent.click(screen.getByText('+ Add another'));
        await userEvent.type(screen.getByRole('textbox'), 'a bit more than fits');
        expect(screen.getByRole('alert').textContent).toContain('too long');
        expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
            true,
        );
    });

    test('a note that cannot be written is only read, and an empty one says so', () => {
        const { rerender } = render(
            <NoteForAgent note={list('one', 'two')} delivered readOnly onSave={mock()} />,
        );
        expect(screen.getByText('one')).toBeTruthy();
        expect(screen.queryByText('+ Add another')).toBeNull();
        expect(screen.getByText('Read by the agent.')).toBeTruthy();
        rerender(<NoteForAgent note="" delivered={false} readOnly onSave={mock()} />);
        expect(
            (screen.getByRole('button', { name: 'No note' }) as HTMLButtonElement).disabled,
        ).toBe(true);
    });

    test('on a copy shared with a person the elements are for the owner', () => {
        render(<NoteForAgent to="Grace" note={list('one')} delivered={false} onSave={mock()} />);
        expect(screen.getByRole('region', { name: 'Note for Grace' })).toBeTruthy();
        expect(screen.getByText('Sent to Grace.')).toBeTruthy();
    });
});

describe('the note of a person, as a list', () => {
    test('the owner reads the elements without their names', () => {
        render(
            <PeopleResults
                now={1}
                people={[
                    {
                        name: 'Mario',
                        state: 'open',
                        expiresAt: 10,
                        checklists: [],
                        items: {},
                        note: joinNote([
                            { id: 'k3f9', text: 'Login is slow' },
                            { id: 'a81x', text: 'See https://example.com/x' },
                        ]),
                    },
                ]}
            />,
        );
        const region = screen.getByRole('region', { name: 'From the people you share with' });
        expect(region.textContent).toContain('- Login is slow');
        expect(region.textContent).not.toContain('[#');
        expect(within(region).getByRole('link', { name: 'https://example.com/x' })).toBeTruthy();
    });
});

describe('screenshots in notes', () => {
    const shot = createId();
    const token = screenshotToken(shot);
    const jpeg = { mime: 'image/jpeg' as const, bytes: new Uint8Array([0xff, 0xd8, 0xff, 1]) };

    function api(overrides: Partial<ImagesApi> = {}) {
        const send = mock(async (_file: Blob) => shot);
        const load = mock(async (_id: string) => jpeg as typeof jpeg | null);
        const value: ImagesApi = { enabled: true, online: true, send, load, ...overrides };
        return { value, send, load };
    }

    const withImages = (value: ImagesApi | null, node: ReactNode) => (
        <ImagesProvider value={value}>{node}</ImagesProvider>
    );

    const reviewed = (note?: string) => ({
        ...baseItem,
        status: 'cancelled' as const,
        ...(note !== undefined && { note }),
    });

    test('the note of an item shows its text and its picture, never the token', async () => {
        const { value, load } = api();
        render(
            withImages(value, <ItemRow item={reviewed(`Broken\n${token}`)} onChange={mock()} />),
        );
        const picture = await screen.findByRole('img', { name: 'Screenshot' });
        // A data address: the page's policy allows no blob.
        expect(picture.getAttribute('src')).toBe('data:image/jpeg;base64,/9j/AQ==');
        expect(load).toHaveBeenCalledWith(shot);
        expect(screen.getByText('Broken')).toBeTruthy();
        expect(document.body.textContent).not.toContain('[screenshot');
    });

    test('a screenshot is added while writing the note, and saved with it', async () => {
        const { value, send } = api();
        const onChange = mock();
        render(withImages(value, <ItemRow item={reviewed()} onChange={onChange} />));
        await userEvent.click(screen.getByText('+ Add note'));
        await userEvent.type(screen.getByRole('textbox'), 'Looks wrong');
        const file = new File(['pixels'], 'shot.png', { type: 'image/png' });
        await userEvent.upload(screen.getByLabelText('Choose a screenshot'), file);
        expect(send).toHaveBeenCalledWith(file);
        expect(await screen.findByRole('button', { name: 'Replace screenshot' })).toBeTruthy();
        await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
        expect(onChange).toHaveBeenCalledWith({ note: `Looks wrong\n${token}` });
    });

    test('a note can be only a screenshot, and the screenshot can be taken off', async () => {
        const { value } = api();
        const onChange = mock();
        const { rerender } = render(
            withImages(value, <ItemRow item={reviewed()} onChange={onChange} />),
        );
        await userEvent.click(screen.getByText('+ Add note'));
        await userEvent.upload(
            screen.getByLabelText('Choose a screenshot'),
            new File(['p'], 'a.png', { type: 'image/png' }),
        );
        await screen.findByRole('button', { name: 'Replace screenshot' });
        await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
        expect(onChange).toHaveBeenLastCalledWith({ note: token });

        rerender(withImages(value, <ItemRow item={reviewed(token)} onChange={onChange} />));
        expect(screen.getByText('Screenshot only · tap to edit')).toBeTruthy();
        await userEvent.click(screen.getByText('Screenshot only · tap to edit'));
        await userEvent.click(screen.getByRole('button', { name: 'Remove screenshot' }));
        await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
        expect(onChange).toHaveBeenLastCalledWith({ note: null });
    });

    test('an image pasted into the note is attached', async () => {
        const { value, send } = api();
        render(withImages(value, <ItemRow item={reviewed()} onChange={mock()} />));
        await userEvent.click(screen.getByText('+ Add note'));
        const file = new File(['p'], 'pasted.png', { type: 'image/png' });
        fireEvent.paste(screen.getByRole('textbox'), {
            clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] },
        });
        await waitFor(() => expect(send).toHaveBeenCalledWith(file));
    });

    test('a screenshot that fails is reported and the note can still be saved', async () => {
        const failing = api({ send: mock(async () => Promise.reject(new Error('Too much.'))) });
        const onChange = mock();
        render(withImages(failing.value, <ItemRow item={reviewed()} onChange={onChange} />));
        await userEvent.click(screen.getByText('+ Add note'));
        await userEvent.type(screen.getByRole('textbox'), 'Text only');
        await userEvent.upload(
            screen.getByLabelText('Choose a screenshot'),
            new File(['p'], 'a.png', { type: 'image/png' }),
        );
        expect((await screen.findByRole('alert')).textContent).toBe('Too much.');
        await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
        expect(onChange).toHaveBeenCalledWith({ note: 'Text only' });
    });

    test('with the computer away a screenshot is still taken, and says it is sent later', async () => {
        const away = api({ online: false });
        const onChange = mock();
        render(withImages(away.value, <ItemRow item={reviewed()} onChange={onChange} />));
        await userEvent.click(screen.getByText('+ Add note'));
        expect(
            screen.getByText('The computer is offline: the screenshot is sent when it is back.'),
        ).toBeTruthy();
        await userEvent.upload(
            screen.getByLabelText('Choose a screenshot'),
            new File(['p'], 'a.png', { type: 'image/png' }),
        );
        await screen.findByRole('button', { name: 'Replace screenshot' });
        await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
        expect(onChange).toHaveBeenCalledWith({ note: token });
    });

    test('a computer not known to take screenshots says why nothing can be added, and a picture never seen says so', async () => {
        const unknown = api({
            enabled: false,
            online: false,
            unavailable: 'Needs the computer to be online once, to know it takes screenshots.',
            load: mock(async () => null),
        });
        render(
            withImages(
                unknown.value,
                <ItemRow item={reviewed(`Broken\n${token}`)} onChange={mock()} />,
            ),
        );
        expect(
            await screen.findByText('Screenshot not available while the computer is offline.'),
        ).toBeTruthy();
        await userEvent.click(screen.getByText('Broken'));
        expect(
            (screen.getByRole('button', { name: 'Replace screenshot' }) as HTMLButtonElement)
                .disabled,
        ).toBe(true);
        expect(
            screen.getByText('Needs the computer to be online once, to know it takes screenshots.'),
        ).toBeTruthy();
    });

    test('a view without screenshots has no button for them, and hides the tokens it is given', async () => {
        render(withImages(null, <ItemRow item={reviewed(`Broken\n${token}`)} onChange={mock()} />));
        expect(screen.getByText('Broken')).toBeTruthy();
        expect(document.body.textContent).not.toContain('[screenshot');
        await userEvent.click(screen.getByText('Broken'));
        expect(screen.queryByLabelText('Choose a screenshot')).toBeNull();
    });

    test('a tap on the picture opens it full size, and Escape closes it', async () => {
        const { value } = api();
        render(
            withImages(value, <ItemRow item={reviewed(`Broken\n${token}`)} onChange={mock()} />),
        );
        await userEvent.click(await screen.findByRole('button', { name: 'Open screenshot' }));
        const dialog = screen.getByRole('dialog', { name: 'Screenshot' });
        expect(within(dialog).getByRole('img', { name: 'Screenshot, full size' })).toBeTruthy();
        await userEvent.keyboard('{Escape}');
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    test('an element of the note for the agent takes a screenshot too', async () => {
        const { value } = api();
        const onSave = mock();
        render(withImages(value, <NoteForAgent note="" delivered={false} onSave={onSave} />));
        await userEvent.click(screen.getByText('+ Write something for the agent'));
        await userEvent.type(screen.getByRole('textbox'), 'Header is wrong');
        await userEvent.upload(
            screen.getByLabelText('Choose a screenshot'),
            new File(['p'], 'a.png', { type: 'image/png' }),
        );
        await screen.findByRole('button', { name: 'Replace screenshot' });
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));
        const saved = onSave.mock.calls[0]?.[0] as string;
        expect(saved).toMatch(
            /^- Header is wrong \[#[a-z0-9]{4}\]\n {2}\[screenshot:[0-9A-Z]{26}\]$/,
        );
        expect(splitNote(saved)[0]?.text).toBe(`Header is wrong\n${token}`);
    });

    test('an element with a picture shows both, and the others are untouched when it is edited', async () => {
        const { value } = api();
        const onSave = mock();
        const note = joinNote([
            { id: 'aaaa', text: `Header\n${token}` },
            { id: 'bbbb', text: 'Footer' },
        ]);
        render(withImages(value, <NoteForAgent note={note} delivered={false} onSave={onSave} />));
        expect(await screen.findByRole('img', { name: 'Screenshot' })).toBeTruthy();
        expect(document.body.textContent).not.toContain('[screenshot');
        await userEvent.click(screen.getByText('Footer'));
        await userEvent.type(screen.getByRole('textbox'), ' too');
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(onSave).toHaveBeenCalledWith(
            joinNote([
                { id: 'aaaa', text: `Header\n${token}` },
                { id: 'bbbb', text: 'Footer too' },
            ]),
        );
    });

    test('the owner sees the pictures a person attached, under their answer and in their note', async () => {
        const { value, load } = api();
        const second = createId();
        render(
            withImages(
                value,
                <>
                    <ItemRow
                        item={baseItem}
                        onChange={mock()}
                        outcomes={[
                            {
                                person: 'Mario',
                                status: 'cancelled',
                                note: `Broken\n${token}`,
                                state: 'open',
                            },
                        ]}
                    />
                    <PeopleResults
                        now={1}
                        people={[
                            {
                                name: 'Mario',
                                state: 'open',
                                expiresAt: 10,
                                checklists: [],
                                items: {},
                                note: joinNote([
                                    { id: 'k3f9', text: `Slow\n${screenshotToken(second)}` },
                                ]),
                            },
                        ]}
                    />
                </>,
            ),
        );
        await waitFor(() =>
            expect(screen.getAllByRole('img', { name: 'Screenshot' })).toHaveLength(2),
        );
        expect(load.mock.calls.map((call) => call[0]).sort()).toEqual([shot, second].sort());
        expect(document.body.textContent).not.toContain('[screenshot');
    });

    test('the note of a person holds no token for the owner to read', () => {
        render(
            <PeopleResults
                now={1}
                people={[
                    {
                        name: 'Mario',
                        state: 'open',
                        expiresAt: 10,
                        checklists: [],
                        items: {},
                        note: joinNote([{ id: 'k3f9', text: `Slow\n${token}` }]),
                    },
                ]}
            />,
        );
        expect(
            screen.getByRole('region', { name: 'From the people you share with' }).textContent,
        ).not.toContain('[screenshot');
    });
});

describe('Markdown', () => {
    function clipboard(write: (text: string) => Promise<void>) {
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: write },
            configurable: true,
        });
    }

    test('the title is bold, the rest is normal text, and code is a box of its own', () => {
        const { container } = render(
            <Markdown
                title
                text={
                    'Sign in\n\nThen run:\n\n```\nbun run dev\n```\n\nWith `displayName` and **bold** and [notes](https://example.com/n).'
                }
            />,
        );
        expect(container.querySelector('p.font-semibold')?.textContent).toBe('Sign in');
        expect(container.querySelector('pre')?.textContent).toBe('bun run dev');
        expect(container.querySelector('p code')?.textContent).toBe('displayName');
        expect(container.querySelector('strong')?.textContent).toBe('bold');
        const link = container.querySelector('a');
        expect(link?.getAttribute('href')).toBe('https://example.com/n');
        expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
        // The label is not the address: the real host is shown next to it.
        expect(container.textContent).toContain('notes (example.com)');
    });

    test('HTML in the text is shown as characters and never becomes an element', () => {
        const { container } = render(
            <Markdown text={'<img src=x onerror=alert(1)> <b>x</b> [a](javascript:alert(1))'} />,
        );
        expect(container.querySelector('img')).toBeNull();
        expect(container.querySelector('b')).toBeNull();
        expect(container.querySelector('a[href^="javascript"]')).toBeNull();
        expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    });

    test('the copy button copies the block as written, shows a check, then the icon again', async () => {
        const written: string[] = [];
        clipboard(async (text) => {
            written.push(text);
        });
        render(<Markdown text={'```\nbun run dev --port 3000\n  second line\n```'} />);

        const button = screen.getByRole('button', { name: 'Copy' });
        await userEvent.click(button);

        expect(written).toEqual(['bun run dev --port 3000\n  second line']);
        await screen.findByRole('button', { name: 'Copied' });
        expect(screen.getByRole('status').textContent).toBe('Copied');
        // The check is back to the copy icon after a moment.
        await screen.findByRole('button', { name: 'Copy' }, { timeout: 3_000 });
    });

    test('without a clipboard the block is selected for a copy by hand', async () => {
        clipboard(async () => {
            throw new Error('denied');
        });
        const execCommand = document.execCommand;
        document.execCommand = () => false;
        try {
            const { container } = render(<Markdown text={'```\nls -la\n```'} />);
            await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
            await waitFor(() => expect(window.getSelection()?.toString()).toContain('ls -la'));
            expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
            expect(container.querySelector('pre')?.textContent).toBe('ls -la');
        } finally {
            document.execCommand = execCommand;
        }
    });
});

describe('markdown in what the agent writes', () => {
    const note = (text: string, extra: Partial<Item> = {}): Item => ({
        ...baseItem,
        text,
        ...extra,
    });

    test('an item: the title is bold next to the status buttons, the rest is under the row', () => {
        const { container } = render(
            <ItemRow
                item={note(
                    'Sign in\n\nRun:\n\n```\nbun run dev\n```\n- greeting uses `displayName`',
                )}
                onChange={mock()}
            />,
        );
        const title = container.querySelector('p.font-semibold');
        expect(title?.textContent).toBe('Sign in');
        // The title is in the row with the buttons; the code box is not.
        const row = title?.closest('div.flex');
        expect(row?.querySelector('pre')).toBeNull();
        expect(row?.querySelector('fieldset')).not.toBeNull();
        expect(container.querySelector('pre')?.textContent).toBe('bun run dev');
        expect(container.querySelector('ul li code')?.textContent).toBe('displayName');
        // The status group is named by the title only, not by the whole text.
        expect(screen.getByRole('group', { name: 'Status of Sign in' })).toBeTruthy();
    });

    test('a simple one-line item is the title, in bold', () => {
        const { container } = render(
            <ItemRow item={note('Wrong password shows an error')} onChange={mock()} />,
        );
        expect(container.querySelector('p.font-semibold')?.textContent).toBe(
            'Wrong password shows an error',
        );
        expect(container.querySelector('pre')).toBeNull();
    });

    test('the detail of an item shows under it as markdown', () => {
        const { container } = render(
            <ItemRow
                item={note('Open the page', { detail: 'Use `Cmd+R` twice' })}
                onChange={mock()}
            />,
        );
        expect(container.querySelector('li > div code')?.textContent).toBe('Cmd+R');
    });

    test('an item added by the user stays plain text: no markdown, no bold, links only', () => {
        const { container } = render(
            <ItemRow
                item={note('Check *this* and `that` at https://example.com/a', {
                    addedByUser: true,
                })}
                onChange={mock()}
                onRemove={mock()}
            />,
        );
        expect(container.querySelector('em, code, strong, p.font-semibold')).toBeNull();
        expect(container.textContent).toContain('Check *this* and `that` at');
        expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/a');
    });

    test('a note of the user stays plain text', () => {
        const { container } = render(
            <ItemRow
                item={note('Checked', { status: 'done', note: 'It says **no** and `x`' })}
                onChange={mock()}
            />,
        );
        expect(container.textContent).toContain('It says **no** and `x`');
    });

    test('the message of the agent is markdown, with numbered steps as a list', () => {
        const { container } = render(
            <AgentMessage
                at={1}
                text={
                    '5 checks ready\n1. Update the app\n2. Run `palmtop status`\n\n```\npalmtop status\n```'
                }
            />,
        );
        expect(container.querySelectorAll('ol li')).toHaveLength(2);
        expect(container.querySelector('ol li code')?.textContent).toBe('palmtop status');
        expect(container.querySelector('pre')?.textContent).toBe('palmtop status');
    });

    test('a choice: question and options are inline markdown, the detail has blocks', () => {
        const checklistId = createId();
        const option = (text: string, extra: Partial<Item> = {}): Item => ({
            ...baseItem,
            id: createId(),
            checklistId,
            text,
            ...extra,
        });
        const { container } = render(
            <ChoiceCarousel
                title="Which `cache`?"
                pick="one"
                options={[
                    option('**Redis**', { detail: 'Run it with:\n\n```\nredis-server\n```' }),
                    option('Own *answer*', { addedByUser: true }),
                ]}
                onChange={mock()}
                onAddOption={mock()}
                onRemoveOption={mock()}
                confirm={() => true}
            />,
        );
        expect(container.querySelector('h2 code')?.textContent).toBe('cache');
        expect(container.querySelector('article strong')?.textContent).toBe('Redis');
        expect(container.querySelector('article pre')?.textContent).toBe('redis-server');
        // An option added by the user is not markdown.
        const second = screen.getByRole('article', { name: 'Option 2 of 2' });
        expect(second.querySelector('em')).toBeNull();
        expect(second.textContent).toContain('Own *answer*');
        // Names for assistive technology and the closed row have no markers.
        expect(screen.getByRole('group', { name: 'Answer for Redis' })).toBeTruthy();
    });
});
