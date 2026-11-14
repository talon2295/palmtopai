import { bindCopyCode, copyElementText } from '../lib/copy-code';
import { bindInstallChooser, INSTALL_SYSTEM_KEY } from '../lib/install';
import { landingRedirect } from '../lib/landing';
import { bindNavMenu } from '../lib/nav-menu';
import { applyTheme, parseThemePreference, THEME_KEY, type ThemePreference } from '../lib/theme';

/** localStorage can throw (blocked storage, private mode): preferences are then not kept. */
function readSetting(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeSetting(key: string, value: string | null): void {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch {
        // Not kept after a reload.
    }
}

// Old links to the landing page: join links go to the app, moved sections to the docs.
const redirect = landingRedirect(window.location);
if (redirect) window.location.replace(redirect);

// Theme switch: system, light or dark, remembered in this browser.
const themeButtons = document.querySelectorAll<HTMLElement>('[data-theme-choice]');
function showTheme(preference: ThemePreference): void {
    applyTheme(document.documentElement, preference);
    for (const button of themeButtons) {
        button.setAttribute('aria-pressed', String(button.dataset.themeChoice === preference));
    }
}
showTheme(parseThemePreference(readSetting(THEME_KEY)));
for (const button of themeButtons) {
    button.addEventListener('click', () => {
        const preference = parseThemePreference(button.dataset.themeChoice ?? null);
        writeSetting(THEME_KEY, preference === 'system' ? null : preference);
        showTheme(preference);
    });
}

// Install command: the system of the visitor, from the browser or from their last choice.
bindInstallChooser(document, {
    nav: navigator,
    read: () => readSetting(INSTALL_SYSTEM_KEY),
    write: (system) => writeSetting(INSTALL_SYSTEM_KEY, system),
});

// The button copies the command (without the prompt in front of it).
for (const button of document.querySelectorAll<HTMLElement>('[data-copy-command]')) {
    const command = button.parentElement?.querySelector('[data-command-text]');
    button.addEventListener('click', async () => {
        if (!command) return;
        button.textContent = await copyElementText(command);
        setTimeout(() => {
            button.textContent = 'Copy';
        }, 2_000);
    });
}

bindCopyCode(document);
bindNavMenu(document);

// Code blocks of the docs: a Copy button in the corner.
for (const pre of document.querySelectorAll<HTMLElement>('.doc pre')) {
    const code = pre.querySelector('code');
    if (!code) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy';
    button.textContent = 'Copy';
    button.addEventListener('click', async () => {
        const result = await copyElementText(code);
        button.textContent = result;
        button.dataset.copied = result;
        setTimeout(() => {
            button.textContent = 'Copy';
            delete button.dataset.copied;
        }, 1_500);
    });
    pre.append(button);
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (!reducedMotion && 'IntersectionObserver' in window) {
    document.documentElement.classList.add('js-reveal');
    const observer = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                entry.target.classList.add('revealed');
                observer.unobserve(entry.target);
            }
        },
        { rootMargin: '0px 0px -10% 0px' },
    );
    for (const element of document.querySelectorAll('[data-reveal]')) observer.observe(element);
}
