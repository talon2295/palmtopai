import {
    CloseCode,
    generateDeviceKeys,
    parseE2EComputerMessage,
    type SecureChannel,
    startDevicePairing,
} from '@palmtopai/protocol';

/** A message the daemon sent to the device, opened. */
export interface DeviceMessage {
    type: string;
    code?: string;
    message?: string;
    projects?: Array<{ id: string }>;
    state?: { lamport: number };
    op?: { opId: string; clock: { lamport: number } };
    opId?: string;
}

export interface E2EDevice {
    /** Opened messages from the daemon, in order (`paired` first). */
    messages: DeviceMessage[];
    /** The number the device shows (what pairing by code compares). */
    number: string;
    /** Sealed, like the app. */
    send(message: object): void;
    close(): void;
    closed: Promise<number>;
}

export type PairAttempt =
    | { kind: 'paired'; device: E2EDevice }
    /** The daemon refused: its plain error, then the close. */
    | { kind: 'refused'; error: DeviceMessage; code: number }
    /** The relay closed before the daemon answered (e.g. the daemon is not connected yet). */
    | { kind: 'closed'; code: number };

/**
 * A device pairing through the relay as the app does (`e2e.ts`): it proves the single-use key
 * without sending it and opens the sealed channel. `onNumber` sees the 6-digit number as soon as
 * it is known; with a pairing code the daemon's `paired` comes once the terminal said yes.
 */
export async function pairOverRelay(options: {
    url: string;
    roomId: string;
    pairKey: string;
    deviceId: string;
    name?: string;
    onNumber?: (number: string) => void;
}): Promise<PairAttempt> {
    const ws = new WebSocket(options.url);
    const plain: string[] = [];
    const messages: DeviceMessage[] = [];
    let channel: SecureChannel | null = null;
    let opening: Promise<void> = Promise.resolve();
    let closedWith: number | null = null;
    const closed = new Promise<number>((resolve) => {
        ws.addEventListener('close', (event) => {
            closedWith = event.code;
            resolve(event.code);
        });
    });
    ws.addEventListener('message', (event) => {
        const data = String(event.data);
        const frame = parseE2EComputerMessage(data);
        const ready = channel;
        if (ready && frame?.type === 'sealed') {
            opening = opening.then(async () => {
                messages.push(JSON.parse(await ready.open(frame)) as DeviceMessage);
            });
        } else {
            plain.push(data);
        }
    });
    await new Promise((resolve) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('close', resolve, { once: true });
    });
    const next = async (): Promise<string | null> => {
        for (let i = 0; i < 300 && plain.length === 0 && closedWith === null; i++) {
            await Bun.sleep(10);
        }
        return plain.shift() ?? null;
    };
    const ended = async (raw: string | null): Promise<PairAttempt> => {
        const code = await closed;
        return raw && !parseE2EComputerMessage(raw)
            ? { kind: 'refused', error: JSON.parse(raw) as DeviceMessage, code }
            : { kind: 'closed', code };
    };
    if (closedWith !== null) return { kind: 'closed', code: closedWith };

    const side = await startDevicePairing({
        roomId: options.roomId,
        pairKey: options.pairKey,
        deviceId: options.deviceId,
        name: options.name ?? `Test ${options.deviceId}`,
        deviceKeys: await generateDeviceKeys(),
    });
    ws.send(JSON.stringify(side.start));
    const welcomeRaw = await next();
    const welcome = welcomeRaw ? parseE2EComputerMessage(welcomeRaw) : null;
    if (welcome?.type !== 'pair.welcome') return ended(welcomeRaw);
    const revealed = await side.reveal(welcome);
    ws.send(JSON.stringify(revealed.reveal));
    options.onNumber?.(revealed.number);
    const acceptRaw = await next();
    const accept = acceptRaw ? parseE2EComputerMessage(acceptRaw) : null;
    if (accept?.type !== 'pair.accept') return ended(acceptRaw);
    const finished = await revealed.finish(accept);
    channel = finished.channel;
    // Sealed frames that arrived while the channel was being derived.
    for (const raw of plain.splice(0)) {
        const frame = parseE2EComputerMessage(raw);
        if (frame?.type !== 'sealed') continue;
        opening = opening.then(async () => {
            messages.push(JSON.parse(await finished.channel.open(frame)) as DeviceMessage);
        });
    }
    return {
        kind: 'paired',
        device: {
            messages,
            number: revealed.number,
            send(message) {
                void finished.channel.seal(JSON.stringify(message)).then((frame) => {
                    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
                });
            },
            close: () => ws.close(),
            closed,
        },
    };
}

/** Waits for a message of the daemon matching `found`. */
export async function waitForMessage(
    device: E2EDevice,
    found: (message: DeviceMessage) => boolean,
    timeoutMs = 5_000,
): Promise<DeviceMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const message = device.messages.find(found);
        if (message) return message;
        if (Date.now() > deadline) throw new Error('the daemon never sent the expected message');
        await Bun.sleep(10);
    }
}

export { CloseCode };
