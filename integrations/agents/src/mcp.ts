import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { backupFile, backupSuffix, readIfExists, writeAtomic } from './files';
import { InstallError } from './skill';

/** Name of the palmtop MCP server in the configuration of an agent. */
export const MCP_SERVER_NAME = 'palmtop';

/** How an agent starts `palmtop mcp`: absolute paths, never a shim that needs a shell. */
export interface McpServerCommand {
    command: string;
    args: string[];
}

/** What an install did about the MCP server of an agent. */
export interface McpChange {
    path: string;
    change: 'created' | 'updated' | 'unchanged' | 'skipped';
    /** `claude`: registered with `claude mcp add`; `file`: written in the configuration file. */
    via?: 'claude' | 'file';
    backup?: string;
    /** Why nothing was done (`skipped`). */
    reason?: string;
}

/** Runs `claude` with these arguments; null when there is no `claude` command to run. */
export type ClaudeRunner = (args: string[]) => Promise<{ code: number } | null>;

/** The user-scope configuration file of Claude Code: `$CLAUDE_CONFIG_DIR/.claude.json` or `~/.claude.json`. */
export function claudeJsonPath(env: Record<string, string | undefined>, homeDir: string): string {
    return join(env.CLAUDE_CONFIG_DIR || homeDir, '.claude.json');
}

interface ClaudeServerEntry {
    type: 'stdio';
    command: string;
    args: string[];
    env: Record<string, string>;
}

function wantedEntry(server: McpServerCommand): ClaudeServerEntry {
    return { type: 'stdio', command: server.command, args: server.args, env: {} };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameEntry(existing: unknown, server: McpServerCommand): boolean {
    if (!isObject(existing)) return false;
    const env = existing.env;
    return (
        (existing.type === undefined || existing.type === 'stdio') &&
        existing.command === server.command &&
        JSON.stringify(existing.args ?? []) === JSON.stringify(server.args) &&
        (env === undefined || (isObject(env) && Object.keys(env).length === 0))
    );
}

async function readClaudeJson(
    path: string,
): Promise<{ text: string | null; json: Record<string, unknown> }> {
    const text = await readIfExists(path);
    if (text === null || text.trim() === '') return { text, json: {} };
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        throw new InstallError(`${path} is not valid JSON: fix it, then run install again`);
    }
    if (!isObject(json)) throw new InstallError(`${path} does not contain a JSON object`);
    if (json.mcpServers !== undefined && !isObject(json.mcpServers)) {
        throw new InstallError(`"mcpServers" in ${path} is not an object`);
    }
    return { text, json };
}

function currentServer(json: Record<string, unknown>): unknown {
    return isObject(json.mcpServers) ? json.mcpServers[MCP_SERVER_NAME] : undefined;
}

/**
 * Registers the MCP server of palmtop in Claude Code, for the user (all projects). With a
 * `claude` command that is `claude mcp add`, which writes the file the way Claude Code does (its
 * file is written all the time by running sessions); without one, the entry is written in the
 * file, which is backed up first. Idempotent.
 */
export async function installClaudeMcp(options: {
    path: string;
    server: McpServerCommand;
    run?: ClaudeRunner;
    now?: Date;
}): Promise<McpChange> {
    const { path, server, run } = options;
    const { text, json } = await readClaudeJson(path);
    const existing = currentServer(json);
    if (sameEntry(existing, server)) return { path, change: 'unchanged' };
    const change = existing === undefined ? 'created' : 'updated';

    if (run) {
        const removed =
            existing === undefined
                ? { code: 0 }
                : await run(['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME]);
        const added =
            removed?.code === 0
                ? await run([
                      'mcp',
                      'add',
                      '--scope',
                      'user',
                      MCP_SERVER_NAME,
                      '--',
                      server.command,
                      ...server.args,
                  ])
                : null;
        if (
            added?.code === 0 &&
            sameEntry(currentServer((await readClaudeJson(path)).json), server)
        ) {
            return { path, change, via: 'claude' };
        }
    }

    const mcpServers = isObject(json.mcpServers) ? json.mcpServers : {};
    const updated = {
        ...json,
        mcpServers: { ...mcpServers, [MCP_SERVER_NAME]: wantedEntry(server) },
    };
    await mkdir(dirname(path), { recursive: true });
    const backup =
        text === null ? undefined : await backupFile(path, backupSuffix(options.now ?? new Date()));
    await writeAtomic(path, `${JSON.stringify(updated, null, indentOf(text))}\n`);
    return { path, change, via: 'file', ...(backup && { backup }) };
}

/** Keeps the indentation of an existing file; Claude Code writes 2 spaces. */
function indentOf(content: string | null): string {
    const match = content?.match(/^[{[]\s*\n([ \t]+)\S/);
    return match?.[1] ?? '  ';
}

export const CODEX_MCP_BEGIN = '# >>> palmtop mcp (palmtop setup) >>>';
export const CODEX_MCP_END = '# <<< palmtop mcp <<<';

const tomlString = (value: string) => JSON.stringify(value);

/**
 * The server in the `config.toml` of Codex. Codex asks before running a tool of an MCP server
 * unless told otherwise: the tools of palmtop only write the checklists of the conversation.
 */
export function codexMcpBlock(server: McpServerCommand): string {
    return [
        CODEX_MCP_BEGIN,
        `[mcp_servers.${MCP_SERVER_NAME}]`,
        `command = ${tomlString(server.command)}`,
        `args = [${server.args.map(tomlString).join(', ')}]`,
        'default_tools_approval_mode = "approve"',
        CODEX_MCP_END,
        '',
    ].join('\n');
}

/**
 * Adds the palmtop MCP server to `$CODEX_HOME/config.toml` between two marker lines, which a
 * later install replaces. A `[mcp_servers.palmtop]` the user wrote by hand is left as it is.
 */
export async function installCodexMcp(options: {
    path: string;
    server: McpServerCommand;
    now?: Date;
}): Promise<McpChange> {
    const { path, server } = options;
    const block = codexMcpBlock(server);
    const current = await readIfExists(path);
    const begin = current?.indexOf(CODEX_MCP_BEGIN) ?? -1;
    const end = current?.indexOf(CODEX_MCP_END) ?? -1;

    let content: string;
    if (current !== null && begin !== -1 && end > begin) {
        const after = current.indexOf('\n', end);
        content = `${current.slice(0, begin)}${block}${after === -1 ? '' : current.slice(after + 1)}`;
        if (content === current) return { path, change: 'unchanged' };
    } else if (current !== null && /^\s*\[mcp_servers\.palmtop[\].]/m.test(current)) {
        return {
            path,
            change: 'skipped',
            reason: '[mcp_servers.palmtop] is already in config.toml, written by hand: left as it is',
        };
    } else {
        const separator =
            current === null || current === '' ? '' : current.endsWith('\n') ? '\n' : '\n\n';
        content = `${current ?? ''}${separator}${block}`;
    }

    await mkdir(dirname(path), { recursive: true });
    const backup =
        current === null
            ? undefined
            : await backupFile(path, backupSuffix(options.now ?? new Date()));
    await writeAtomic(path, content);
    return {
        path,
        change: current === null ? 'created' : 'updated',
        via: 'file',
        ...(backup && { backup }),
    };
}
