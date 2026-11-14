import { isWebAddress, splitLinks } from './linkify';

/**
 * The small markdown of the text the agent writes: bold, italic, `code`, lists, ``` blocks and
 * links. Nothing else: no headings, no images, no HTML (a `<b>` stays the characters `<b>`). The
 * parser only builds a tree of plain data; the components turn it into React elements, so there is
 * never HTML to sanitize.
 */

export type Inline =
    | { kind: 'text'; text: string }
    | { kind: 'bold'; children: Inline[] }
    | { kind: 'italic'; children: Inline[] }
    | { kind: 'code'; text: string }
    /**
     * `label` is set on `[text](address)`: what is shown is not the address, so the components
     * show the host of the address next to it. A bare address is its own text.
     */
    | { kind: 'link'; text: string; url: string; label?: boolean; host: string }
    | { kind: 'break' };

export type Block =
    | { kind: 'paragraph'; children: Inline[] }
    | { kind: 'list'; ordered: boolean; start: number; items: Inline[][] }
    | { kind: 'code'; text: string };

const FENCE = /^\s*```/;
const FENCE_END = /^\s*```\s*$/;
const LIST_ITEM = /^ {0,3}(?:([-*•])|(\d{1,9})[.)])\s+(.*)$/;
const CONTINUATION = /^ {2,}\S/;
/** Emphasis inside emphasis stops here: three levels are more than a check ever needs. */
const MAX_DEPTH = 3;

function hostOf(address: string): string {
    try {
        return new URL(address).hostname.replace(/^www\./i, '');
    } catch {
        return '';
    }
}

/** Plain text with the addresses in it turned into links (what the app has always done). */
function plain(text: string): Inline[] {
    return splitLinks(text).map(
        (part): Inline =>
            part.url
                ? { kind: 'link', text: part.text, url: part.url, host: hostOf(part.url) }
                : { kind: 'text', text: part.text },
    );
}

/** The index of the `)` that closes the `(` just before `from`, or -1. */
function closingParen(text: string, from: number): number {
    let depth = 1;
    for (let at = from; at < text.length; at++) {
        const char = text[at];
        if (char === ' ' || char === '\t') return -1;
        if (char === '(') depth++;
        if (char === ')' && --depth === 0) return at;
    }
    return -1;
}

const isSpace = (char: string | undefined) => char === undefined || /\s/.test(char);

/** One line of text as inline nodes. A marker that is never closed is just the character. */
export function parseInline(text: string, depth = 0): Inline[] {
    const nodes: Inline[] = [];
    let buffer = '';
    const flush = () => {
        if (buffer) nodes.push(...plain(buffer));
        buffer = '';
    };

    let at = 0;
    while (at < text.length) {
        const char = text[at] as string;

        if (char === '`') {
            const end = text.indexOf('`', at + 1);
            if (end > at + 1) {
                flush();
                nodes.push({ kind: 'code', text: text.slice(at + 1, end) });
                at = end + 1;
                continue;
            }
        }

        // `![alt](address)` is an image, which is not supported: it stays as it was typed.
        if (char === '[' && text[at - 1] !== '!') {
            const middle = text.indexOf('](', at + 1);
            const end = middle > at ? closingParen(text, middle + 2) : -1;
            if (end > 0) {
                const label = text.slice(at + 1, middle);
                const address = text.slice(middle + 2, end);
                if (label.trim() !== '' && !label.includes('[') && isWebAddress(address)) {
                    flush();
                    nodes.push({
                        kind: 'link',
                        text: label,
                        url: address,
                        label: true,
                        host: hostOf(address),
                    });
                    at = end + 1;
                    continue;
                }
            }
        }

        if (char === '*' && depth < MAX_DEPTH) {
            const double = text[at + 1] === '*';
            const marker = double ? '**' : '*';
            const start = at + marker.length;
            // The text inside cannot begin with a space (`2 * 3 * 4` is arithmetic, not italic).
            if (!isSpace(text[start]) && text[start] !== '*') {
                let end = text.indexOf(marker, start);
                // `*a **b** c*`: a single `*` does not close on the first half of a `**`.
                while (end > 0 && !double && text[end + 1] === '*') {
                    end = text.indexOf(marker, end + 2);
                }
                if (end > start && !isSpace(text[end - 1])) {
                    flush();
                    const children = parseInline(text.slice(start, end), depth + 1);
                    nodes.push({ kind: double ? 'bold' : 'italic', children });
                    at = end + marker.length;
                    continue;
                }
            }
        }

        buffer += char;
        at++;
    }
    flush();
    return nodes;
}

