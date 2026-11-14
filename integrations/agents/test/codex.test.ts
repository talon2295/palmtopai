import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { AGENT_GUIDE, GUIDE_COMMANDS, GUIDE_TOOLS } from '@palmtopai/agent-guide';
import {
    CODEX_RULES_CONTENT,
    CODEX_SKILL_CONTENT,
    CODEX_SKILL_ICON,
    CODEX_SKILL_INTERFACE,
    codexHomeDir,
    codexSkillPath,
    installCodex,
    SKILL_DESCRIPTION,
} from '../src';

let homeDir: string;
let codexHome: string;
const now = new Date(2026, 8, 24, 10, 15, 0);

beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'palmtop-codex-'));
    codexHome = join(homeDir, '.codex');
});

afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
});

const skillDir = () => join(homeDir, '.agents', 'skills', 'palmtop');
const rulesPath = () => join(codexHome, 'rules', 'palmtop.rules');

describe('installCodex', () => {
    test('creates the skill in ~/.agents/skills and the rules in CODEX_HOME', async () => {
        const result = await installCodex({ homeDir, codexHome, now });
        expect(result).toEqual({
            skill: [
                { path: join(skillDir(), 'SKILL.md'), change: 'created' },
                { path: join(skillDir(), 'agents', 'openai.yaml'), change: 'created' },
                { path: join(skillDir(), 'assets', 'icon.svg'), change: 'created' },
            ],
            rules: { path: rulesPath(), change: 'created' },
        });
        expect(codexSkillPath(homeDir)).toBe(join(skillDir(), 'SKILL.md'));
        expect(await readFile(join(skillDir(), 'SKILL.md'), 'utf8')).toBe(CODEX_SKILL_CONTENT);
        expect(await readFile(join(skillDir(), 'agents', 'openai.yaml'), 'utf8')).toBe(
            CODEX_SKILL_INTERFACE,
        );
        expect(await readFile(join(skillDir(), 'assets', 'icon.svg'), 'utf8')).toBe(
            CODEX_SKILL_ICON,
        );
        expect(await readFile(rulesPath(), 'utf8')).toBe(CODEX_RULES_CONTENT);
    });

    test('is idempotent: a second run changes nothing and makes no backup', async () => {
        await installCodex({ homeDir, codexHome, now });
        const second = await installCodex({ homeDir, codexHome, now });
        expect([...second.skill, second.rules].map((file) => file.change)).toEqual([
            'unchanged',
            'unchanged',
            'unchanged',
            'unchanged',
        ]);
        expect((await readdir(skillDir())).sort()).toEqual(['SKILL.md', 'agents', 'assets']);
        expect(await readdir(join(codexHome, 'rules'))).toEqual(['palmtop.rules']);
    });

    test('leaves the other rules alone and backs up a modified palmtop file', async () => {
        await mkdir(join(codexHome, 'rules'), { recursive: true });
        const defaultRules = 'prefix_rule(pattern = ["git", "status"], decision = "allow")\n';
        await writeFile(join(codexHome, 'rules', 'default.rules'), defaultRules);
        await writeFile(rulesPath(), '# my edits\n');

        const result = await installCodex({ homeDir, codexHome, now });
        const backup = `${rulesPath()}.palmtop-backup-20260924-101500`;
        expect(result.rules).toEqual({ path: rulesPath(), change: 'updated', backup });
        expect(await readFile(backup, 'utf8')).toBe('# my edits\n');
        expect(await readFile(join(codexHome, 'rules', 'default.rules'), 'utf8')).toBe(
            defaultRules,
        );
    });

    test('the config dir follows CODEX_HOME', () => {
        expect(codexHomeDir({ CODEX_HOME: '/custom/codex' })).toBe('/custom/codex');
        expect(codexHomeDir({})).toEndWith(`${sep}.codex`);
    });
});

describe('skill', () => {
    test('has the frontmatter Codex reads and documents every agent command', () => {
        const frontmatter = CODEX_SKILL_CONTENT.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
        expect(frontmatter.split('\n')).toEqual([
            'name: palmtop',
            `description: ${SKILL_DESCRIPTION}`,
        ]);
        // Codex rejects descriptions over 1024 characters.
        expect(SKILL_DESCRIPTION.length).toBeLessThanOrEqual(1024);
        expect(CODEX_SKILL_CONTENT).not.toContain('$ARGUMENTS');
        expect(CODEX_SKILL_CONTENT).toEndWith(AGENT_GUIDE);
        for (const tool of GUIDE_TOOLS) expect(CODEX_SKILL_CONTENT).toContain(tool);
        for (const command of GUIDE_COMMANDS) expect(CODEX_SKILL_CONTENT).toContain(command);
    });

    test('the interface points to the icon under assets/ with a #RRGGBB color', () => {
        expect(CODEX_SKILL_INTERFACE).toContain('icon_small: "./assets/icon.svg"');
        expect(CODEX_SKILL_INTERFACE).toMatch(/brand_color: "#[0-9A-F]{6}"/);
        expect(CODEX_SKILL_ICON).toStartWith('<svg');
    });

    test('the rules allow every palmtop command', () => {
        expect(CODEX_RULES_CONTENT).toContain('pattern = ["palmtop"]');
        expect(CODEX_RULES_CONTENT).toContain('decision = "allow"');
    });
});
