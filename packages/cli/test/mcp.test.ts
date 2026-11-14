import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { GUIDE_TOOLS } from '@palmtopai/agent-guide';
import { DAEMON_PROTOCOL_VERSION, LIMITS } from '@palmtopai/protocol';
import { type Relay, startRelay } from '@palmtopai/relay';
import { buildCli } from '../scripts/build';
import { CliError, DaemonClient } from '../src/daemon-client';
import { toolDefinitions } from '../src/mcp';

// Each test starts `node` processes and a daemon: on a slow machine 5 s is not enough.
setDefaultTimeout(30_000);

const NODE = Bun.which('node');
if (!NODE) throw new Error('these tests run the compiled CLI with Node.js 22+: install node');

let home: string;
let work: string;
let cli: string;
let relay: Relay;
const connected: Client[] = [];

function freePort(): number {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
    const port = server.port as number;
    server.stop(true);
    return port;
}

function environment(): Record<string, string> {
    return {
        PALMTOP_HOME: home,
        PALMTOP_RELAY_URL: `ws://127.0.0.1:${relay.port}`,
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: join(home, 'claude-config'),
        CODEX_HOME: join(home, 'codex-home'),
    };
}

/** An MCP client of the real `palmtop mcp`, started in `cwd`, as an agent would. */
async function connect(entry = cli, cwd = work): Promise<Client> {
    const client = new Client({ name: 'test', version: '0' });
    const errors: unknown[] = [];
    client.onerror = (error) => errors.push(error);
    await client.connect(
        new StdioClientTransport({
            command: NODE as string,
            args: [entry, 'mcp'],
            env: environment(),
            cwd,
            stderr: 'pipe',
        }),
    );
    connected.push(client);
    return Object.assign(client, { errors });
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    return { text: content.map((part) => part.text).join('\n'), isError: result.isError === true };
}

async function palmtop(entry: string, ...args: string[]) {
    const child = Bun.spawn([NODE as string, entry, ...args], {
        cwd: work,
        env: { ...process.env, ...environment() },
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { stdout, code };
}

async function daemonPid(): Promise<number> {
    return Number.parseInt(await readFile(join(home, 'daemon.pid'), 'utf8'), 10);
}

beforeAll(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'palmtop-mcp-')));
    cli = await buildCli(join(home, 'dist'));
    work = join(home, 'my-project');
    await mkdir(work, { recursive: true });
    relay = startRelay({ port: 0, log: () => {} });
    await writeFile(join(home, 'config.json'), JSON.stringify({ localPort: freePort() }));
});

afterAll(async () => {
    for (const client of connected) await client.close().catch(() => {});
    await palmtop(cli, 'stop');
    await relay.stop();
    await rm(home, { recursive: true, force: true });
});

