/**
 * The menu of the header on phones: a `<details data-nav-menu>`, so it opens and closes without
 * JavaScript too. This closes it on a tap on one of its links (a link to `/#roadmap` stays on the
 * page), on a tap outside it, and on Escape.
 */
export function bindNavMenu(root: Document): void {
    const menu = root.querySelector<HTMLDetailsElement>('details[data-nav-menu]');
    if (!menu) return;
    const close = () => {
        menu.open = false;
    };
    for (const link of menu.querySelectorAll('a')) link.addEventListener('click', close);
    root.addEventListener('click', (event) => {
        if (menu.open && !menu.contains(event.target as Node)) close();
    });
    root.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !menu.open) return;
        close();
        menu.querySelector('summary')?.focus();
    });
}
