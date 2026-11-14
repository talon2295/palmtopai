import cli from '../../../../packages/cli/package.json';

/** Public address of the relay, which serves this site. */
export const SITE_URL = 'https://palmtop.mtwa.it';

/** The web app, on a name of its own so that its storage stays apart from the site's. */
export const APP_URL = 'https://app.palmtop.mtwa.it/';

/** The installers (`public/install.sh` and `public/install.ps1`), and the commands that run them. */
export const INSTALL_SCRIPT_URL = `${SITE_URL}/install.sh`;
export const INSTALL_PS1_URL = `${SITE_URL}/install.ps1`;
export const INSTALL_COMMANDS = {
    /** macOS, Linux and a WSL terminal. */
    unix: `curl -fsSL ${INSTALL_SCRIPT_URL} | bash`,
    /** Windows PowerShell 5.1 or newer, and PowerShell 7. */
    windows: `irm ${INSTALL_PS1_URL} | iex`,
} as const;
/** What the page shows before the browser says which system it is. */
export const INSTALL_COMMAND = INSTALL_COMMANDS.unix;

/** The public source repository. */
export const REPO_URL = 'https://github.com/talon2295/palmtopai';

/** Version of the CLI built with this site (`packages/cli/package.json`). */
export const CLI_VERSION: string = cli.version;

/** Header links: in the header on wide screens, in the menu (☰) on phones. */
export const NAV_LINKS = [
    { href: '/docs', label: 'Docs' },
    { href: '/#roadmap', label: 'Roadmap' },
    { href: '/changelog', label: 'Changelog' },
    { href: '/#feedback', label: 'Feedback' },
] as const;
