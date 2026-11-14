import type { ChoicePick, Item, ItemStatus } from '@palmtopai/protocol';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { plainTitle } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import { AddItemForm } from './AddItemForm';
import type { ItemChange } from './ItemRow';
import { LinkedText } from './LinkedText';
import { Markdown, MarkdownInline } from './Markdown';
import { NoteEditor } from './NoteEditor';

/** The three review marks, as they read on the options of a question. */
/** An option as plain words, for labels and the closed row: markdown only in what the agent wrote. */
const optionLabel = (option: Item) => (option.addedByUser ? option.text : plainTitle(option.text));

const ANSWERS: Array<{ status: ItemStatus; symbol: string; label: string; active: string }> = [
    {
        status: 'done',
        symbol: '✓',
        label: 'Pick',
        active: 'border-emerald-600 bg-emerald-600 text-white',
    },
    {
        status: 'cancelled',
        symbol: '✕',
        label: 'No',
        active: 'border-red-600 bg-red-600 text-white',
    },
    {
        status: 'question',
        symbol: '?',
        label: 'Ask',
        active: 'border-amber-500 bg-amber-500 text-white',
    },
];

/** How long an answered question stays open, so a note can follow the answer. */
export const CLOSE_DELAY_MS = 5_000;

export interface ChoiceCarouselProps {
    /** The question the agent asked. */
    title: string;
    /** `one`: a single option can be chosen; `any`: as many as the user wants. */
    pick: ChoicePick;
    options: Item[];
    onChange: (item: Item, change: ItemChange) => void;
    onAddOption: (text: string) => void;
    onRemoveOption: (item: Item) => void;
    confirm?: (message: string) => boolean;
    closeDelayMs?: number;
}

/**
 * A question with its options, one card at a time. The user answers each option (choose, no, ask)
 * with an optional note, or writes an answer of their own on the last card. Once the question is
 * answered it closes into a row with the chosen option, which opens it again.
 */
