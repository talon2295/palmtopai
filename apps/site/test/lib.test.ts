import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNoInlineScripts, findInlineScripts } from '../build/inline-scripts';
import { bindCopyCode } from '../src/lib/copy-code';
import { docsNavigation, newestVersionFirst } from '../src/lib/docs';
import { bindFeedbackForm, feedbackResultText } from '../src/lib/feedback';
import {
    applyInstallSystem,
    bindInstallChooser,
    detectInstallSystem,
    INSTALL_SYSTEM_KEY,
    parseInstallSystem,
} from '../src/lib/install';
import { landingRedirect } from '../src/lib/landing';
import { bindNavMenu } from '../src/lib/nav-menu';
import { canonicalUrl, robotsTxt, sitemapXml } from '../src/lib/seo';
import { INSTALL_COMMAND, INSTALL_COMMANDS, REPO_URL, SITE_URL } from '../src/lib/site';
import { applyTheme, parseThemePreference, THEME_KEY } from '../src/lib/theme';

const ROOM = 'R1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0u_-';

describe('landing page', () => {
    test('old join links on the landing page go to the app, fragment included', () => {
        expect(landingRedirect({ pathname: '/', hash: `#join?r=${ROOM}&p=x&t=y` })).toBe(
            `https://app.palmtop.mtwa.it/#join?r=${ROOM}&p=x&t=y`,
        );
        expect(landingRedirect({ pathname: '/', hash: '' })).toBeNull();
        expect(landingRedirect({ pathname: '/docs/cli', hash: '#join?x' })).toBeNull();
    });

    test('install and uninstall sections moved to the docs', () => {
        expect(landingRedirect({ pathname: '/', hash: '#uninstall' })).toBe(
            '/docs/update-uninstall#uninstall',
        );
        expect(landingRedirect({ pathname: '/', hash: '#install' })).toBe(
            '/docs/getting-started#install-by-hand',
        );
        expect(landingRedirect({ pathname: '/', hash: '#how-it-works' })).toBeNull();
    });
});

