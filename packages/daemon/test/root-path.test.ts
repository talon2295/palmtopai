import { describe, expect, test } from 'bun:test';
import { MemoryStorage, ProjectRegistry } from '../src';
import { normalizeRoot, rootKey, rootName, sameRoot } from '../src/root-path';
import { createTempHome } from './helpers';

describe('folders of projects on Windows', () => {
    test('a path is written with backslashes and no separator at the end', () => {
        expect(normalizeRoot('C:\\Users\\Ada\\Repo\\', 'win32')).toBe('C:\\Users\\Ada\\Repo');
        // Git reports forward slashes.
        expect(normalizeRoot('C:/Users/Ada/Repo', 'win32')).toBe('C:\\Users\\Ada\\Repo');
        expect(normalizeRoot('C:/Users/Ada/Repo//', 'win32')).toBe('C:\\Users\\Ada\\Repo');
        expect(normalizeRoot('C:\\Users\\Ada\\..\\Bob\\Repo', 'win32')).toBe(
            'C:\\Users\\Bob\\Repo',
        );
    });

    test('a drive keeps its separator', () => {
        expect(normalizeRoot('C:\\', 'win32')).toBe('C:\\');
        expect(normalizeRoot('C:/', 'win32')).toBe('C:\\');
        expect(normalizeRoot('/', 'linux')).toBe('/');
    });

    test('the case of names does not tell two folders apart, the drive letter either', () => {
        expect(sameRoot('C:\\Work\\Repo', 'c:/work/repo/', 'win32')).toBe(true);
        expect(sameRoot('C:\\Work\\Repo', 'C:\\Work\\Other', 'win32')).toBe(false);
        expect(rootKey('C:\\Work\\Repo', 'win32')).toBe('c:\\work\\repo');
    });

    test('macOS and Linux compare folders as they are, and keep a backslash in a name', () => {
        expect(sameRoot('/work/Repo', '/work/repo', 'linux')).toBe(false);
        expect(sameRoot('/work/repo/', '/work/repo', 'linux')).toBe(true);
        expect(rootName('/work/we\\ird', 'linux')).toBe('we\\ird');
    });

    test('the name of a project is the last folder', () => {
        expect(rootName('C:\\Users\\Ada\\My Repo', 'win32')).toBe('My Repo');
        expect(rootName('C:\\', 'win32')).toBe('C:\\');
    });
});

describe('ProjectRegistry on Windows', () => {
    test('one project per folder whatever the case or the separators, shown as first given', async () => {
        const { home, cleanup } = await createTempHome();
        try {
            const registry = await ProjectRegistry.open(
                `${home}/projects.json`,
                new MemoryStorage(),
                'win32',
            );
            const first = await registry.resolve({ rootPath: 'C:\\Work\\Repo\\' });
            const again = await registry.resolve({ rootPath: 'c:/work/repo' });
            const other = await registry.resolve({ rootPath: 'C:\\Work\\Other' });
            expect(first).toEqual({ projectId: first.projectId, name: 'Repo', created: true });
            expect(again).toEqual({ ...first, created: false });
            expect(other.projectId).not.toBe(first.projectId);
            expect(await registry.find('C:/WORK/REPO')).toEqual({ ...first, created: false });
            expect(registry.info(first.projectId)?.rootPath).toBe('C:\\Work\\Repo');

            const reopened = await ProjectRegistry.open(
                `${home}/projects.json`,
                new MemoryStorage(),
                'win32',
            );
            expect((await reopened.resolve({ rootPath: 'c:\\WORK\\repo\\' })).projectId).toBe(
                first.projectId,
            );
        } finally {
            await cleanup();
        }
    });
});
