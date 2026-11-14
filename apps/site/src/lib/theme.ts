/** Theme chosen by the visitor; `system` follows the device and is stored as no value. */
export type ThemePreference = 'system' | 'light' | 'dark';

/** localStorage key, also read by `public/theme-init.js` before the page renders. */
export const THEME_KEY = 'palmtop.theme';

export function parseThemePreference(value: string | null): ThemePreference {
    return value === 'light' || value === 'dark' ? value : 'system';
}

/**
 * Applies a preference to the root element: `data-theme` for an explicit choice, nothing for
 * `system` (the CSS follows `prefers-color-scheme`).
 */
export function applyTheme(root: HTMLElement, preference: ThemePreference): void {
    if (preference === 'system') delete root.dataset.theme;
    else root.dataset.theme = preference;
}
