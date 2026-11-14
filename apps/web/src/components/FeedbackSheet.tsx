import { FEEDBACK_MESSAGE_MAX, FEEDBACK_TYPES, type FeedbackType } from '@palmtopai/protocol';
import { type FormEvent, useId, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
    Drawer,
    DrawerContent,
    DrawerDescription,
    DrawerHeader,
    DrawerTitle,
} from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
    FEEDBACK_RESULT_TEXT,
    type FeedbackResult,
    loadFeedbackEmail,
    saveFeedbackEmail,
    sendFeedback,
} from '@/lib/feedback';
import { cn } from '@/lib/utils';

const TYPE_LABEL: Record<FeedbackType, string> = {
    bug: 'Bug',
    feature: 'Feature request',
    other: 'Other',
};

/** Bottom sheet with the feedback form: type, message and the email to answer to. */
export function FeedbackSheet({
    open,
    onOpenChange,
    send = sendFeedback,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    send?: typeof sendFeedback;
}) {
    const [type, setType] = useState<FeedbackType>('bug');
    const [message, setMessage] = useState('');
    const [email, setEmail] = useState(loadFeedbackEmail);
    const [sending, setSending] = useState(false);
    const [result, setResult] = useState<FeedbackResult | null>(null);
    const messageId = useId();
    const emailId = useId();

    const changeOpen = (next: boolean) => {
        // A sent message is not shown again; a draft stays for the next time.
        if (!next && result === 'sent') {
            setMessage('');
            setResult(null);
        }
        onOpenChange(next);
    };

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setSending(true);
        const outcome = await send({
            type,
            message,
            email: email.trim(),
            // The app sits at the root of its own origin: `/app/` keeps it apart from the site's `/`.
            page: '/app/',
        });
        setSending(false);
        setResult(outcome);
        if (outcome === 'sent') saveFeedbackEmail(email.trim());
    };

    return (
        <Drawer open={open} onOpenChange={changeOpen}>
            <DrawerContent>
                <div className="mx-auto w-full max-w-lg">
                    <DrawerHeader>
                        <DrawerTitle>Send feedback</DrawerTitle>
                        <DrawerDescription>
                            Something broken, missing or confusing? We read every message and reply
                            by email.
                        </DrawerDescription>
                    </DrawerHeader>
                    {result === 'sent' ? (
                        <div className="flex flex-col gap-4 px-4 pb-8">
                            <p role="status" className="text-emerald-700 dark:text-emerald-300">
                                Thanks! Your feedback is on its way.
                            </p>
                            <Button variant="outline" onClick={() => changeOpen(false)}>
                                Close
                            </Button>
                        </div>
                    ) : (
                        <form onSubmit={submit} className="flex flex-col gap-4 px-4 pb-8">
                            <fieldset>
                                <legend className="sr-only">What is it about?</legend>
                                <div className="inline-flex flex-wrap gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800">
                                    {FEEDBACK_TYPES.map((value) => (
                                        <button
                                            key={value}
                                            type="button"
                                            aria-pressed={type === value}
                                            onClick={() => setType(value)}
                                            className={cn(
                                                'rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 dark:text-zinc-400',
                                                type === value &&
                                                    'bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100',
                                            )}
                                        >
                                            {TYPE_LABEL[value]}
                                        </button>
                                    ))}
                                </div>
                            </fieldset>
                            <div className="flex flex-col gap-1.5">
                                <label htmlFor={messageId} className="text-sm font-medium">
                                    Message
                                </label>
                                <Textarea
                                    id={messageId}
                                    required
                                    rows={5}
                                    maxLength={FEEDBACK_MESSAGE_MAX}
                                    value={message}
                                    onChange={(event) => setMessage(event.target.value)}
                                    placeholder="What happened, or what would you like palmtop to do?"
                                    className="text-base md:text-sm"
                                />
                            </div>
                            <div className="flex flex-col gap-1.5">
                                <label htmlFor={emailId} className="text-sm font-medium">
                                    Email
                                </label>
                                <Input
                                    id={emailId}
                                    type="email"
                                    required
                                    maxLength={254}
                                    autoComplete="email"
                                    value={email}
                                    onChange={(event) => setEmail(event.target.value)}
                                    placeholder="you@example.com"
                                />
                                <span className="text-xs text-zinc-500">Only to reply to you.</span>
                            </div>
                            {result && (
                                <Alert role="alert" variant="destructive">
                                    {FEEDBACK_RESULT_TEXT[result]}
                                </Alert>
                            )}
                            <Button type="submit" disabled={sending}>
                                {sending ? 'Sending…' : 'Send feedback'}
                            </Button>
                        </form>
                    )}
                </div>
            </DrawerContent>
        </Drawer>
    );
}
