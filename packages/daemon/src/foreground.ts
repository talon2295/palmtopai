import { rm } from 'node:fs/promises';
import { pathsFor } from './config';
import { startDaemon } from './daemon';
import { writeFileAtomic } from './fs-utils';

/**
 * Runs the daemon until SIGINT/SIGTERM (`palmtop serve`, and the detached process started by
 * the CLI autostart). Logs ports only: never tokens or the local key.
 */
export async function runForeground(): Promise<void> {
    let shutdown: (reason: string) => Promise<void> = async () => {};
    const daemon = await startDaemon({ onShutdown: () => void shutdown('stop request') });
    const { pid } = pathsFor(daemon.home);
    await writeFileAtomic(pid, `${process.pid}\n`);

    console.error(`[palmtop] local API on 127.0.0.1:${daemon.localPort}, relay ${daemon.relayUrl}`);

    let shuttingDown = false;
    shutdown = async (reason: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.error(`[palmtop] ${reason} received, saving state`);
        await daemon.stop();
        await rm(pid, { force: true });
        process.exit(0);
    };
    // SIGBREAK is Ctrl+Break and the closing of the console window on Windows; SIGHUP the closing
    // of the terminal elsewhere. Only SIGINT and SIGTERM are the same everywhere.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
        process.on(signal, () => void shutdown(signal));
    }
}
