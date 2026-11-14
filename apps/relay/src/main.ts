#!/usr/bin/env bun
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_LIMITS, type RelayLimits, startRelay } from './relay';

/**
 * Relay entry point (pm2 in production). Configuration from the environment:
 * HOST, PORT, WEB_ROOT, CLI_ROOT, TRUST_PROXY=1, DATA_DIR (statistics, default
 * ~/.palmtop-relay), ADMIN_PORT (statistics on 127.0.0.1, default 8788) and RELAY_<LIMIT> for
 * every limit, e.g. RELAY_DEVICES_PER_ROOM=20.
 */
const env = process.env;

function number(name: string, fallback: number): number {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
        console.error(`[relay] invalid ${name}: ${raw}`);
        process.exit(1);
    }
    return value;
}

const envName = (key: string) => `RELAY_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
const limits = Object.fromEntries(
    Object.entries(DEFAULT_LIMITS).map(([key, value]) => [key, number(envName(key), value)]),
) as unknown as RelayLimits;

const relay = startRelay({
    hostname: env.HOST || '127.0.0.1',
    port: number('PORT', 8787),
    webRoot: env.WEB_ROOT || join(dirname(import.meta.dir), '..', 'web', 'dist'),
    cliRoot: env.CLI_ROOT || join(dirname(import.meta.dir), '..', '..', 'packages', 'cli', 'dist'),
    trustProxy: env.TRUST_PROXY === '1',
    dataDir: env.DATA_DIR || join(homedir(), '.palmtop-relay'),
    adminPort: number('ADMIN_PORT', 8788),
    limits,
});
console.log(`[relay] listening on ${env.HOST || '127.0.0.1'}:${relay.port}`);
console.log(`[relay] statistics on 127.0.0.1:${relay.adminPort}`);

const shutdown = async (signal: string) => {
    console.log(`[relay] ${signal} received, stopping`);
    await relay.stop();
    process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
