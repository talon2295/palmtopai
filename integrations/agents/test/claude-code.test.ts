import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { AGENT_GUIDE, GUIDE_COMMANDS, GUIDE_TOOLS } from '@palmtopai/agent-guide';
import {
    CLAUDE_MCP_RULE,
    CLAUDE_PERMISSION_RULE,
    CLAUDE_SKILL_CONTENT,
    claudeConfigDir,
    InstallError,
    installClaudeCode,
} from '../src';

let claudeDir: string;
const now = new Date(2026, 8, 14, 18, 30, 5);

beforeEach(async () => {
    claudeDir = await mkdtemp(join(tmpdir(), 'palmtop-claude-'));
});

afterEach(async () => {
    await rm(claudeDir, { recursive: true, force: true });
});

const settingsPath = () => join(claudeDir, 'settings.json');
const skillPath = () => join(claudeDir, 'skills', 'palmtop', 'SKILL.md');

describe('install', () => {
    test('into an empty config dir creates the skill and the settings', async () => {
        const result = await installClaudeCode({ claudeDir, now });
        expect(result).toEqual({
            skill: { path: skillPath(), change: 'created' },
            settings: { path: settingsPath(), change: 'created' },
            permissions: [CLAUDE_MCP_RULE, CLAUDE_PERMISSION_RULE],
        });
        expect(await readFile(skillPath(), 'utf8')).toBe(CLAUDE_SKILL_CONTENT);
        expect(JSON.parse(await readFile(settingsPath(), 'utf8'))).toEqual({
            permissions: { allow: [CLAUDE_MCP_RULE, CLAUDE_PERMISSION_RULE] },
        });
        expect(await readFile(settingsPath(), 'utf8')).toStartWith('{\n    "permissions"');
    });

    test('is idempotent: a second run changes nothing and makes no backup', async () => {
        await installClaudeCode({ claudeDir, now });
        const settings = await readFile(settingsPath(), 'utf8');
        expect(await installClaudeCode({ claudeDir, now })).toEqual({
            skill: { path: skillPath(), change: 'unchanged' },
            settings: { path: settingsPath(), change: 'unchanged' },
            permissions: [],
        });
        expect(await readFile(settingsPath(), 'utf8')).toBe(settings);
        expect((await readdir(claudeDir)).sort()).toEqual(['settings.json', 'skills']);
        expect(await readdir(join(claudeDir, 'skills', 'palmtop'))).toEqual(['SKILL.md']);
    });

    test('keeps existing settings, their order and indentation, and backs them up', async () => {
        const original = `{\n  "model": "opus",\n  "permissions": {\n    "allow": ["Bash(git status)"],\n    "deny": ["Bash(rm *)"]\n  },\n  "theme": "dark"\n}\n`;
        await writeFile(settingsPath(), original);
        await chmod(settingsPath(), 0o600);

        const result = await installClaudeCode({ claudeDir, now });
        const backup = `${settingsPath()}.palmtop-backup-20260914-183005`;
        expect(result.settings).toEqual({ path: settingsPath(), change: 'updated', backup });
        expect(await readFile(backup, 'utf8')).toBe(original);

        const written = await readFile(settingsPath(), 'utf8');
        expect(JSON.parse(written)).toEqual({
            model: 'opus',
            permissions: {
                allow: ['Bash(git status)', CLAUDE_MCP_RULE, CLAUDE_PERMISSION_RULE],
                deny: ['Bash(rm *)'],
            },
            theme: 'dark',
        });
        expect(Object.keys(JSON.parse(written))).toEqual(['model', 'permissions', 'theme']);
        expect(written).toStartWith('{\n  "model"');
        // Windows has no permission bits.
        if (process.platform !== 'win32') {
            expect((await stat(settingsPath())).mode & 0o777).toBe(0o600);
        }
    });

    test('equivalent rules already present are left alone', async () => {
        const original = '{"permissions":{"allow":["Bash(palmtop:*)","mcp__palmtop__*"]}}';
        await writeFile(settingsPath(), original);
        const result = await installClaudeCode({ claudeDir, now });
        expect(result.settings.change).toBe('unchanged');
        expect(result.permissions).toEqual([]);
        expect(await readFile(settingsPath(), 'utf8')).toBe(original);
    });

    test('adds only the rule that is missing', async () => {
        await writeFile(settingsPath(), '{"permissions":{"allow":["Bash(palmtop *)"]}}');
        const result = await installClaudeCode({ claudeDir, now });
        expect(result.permissions).toEqual([CLAUDE_MCP_RULE]);
        expect(JSON.parse(await readFile(settingsPath(), 'utf8')).permissions.allow).toEqual([
            CLAUDE_PERMISSION_RULE,
            CLAUDE_MCP_RULE,
        ]);
    });

    test('a modified skill is backed up before being replaced', async () => {
        await mkdir(join(claudeDir, 'skills', 'palmtop'), { recursive: true });
        await writeFile(skillPath(), 'my local edits');
        const first = await installClaudeCode({ claudeDir, now });
        expect(first.skill.change).toBe('updated');
        expect(await readFile(first.skill.backup as string, 'utf8')).toBe('my local edits');

        // Same second: backups never overwrite each other.
        await writeFile(skillPath(), 'edited again');
        const second = await installClaudeCode({ claudeDir, now });
        expect(second.skill.backup).toBe(`${first.skill.backup}-2`);
        expect(await readFile(second.skill.backup as string, 'utf8')).toBe('edited again');
    });

    test.each([
        ['invalid JSON', '{"permissions": ', 'is not valid JSON'],
        ['a JSON array', '[]', 'does not contain a JSON object'],
        ['permissions not an object', '{"permissions": true}', '"permissions" in'],
        ['allow not an array', '{"permissions": {"allow": "Bash"}}', '"permissions.allow" in'],
    ])('refuses to touch settings with %s', async (_label, content, message) => {
        await writeFile(settingsPath(), content);
        const error = await installClaudeCode({ claudeDir, now }).catch((caught) => caught);
        expect(error).toBeInstanceOf(InstallError);
        expect((error as Error).message).toContain(message);
        expect(await readFile(settingsPath(), 'utf8')).toBe(content);
        expect(await readdir(claudeDir)).toEqual(['settings.json']);
    });

    test('the config dir follows CLAUDE_CONFIG_DIR', () => {
        expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/custom/claude' })).toBe('/custom/claude');
        expect(claudeConfigDir({})).toEndWith(`${sep}.claude`);
    });
});

describe('skill', () => {
    test('has the frontmatter Claude Code needs and documents every agent command', async () => {
        const skill = CLAUDE_SKILL_CONTENT;
        const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
        expect(frontmatter).toContain('name: palmtop');
        expect(frontmatter).toMatch(/^description: .{50,1500}$/m);
        expect(frontmatter).toContain(
            `allowed-tools: ${CLAUDE_MCP_RULE} ${CLAUDE_PERMISSION_RULE}`,
        );
        expect(frontmatter).toContain('argument-hint:');
        for (const tool of GUIDE_TOOLS) expect(skill).toContain(tool);
        for (const command of GUIDE_COMMANDS) expect(skill).toContain(command);
        // The body is the agent-neutral guide, plus the title passed to /palmtop.
        expect(skill).toEndWith(AGENT_GUIDE);
        expect(skill).toContain('"$ARGUMENTS"');
    });
});