describe('seo', () => {
    test('canonical addresses are on the site host, without the trailing slash', () => {
        expect(canonicalUrl('/')).toBe(`${SITE_URL}/`);
        expect(canonicalUrl('/index.html')).toBe(`${SITE_URL}/`);
        expect(canonicalUrl('/docs/cli/')).toBe(`${SITE_URL}/docs/cli`);
        expect(canonicalUrl('/docs/cli/index.html')).toBe(`${SITE_URL}/docs/cli`);
        expect(canonicalUrl('/changelog')).toBe(`${SITE_URL}/changelog`);
    });

    test('the sitemap lists the canonical addresses, robots.txt points to it', () => {
        const xml = sitemapXml(['/', '/docs/cli']);
        expect(xml).toContain(`<loc>${SITE_URL}/</loc>`);
        expect(xml).toContain(`<loc>${SITE_URL}/docs/cli</loc>`);
        expect(robotsTxt()).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`);
    });
});

describe('copy code', () => {
    const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

    function renderSnippet(writeText: (text: string) => Promise<void>): HTMLElement {
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        document.body.innerHTML =
            '<p>Run <button type="button" class="copy-code">\n <code> palmtop pair </code></button></p>';
        bindCopyCode(document, 20);
        return document.querySelector('.copy-code') as HTMLElement;
    }

    afterEach(() => {
        Reflect.deleteProperty(navigator, 'clipboard');
        document.body.innerHTML = '';
    });

    test('a click copies the code and shows it for a moment', async () => {
        const copied: string[] = [];
        const button = renderSnippet(async (text) => {
            copied.push(text);
        });
        button.click();
        await tick();
        expect(copied).toEqual(['palmtop pair']);
        expect(button.dataset.copied).toBe('Copied');
        await tick(40);
        expect(button.dataset.copied).toBeUndefined();
    });

    test('without a clipboard the code gets selected', async () => {
        const button = renderSnippet(() => Promise.reject(new Error('not allowed')));
        button.click();
        await tick();
        expect(button.dataset.copied).toBe('Selected');
        expect(window.getSelection()?.toString().trim()).toBe('palmtop pair');
    });
});

describe('inline scripts', () => {
    test('built scripts and JSON data blocks are allowed, inline and unbuilt scripts are not', () => {
        const html = [
            '<script type="module" src="/assets/landing.js"></script>',
            '<script type="application/ld+json">{"@type":"WebSite"}</script>',
            '<script type="application/json">{}</script>',
            '<script>console.log(1)</script>',
            '<SCRIPT type="module">\n  import "x";\n</SCRIPT>',
            '<script src="../scripts/home.ts"></script>',
        ].join('');
        expect(findInlineScripts(html)).toEqual([
            'console.log(1)',
            'import "x";',
            'src=../scripts/home.ts',
        ]);
    });

    test('the build check names the page with an inline script', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'palmtop-site-'));
        try {
            await mkdir(join(dir, 'docs'));
            await writeFile(join(dir, 'index.html'), '<script src="/assets/a.js"></script>');
            await assertNoInlineScripts(dir);
            await writeFile(join(dir, 'docs', 'index.html'), '<script>alert(1)</script>');
            await expect(assertNoInlineScripts(dir)).rejects.toThrow(/docs[\\/]index\.html/);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('docs and changelog', () => {
    const docs = [
        { id: 'cli', title: 'CLI', order: 5 },
        { id: 'getting-started', title: 'Getting started', order: 1 },
        { id: 'concepts', title: 'Concepts', order: 2 },
    ];

    test('docs are sorted by order, with the pages around the current one', () => {
        const middle = docsNavigation(docs, 'concepts');
        expect(middle.ordered.map((doc) => doc.id)).toEqual(['getting-started', 'concepts', 'cli']);
        expect(middle.previous?.id).toBe('getting-started');
        expect(middle.next?.id).toBe('cli');
        const first = docsNavigation(docs, 'getting-started');
        expect(first.previous).toBeNull();
        expect(docsNavigation(docs, 'cli').next).toBeNull();
        expect(docsNavigation(docs, 'index')).toMatchObject({ previous: null, next: null });
    });

    test('versions sort numerically, newest first', () => {
        expect(['0.9.0', '0.10.0', '0.7.1', '1.0.0'].sort(newestVersionFirst)).toEqual([
            '1.0.0',
            '0.10.0',
            '0.9.0',
            '0.7.1',
        ]);
    });
});

describe('header menu', () => {
    function render() {
        document.body.innerHTML = `
            <header>
                <details data-nav-menu>
                    <summary aria-label="Menu"></summary>
                    <div><a href="/#roadmap">Roadmap</a></div>
                </details>
            </header>
            <main><p id="outside">Text</p></main>`;
        bindNavMenu(document);
        const menu = document.querySelector('details') as HTMLDetailsElement;
        menu.open = true;
        return menu;
    }

    afterEach(() => {
        document.body.innerHTML = '';
    });

    test('a tap on one of its links closes it', () => {
        const menu = render();
        (document.querySelector('a') as HTMLElement).click();
        expect(menu.open).toBe(false);
    });

    test('a tap outside closes it, a tap inside does not', () => {
        const menu = render();
        (menu.querySelector('div') as HTMLElement).click();
        expect(menu.open).toBe(true);
        (document.getElementById('outside') as HTMLElement).click();
        expect(menu.open).toBe(false);
    });

    test('Escape closes it and gives the focus back to the button', () => {
        const menu = render();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(menu.open).toBe(false);
        expect(document.activeElement).toBe(menu.querySelector('summary'));
        menu.open = true;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(menu.open).toBe(true);
    });
});

describe('source repository', () => {
    test('is the public repository on GitHub, over HTTPS, without a trailing slash', () => {
        expect(REPO_URL).toBe('https://github.com/talon2295/palmtopai');
        expect(new URL(REPO_URL).protocol).toBe('https:');
        expect(REPO_URL.endsWith('/')).toBe(false);
    });
});

describe('install command', () => {
    test('runs install.sh from this site, and the script downloads from it too', async () => {
        expect(INSTALL_COMMAND).toBe(`curl -fsSL ${SITE_URL}/install.sh | bash`);
        const script = await Bun.file(join(import.meta.dir, '..', 'public', 'install.sh')).text();
        expect(script).toContain(`base="\${PALMTOP_INSTALL_URL:-${SITE_URL}}"`);
        expect(script).toContain(`#   curl -fsSL ${SITE_URL}/install.sh | bash`);
    });
});

