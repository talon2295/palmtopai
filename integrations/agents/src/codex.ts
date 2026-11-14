import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGENT_GUIDE } from '@palmtopai/agent-guide';
import { backupSuffix, type FileChange, writeOwnedFile } from './files';
import { installCodexMcp, type McpChange, type McpServerCommand } from './mcp';
import { SKILL_DESCRIPTION } from './skill';

/**
 * The Codex skill: frontmatter and the same guide every other agent reads with `palmtop guide`.
 * Codex has no argument placeholder: whatever the user typed after `$palmtop` is in their message.
 */
export const CODEX_SKILL_CONTENT = `---
name: palmtop
description: ${SKILL_DESCRIPTION}
---

If the user gave a session title when asking for palmtop, use it for \`session_start\`.

${AGENT_GUIDE}`;

/** Name, icon and color of the skill in the Codex interface (`agents/openai.yaml`). */
export const CODEX_SKILL_INTERFACE = `interface:
  display_name: "palmtop"
  short_description: "Put checks on your devices and read the review"
  icon_small: "./assets/icon.svg"
  brand_color: "#34D399"
  default_prompt: "Put the checks of this work on palmtop."
`;

/** The palmtop logo, as on the site. */
export const CODEX_SKILL_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><title>PalmtopAI</title><rect width="64" height="64" rx="14" fill="#0b0d12"/><path d="M18 33l9 9 19-20" fill="none" stroke="#34d399" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>
`;

/**
 * Lets Codex run `palmtop` without asking. Allowed commands run outside the sandbox, which
 * `palmtop` needs to reach the daemon on 127.0.0.1 and start it.
 */
export const CODEX_RULES_CONTENT = `# Installed by palmtop (palmtop setup): lets Codex run palmtop commands without asking.
prefix_rule(
    pattern = ["palmtop"],
    decision = "allow",
    justification = "palmtop puts checks on the user's devices and reads their review",
)
`;

/** Codex's configuration directory: `$CODEX_HOME`, or `~/.codex`. */
export function codexHomeDir(env: Record<string, string | undefined>): string {
    return env.CODEX_HOME || join(homedir(), '.codex');
}

export interface CodexInstallOptions {
    /** The user's home: Codex reads user skills from `~/.agents/skills`, not from `$CODEX_HOME`. */
    homeDir: string;
    codexHome: string;
    now?: Date;
    /** Registers the palmtop MCP server in `$CODEX_HOME/config.toml`. */
    mcp?: McpServerCommand;
}

export interface CodexInstallResult {
    /** `SKILL.md`, `agents/openai.yaml`, `assets/icon.svg`. */
    skill: FileChange[];
    rules: FileChange;
    /** Only when `mcp` was asked for. */
    mcp?: McpChange;
}

/** Where Codex finds the palmtop skill. */
export function codexSkillPath(homeDir: string): string {
    return join(homeDir, '.agents', 'skills', 'palmtop', 'SKILL.md');
}

/**
 * Installs the `palmtop` skill in `~/.agents/skills/palmtop`, a rules file that allows
 * `palmtop` commands in `$CODEX_HOME/rules/palmtop.rules` and the MCP server in `config.toml`. Idempotent; changed files are backed
 * up first.
 */
export async function installCodex(options: CodexInstallOptions): Promise<CodexInstallResult> {
    const suffix = backupSuffix(options.now ?? new Date());
    const dir = join(options.homeDir, '.agents', 'skills', 'palmtop');
    const skill = [
        await writeOwnedFile(codexSkillPath(options.homeDir), CODEX_SKILL_CONTENT, suffix),
        await writeOwnedFile(join(dir, 'agents', 'openai.yaml'), CODEX_SKILL_INTERFACE, suffix),
        await writeOwnedFile(join(dir, 'assets', 'icon.svg'), CODEX_SKILL_ICON, suffix),
    ];
    const rules = await writeOwnedFile(
        join(options.codexHome, 'rules', 'palmtop.rules'),
        CODEX_RULES_CONTENT,
        suffix,
    );
    const mcp =
        options.mcp &&
        (await installCodexMcp({
            path: join(options.codexHome, 'config.toml'),
            server: options.mcp,
            ...(options.now && { now: options.now }),
        }));
    return { skill, rules, ...(mcp && { mcp }) };
}
