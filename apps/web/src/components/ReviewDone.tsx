import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface ReviewDoneProps {
    /** The session is marked done: nothing new from the agent since. */
    done: boolean;
    /** The computer is connected: a done is only sent live, never queued for later. */
    online: boolean;
    /** Items of the session still waiting for a review. */
    toReview: number;
    /**
     * An agent is waiting for the tap (`false`: none is, and a tap would go nowhere); `undefined`
     * when the computer does not say.
     */
    waiting?: boolean | undefined;
    onMark: () => void;
    /** On a copy shared with the user: the name of who shared it, who is the one told. */
    owner?: string;
    confirm?: (message: string) => boolean;
}

/** What the user is asked before telling the agent they are done. */
export function doneQuestion(toReview: number, owner?: string): string {
    const left =
        toReview === 0
            ? ''
            : ` ${toReview === 1 ? '1 item is' : `${toReview} items are`} not reviewed yet.`;
    return owner
        ? `Tell ${owner} you finished reviewing?${left}`
        : `Tell the agent you finished reviewing this session?${left}`;
}

/**
 * The end of a review: tells the agent, which may be waiting for it, that the user finished. It
 * turns off once pressed and comes back when the agent writes something new in the session.
 */
export function ReviewDone({
    done,
    online,
    toReview,
    waiting,
    onMark,
    owner,
    confirm = (message) => window.confirm(message),
}: ReviewDoneProps) {
    if (done) {
        return (
            <section
                aria-label="Review done"
                className="flex flex-col items-center gap-1 rounded-xl border border-emerald-600/30 bg-emerald-50 px-4 py-3 text-center text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200"
            >
                <p className="flex items-center gap-1.5 text-sm font-medium">
                    <Check className="size-4" aria-hidden="true" />
                    Marked as done
                </p>
                <p className="text-xs opacity-80">
                    {owner
                        ? `${owner} sees it on their devices.`
                        : 'If the agent is waiting, it reads your review now. Otherwise tell it in the chat.'}
                </p>
            </section>
        );
    }
    const nobody = online && waiting === false;
    return (
        <section aria-label="Review done" className="flex flex-col items-center gap-1">
            <Button
                variant="outline"
                disabled={!online || nobody}
                onClick={() => {
                    if (confirm(doneQuestion(toReview, owner))) onMark();
                }}
                className="w-full rounded-lg border-zinc-300 dark:border-zinc-700"
            >
                Review done
            </Button>
            {nobody && (
                <p className="text-xs text-zinc-500">
                    The agent is not waiting for it: tell it in the chat when you are done.
                </p>
            )}
            {!online && (
                <p className="text-xs text-zinc-500">
                    Needs {owner ? `${owner}'s computer` : 'your computer'} online:{' '}
                    {owner ?? 'the agent'} is told right away.
                </p>
            )}
        </section>
    );
}