function lines(text: string): string[] {
    return text.replace(/\r\n?/g, '\n').split('\n');
}

/** A paragraph or a list item: its lines, one after the other with a break between. */
function joined(rows: string[]): Inline[] {
    const nodes: Inline[] = [];
    rows.forEach((row, index) => {
        if (index > 0) nodes.push({ kind: 'break' });
        nodes.push(...parseInline(row.trim()));
    });
    return nodes;
}

export function parseMarkdown(text: string): Block[] {
    const rows = lines(text);
    const blocks: Block[] = [];
    let at = 0;
    while (at < rows.length) {
        const row = rows[at] as string;

        if (row.trim() === '') {
            at++;
            continue;
        }

        if (FENCE.test(row)) {
            const body: string[] = [];
            at++;
            while (at < rows.length && !FENCE_END.test(rows[at] as string)) {
                body.push(rows[at] as string);
                at++;
            }
            at++; // the closing fence, or past the end: an unclosed block runs to the end
            while (body.length > 0 && body[0]?.trim() === '') body.shift();
            while (body.length > 0 && body.at(-1)?.trim() === '') body.pop();
            if (body.length > 0) blocks.push({ kind: 'code', text: body.join('\n') });
            continue;
        }

        const first = LIST_ITEM.exec(row);
        if (first) {
            const ordered = first[2] !== undefined;
            const items: string[][] = [];
            while (at < rows.length) {
                const current = rows[at] as string;
                const match = LIST_ITEM.exec(current);
                if (match && (match[2] !== undefined) === ordered) {
                    items.push([match[3] as string]);
                } else if (CONTINUATION.test(current) && !match && items.length > 0) {
                    items.at(-1)?.push(current);
                } else {
                    break;
                }
                at++;
            }
            blocks.push({
                kind: 'list',
                ordered,
                start: ordered ? Number(first[2]) : 1,
                items: items.map(joined),
            });
            continue;
        }

        const paragraph: string[] = [];
        while (at < rows.length) {
            const current = rows[at] as string;
            if (current.trim() === '' || FENCE.test(current) || LIST_ITEM.test(current)) break;
            paragraph.push(current);
            at++;
        }
        blocks.push({ kind: 'paragraph', children: joined(paragraph) });
    }
    return blocks;
}

/**
 * The first line of a text is the title of the item and the rest is what the title leaves out.
 * A text that opens with a code block has no title.
 */
export function splitTitle(text: string): { title: string; rest: string } {
    const trimmed = text.replace(/\r\n?/g, '\n').replace(/^\s*\n/, '');
    if (FENCE.test(trimmed.split('\n', 1)[0] ?? '')) return { title: '', rest: trimmed };
    const end = trimmed.indexOf('\n');
    if (end < 0) return { title: trimmed.trim(), rest: '' };
    return { title: trimmed.slice(0, end).trim(), rest: trimmed.slice(end + 1) };
}

function plainText(nodes: Inline[]): string {
    return nodes
        .map((node) => {
            switch (node.kind) {
                case 'text':
                case 'code':
                case 'link':
                    return node.text;
                case 'bold':
                case 'italic':
                    return plainText(node.children);
                default:
                    return ' ';
            }
        })
        .join('');
}

/** The title of a text without any marker, for a place that only has room for one line. */
export function plainTitle(text: string): string {
    return plainText(parseInline(splitTitle(text).title));
}