describe('palmtop mcp', () => {
    let agent: Client;

    beforeAll(async () => {
        agent = await connect();
    });

    test('announces itself, its instructions and its tools', async () => {
        expect(agent.getServerVersion()?.name).toBe('palmtop');
        expect(agent.getInstructions()).toContain('session_start');
        const { tools } = await agent.listTools();
        const names = tools.map((tool) => tool.name);
        expect(names).toEqual(toolDefinitions().map((tool) => tool.name));
        // The guide documents exactly the tools the server has.
        expect([...names].sort()).toEqual([...GUIDE_TOOLS].sort());
        for (const name of [
            'session_start',
            'checklist_create',
            'item_add',
            'choice_create',
            'feedback',
            'share',
            'retest',
        ]) {
            expect(names).toContain(name);
        }
        // What the user does with their own hands never becomes a tool of the agent.
        for (const name of names) {
            expect(name).not.toMatch(/pair|invite|device|delete|project_remove|unshare|close/);
        }
        for (const tool of tools) {
            expect(tool.description?.length).toBeGreaterThan(10);
            expect(tool.inputSchema.type).toBe('object');
            expect(tool.inputSchema).not.toHaveProperty('$schema');
        }
    });

    test('says the text is markdown and accepts what the protocol accepts, no more', async () => {
        const { tools } = await agent.listTools();
        for (const name of ['checklist_create', 'item_add', 'choice_create', 'message_set']) {
            const description = tools.find((tool) => tool.name === name)?.description ?? '';
            expect(description).toContain('markdown');
            expect(description).toContain('copy button');
        }
        expect(agent.getInstructions()).toContain('markdown');
        const properties = (name: string) =>
            tools.find((tool) => tool.name === name)?.inputSchema.properties as Record<
                string,
                { maxLength?: number; description?: string }
            >;
        expect(properties('item_add').text?.maxLength).toBe(LIMITS.text);
        expect(properties('message_set').text?.maxLength).toBe(LIMITS.text);
        expect(properties('item_add').detail?.description).toContain('Deprecated');
        // Over the limit: refused here, with a clear message, not by the computer later.
        const long = await call(agent, 'item_add', { text: 'x'.repeat(LIMITS.text + 1) });
        expect(long.isError).toBe(true);
        expect(long.text).toContain('invalid arguments');
    });

    test('asks for a session before anything else', async () => {
        const result = await call(agent, 'item_add', { text: 'x' });
        expect(result.isError).toBe(true);
        expect(result.text).toContain('session_start');
        expect(result.text).not.toContain('--session');
    });

    test('lists no sessions where there is no project yet', async () => {
        const result = await call(agent, 'session_list');
        expect(result.isError).toBe(false);
    });

    test('rejects arguments that do not fit', async () => {
        const result = await call(agent, 'choice_create', {
            question: 'Which?',
            options: [{ text: 'only one' }],
        });
        expect(result.isError).toBe(true);
        expect(result.text).toContain('invalid arguments');
    });

    test('keeps the text of the checks as written', async () => {
        const started = await call(agent, 'session_start', { title: '-R&D "x" è' });
        expect(started.isError).toBe(false);
        expect(started.text).toContain('current session');
        const ref = /session (\w{6}) /.exec(started.text)?.[1];
        expect(ref).toBeDefined();

        const texts = [
            'R&D `x` $HOME "q" è',
            '100% ^done^ !important',
            '--version flag',
            "it's a path: C:\\Users\\x & 'quoted'",
        ];
        const markdown =
            'Sign in\n\nRun:\n\n```\nbun run dev --port 3000\n```\n- `displayName` is shown';
        const created = await call(agent, 'checklist_create', {
            title: '-- Checks & co',
            items: [...texts, markdown],
        });
        expect(created.isError).toBe(false);
        const shown = await call(agent, 'show');
        for (const text of texts) expect(shown.text).toContain(text);
        // A markdown text with lines and a block is stored whole; `show` keeps its lines under the first.
        expect(shown.text).toMatch(/\n {2,}bun run dev --port 3000\n/);
        expect(shown.text).toContain('- `displayName` is shown');
        expect(shown.text).toMatch(/Sign in\n/);
        expect(shown.text).toContain('-- Checks & co');
        expect(shown.text).toContain('-R&D "x" è');
    });

    test('adds, edits and removes items and checklists', async () => {
        const added = await call(agent, 'item_add', {
            text: '-v is not a flag',
            detail: 'under the check',
        });
        expect(added.isError).toBe(false);
        const itemRef = /Added (\S+) to/.exec(added.text)?.[1] as string;
        expect(itemRef).toBeDefined();
        expect((await call(agent, 'show')).text).toContain('under the check');

        const edited = await call(agent, 'item_edit', { item: itemRef, text: '-y changed & done' });
        expect(edited.isError).toBe(false);
        expect((await call(agent, 'show')).text).toContain('-y changed & done');

        const removed = await call(agent, 'item_remove', { item: itemRef });
        expect(removed.isError).toBe(false);
        expect((await call(agent, 'show')).text).not.toContain('-y changed & done');

        const missing = await call(agent, 'item_remove', { item: 'zzzzzz' });
        expect(missing.isError).toBe(true);
        expect(missing.text).not.toMatch(/^palmtop: /);
        expect(missing.text).not.toContain('palmtop --help');

        const list = await call(agent, 'checklist_create', { title: 'Second', items: ['one'] });
        const listRef = /checklist (\S+) /.exec(list.text)?.[1] as string;
        const renamed = await call(agent, 'checklist_rename', { checklist: listRef, title: '-B' });
        expect(renamed.isError).toBe(false);
        expect((await call(agent, 'show')).text).toContain('-B');
        expect((await call(agent, 'checklist_remove', { checklist: listRef })).isError).toBe(false);
    });

    test('asks a question with options', async () => {
        const choice = await call(agent, 'choice_create', {
            question: 'Which one? -- "now"',
            options: [
                { text: 'Option A & B', detail: 'the first' },
                { text: '--multiple' },
                { text: 'Third', detail: 'last' },
            ],
            multiple: true,
        });
        expect(choice.isError).toBe(false);
        const shown = (await call(agent, 'show')).text;
        expect(shown).toContain('Option A & B');
        expect(shown).toContain('--multiple');
        expect(shown).toContain('the first');
    });

    test('shows and clears the message of the session', async () => {
        const set = await call(agent, 'message_set', { text: '3 checks ready & waiting' });
        expect(set.isError).toBe(false);
        expect((await call(agent, 'show')).text).toContain('3 checks ready & waiting');
        expect((await call(agent, 'message_set', { clear: true })).isError).toBe(false);
        expect((await call(agent, 'message_set', {})).isError).toBe(true);
        expect((await call(agent, 'message_set', { text: 'x', clear: true })).isError).toBe(true);
        const toNobody = await call(agent, 'message_set', { text: 'hi', to: 'Nobody' });
        expect(toNobody.isError).toBe(true);
    });

    test('reads the feedback, and the people and shares of the user', async () => {
        const feedback = await call(agent, 'feedback');
        expect(feedback.isError).toBe(false);
        expect(feedback.text).toContain('not reviewed');
        expect((await call(agent, 'people_list')).isError).toBe(false);
        expect((await call(agent, 'share_list')).isError).toBe(false);
        const share = await call(agent, 'share', { checklist: 'zzzzzz', with: 'Nobody' });
        expect(share.isError).toBe(true);
    });

    test('keeps the current session, and switches with session_use', async () => {
        const first = (await call(agent, 'session_list')).text;
        expect(first).toContain('Current session:');
        const other = await call(agent, 'session_start', { title: 'Another' });
        const otherRef = /session (\w{6}) /.exec(other.text)?.[1] as string;
        const firstRef = /Current session: (\w{6})/.exec(first)?.[1] as string;
        expect(otherRef).not.toBe(firstRef);
        expect((await call(agent, 'show')).text).toContain('Another');

        // The session of a call that names one is not the current one.
        expect((await call(agent, 'show', { session: firstRef })).text).toContain('-R&D');
        expect((await call(agent, 'show')).text).toContain('Another');

        expect((await call(agent, 'session_use', { ref: firstRef })).isError).toBe(false);
        expect((await call(agent, 'show')).text).toContain('-R&D');
        const unknown = await call(agent, 'session_use', { ref: 'zzzzzz' });
        expect(unknown.isError).toBe(true);
        expect((await call(agent, 'show')).text).toContain('-R&D');
    });

    test('a second conversation has its own current session', async () => {
        const second = await connect();
        const result = await call(second, 'item_add', { text: 'x' });
        expect(result.isError).toBe(true);
        expect(result.text).toContain('session_start');
    });

    test('has no session in a folder that is not a project', async () => {
        const elsewhere = join(home, 'elsewhere');
        await mkdir(elsewhere, { recursive: true });
        const client = await connect(cli, elsewhere);
        const result = await call(client, 'session_use', { ref: 'abcdef' });
        expect(result.isError).toBe(true);
        expect(result.text).toContain('session_start');
    });
});

