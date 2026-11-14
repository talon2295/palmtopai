import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import {
    BUILD_INFO,
    type Config,
    type DaemonStatus,
    ensurePrivateDir,
    KEY_HEADER,
    loadConfig,
    type Paths,
    pathsFor,
} from '@palmtopai/daemon';
import { DAEMON_PROTOCOL_VERSION } from '@palmtopai/protocol';

export class CliError extends Error {
    override name = 'CliError';
    constructor(
        message: string,
        readonly exitCode = 1,
        /** The HTTP status of the daemon's answer, when the error comes from one. */
        readonly status?: number,
    ) {
        super(message);
    }
}

/** The Local API did not answer at all: the daemon is stopped or restarting. */
export class DaemonUnreachableError extends CliError {
    override name = 'DaemonUnreachableError';
    constructor() {
        super('cannot reach the daemon');
    }
}

export interface Health extends DaemonStatus {
    ok: true;
    pid: number;
}

type Probe = { kind: 'up'; health: Health } | { kind: 'down' } | { kind: 'foreign' };

const START_TIMEOUT_MS = 8_000;
const STOP_TIMEOUT_MS = 5_000;

/** Talks to the Local API. The local key is sent in a header and never printed. */
export class DaemonClient {
    readonly paths: Paths;
    #config: Config | undefined;
    #key: string | undefined;

    readonly #restart: boolean;
    readonly #notice: (text: string) => void;

    /**
     * `restart: false` never stops a daemon that is running, whatever its build (the MCP server of
     * an agent, which can be older than the daemon after `palmtop update`). `notice` is where a
     * one-time note for the user goes (the error stream of the command).
     */
    constructor(
        home: string,
        options: { restart?: boolean; notice?: (text: string) => void } = {},
    ) {
        this.paths = pathsFor(home);
        this.#restart = options.restart ?? true;
        this.#notice = options.notice ?? (() => {});
    }

    async config(): Promise<Config> {
        this.#config ??= await loadConfig(this.paths.config);
        return this.#config;
    }

    async #readKey(): Promise<string | undefined> {
        if (this.#key) return this.#key;
        try {
            const key = (await readFile(this.paths.localKey, 'utf8')).trim();
            if (key) this.#key = key;
        } catch {
            // Not created yet: the daemon writes it on first start.
        }
        return this.#key;
    }

    async probe(): Promise<Probe> {
        const { localPort } = await this.config();
        const key = await this.#readKey();
        let response: Response;
        try {
            response = await fetch(`http://127.0.0.1:${localPort}/health`, {
                headers: key ? { [KEY_HEADER]: key } : {},
                signal: AbortSignal.timeout(1_500),
            });
        } catch {
            return { kind: 'down' };
        }
        if (!response.ok) return { kind: 'foreign' };
        return { kind: 'up', health: (await response.json()) as Health };
    }

    /**
     * Returns the running daemon, starting it detached (logging to daemon.log) if needed.
     * `cliEntry` is the script of this CLI: the daemon is `palmtop serve` in the same runtime.
     * A daemon of another build (e.g. still running after `palmtop update`) is restarted.
     */
    async ensureRunning(cliEntry: string, build = BUILD_INFO.build): Promise<Health> {
        const first = await this.probe();
        if (first.kind === 'up' && first.health.build === build) return first.health;
        if (first.kind === 'foreign') throw foreignDaemon(await this.config());
        if (first.kind === 'up') {
            if (!this.#restart) {
                // Another build still speaks the same protocol: keep using it.
                const { protocol } = first.health;
                if (protocol === DAEMON_PROTOCOL_VERSION) return first.health;
                throw new CliError(
                    typeof protocol === 'number' && protocol > DAEMON_PROTOCOL_VERSION
                        ? 'palmtop was updated since this conversation started: restart the conversation (or the agent) to use the new version'
                        : 'the palmtop daemon is older than this palmtop: run `palmtop serve -b` in a terminal, then try again',
                );
            }
            await this.stop();
        }

        const home = await ensurePrivateDir(this.paths.home, { marker: this.paths.acl });
        if (home.aclError) {
            this.#notice(
                `note: palmtop could not limit ${this.paths.home} to your Windows user (${home.aclError}). The folder is in your profile, which Windows already keeps to you.\n`,
            );
        }
        const log = openSync(this.paths.log, 'a', 0o600);
        try {
            // Own process group: closing the terminal or Ctrl+C on the CLI does not kill it.
            const child = spawn(process.execPath, [cliEntry, 'serve'], {
                detached: true,
                // Windows: without it the daemon opens a console window of its own.
                windowsHide: true,
                stdio: ['ignore', log, log],
                env: process.env,
            });
            child.unref();
        } finally {
            closeSync(log);
        }

        const deadline = Date.now() + START_TIMEOUT_MS;
        let delay = 50;
        while (Date.now() < deadline) {
            await sleep(delay);
            delay = Math.min(delay * 2, 400);
            const probe = await this.probe();
            if (probe.kind === 'up') return probe.health;
            if (probe.kind === 'foreign') throw foreignDaemon(await this.config());
        }
        throw new CliError(`the daemon did not start in time, see ${this.paths.log}`);
    }

    /** Stops the daemon listening on the configured port. Returns false if none was running. */
    async stop(): Promise<boolean> {
        const probe = await this.probe();
        if (probe.kind === 'down') return false;
        if (probe.kind === 'foreign') throw foreignDaemon(await this.config());
        // Asked to stop itself, so it saves its state on every system. A daemon of an older build
        // has no such request (and Windows has no signal that lets it save): then it is signalled.
        if (!(await this.#requestShutdown())) process.kill(probe.health.pid, 'SIGTERM');
        const deadline = Date.now() + STOP_TIMEOUT_MS;
        while (Date.now() < deadline) {
            await sleep(100);
            if ((await this.probe()).kind === 'down') return true;
        }
        throw new CliError(`the daemon (pid ${probe.health.pid}) did not stop in time`);
    }

    /** `POST /shutdown`: whether the daemon accepted to stop. */
    async #requestShutdown(): Promise<boolean> {
        try {
            const { localPort } = await this.config();
            const key = await this.#readKey();
            if (!key) return false;
            const response = await fetch(`http://127.0.0.1:${localPort}/shutdown`, {
                method: 'POST',
                headers: { [KEY_HEADER]: key },
                signal: AbortSignal.timeout(3_000),
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    async request<T>(
        method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        path: string,
        options: { body?: unknown; headers?: Record<string, string> } = {},
    ): Promise<T> {
        const { localPort } = await this.config();
        const key = await this.#readKey();
        if (!key) throw new CliError('the daemon is not initialized');
        let response: Response;
        try {
            response = await fetch(`http://127.0.0.1:${localPort}${path}`, {
                method,
                headers: {
                    [KEY_HEADER]: key,
                    ...(options.body !== undefined && { 'content-type': 'application/json' }),
                    ...options.headers,
                },
                ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
            });
        } catch {
            throw new DaemonUnreachableError();
        }
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
            throw new CliError(
                payload.error ?? `daemon answered ${response.status}`,
                1,
                response.status,
            );
        }
        return payload as T;
    }
}

function foreignDaemon(config: Config): CliError {
    return new CliError(
        `port ${config.localPort} is used by another daemon (different PALMTOP_HOME or local key)`,
    );
}
