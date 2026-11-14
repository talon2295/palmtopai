import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    type ClaudeRunner,
    CODEX_MCP_BEGIN,
    CODEX_MCP_END,
    claudeJsonPath,
    codexMcpBlock,
    InstallError,
    installClaudeCode,
    installClaudeMcp,
    installCodex,
    installCodexMcp,
    type McpServerCommand,
} from '../src';

let dir: string;
const now = new Date(2026, 9, 16, 12, 0, 0);
const server: McpServerCommand = {
    command: '/usr/local/bin/node',
    args: ['/home/ada/.palmtopai/bin/palmtop.mjs', 'mcp'],
};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'palmtop-mcp-install-'));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const claudeJson = () => join(dir, '.claude.json');
const configToml = () => join(dir, 'config.toml');
const entry = (overrides: Record<string, unknown> = {}) => ({
    type: 'stdio',
    command: server.command,
    args: server.args,
    env: {},
    ...overrides,
});

/** A `claude` that edits the file the way `claude mcp add` and `claude mcp remove` do. */
function fakeClaude(calls: string[][]): ClaudeRunner {
    return async (args) => {
        calls.push(args);
        const text = await readFile(claudeJson(), 'utf8').catch(() => '{}');
        const json = JSON.parse(text);
        json.mcpServers ??= {};
        if (args[1] === 'remove') delete json.mcpServers[args[4] as string];
        else {
            const at = args.indexOf('--');
            json.mcpServers[args[4] as string] = {
                type: 'stdio',
                command: args[at + 1],
                args: args.slice(at + 2),
                env: {},
            };
        }
        await writeFile(claudeJson(), JSON.stringify(json, null, 2));
        return { code: 0 };
    };
}

describe('Claude Code MCP server', () => {
    test('the file is ~/.claude.json, or inside CLAUDE_CONFIG_DIR', () => {
        expect(claudeJsonPath({}, '/home/ada')).toBe(join('/home/ada', '.claude.json'));
        expect(claudeJsonPath({ CLAUDE_CONFIG_DIR: '/custom' }, '/home/ada')).toBe(
            join('/custom', '.claude.json'),
        );
    });

    test('without a claude command it writes the entry in the file', async () => {
        const change = await installClaudeMcp({ path: claudeJson(), server, now });
        expect(change).toEqual({ path: claudeJson(), change: 'created', via: 'file' });
        const text = await readFile(claudeJson(), 'utf8');
        expect(JSON.parse(text)).toEqual({ mcpServers: { palmtop: entry() } });
        expect(text).toStartWith('{\n  "mcpServers"');
    });

    test('is idempotent', async () => {
        await installClaudeMcp({ path: claudeJson(), server, now });
        const before = await readFile(claudeJson(), 'utf8');
        expect(await installClaudeMcp({ path: claudeJson(), server, now })).toEqual({
            path: claudeJson(),
            change: 'unchanged',
        });
        expect(await readFile(claudeJson(), 'utf8')).toBe(before);
        expect(await readdir(dir)).toEqual(['.claude.json']);
    });

    test('keeps everything else in the file, and backs it up', async () => {
        const original = {
            numStartups: 12,
            projects: { '/work': { allowedTools: [] } },
            mcpServers: { other: { type: 'http', url: 'https://example.com/mcp' } },
        };
        await writeFile(claudeJson(), JSON.stringify(original, null, 4));
        const change = await installClaudeMcp({ path: claudeJson(), server, now });
        const backup = `${claudeJson()}.palmtop-backup-20261016-120000`;
        expect(change).toEqual({ path: claudeJson(), change: 'created', via: 'file', backup });
        expect(JSON.parse(await readFile(backup, 'utf8'))).toEqual(original);
        const written = await readFile(claudeJson(), 'utf8');
        expect(JSON.parse(written)).toEqual({
            ...original,
            mcpServers: { ...original.mcpServers, palmtop: entry() },
        });
        expect(written).toStartWith('{\n    "numStartups"');
    });

    test('a different command is replaced', async () => {
        await writeFile(
            claudeJson(),
            JSON.stringify({ mcpServers: { palmtop: entry({ command: '/old/node' }) } }),
        );
        const change = await installClaudeMcp({ path: claudeJson(), server, now });
        expect(change.change).toBe('updated');
        expect(JSON.parse(await readFile(claudeJson(), 'utf8')).mcpServers.palmtop).toEqual(
            entry(),
        );
    });

    test('with a claude command it registers through it', async () => {
        const calls: string[][] = [];
        const change = await installClaudeMcp({
            path: claudeJson(),
            server,
            run: fakeClaude(calls),
            now,
        });
        expect(change).toEqual({ path: claudeJson(), change: 'created', via: 'claude' });
        expect(calls).toEqual([
            ['mcp', 'add', '--scope', 'user', 'palmtop', '--', server.command, ...server.args],
        ]);
        expect(await readdir(dir)).toEqual(['.claude.json']);
    });

    test('with a claude command, a changed entry is removed and added again', async () => {
        await writeFile(
            claudeJson(),
            JSON.stringify({ mcpServers: { palmtop: entry({ command: '/old/node' }) } }),
        );
        const calls: string[][] = [];
        const change = await installClaudeMcp({
            path: claudeJson(),
            server,
            run: fakeClaude(calls),
            now,
        });
        expect(change).toEqual({ path: claudeJson(), change: 'updated', via: 'claude' });
        expect(calls.map((call) => call[1])).toEqual(['remove', 'add']);
    });

    test.each([
        ['there is no claude command', async () => null],
        ['it fails', async () => ({ code: 1 })],
        ['it succeeds without changing the file', async () => ({ code: 0 })],
    ] as Array<[string, ClaudeRunner]>)('writes the file when %s', async (_label, run) => {
        const change = await installClaudeMcp({ path: claudeJson(), server, run, now });
        expect(change).toEqual({ path: claudeJson(), change: 'created', via: 'file' });
        expect(JSON.parse(await readFile(claudeJson(), 'utf8')).mcpServers.palmtop).toEqual(
            entry(),
        );
    });

    test.each([
        ['invalid JSON', '{"mcpServers": ', 'is not valid JSON'],
        ['a JSON array', '[]', 'does not contain a JSON object'],
        ['mcpServers not an object', '{"mcpServers": []}', '"mcpServers" in'],
    ])('refuses to touch a file with %s', async (_label, content, message) => {
        await writeFile(claudeJson(), content);
        const error = await installClaudeMcp({ path: claudeJson(), server, now }).catch((e) => e);
        expect(error).toBeInstanceOf(InstallError);
        expect((error as Error).message).toContain(message);
        expect(await readFile(claudeJson(), 'utf8')).toBe(content);
        expect(await readdir(dir)).toEqual(['.claude.json']);
    });

    test('installClaudeCode registers it only when asked to', async () => {
        const claudeDir = join(dir, '.claude');
        expect((await installClaudeCode({ claudeDir, now })).mcp).toBeUndefined();
        const result = await installClaudeCode({
            claudeDir,
            now,
            mcp: { server, claudeJson: claudeJson() },
        });
        expect(result.mcp).toEqual({ path: claudeJson(), change: 'created', via: 'file' });
    });
});

