import type { Pairing } from '@palmtopai/client';
import { type ReactNode, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { UnsupportedReason } from '@/lib/identity';
import { FeedbackSheet } from './FeedbackSheet';
import { PairCode } from './PairCode';

export function EmptyState({
    invalidLink = false,
    invitation = false,
    pairing = false,
    unsupported,
    notice,
    onPairedByCode,
}: {
    invalidLink?: boolean;
    /** The link was an invitation to look at what somebody shares, not a pairing. */
    invitation?: boolean;
    /** Shown above the rest (a computer that may still accept this device). */
    notice?: ReactNode;
    pairing?: boolean;
    /** palmtop can't encrypt here: not on HTTPS, a browser too old, or its storage failing. */
    unsupported?: UnsupportedReason | undefined;
    /** In the app on the Home Screen: pairing goes through a code instead of the QR. */
    onPairedByCode?: ((roomId: string, pairing: Pairing) => void) | undefined;
}) {
    const [feedbackOpen, setFeedbackOpen] = useState(false);
    return (
        <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-6 text-center">
            <h1 className="text-2xl font-semibold">PalmtopAI</h1>
            {notice}
            {invalidLink && (
                <Alert role="alert" variant="destructive">
                    {invitation
                        ? 'That invitation is not valid any more: it opens once, within a day. Ask the person who sent it for a new one.'
                        : 'That pairing link is not valid any more. Generate a new one on your computer.'}
                </Alert>
            )}
            {unsupported === 'insecure' ? (
                <Alert role="alert" variant="destructive">
                    palmtop encrypts everything end to end, and browsers allow that only on a secure
                    page. Open palmtop with its https:// address.
                </Alert>
            ) : unsupported === 'storage' ? (
                <>
                    <Alert role="alert" variant="destructive">
                        palmtop can&apos;t read the keys of this device from the browser&apos;s
                        storage right now. Close the app completely and open it again. In a private
                        window, or with site data blocked, use a normal window instead.
                    </Alert>
                    <Button onClick={() => window.location.reload()} className="self-center px-3">
                        Try again
                    </Button>
                </>
            ) : unsupported ? (
                <Alert role="alert" variant="destructive">
                    This browser is too old for palmtop&apos;s end-to-end encryption. Update it
                    (Safari 17, Chrome 137, Firefox 130 or newer) and open palmtop again.
                </Alert>
            ) : pairing ? (
                <p className="text-zinc-600 dark:text-zinc-400">
                    {invitation ? 'Opening what was shared with you…' : 'Pairing this device…'}
                </p>
            ) : onPairedByCode ? (
                <>
                    <p className="text-zinc-600 dark:text-zinc-400">
                        Check your coding agent&apos;s work from here. Pair this device with your
                        computer:
                    </p>
                    <PairCode onPaired={onPairedByCode} />
                    <Encrypted />
                </>
            ) : (
                <>
                    <p className="text-zinc-600 dark:text-zinc-400">
                        Check your coding agent&apos;s work from here.
                    </p>
                    <p className="text-sm text-zinc-500">
                        On your computer run{' '}
                        <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
                            palmtop pair
                        </code>{' '}
                        and scan the QR code with this device.
                    </p>
                    <Encrypted />
                </>
            )}
            <Button
                variant="link"
                onClick={() => setFeedbackOpen(true)}
                className="self-center text-zinc-500"
            >
                Send feedback
            </Button>
            <FeedbackSheet open={feedbackOpen} onOpenChange={setFeedbackOpen} />
        </div>
    );
}

/** Shown while pairing: the moment to know the relay can't read what this device will get. */
function Encrypted() {
    return (
        <p className="text-sm text-emerald-700 dark:text-emerald-400">
            End-to-end encrypted: the relay can&apos;t read your checklists.
        </p>
    );
}
