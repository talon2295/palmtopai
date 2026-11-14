import type { Checklist, Item } from '@palmtopai/protocol';
import { AddItemForm } from './AddItemForm';
import { type ItemChange, ItemRow } from './ItemRow';
import { LinkedText } from './LinkedText';
import type { PersonOutcome } from './SharedOutcomes';

export interface ChecklistCardProps {
    checklist: Checklist;
    /** Every item of the checklist: the count in the header and the order of a new one. */
    items: Item[];
    /** The items to show: with "Hide reviewed" on, the ones still to review. */
    visible: Item[];
    /** Items counting down before they are hidden, with the run number of each. */
    countdowns: ReadonlyMap<string, number>;
    hideDelayMs: number;
    onChange: (item: Item, change: ItemChange) => void;
    onEditingChange: (item: Item, editing: boolean) => void;
    /** Only items added on a device can be removed. */
    onRemove: (item: Item) => void;
    onAdd: (text: string) => void;
    /** False for a guest: they review and write notes, they do not add items. */
    canAdd?: boolean;
    /** The answers of the people the session is shared with, by item. */
    outcomes?: ReadonlyMap<string, PersonOutcome[]> | undefined;
    /** The list can be read, not answered (a copy that stopped taking answers). */
    readOnly?: boolean;
    confirm?: (message: string) => boolean;
}

/** A checklist of the session: its title, the items to review and the form to add one. */
export function ChecklistCard({
    checklist,
    items,
    visible,
    countdowns,
    hideDelayMs,
    onChange,
    onEditingChange,
    onRemove,
    onAdd,
    canAdd = true,
    outcomes,
    readOnly = false,
    confirm,
}: ChecklistCardProps) {
    const reviewed = items.filter((item) => item.status).length;
    return (
        <section
            aria-labelledby={`checklist-${checklist.id}`}
            className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
        >
            {/* Tinted strip: the title of a checklist never reads as one of its items. */}
            <div className="flex items-baseline justify-between gap-3 border-b border-zinc-200 bg-zinc-50 px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-800/40">
                <h2 id={`checklist-${checklist.id}`} className="font-semibold">
                    <LinkedText text={checklist.title} />
                </h2>
                <span className="shrink-0 text-xs text-zinc-500">
                    {reviewed}/{items.length} reviewed
                </span>
            </div>
            <div className="px-4 pt-1">
                {visible.length > 0 && (
                    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                        {visible.map((item) => {
                            const run = countdowns.get(item.id);
                            return (
                                <ItemRow
                                    key={item.id}
                                    item={item}
                                    onChange={(change) => onChange(item, change)}
                                    onEditingChange={(editing) => onEditingChange(item, editing)}
                                    {...(run !== undefined && {
                                        countdown: { run, durationMs: hideDelayMs },
                                    })}
                                    {...(item.addedByUser && { onRemove: () => onRemove(item) })}
                                    readOnly={readOnly}
                                    outcomes={outcomes?.get(item.id)}
                                    {...(confirm && { confirm })}
                                />
                            );
                        })}
                    </ul>
                )}
                {!readOnly && canAdd && (
                    <AddItemForm checklistTitle={checklist.title} onAdd={onAdd} />
                )}
            </div>
        </section>
    );
}
