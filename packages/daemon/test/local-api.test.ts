import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    type Daemon,
    DEFAULT_RELAY_URL,
    defaultComputerName,
    KEY_HEADER,
    loadConfig,
    resolveRelayUrl,
    saveComputerName,
} from '../src';
import { createTempHome, expectMode, startTestDaemon } from './helpers';

describe('Local API', () => {
    let daemon: Daemon;
    let key: string;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
        const temp = await createTempHome();
        cleanup = temp.cleanup;
        daemon = await startTestDaemon(temp.home);
        key = (await readFile(join(temp.home, 'local.key'), 'utf8')).trim();
    });

    afterAll(async () => {
        await daemon.stop();
        await cleanup();
    });

    const local = (path: string, init: RequestInit = {}) =>
        fetch(`http://127.0.0.1:${daemon.localPort}${path}`, init);

    test('local.key is created with mode 600', async () => {
        await expectMode(join(daemon.home, 'local.key'), 0o600);
        expect(key.length).toBeGreaterThanOrEqual(32);
    });

    test('requests without the right key are refused', async () => {
        expect((await local('/health')).status).toBe(401);
        expect((await local('/health', { headers: { [KEY_HEADER]: 'wrong' } })).status).toBe(401);
        const response = await local('/health', { headers: { [KEY_HEADER]: key } });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ ok: true, localPort: daemon.localPort });
    });

    test('shutdown needs the key, and is refused by a daemon that cannot stop itself', async () => {
        const post = (headers: Record<string, string>) =>
            local('/shutdown', { method: 'POST', headers });
        expect((await post({})).status).toBe(401);
        // This daemon was not started by `palmtop serve`: no stop request handler.
        const refused = await post({ [KEY_HEADER]: key });
        expect(refused.status).toBe(501);
    });

    test('shutdown answers, then calls the handler of palmtop serve', async () => {
        const temp = await createTempHome();
        let stopped = 0;
        const other = await startTestDaemon(temp.home, { onShutdown: () => void stopped++ });
        try {
            const otherKey = (await readFile(join(temp.home, 'local.key'), 'utf8')).trim();
            const response = await fetch(`http://127.0.0.1:${other.localPort}/shutdown`, {
                method: 'POST',
                headers: { [KEY_HEADER]: otherKey },
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ ok: true });
            for (let i = 0; i < 100 && stopped === 0; i++) await Bun.sleep(10);
            expect(stopped).toBe(1);
        } finally {
            await other.stop();
            await temp.cleanup();
        }
    });

    test('a port that is taken says so and what to do', async () => {
        const temp = await createTempHome();
        try {
            await expect(
                startTestDaemon(temp.home, { localPort: daemon.localPort }),
            ).rejects.toThrow(/already in use.*localPort/);
        } finally {
            await temp.cleanup();
        }
    });

    test('requests with a foreign Host header are refused (DNS rebinding)', async () => {
        const response = await local('/health', {
            headers: { [KEY_HEADER]: key, host: `evil.example:${daemon.localPort}` },
        });
        expect(response.status).toBe(403);
    });

    test('projects/resolve returns the project id and nothing secret', async () => {
        const request = (body: unknown) =>
            local('/projects/resolve', {
                method: 'POST',
                headers: { [KEY_HEADER]: key, 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });

        const first = await request({ rootPath: '/tmp/some-repo' });
        const text = await first.text();
        const second = (await (await request({ rootPath: '/tmp/some-repo' })).json()) as {
            projectId: string;
        };
        const body = JSON.parse(text) as { projectId: string; name: string; created: boolean };

        expect(first.status).toBe(200);
        expect(body).toEqual({ projectId: body.projectId, name: 'some-repo', created: true });
        expect(second.projectId).toBe(body.projectId);

        const registry = await readFile(join(daemon.home, 'projects.json'), 'utf8');
        const { privateKey } = (
            JSON.parse(registry) as { computer: { roomKey: { privateKey: string } } }
        ).computer.roomKey;
        expect(text).not.toContain(privateKey);

        expect((await request({})).status).toBe(400);
        expect(
            (
                await local('/projects/resolve', {
                    method: 'POST',
                    headers: { [KEY_HEADER]: key },
                    body: 'not json',
                })
            ).status,
        ).toBe(400);
    });

    test('projects/lookup finds projects without creating them', async () => {
        const lookup = async (rootPath: string) => {
            const response = await local('/projects/lookup', {
                method: 'POST',
                headers: { [KEY_HEADER]: key, 'content-type': 'application/json' },
                body: JSON.stringify({ rootPath }),
            });
            expect(response.status).toBe(200);
            return response.json();
        };

        expect(await lookup('/tmp/never-created')).toEqual({ project: null });
        const { projectId } = await daemon.registry.resolve({ rootPath: '/tmp/looked-up' });
        expect(await lookup('/tmp/looked-up')).toEqual({
            project: { projectId, name: 'looked-up' },
        });
        const registry = await readFile(join(daemon.home, 'projects.json'), 'utf8');
        expect(registry).not.toContain('never-created');
    });

    test('config/name reads, sets and resets the computer name, keeping other config keys', async () => {
        const configPath = join(daemon.home, 'config.json');
        await writeFile(configPath, JSON.stringify({ localPort: 0, extra: 1 }));
        const request = (init: RequestInit = {}) =>
            local('/config/name', {
                ...init,
                headers: { [KEY_HEADER]: key, 'content-type': 'application/json' },
            });
        const put = (body: unknown) => request({ method: 'PUT', body: JSON.stringify(body) });

        const host = defaultComputerName();
        expect(await (await request()).json()).toEqual({ name: host, default: host });

        const set = await put({ name: '  Office  ' });
        expect(set.status).toBe(200);
        expect(await set.json()).toEqual({ name: 'Office', default: host });
        expect(daemon.computerName).toBe('Office');
        expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
            localPort: 0,
            extra: 1,
            computerName: 'Office',
        });
        expect((await loadConfig(configPath)).computerName).toBe('Office');
        const health = await local('/health', { headers: { [KEY_HEADER]: key } });
        expect(await health.json()).toMatchObject({ computerName: 'Office' });

        for (const name of ['', '   ', 'x'.repeat(41), 'two\nlines', 42]) {
            const refused = await put({ name });
            expect(refused.status).toBe(400);
        }
        expect(daemon.computerName).toBe('Office');

        expect(await (await put({ name: null })).json()).toEqual({ name: host, default: host });
        expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
            localPort: 0,
            extra: 1,
        });
        expect((await local('/config/name')).status).toBe(401);
    });

    test('health reports the relay URL and status, and no device port', async () => {
        const response = await local('/health', { headers: { [KEY_HEADER]: key } });
        const health = (await response.json()) as Record<string, unknown>;
        expect(health).toMatchObject({
            ok: true,
            localPort: daemon.localPort,
            relay: { url: daemon.relayUrl },
        });
        expect(Object.keys(health)).not.toContain('devicePort');
    });
});

