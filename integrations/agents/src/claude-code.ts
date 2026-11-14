import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AGENT_GUIDE } from '@palmtopai/agent-guide';
import {
    backupFile,
    backupSuffix,
    type FileChange,
    readIfExists,
    writeAtomic,
    writeOwnedFile,
} from './files';
import { type ClaudeRunner, installClaudeMcp, type McpChange, type McpServerCommand } from './mcp';
import { InstallError, SKILL_DESCRIPTION } from './skill';

/** The rule written to `permissions.allow` for the `palmtop` command. */
export const CLAUDE_PERMISSION_RULE = 'Bash(palmtop *)';
/** The rule for the tools of the palmtop MCP server (`mcp__<server>`: every tool of it). */
export const CLAUDE_MCP_RULE = 'mcp__palmtop';
/** Rules that already allow every `palmtop` command (`:*` is the legacy spelling). */
const EQUIVALENT_RULES = new Set([CLAUDE_PERMISSION_RULE, 'Bash(palmtop:*)']);
const EQUIVALENT_MCP_RULES = new Set([CLAUDE_MCP_RULE, `${CLAUDE_MCP_RULE}__*`]);

const CLAUDE_SKILL_FRONTMATTER = `---
name: palmtop
description: ${SKILL_DESCRIPTION}
argument-hint: "[session title]"
allowed-tools: ${CLAUDE_MCP_RULE} ${CLAUDE_PERMISSION_RULE}
---
`;

/**
 * The Claude Code skill: frontmatter, the session title typed after `/palmtop`, and the same
 * guide every other agent reads with `palmtop guide`.
 */
export const CLAUDE_SKILL_CONTENT = `${CLAUDE_SKILL_FRONTMATTER}
Session title given by the user after /palmtop, if any: "$ARGUMENTS".

${AGENT_GUIDE}`;

/** Claude Code's configuration directory: `$CLAUDE_CONFIG_DIR`, or `~/.claude`. */
export function claudeConfigDir(env: Record<string, string | undefined>): string {
    return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/** The configuration file with the MCP servers of the user: `$CLAUDE_CONFIG_DIR/.claude.json` or `~/.claude.json`. */
export { claudeJsonPath } from './mcp';

export interface ClaudeCodeInstallOptions {
    claudeDir: string;
    now?: Date;
    /** Registers the palmtop MCP server: how to start it, and where Claude Code keeps its servers. */
    mcp?: { server: McpServerCommand; claudeJson: string; run?: ClaudeRunner };
}

export interface ClaudeCodeInstallResult {
    skill: FileChange;
    settings: FileChange;
    /** The rules this run added to `permissions.allow`. */
    permissions: string[];
    /** Only when `mcp` was asked for. */
    mcp?: McpChange;
}

/**
 * Installs the `palmtop` skill, allows the palmtop tools and commands in the user settings of
 * Claude Code and registers the MCP server. Idempotent: a second run changes nothing. Files that
 * are modified are backed up first.
 */
export async function installClaudeCode(
    options: ClaudeCodeInstallOptions,
): Promise<ClaudeCodeInstallResult> {
    const suffix = backupSuffix(options.now ?? new Date());
    // Settings are validated before anything is written: an invalid file leaves no partial install.
    const settings = await planSettings(options.claudeDir);
    const skill = await installSkill(options.claudeDir, suffix);
    const result: ClaudeCodeInstallResult = {
        skill,
        settings: await settings.apply(suffix),
        permissions: settings.added,
    };
    if (options.mcp) {
        result.mcp = await installClaudeMcp({
            path: options.mcp.claudeJson,
            server: options.mcp.server,
            ...(options.mcp.run && { run: options.mcp.run }),
            ...(options.now && { now: options.now }),
        });
    }
    return result;
}

function installSkill(claudeDir: string, suffix: string): Promise<FileChange> {
    return writeOwnedFile(
        join(claudeDir, 'skills', 'palmtop', 'SKILL.md'),
        CLAUDE_SKILL_CONTENT,
        suffix,
    );
}

async function planSettings(claudeDir: string): Promise<{
    added: string[];
    apply: (suffix: string) => Promise<ClaudeCodeInstallResult['settings']>;
}> {
    const path = join(claudeDir, 'settings.json');
    const current = await readIfExists(path);

    let settings: Record<string, unknown> = {};
    if (current !== null && current.trim() !== '') {
        try {
            settings = JSON.parse(current);
        } catch {
            throw new InstallError(`${path} is not valid JSON: fix it, then run install again`);
        }
        if (!isObject(settings)) throw new InstallError(`${path} does not contain a JSON object`);
    }

    const permissions = settings.permissions ?? {};
    if (!isObject(permissions)) throw new InstallError(`"permissions" in ${path} is not an object`);
    const allow = permissions.allow ?? [];
    if (!Array.isArray(allow)) {
        throw new InstallError(`"permissions.allow" in ${path} is not an array`);
    }
    const added = [
        ...(allow.some((rule) => EQUIVALENT_MCP_RULES.has(rule)) ? [] : [CLAUDE_MCP_RULE]),
        ...(allow.some((rule) => EQUIVALENT_RULES.has(rule)) ? [] : [CLAUDE_PERMISSION_RULE]),
    ];
    if (added.length === 0) {
        return { added, apply: async () => ({ path, change: 'unchanged' }) };
    }

    const updated = {
        ...settings,
        permissions: { ...permissions, allow: [...allow, ...added] },
    };
    return {
        added,
        apply: async (suffix) => {
            await mkdir(dirname(path), { recursive: true });
            const backup = current === null ? undefined : await backupFile(path, suffix);
            await writeAtomic(path, `${JSON.stringify(updated, null, indentOf(current))}\n`);
            return {
                path,
                change: current === null ? 'created' : 'updated',
                ...(backup && { backup }),
            };
        },
    };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keeps the indentation of an existing file; new files use 4 spaces. */
function indentOf(content: string | null): string {
    const match = content?.match(/^[{[]\s*\n([ \t]+)\S/);
    return match?.[1] ?? '    ';
}