describe('Codex MCP server', () => {
    test('the block names the server, its command and the approval mode', () => {
        const block = codexMcpBlock(server);
        expect(block).toStartWith(`${CODEX_MCP_BEGIN}\n[mcp_servers.palmtop]\n`);
        expect(block).toContain(`command = "${server.command}"`);
        expect(block).toContain('args = ["/home/ada/.palmtopai/bin/palmtop.mjs", "mcp"]');
        expect(block).toContain('default_tools_approval_mode = "approve"');
        expect(block).toEndWith(`${CODEX_MCP_END}\n`);
    });

    test('paths with backslashes and quotes are valid TOML strings', () => {
        const block = codexMcpBlock({
            command: 'C:\\Program Files\\nodejs\\node.exe',
            args: ['C:\\Users\\Ada "A"\\.palmtopai\\bin\\palmtop.mjs', 'mcp'],
        });
        expect(block).toContain('command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"');
        expect(block).toContain('"C:\\\\Users\\\\Ada \\"A\\"\\\\.palmtopai\\\\bin\\\\palmtop.mjs"');
    });

    test('creates config.toml, and a second run changes nothing', async () => {
        const first = await installCodexMcp({ path: configToml(), server, now });
        expect(first).toEqual({ path: configToml(), change: 'created', via: 'file' });
        expect(await readFile(configToml(), 'utf8')).toBe(codexMcpBlock(server));
        expect(await installCodexMcp({ path: configToml(), server, now })).toEqual({
            path: configToml(),
            change: 'unchanged',
        });
        expect(await readdir(dir)).toEqual(['config.toml']);
    });

    test.each([
        ['a final newline', 'model = "gpt-5"\n\n[profiles.fast]\nmodel = "mini"\n'],
        ['no final newline', 'model = "gpt-5"'],
    ])('appends to a config.toml with %s, keeping it, with a backup', async (_label, original) => {
        await writeFile(configToml(), original);
        const change = await installCodexMcp({ path: configToml(), server, now });
        const backup = `${configToml()}.palmtop-backup-20261016-120000`;
        expect(change).toEqual({ path: configToml(), change: 'updated', via: 'file', backup });
        expect(await readFile(backup, 'utf8')).toBe(original);
        const written = await readFile(configToml(), 'utf8');
        expect(written).toStartWith(original);
        expect(written).toEndWith(codexMcpBlock(server));
        expect(written.split(CODEX_MCP_BEGIN)).toHaveLength(2);
    });

    test('replaces its own block when the command changed, and only that', async () => {
        const old = codexMcpBlock({ command: '/old/node', args: ['/old/palmtop.mjs', 'mcp'] });
        await writeFile(
            configToml(),
            `model = "gpt-5"\n\n${old}\n[profiles.fast]\nmodel = "mini"\n`,
        );
        const change = await installCodexMcp({ path: configToml(), server, now });
        expect(change.change).toBe('updated');
        expect(await readFile(configToml(), 'utf8')).toBe(
            `model = "gpt-5"\n\n${codexMcpBlock(server)}\n[profiles.fast]\nmodel = "mini"\n`,
        );
    });

    test('leaves a server written by hand as it is', async () => {
        const original = '[mcp_servers.palmtop]\ncommand = "palmtop-mcp"\n';
        await writeFile(configToml(), original);
        const change = await installCodexMcp({ path: configToml(), server, now });
        expect(change.change).toBe('skipped');
        expect(change.reason).toContain('written by hand');
        expect(await readFile(configToml(), 'utf8')).toBe(original);
        expect(await readdir(dir)).toEqual(['config.toml']);
    });

    test('installCodex registers it only when asked to', async () => {
        const codexHome = join(dir, '.codex');
        expect((await installCodex({ homeDir: dir, codexHome, now })).mcp).toBeUndefined();
        const result = await installCodex({ homeDir: dir, codexHome, now, mcp: server });
        expect(result.mcp).toEqual({
            path: join(codexHome, 'config.toml'),
            change: 'created',
            via: 'file',
        });
    });
});
