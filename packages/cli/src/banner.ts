/**
 * The palmtop logo for the terminal: the green check on the dark rounded square of `icon.svg`,
 * drawn with half blocks (one cell = two square pixels), 18 × 18 pixels with the edges.
 */
const CHECK = [
    '                  ',
    '            ▄▄    ',
    '          ▄██▀    ',
    '    ██▄ ▄██▀      ',
    '     ▀████        ',
    '       ▀▀         ',
    '                  ',
];
const WIDTH = 18;

const ESC = '\u001b[';
const RESET = `${ESC}0m`;
/** `#34d399` and `#0b0d12` of the logo; 256-colour terminals get the closest ones. */
const GREEN = { truecolor: '38;2;52;211;153', ansi256: '38;5;79' };
const SQUARE_FG = { truecolor: '38;2;11;13;18', ansi256: '38;5;233' };
const SQUARE_BG = { truecolor: '48;2;11;13;18', ansi256: '48;5;233' };

export type ColorDepth = 'none' | 'ansi256' | 'truecolor';

/** Colour support of an output, as Node reports it; `NO_COLOR` turns colours off. */
export function colorDepth(
    stream: { isTTY?: boolean; hasColors?: (count?: number) => boolean },
    env: Record<string, string | undefined>,
): ColorDepth {
    if (!stream.isTTY || env.NO_COLOR || env.TERM === 'dumb') return 'none';
    if (stream.hasColors?.(2 ** 24)) return 'truecolor';
    return stream.hasColors?.(256) ? 'ansi256' : 'none';
}

/** Logo on the left, name, version and tagline on the right. */
export function banner(version: string, depth: ColorDepth): string {
    const text = [
        '',
        '',
        paint(`palmtop ${version}`, depth, '1'),
        paint('The missing checklist for AI coding', depth, '2'),
        '',
        '',
        '',
    ];
    if (depth === 'none') {
        return CHECK.map((row, i) => `  ${row}   ${text[i]}`.trimEnd()).join('\n');
    }
    const code = (color: { truecolor: string; ansi256: string }) => `${ESC}${color[depth]}m`;
    const edge = (char: string) => `  ${code(SQUARE_FG)} ${char.repeat(WIDTH - 2)} ${RESET}`;
    const rows = CHECK.map((row, i) =>
        `  ${code(SQUARE_BG)}${code(GREEN)}${row}${RESET}   ${text[i]}`.trimEnd(),
    );
    // Half-block top and bottom edges with the corners left out: a rounded square.
    return [edge('▄'), ...rows, edge('▀')].join('\n');
}

/** Green text, for the accents of `palmtop setup`. */
export function green(text: string, depth: ColorDepth): string {
    return depth === 'none' ? text : `${ESC}${GREEN[depth]}m${text}${RESET}`;
}

function paint(text: string, depth: ColorDepth, style: string): string {
    return depth === 'none' ? text : `${ESC}${style}m${text}${RESET}`;
}