describe('theme', () => {
    afterEach(() => {
        delete document.documentElement.dataset.theme;
        localStorage.clear();
    });

    test('only light and dark are explicit choices; system leaves the root untouched', () => {
        expect(parseThemePreference('dark')).toBe('dark');
        expect(parseThemePreference('sepia')).toBe('system');
        expect(parseThemePreference(null)).toBe('system');
        const root = document.documentElement;
        applyTheme(root, 'dark');
        expect(root.dataset.theme).toBe('dark');
        applyTheme(root, 'system');
        expect(root.dataset.theme).toBeUndefined();
    });

    test('theme-init.js applies the stored choice with the same key', async () => {
        const script = await Bun.file(new URL('../public/theme-init.js', import.meta.url)).text();
        expect(script).toContain(`'${THEME_KEY}'`);
        localStorage.setItem(THEME_KEY, 'light');
        new Function(script)();
        expect(document.documentElement.dataset.theme).toBe('light');
        delete document.documentElement.dataset.theme;
        localStorage.setItem(THEME_KEY, 'sepia');
        new Function(script)();
        expect(document.documentElement.dataset.theme).toBeUndefined();
    });
});

describe('feedback form', () => {
    function form() {
        document.body.innerHTML = `
            <form id="feedback-form">
                <input type="radio" name="type" value="bug" />
                <input type="radio" name="type" value="feature" checked />
                <textarea name="message"></textarea>
                <input type="email" name="email" value="tester@example.com" />
                <input type="text" name="website" value="" />
                <button type="submit">Send</button>
                <p data-feedback-status></p>
            </form>`;
        const element = document.getElementById('feedback-form') as HTMLFormElement;
        // Typed by the person: `reset()` goes back to the empty default.
        (element.querySelector('textarea') as HTMLTextAreaElement).value = 'Add a dark QR page';
        return element;
    }

    async function submit(element: HTMLFormElement) {
        element.dispatchEvent(new Event('submit', { cancelable: true }));
        await Bun.sleep(0);
    }

    test('posts JSON to /feedback with the page, then clears the form', async () => {
        const element = form();
        const calls: Array<{ url: string; init: RequestInit }> = [];
        bindFeedbackForm(
            element,
            async (url, init) => {
                calls.push({ url, init });
                return new Response('{"ok":true}', { status: 201 });
            },
            () => '/',
        );
        await submit(element);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe('/feedback');
        expect(calls[0]?.init.method).toBe('POST');
        expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
            type: 'feature',
            message: 'Add a dark QR page',
            email: 'tester@example.com',
            page: '/',
            website: '',
        });
        const status = element.querySelector<HTMLElement>('[data-feedback-status]');
        expect(status?.dataset.result).toBe('ok');
        expect(status?.textContent).toContain('Thanks');
        expect(element.querySelector('textarea')?.value).toBe('');
        expect(element.querySelector('button')?.disabled).toBe(false);
    });

    test('keeps the text and explains errors', async () => {
        const element = form();
        let answer: () => Promise<Response> = async () => new Response('', { status: 429 });
        bindFeedbackForm(element, () => answer());
        await submit(element);
        const status = element.querySelector<HTMLElement>('[data-feedback-status]');
        expect(status?.dataset.result).toBe('error');
        expect(status?.textContent).toContain('try again in a minute');
        expect(element.querySelector('textarea')?.value).toBe('Add a dark QR page');

        answer = async () => {
            throw new TypeError('offline');
        };
        await submit(element);
        expect(status?.textContent).toContain('check your connection');
    });

    test('result texts', () => {
        expect(feedbackResultText(400)).toContain('Check the fields');
        expect(feedbackResultText(500)).toContain('try again later');
    });
});

