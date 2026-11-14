/** The systems the install command is for: `unix` is macOS, Linux and a WSL terminal. */
export type InstallSystem = 'unix' | 'windows';

/** localStorage key of the system chosen by hand on the install command. */
export const INSTALL_SYSTEM_KEY = 'palmtop.install-system';

export function parseInstallSystem(value: string | null | undefined): InstallSystem | null {
    return value === 'unix' || value === 'windows' ? value : null;
}

/** What a browser tells about the computer it runs on. */
export interface NavigatorInfo {
    userAgent?: string;
    /** Chromium: `platform` is `Windows`, `macOS`, `Linux`, `Android`... */
    userAgentData?: { platform?: string };
}

/**
 * The system of the visitor: Windows gets the PowerShell command, everything else (macOS, Linux,
 * a phone, a browser that says nothing) the shell one.
 */
export function detectInstallSystem(nav: NavigatorInfo): InstallSystem {
    if (nav.userAgentData?.platform === 'Windows') return 'windows';
    return /Windows/i.test(nav.userAgent ?? '') && !/Phone/i.test(nav.userAgent ?? '')
        ? 'windows'
        : 'unix';
}

const PROMPTS: Record<InstallSystem, string> = { unix: '$ ', windows: 'PS> ' };

/**
 * Shows one system on every install command of `root` (`components/InstallCommand.astro`): its
 * command and prompt, and the button that is pressed. The commands are in the
 * `data-unix` and `data-windows` attributes of `[data-install]`.
 */
export function applyInstallSystem(root: ParentNode, system: InstallSystem): void {
    for (const install of root.querySelectorAll<HTMLElement>('[data-install]')) {
        const command = install.dataset[system];
        const text = install.querySelector('[data-command-text]');
        if (command && text) text.textContent = command;
        const prompt = install.querySelector('[data-command-prompt]');
        if (prompt) prompt.textContent = PROMPTS[system];
        for (const button of install.querySelectorAll<HTMLElement>('[data-install-system]')) {
            button.setAttribute('aria-pressed', String(button.dataset.installSystem === system));
        }
    }
}

export interface InstallChooserOptions {
    nav: NavigatorInfo;
    /** The choice kept in this browser, if any; may throw (blocked storage). */
    read: () => string | null;
    write: (system: InstallSystem) => void;
}

/**
 * Starts every install command of `root` on the system the visitor chose before, or else the one
 * the browser reports, and lets a click on a system's button change it (and be remembered).
 */
export function bindInstallChooser(root: ParentNode, options: InstallChooserOptions): void {
    let stored: string | null = null;
    try {
        stored = options.read();
    } catch {
        // Blocked storage: the system is detected on every visit.
    }
    applyInstallSystem(root, parseInstallSystem(stored) ?? detectInstallSystem(options.nav));
    for (const button of root.querySelectorAll<HTMLElement>('[data-install-system]')) {
        button.addEventListener('click', () => {
            const system = parseInstallSystem(button.dataset.installSystem);
            if (!system) return;
            applyInstallSystem(root, system);
            try {
                options.write(system);
            } catch {
                // Not kept after a reload.
            }
        });
    }
}