interface Reply {
    id: number | null;
    result?: { protocolVersion?: string; content?: Array<{ type: string }> };
    error?: { code: number };
}

describe('the process', () => {
    test('writes only the protocol to stdout and ends when stdin closes', async () => {
        const child = Bun.spawn([NODE as string, cli, 'mcp'], {
            cwd: work,
            env: { ...process.env, ...environment() },
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const requests = [
            {
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: { protocolVersion: '2025-11-25' },
            },
            { jsonrpc: '2.0', method: 'notifications/initialized' },
            { jsonrpc: '2.0', id: 2, method: 'server/discover' },
            { jsonrpc: '2.0', id: 3, method: 'ping' },
            {
                jsonrpc: '2.0',
                id: 4,
                method: 'tools/call',
                params: { name: 'nope', arguments: {} },
            },
            { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'session_list' } },
        ];
        child.stdin.write(`${requests.map((request) => JSON.stringify(request)).join('\n')}\n`);
        child.stdin.write('not json\n');
        child.stdin.end();
        const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        expect(code).toBe(0);

        const messages = stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Reply);
        const byId = new Map(messages.map((message) => [message.id, message]));
        expect(byId.get(1)?.result?.protocolVersion).toBe('2025-11-25');
        expect(byId.get(2)?.error?.code).toBe(-32601);
        expect(byId.get(3)?.result).toEqual({});
        expect(byId.get(4)?.error?.code).toBe(-32602);
        expect(byId.get(5)?.result?.content?.[0]?.type).toBe('text');
        expect(byId.get(null)?.error?.code).toBe(-32700);
    });

    test('never restarts a daemon of another build', async () => {
        const pid = await daemonPid();
        const newer = await buildCli(join(home, 'dist-newer'), { version: '9.9.9' });
        expect(newer).not.toBe(cli);
        const client = await connect(newer);
        const result = await call(client, 'session_list');
        expect(result.isError).toBe(false);
        expect(await daemonPid()).toBe(pid);

        // The CLI, run by a person, does restart it onto its own build.
        const listed = await palmtop(newer, 'session', 'list');
        expect(listed.code).toBe(0);
        expect(await daemonPid()).not.toBe(pid);
    });
});