describe('install command for the system of the visitor', () => {
    const windowsUa =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
    const macUa =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';

    test('the commands are the ones of the two installers', () => {
        expect(INSTALL_COMMANDS.unix).toBe(`curl -fsSL ${SITE_URL}/install.sh | bash`);
        expect(INSTALL_COMMANDS.windows).toBe(`irm ${SITE_URL}/install.ps1 | iex`);
        expect(INSTALL_COMMAND).toBe(INSTALL_COMMANDS.unix);
    });

    test('Windows gets PowerShell, everything else the shell command', () => {
        expect(detectInstallSystem({ userAgent: windowsUa })).toBe('windows');
        expect(detectInstallSystem({ userAgentData: { platform: 'Windows' } })).toBe('windows');
        // Chromium with a frozen user agent still says its platform.
        expect(
            detectInstallSystem({ userAgent: macUa, userAgentData: { platform: 'Windows' } }),
        ).toBe('windows');
        expect(detectInstallSystem({ userAgent: macUa })).toBe('unix');
        expect(detectInstallSystem({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe('unix');
        expect(detectInstallSystem({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' })).toBe('unix');
        expect(detectInstallSystem({ userAgent: 'Mozilla/5.0 (Windows Phone 10.0)' })).toBe('unix');
        expect(detectInstallSystem({})).toBe('unix');
    });

    test('a stored choice is a system, anything else is nothing', () => {
        expect(parseInstallSystem('windows')).toBe('windows');
        expect(parseInstallSystem('unix')).toBe('unix');
        expect(parseInstallSystem('linux')).toBeNull();
        expect(parseInstallSystem(null)).toBeNull();
    });

    function render() {
        document.body.innerHTML = `
            <div data-install data-unix="${INSTALL_COMMANDS.unix}" data-windows="${INSTALL_COMMANDS.windows}">
                <button data-install-system="unix" aria-pressed="true">macOS / Linux</button>
                <button data-install-system="windows" aria-pressed="false">Windows</button>
                <code><span data-command-prompt>$ </span><span data-command-text>${INSTALL_COMMANDS.unix}</span></code>
            </div>`;
    }
    const text = () => document.querySelector('[data-command-text]')?.textContent;
    const prompt = () => document.querySelector('[data-command-prompt]')?.textContent;
    const pressed = () =>
        [...document.querySelectorAll('[data-install-system]')]
            .filter((button) => button.getAttribute('aria-pressed') === 'true')
            .map((button) => (button as HTMLElement).dataset.installSystem);
    afterEach(() => {
        document.body.innerHTML = '';
    });

    test('a system shows its command and prompt, and presses its button', () => {
        render();
        applyInstallSystem(document, 'windows');
        expect(text()).toBe(INSTALL_COMMANDS.windows);
        expect(prompt()).toBe('PS> ');
        expect(pressed()).toEqual(['windows']);
        applyInstallSystem(document, 'unix');
        expect(text()).toBe(INSTALL_COMMANDS.unix);
        expect(prompt()).toBe('$ ');
        expect(pressed()).toEqual(['unix']);
    });

    test('it starts from the browser, a stored choice wins, and a click is remembered', () => {
        render();
        const kept: string[] = [];
        bindInstallChooser(document, {
            nav: { userAgent: windowsUa },
            read: () => null,
            write: (system) => kept.push(system),
        });
        expect(text()).toBe(INSTALL_COMMANDS.windows);
        (document.querySelector('[data-install-system="unix"]') as HTMLElement).click();
        expect(text()).toBe(INSTALL_COMMANDS.unix);
        expect(kept).toEqual(['unix']);

        render();
        bindInstallChooser(document, {
            nav: { userAgent: windowsUa },
            read: () => 'unix',
            write: () => {},
        });
        expect(text()).toBe(INSTALL_COMMANDS.unix);
        expect(INSTALL_SYSTEM_KEY).toBe('palmtop.install-system');
    });

    test('blocked storage does not stop the page: detection still works, nothing is kept', () => {
        render();
        bindInstallChooser(document, {
            nav: { userAgent: windowsUa },
            read: () => {
                throw new Error('blocked');
            },
            write: () => {
                throw new Error('blocked');
            },
        });
        expect(text()).toBe(INSTALL_COMMANDS.windows);
        (document.querySelector('[data-install-system="unix"]') as HTMLElement).click();
        expect(text()).toBe(INSTALL_COMMANDS.unix);
    });
});
