// Applies the theme chosen on the site (lib/theme.ts) before the page renders, to avoid a flash
// of the other theme. A file, not an inline script: the relay's CSP only allows script files.
(() => {
    try {
        const theme = localStorage.getItem('palmtop.theme');
        if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    } catch {
        // Storage blocked: follow the system theme.
    }
})();
