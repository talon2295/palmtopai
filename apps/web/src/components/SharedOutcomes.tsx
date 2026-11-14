import {
    type ItemStatus,
    renderNote,
    type SharedPerson,
    type SharedState,
    screenshotIds,
    stripScreenshots,
} from '@palmtopai/protocol';
import { cn } from '@/lib/utils';
import { LinkedText } from './LinkedText';
import { ScreenshotThumb } from './ScreenshotThumb';

/** What one person answered about one item, as the owner sees it under the item. */
export interface PersonOutcome {
    person: string;
    /** `undefined`: has not answered. */
    status?: ItemStatus | undefined;
    note?: string | undefined;
    state: SharedState;
}

const MARKS: Record<ItemStatus, { symbol: string; label: string; chip: string }> = {
    done: {
        symbol: '✓',
        label: 'works',
        chip: 'border-emerald-600/40 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
    },
    cancelled: {
        symbol: '✕',
        label: 'fails',
        chip: 'border-red-600/40 bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200',
    },
    question: {
        symbol: '?',
        label: 'question',
        chip: 'border-amber-500/50 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
    },
};

const WAITING =
    'border-dashed border-zinc-300 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400';

/**
 * Chips under an item of the owner's checklist: one for each person it is shared with, their
 * name and what they answered, or a dotted chip while they have not. A note a person wrote shows
 * under the chips, with their name.
 */
export function SharedOutcomes({ outcomes }: { outcomes: PersonOutcome[] }) {
    if (outcomes.length === 0) return null;
    const notes = outcomes.filter((outcome) => outcome.note);
    return (
        <div className="mt-2">
            <ul aria-label="Answers of the people" className="flex flex-wrap gap-1.5">
                {outcomes.map((outcome) => {
                    const mark = outcome.status ? MARKS[outcome.status] : null;
                    return (
                        <li
                            key={outcome.person}
                            className={cn(
                                'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
                                mark?.chip ?? WAITING,
                                outcome.state === 'closed' && 'opacity-60',
                            )}
                        >
                            <span className="truncate">{outcome.person}</span>
                            <span aria-hidden="true" className="font-semibold">
                                {mark?.symbol ?? '…'}
                            </span>
                            <span className="sr-only">{mark?.label ?? 'has not answered'}</span>
                        </li>
                    );
                })}
            </ul>
            {notes.map((outcome) => (
                <div key={outcome.person} className="mt-1">
                    <p className="text-xs break-words whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">
                        <span className="font-medium">{outcome.person}:</span>{' '}
                        <LinkedText text={stripScreenshots(outcome.note ?? '')} />
                    </p>
                    <Screenshots note={outcome.note ?? ''} />
                </div>
            ))}
        </div>
    );
}

/** The pictures a person attached to what they wrote, which the owner's device asks the computer for. */
function Screenshots({ note }: { note: string }) {
    const ids = screenshotIds(note);
    if (ids.length === 0) return null;
    return (
        <div className="flex flex-wrap gap-2">
            {ids.map((id) => (
                <ScreenshotThumb key={id} imageId={id} />
            ))}
        </div>
    );
}

const STATE_TEXT = (person: SharedPerson, now: number): string => {
    if (person.state === 'closed') return 'closed';
    if (person.state === 'expired' || now >= person.expiresAt) return 'read-only';
    return `open until ${new Date(person.expiresAt).toLocaleDateString()}`;
};

/**
 * Under the checklists of the owner: who each session is shared with and the notes they wrote
 * on the session.
 */
export function PeopleResults({ people, now }: { people: SharedPerson[]; now: number }) {
    if (people.length === 0) return null;
    const written = people.filter((person) => person.note);
    return (
        <section
            aria-label="From the people you share with"
            className="rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-violet-950 dark:border-violet-900 dark:bg-violet-950/50 dark:text-violet-100"
        >
            <p className="text-xs font-medium text-violet-700 dark:text-violet-300">
                Shared with{' '}
                {people
                    .map(
                        (person) =>
                            `${person.name} (${STATE_TEXT(person, now)}${person.done ? ', finished reviewing' : ''})`,
                    )
                    .join(', ')}
            </p>
            {written.map((person) => (
                <div key={person.name} className="mt-2 text-[15px] leading-snug">
                    {person.note && (
                        <>
                            <p className="break-words whitespace-pre-wrap">
                                <span className="font-medium">{person.name}:</span>{' '}
                                <LinkedText text={stripScreenshots(renderNote(person.note))} />
                            </p>
                            <Screenshots note={person.note} />
                        </>
                    )}
                </div>
            ))}
        </section>
    );
}