describe('relay URL', () => {
    test('the public relay; only PALMTOP_RELAY_URL changes it, and config.json no longer does', async () => {
        const { home, cleanup } = await createTempHome();
        const configPath = join(home, 'config.json');
        await writeFile(configPath, JSON.stringify({ relayUrl: 'ws://127.0.0.1:1' }));
        expect(await loadConfig(configPath)).not.toHaveProperty('relayUrl');
        await cleanup();
        expect(resolveRelayUrl({})).toBe(DEFAULT_RELAY_URL);
        expect(resolveRelayUrl({ PALMTOP_RELAY_URL: 'ws://127.0.0.1:8787' })).toBe(
            'ws://127.0.0.1:8787',
        );
        expect(() => resolveRelayUrl({ PALMTOP_RELAY_URL: 'http://example.com' })).toThrow(
            'invalid PALMTOP_RELAY_URL',
        );
    });
});

describe('computer name config', () => {
    test('the default is the host name without the domain, always a valid name', () => {
        expect(defaultComputerName('Mac-mini-di-Grace.local')).toBe('Mac-mini-di-Grace');
        expect(defaultComputerName('build-01')).toBe('build-01');
        expect(defaultComputerName('a'.repeat(60))).toBe('a'.repeat(40));
        expect(defaultComputerName('')).toBe('Computer');
    });

    test('saving creates config.json when missing and refuses invalid names', async () => {
        const temp = await createTempHome();
        try {
            const path = join(temp.home, 'config.json');
            expect(await saveComputerName(path, 'Laptop')).toBe('Laptop');
            expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ computerName: 'Laptop' });
            await expectMode(path, 0o600);
            await expect(saveComputerName(path, '\t')).rejects.toThrow();
            expect((await loadConfig(path)).computerName).toBe('Laptop');
        } finally {
            await temp.cleanup();
        }
    });
});
