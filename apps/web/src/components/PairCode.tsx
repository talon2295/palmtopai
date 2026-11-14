import {
    type Pairing,
    type PairOffer,
    type PairWaitState,
    pairDevice,
    waitForPairing,
} from '@palmtopai/client';
import { formatPairingNumber } from '@palmtopai/protocol';
import { useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { deviceName } from '@/lib/device';
import { useIdentity } from '@/lib/identity';
import { waitSocketUrl } from '@/lib/install';
import { deviceSocketUrl } from '@/sync/use-project-sync';

/** `ABC123` → `ABC 123`, easier to read and type. */
export const spacedCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

/** A pairing by code waits for a person at the computer: as long as its key is valid. */
const PAIRING_TIMEOUT_MS = 5 * 60_000;

/**
 * Pairing in the app on the Home Screen: it shows a code, the user runs `palmtop pair CODE` on
 * the computer, and the computer's single-use key arrives here. The key went through the relay,
 * so both screens then show a 6-digit number: the pairing is kept only if the user says it is
 * the same here and on the computer (end-to-end encryption, `e2e.ts`).
 */
export function PairCode({
    onPaired,
    wait = waitForPairing,
    pair = pairDevice,
}: {
    onPaired: (roomId: string, pairing: Pairing) => void;
    wait?: typeof waitForPairing;
    pair?: typeof pairDevice;
}) {
    const identity = useIdentity();
    const [state, setState] = useState<PairWaitState>({ status: 'connecting' });
    const [offer, setOffer] = useState<PairOffer | null>(null);
    const [pairing, setPairing] = useState(false);
    /** The number to compare, and how to answer. */
    const [number, setNumber] = useState<string | null>(null);
    const answer = useRef<((same: boolean) => void) | null>(null);
    const [answered, setAnswered] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);

    useEffect(() => {
        const waiting = wait({
            url: waitSocketUrl(window.location),
            onState: setState,
            onOffer: (next) => {
                setFailure(null);
                setOffer(next);
            },
        });
        return () => waiting.stop();
    }, [wait]);

    // An unanswered number ends with the component: nothing is kept.
    useEffect(() => () => answer.current?.(false), []);

    const accept = async (accepted: PairOffer) => {
        setPairing(true);
        try {
            const result = await pair({
                url: deviceSocketUrl(window.location, accepted.room),
                roomId: accepted.room,
                pairKey: accepted.key,
                deviceId: identity.deviceId,
                name: deviceName(),
                deviceKeys: identity.keys,
                timeoutMs: PAIRING_TIMEOUT_MS,
                confirmNumber: (shown) =>
                    new Promise<boolean>((resolve) => {
                        answer.current = resolve;
                        setNumber(shown);
                    }),
            });
            onPaired(accepted.room, result);
        } catch (error) {
            setFailure(
                (error as Error).message === 'the numbers did not match'
                    ? 'The numbers did not match, so nothing was paired. If you saw a different number on the computer, someone may be in the middle: pair with the QR code of palmtop pair instead.'
                    : 'Pairing did not work. Run palmtop pair with the new code below.',
            );
        } finally {
            answer.current = null;
            setOffer(null);
            setNumber(null);
            setAnswered(false);
            setPairing(false);
        }
    };

    const reply = (same: boolean) => {
        setAnswered(true);
        answer.current?.(same);
        answer.current = null;
    };

    if (offer && number) {
        return (
            <div className="flex flex-col gap-4 rounded-xl border border-zinc-200 p-4 text-left dark:border-zinc-800">
                <p className="font-semibold">Check the number</p>
                <p
                    data-testid="pair-number"
                    className="text-center font-mono text-4xl font-semibold tracking-widest"
                >
                    {formatPairingNumber(number)}
                </p>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    Your computer shows a number too. Is it the same? Answer on the computer as
                    well.
                </p>
                {answered ? (
                    <p role="status" className="text-sm text-zinc-500">
                        Waiting for the computer…
                    </p>
                ) : (
                    <div className="flex gap-2">
                        <Button onClick={() => reply(true)}>Same number</Button>
                        <Button variant="outline" onClick={() => reply(false)}>
                            Different
                        </Button>
                    </div>
                )}
            </div>
        );
    }

    if (offer) {
        return (
            <div className="flex flex-col gap-4 rounded-xl border border-zinc-200 p-4 text-left dark:border-zinc-800">
                <p className="font-semibold">Pair with “{offer.computer}”?</p>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    This device will see every project of that computer. Pair only if you just ran
                    palmtop pair there.
                </p>
                <div className="flex gap-2">
                    <Button disabled={pairing} onClick={() => accept(offer)}>
                        {pairing ? 'Pairing…' : 'Pair'}
                    </Button>
                    <Button variant="outline" disabled={pairing} onClick={() => setOffer(null)}>
                        Not now
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col items-center gap-3">
            {failure && (
                <Alert role="alert" variant="destructive">
                    {failure}
                </Alert>
            )}
            {state.status === 'waiting' ? (
                <>
                    <p
                        data-testid="pair-code"
                        className="font-mono text-4xl font-semibold tracking-widest"
                    >
                        {spacedCode(state.code)}
                    </p>
                    <p className="text-sm text-zinc-600 dark:text-zinc-400">
                        In a terminal on your computer run
                    </p>
                    <code className="rounded bg-zinc-100 px-2 py-1 text-sm dark:bg-zinc-800">
                        palmtop pair {state.code}
                    </code>
                    <p className="text-xs text-zinc-500">
                        The code changes every 5 minutes and after each use.
                    </p>
                </>
            ) : (
                <p role="status" className="text-sm text-zinc-500">
                    {state.status === 'connecting'
                        ? 'Getting a pairing code…'
                        : 'No connection to palmtop: retrying…'}
                </p>
            )}
        </div>
    );
}