export function ChoiceCarousel({
    title,
    pick,
    options,
    onChange,
    onAddOption,
    onRemoveOption,
    confirm = (message) => window.confirm(message),
    closeDelayMs = CLOSE_DELAY_MS,
}: ChoiceCarouselProps) {
    const titleId = useId();
    const track = useRef<HTMLDivElement>(null);
    const [index, setIndex] = useState(0);
    /** Card to scroll to once the deck is on screen again (it is unmounted while closed). */
    const pending = useRef<number | null>(null);
    /** An answer of their own was just written: the deck moves to it when it arrives. */
    const added = useRef(false);
    const optionCount = useRef(options.length);
    const [open, setOpen] = useState<{ run: number; timed: boolean } | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const [writing, setWriting] = useState<string | null>(null);

    useEffect(() => () => clearTimeout(timer.current), []);

    /** Keeps the deck open for a moment, with the bar running: an answer can be followed by a note. */
    const keepOpen = () => {
        clearTimeout(timer.current);
        setOpen((current) => ({ run: (current?.run ?? 0) + 1, timed: true }));
        timer.current = setTimeout(() => setOpen(null), closeDelayMs);
    };
    /** Keeps the deck open with no countdown: the user is working on it. */
    const holdOpen = () => {
        clearTimeout(timer.current);
        setOpen((current) => ({ run: current?.run ?? 0, timed: false }));
    };

    const chosen = options.filter((option) => option.status === 'done');
    const answered =
        options.length > 0 &&
        (pick === 'one'
            ? chosen.length > 0
            : options.every((option) => option.status !== undefined));
    const closed = answered && open === null && writing === null;

    const cards = options.length + 1;
    const goTo = (next: number) => {
        const clamped = Math.max(0, Math.min(cards - 1, next));
        setIndex(clamped);
        const element = track.current;
        element?.scrollTo?.({ left: clamped * element.clientWidth, behavior: 'smooth' });
    };

    // A swipe moves the card: the dots and the arrows follow the scroll position.
    const onScroll = () => {
        const element = track.current;
        if (!element || element.clientWidth === 0) return;
        const next = Math.round(element.scrollLeft / element.clientWidth);
        if (next !== index) setIndex(next);
    };

    useEffect(() => {
        if (closed) return;
        if (pending.current !== null) {
            const element = track.current;
            element?.scrollTo?.({ left: pending.current * element.clientWidth });
            pending.current = null;
        }
        if (added.current && options.length > optionCount.current) {
            added.current = false;
            goTo(options.length - 1);
        }
        optionCount.current = options.length;
    });

    const answer = (option: Item, status: ItemStatus) => {
        if (option.status === status) {
            if (option.note && !confirm('Clear this answer? The note will be deleted too.')) return;
            onChange(option, { status: null });
            holdOpen();
            return;
        }
        // Only one option can be chosen: the one chosen before becomes an option refused.
        if (pick === 'one' && status === 'done') {
            for (const other of chosen) {
                if (other.id !== option.id) onChange(other, { status: 'cancelled' });
            }
        }
        onChange(option, { status });
        keepOpen();
    };

    const removeOption = (option: Item) => {
        if (confirm('Delete this answer of yours?')) onRemoveOption(option);
    };

    if (closed) {
        return (
            <section
                aria-labelledby={titleId}
                className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
            >
                <button
                    type="button"
                    aria-expanded="false"
                    onClick={() => {
                        const first = options.findIndex((option) => option.status === 'done');
                        pending.current = Math.max(0, first);
                        setIndex(Math.max(0, first));
                        holdOpen();
                    }}
                    className="flex w-full items-start gap-2 px-4 py-3 text-left"
                >
                    <span className="min-w-0 flex-1">
                        <span
                            id={titleId}
                            className="block text-xs text-zinc-500 dark:text-zinc-400"
                        >
                            {plainTitle(title)}
                        </span>
                        <span className="mt-0.5 block font-medium break-words">
                            {chosen.length > 0
                                ? chosen.map(optionLabel).join(', ')
                                : 'No option chosen'}
                        </span>
                    </span>
                    <ChevronDown className="mt-0.5 size-4 shrink-0 text-zinc-500" />
                </button>
            </section>
        );
    }

    return (
        <section
            aria-labelledby={titleId}
            className="relative overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
        >
            <div className="flex items-baseline justify-between gap-3 border-b border-zinc-200 bg-zinc-50 px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-800/40">
                <h2 id={titleId} className="font-semibold">
                    <MarkdownInline text={title} />
                </h2>
                <span className="shrink-0 text-xs text-zinc-500">
                    {pick === 'one' ? 'Pick one' : 'Pick any'}
                </span>
            </div>

            <div
                ref={track}
                onScroll={onScroll}
                // A plain scroller: the cards are articles and the arrows below are the buttons.
                className="flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] motion-safe:scroll-smooth [&::-webkit-scrollbar]:hidden"
            >
                {options.map((option, position) => (
                    <article
                        key={option.id}
                        aria-label={`Option ${position + 1} of ${options.length}`}
                        className="flex w-full shrink-0 snap-center flex-col px-4 pt-4 pb-3"
                    >
                        <p className="text-[15px] leading-snug font-medium break-words">
                            {option.addedByUser ? (
                                <LinkedText text={option.text} />
                            ) : (
                                <MarkdownInline text={option.text} />
                            )}
                        </p>
                        {option.detail && (
                            <Markdown
                                text={option.detail}
                                className="mt-1 text-sm leading-snug text-zinc-600 dark:text-zinc-400"
                            />
                        )}
                        {option.addedByUser && (
                            <p className="mt-1 text-xs text-zinc-500">Added by you</p>
                        )}
                        <fieldset
                            className="mt-3 flex gap-2"
                            aria-label={`Answer for ${optionLabel(option)}`}
                        >
                            {ANSWERS.map((choice) => {
                                const active = option.status === choice.status;
                                return (
                                    <button
                                        key={choice.status}
                                        type="button"
                                        aria-pressed={active}
                                        aria-label={choice.label}
                                        onClick={() => answer(option, choice.status)}
                                        className={cn(
                                            'h-10 flex-1 rounded-lg border text-sm font-semibold transition-colors',
                                            active
                                                ? choice.active
                                                : 'border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800',
                                        )}
                                    >
                                        <span aria-hidden="true">{choice.symbol}</span>{' '}
                                        {choice.label}
                                    </button>
                                );
                            })}
                        </fieldset>
                        {option.status && (
                            <NoteEditor
                                {...(option.note !== undefined && { note: option.note })}
                                label={optionLabel(option)}
                                editing={writing === option.id}
                                onEditing={(editing) => {
                                    setWriting(editing ? option.id : null);
                                    if (editing) holdOpen();
                                    else keepOpen();
                                }}
                                onSave={(note) => onChange(option, { note })}
                            />
                        )}
                        {option.addedByUser && (
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => removeOption(option)}
                                className="mt-2 self-start px-2 font-normal text-red-600 hover:text-red-700 dark:text-red-400"
                            >
                                Delete
                            </Button>
                        )}
                    </article>
                ))}
                <article
                    aria-label="Your own answer"
                    className="flex w-full shrink-0 snap-center flex-col px-4 pt-4 pb-3"
                >
                    <p className="text-[15px] leading-snug font-medium">None of these?</p>
                    <p className="mt-1 text-sm leading-snug text-zinc-600 dark:text-zinc-400">
                        Write your own answer and the agent will take it as the decision.
                    </p>
                    <AddItemForm
                        checklistTitle={title}
                        cta="+ Add your own answer"
                        placeholder="What you would do instead"
                        fieldLabel={`Your own answer to ${title}`}
                        onOpenChange={(formOpen) => (formOpen ? holdOpen() : keepOpen())}
                        onAdd={(text) => {
                            added.current = true;
                            onAddOption(text);
                            holdOpen();
                        }}
                    />
                </article>
            </div>

            <div className="flex items-center justify-between gap-2 px-4 pb-3">
                <Button
                    variant="outline"
                    size="icon"
                    aria-label="Previous option"
                    disabled={index === 0}
                    onClick={() => goTo(index - 1)}
                    className="size-9 rounded-lg"
                >
                    <ChevronLeft />
                </Button>
                <div className="flex items-center gap-1.5">
                    {[...options.map((option) => option.id), 'own-answer'].map((id, position) => (
                        <button
                            key={id}
                            type="button"
                            aria-label={
                                position === options.length
                                    ? 'Your own answer'
                                    : `Option ${position + 1}`
                            }
                            aria-current={position === index}
                            onClick={() => goTo(position)}
                            className={cn(
                                'size-2.5 rounded-full transition-colors',
                                position === index
                                    ? 'bg-zinc-800 dark:bg-zinc-100'
                                    : 'bg-zinc-300 dark:bg-zinc-700',
                            )}
                        />
                    ))}
                </div>
                <Button
                    variant="outline"
                    size="icon"
                    aria-label="Next option"
                    disabled={index === cards - 1}
                    onClick={() => goTo(index + 1)}
                    className="size-9 rounded-lg"
                >
                    <ChevronRight />
                </Button>
            </div>

            {open?.timed && (
                // Absolute: the bar does not change the height of the card.
                <span
                    key={open.run}
                    aria-hidden="true"
                    data-testid="close-countdown"
                    style={{ animationDuration: `${closeDelayMs}ms` }}
                    className="absolute inset-x-0 bottom-0 h-0.5 origin-left animate-countdown rounded-full bg-zinc-400 dark:bg-zinc-500"
                />
            )}
        </section>
    );
}