describe('DaemonClient without restart', () => {
    async function withDaemon(
        health: Record<string, unknown>,
        check: (c: DaemonClient) => Promise<void>,
    ) {
        const folder = await mkdtemp(join(home, 'fake-'));
        const port = freePort();
        await writeFile(join(folder, 'config.json'), JSON.stringify({ localPort: port }));
        const server = Bun.serve({
            port,
            hostname: '127.0.0.1',
            fetch: () => Response.json({ ok: true, pid: 1, ...health }),
        });
        try {
            await check(new DaemonClient(folder, { restart: false }));
        } finally {
            await server.stop(true);
        }
    }

    test('keeps a daemon of another build with the same protocol', async () => {
        await withDaemon(
            { build: 'aaaaaaaaaaaa', protocol: DAEMON_PROTOCOL_VERSION },
            async (client) => {
                const health = await client.ensureRunning('unused', 'bbbbbbbbbbbb');
                expect(health.build).toBe('aaaaaaaaaaaa');
            },
        );
    });

    test('says what to do when the protocol is not the same', async () => {
        const old = { build: 'aaaaaaaaaaaa', protocol: DAEMON_PROTOCOL_VERSION - 1 };
        await withDaemon(old, async (client) => {
            const error = await client.ensureRunning('unused', 'bbbbbbbbbbbb').catch((e) => e);
            expect(error).toBeInstanceOf(CliError);
            expect(error.message).toContain('palmtop serve -b');
        });
        // A daemon newer than this palmtop: it is the conversation that has to restart.
        const newer = { build: 'aaaaaaaaaaaa', protocol: DAEMON_PROTOCOL_VERSION + 1 };
        await withDaemon(newer, async (client) => {
            const error = await client.ensureRunning('unused', 'bbbbbbbbbbbb').catch((e) => e);
            expect(error).toBeInstanceOf(CliError);
            expect(error.message).toContain('restart the conversation');
        });
        // A daemon that does not report its protocol (before 0.21) counts as an older one.
        await withDaemon({ build: 'aaaaaaaaaaaa' }, async (client) => {
            const error = await client.ensureRunning('unused', 'bbbbbbbbbbbb').catch((e) => e);
            expect(error).toBeInstanceOf(CliError);
        });
    });
});
