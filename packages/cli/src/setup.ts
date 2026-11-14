import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import {
    backupFile,
    type ClaudeRunner,
    claudeConfigDir,
    claudeJsonPath,
    codexHomeDir,
    type FileChange,
    InstallError,
    installClaudeCode,
    installCodex,
    type McpChange,
    type McpServerCommand,
} from '@palmtopai/agents';
import { CliError } from './daemon-client';

export type AgentId = 'claude' | 'codex';

export interface AgentInfo {
    id: AgentId;
    label: string;
    /** Configuration directory of the agent. */
    dir: string;
    /** Its command is on the PATH, or it has used its configuration directory. */
    found: boolean;
}

/**
 * The home folder of the user. On Windows `HOME` is not the folder (Git Bash sets it to an
 * `/c/Users/ada` that Node cannot open): there it is `USERPROFILE`.
 */
export function userHome(
    env: Record<string, string | undefined>,
    platform: NodeJS.Platform = process.platform,
): string {
    return (platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir();
}

/** Tilde form of a path under the home, for messages. */
export function tilde(path: string, env: Record<string, string | undefined>): string {
    const rel = relative(userHome(env), path);
    return rel === '' ? '~' : rel.startsWith('..') || isAbsolute(rel) ? path : `~/${rel}`;
}

/**
 * The first executable `command` in the folders of `path`, or null. On Windows a command is also
 * its name with one of the extensions of PATHEXT (`claude.exe`, `codex.cmd`).
 */
export function findOnPath(
    command: string,
    path: string,
    options: { platform?: NodeJS.Platform; pathext?: string } = {},
): string | null {
    const platform = options.platform ?? process.platform;
    const names =
        platform === 'win32'
            ? [
                  command,
                  ...(options.pathext ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
                      .split(';')
                      .filter(Boolean)
                      .map((extension) => `${command}${extension.toLowerCase()}`),
              ]
            : [command];
    for (const dir of path.split(delimiter).filter(Boolean)) {
        for (const name of names) {
            const candidate = join(dir, name);
            try {
                // Windows has no execute bit: a file with the right name is the command.
                if (platform === 'win32') {
                    if (statSync(candidate).isFile()) return candidate;
                } else {
                    accessSync(candidate, constants.X_OK);
                    return candidate;
                }
            } catch {
                // Not here.
            }
        }
    }
    return null;
}

/** Whether an executable `command` is in one of the folders of `path`. */
export function onPath(
    command: string,
    path: string,
    options: { platform?: NodeJS.Platform; pathext?: string } = {},
): boolean {
    return findOnPath(command, path, options) !== null;
}

/**
 * How an agent starts `palmtop mcp`: the `node` of the PATH and the bundle that is running, both
 * absolute (Claude Code and Codex start it without a shell). Null when palmtop runs from the
 * sources: there is no bundle to point to.
 */
export function mcpServerFor(
    entry: string,
    env: Record<string, string | undefined>,
): McpServerCommand | null {
    let bundle: string;
    try {
        bundle = realpathSync(entry);
    } catch {
        return null;
    }
    if (!/\.(mjs|cjs|js)$/.test(bundle)) return null;
    const node =
        findOnPath('node', env.PATH ?? '') ??
        (basename(process.execPath).toLowerCase().startsWith('node') ? process.execPath : null);
    return node ? { command: node, args: [bundle, 'mcp'] } : null;
}

/** Runs the `claude` of the PATH (`claude mcp add`); null if there is none or it cannot start. */
export function claudeRunner(env: Record<string, string | undefined>): ClaudeRunner {
    const command = findOnPath('claude', env.PATH ?? '');
    if (!command) return async () => null;
    return (args) =>
        new Promise((resolve) => {
            const child = spawn(command, args, { env, stdio: 'ignore', timeout: 20_000 });
            child.once('error', () => resolve(null));
            child.once('close', (code) => resolve({ code: code ?? 1 }));
        });
}

/**
 * Files Codex writes once it has been used. Its folder alone is not enough: other tools (and
 * palmtop's own rules file) can create it on a computer without Codex.
 */
const CODEX_MARKERS = ['auth.json', 'config.toml', 'sessions'];

export function agentsOnThisComputer(env: Record<string, string | undefined>): AgentInfo[] {
    const path = env.PATH ?? '';
    const claude = claudeConfigDir(env);
    const codex = codexHomeDir(env);
    return [
        {
            id: 'claude',
            label: 'Claude Code',
            dir: claude,
            found: existsSync(claude) || onPath('claude', path),
        },
        {
            id: 'codex',
            label: 'Codex',
            dir: codex,
            found:
                onPath('codex', path) ||
                CODEX_MARKERS.some((marker) => existsSync(join(codex, marker))),
        },
    ];
}

/**
 * Without asking: the agents found on this computer. `force` (`--force-agents-install`) takes
 * every agent, also those not installed yet.
 */
export function defaultAgents(agents: AgentInfo[], force = false): AgentId[] {
    return agents.filter((agent) => force || agent.found).map((agent) => agent.id);
}

export interface AgentInstall {
    id: AgentId;
    label: string;
    /** Whether anything was written. */
    changed: boolean;
    /** What was done, one line each. */
    details: string[];
    /** How to start using palmtop with this agent. */
    usage: string;
    result: unknown;
}

const backupNote = (path?: string) => (path ? ` (backup: ${path})` : '');

function describe(label: string, file: FileChange): string {
    return file.change === 'unchanged'
        ? `${label} already up to date: ${file.path}`
        : `${label} ${file.change}: ${file.path}${backupNote(file.backup)}`;
}

function describeMcp(mcp: McpChange | undefined): string {
    if (!mcp) {
        return 'MCP server not registered: palmtop is not running from an installed bundle (run `bun run build:cli` and use that one)';
    }
    if (mcp.change === 'skipped') return `MCP server: ${mcp.reason}`;
    if (mcp.change === 'unchanged') return `MCP server already registered: ${mcp.path}`;
    const how = mcp.via === 'claude' ? ' with claude mcp add' : '';
    return `MCP server ${mcp.change}${how}: ${mcp.path}${backupNote(mcp.backup)}`;
}

/**
 * Installs the palmtop skill, the permissions and the MCP server for each agent. Idempotent, with
 * backups. `entry` is the script of this CLI: the MCP server runs it as `palmtop mcp`.
 */
export async function installAgents(
    ids: AgentId[],
    env: Record<string, string | undefined>,
    entry: string,
): Promise<AgentInstall[]> {
    const installs: AgentInstall[] = [];
    const server = mcpServerFor(entry, env);
    try {
        if (ids.includes('claude')) {
            const result = await installClaudeCode({
                claudeDir: claudeConfigDir(env),
                ...(server && {
                    mcp: {
                        server,
                        claudeJson: claudeJsonPath(env, userHome(env)),
                        run: claudeRunner(env),
                    },
                }),
            });
            const { skill, settings, permissions, mcp } = result;
            installs.push({
                id: 'claude',
                label: 'Claude Code',
                changed:
                    skill.change !== 'unchanged' ||
                    settings.change !== 'unchanged' ||
                    (mcp !== undefined && !['unchanged', 'skipped'].includes(mcp.change)),
                details: [
                    describe('Skill', skill),
                    permissions.length === 0
                        ? `Permissions already allowed in ${settings.path}`
                        : `Permissions ${permissions.map((rule) => `"${rule}"`).join(', ')} added to ${settings.path}${backupNote(settings.backup)}`,
                    describeMcp(mcp),
                ],
                usage: 'New Claude Code sessions load the skill and the palmtop tools (restart Claude Code if it is open): ask Claude to use palmtop, or type /palmtop.',
                result,
            });
        }
        if (ids.includes('codex')) {
            const result = await installCodex({
                homeDir: userHome(env),
                codexHome: codexHomeDir(env),
                ...(server && { mcp: server }),
            });
            // SKILL.md, its interface file and its icon, shown as one skill folder.
            const [main] = result.skill as [FileChange];
            const skillChanged = result.skill.some((file) => file.change !== 'unchanged');
            const backups = result.skill.flatMap((file) => (file.backup ? [file.backup] : []));
            const skill: FileChange = {
                path: dirname(main.path),
                change: !skillChanged
                    ? 'unchanged'
                    : main.change === 'created'
                      ? 'created'
                      : 'updated',
                ...(backups.length > 0 && { backup: backups.join(', ') }),
            };
            installs.push({
                id: 'codex',
                label: 'Codex',
                changed:
                    skillChanged ||
                    result.rules.change !== 'unchanged' ||
                    (result.mcp !== undefined &&
                        !['unchanged', 'skipped'].includes(result.mcp.change)),
                details: [
                    describe('Skill', skill),
                    describe('Rules', result.rules),
                    describeMcp(result.mcp),
                ],
                usage: 'New Codex sessions load the skill and the palmtop tools: ask Codex to use palmtop, or type $palmtop.',
                result,
            });
        }
    } catch (error) {
        if (error instanceof InstallError) throw new CliError(error.message);
        throw error;
    }
    return installs;
}

/** The shell file that puts palmtop on the PATH, and the line it needs. */
export interface ShellProfile {
    shell: string;
    file: string;
    line: string;
}

/** The profile of the user's shell (`$SHELL`), or null for shells palmtop doesn't know. */
export function shellProfile(
    binDir: string,
    env: Record<string, string | undefined>,
    platform: NodeJS.Platform = process.platform,
): ShellProfile | null {
    const home = userHome(env, platform);
    const shell = basename(env.SHELL ?? '');
    // `$HOME/...` keeps the line valid if the home moves; other paths are written as they are.
    const rel = relative(home, binDir).split(sep).join('/');
    const dir = rel && !rel.startsWith('..') && !isAbsolute(rel) ? `$HOME/${rel}` : binDir;
    const exportLine = `export PATH="${dir}:$PATH"`;
    // The profiles are files of a POSIX shell: written with `/` whatever the system running this.
    switch (shell) {
        case 'zsh':
            return { shell, file: posix.join(env.ZDOTDIR || home, '.zshrc'), line: exportLine };
        case 'bash':
            return {
                shell,
                file: posix.join(home, platform === 'darwin' ? '.bash_profile' : '.bashrc'),
                line: exportLine,
            };
        case 'fish':
            return {
                shell,
                file: posix.join(home, '.config', 'fish', 'conf.d', 'palmtop.fish'),
                line: `fish_add_path ${dir}`,
            };
        default:
            return null;
    }
}

/**
 * Adds the PATH line to the shell profile, unless it is already there. The file is backed up
 * first; the line goes at the end, after a `# palmtop` comment.
 */
export async function addToPath(
    profile: ShellProfile,
    suffix: string,
): Promise<{ change: 'created' | 'updated' | 'unchanged'; backup?: string }> {
    let current: string | null = null;
    try {
        current = await readFile(profile.file, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (current?.split('\n').some((line) => line.trim() === profile.line)) {
        return { change: 'unchanged' };
    }
    await mkdir(dirname(profile.file), { recursive: true });
    const backup = current === null ? undefined : await backupFile(profile.file, suffix);
    const separator = current === null || current === '' || current.endsWith('\n') ? '' : '\n';
    await appendFile(profile.file, `${separator}\n# palmtop\n${profile.line}\n`);
    return { change: current === null ? 'created' : 'updated', ...(backup && { backup }) };
}

/** A question from `palmtop setup`, answered by a person; null means they cancelled. */
export interface SetupUi {
    intro(title: string): void;
    step(message: string): void;
    success(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    confirm(message: string, initial: boolean): Promise<boolean | null>;
    multiselect<V extends string>(
        message: string,
        options: { value: V; label: string; hint?: string; disabled?: boolean }[],
        initial: V[],
    ): Promise<V[] | null>;
    spinner(): { start(message: string): void; stop(message: string): void };
    outro(message: string): void;
    cancel(message: string): void;
}
