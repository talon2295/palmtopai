/** A piece of text: plain, or a web address that can be opened. */
export interface TextPart {
    text: string;
    /**
     * Set on a link: the address to open. The text is the address as it was written, so what is
     * shown is where it goes; `https://` is put in front of one written without a scheme.
     */
    url?: string;
    /** Where the part starts in the text, a stable key. */
    offset: number;
}

// Quotes of every kind end an address: they are not in it, whichever way they are written.
const END = '\\s<>"\'`«»“”„‘’…';
const PATH = `[^${END}]*`;
/**
 * An address with its scheme, or one without (`example.com/page`, `www.example.it`). The second
 * form is anything that looks like `name.tld`: a check of the tld and of what comes before the
 * match follows, since a regular expression here cannot look behind in older browsers.
 */
const ADDRESS_PATTERN = new RegExp(
    `https?://[^${END}]+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+([a-z]{2,24})(?::\\d{1,5})?(?:[/?#]${PATH})?`,
    'gi',
);
/** What cannot come right before an address without a scheme: it would be a part of something else. */
const GLUED = /[\w@./:-]/;

/**
 * Top-level domains an address without a scheme can end with: the generic ones people use and the
 * country codes. Left out on purpose: the ones that are also file extensions of the code in the
 * notes of the user (`main.py`, `README.md`, `install.sh`, `lib.rs`, `a.pl`, `b.so`) and `name`
 * (`user.name`). An address with `www.` in front is a link whatever it ends with.
 */
const TLDS = new Set(
    `com net org info biz edu gov mil int io app dev xyz online site store tech shop blog cloud
    page link live news agency studio design space website club top vip pro mobi asia travel
    jobs museum coop aero cat art ai tv fm ly gl gg im to ws nu cx vc la tk cf ga gq
    ac ad ae af ag al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt
    bw by bz ca cd cg ch ci ck cl cm cn co cr cu cv cw cy cz de dj dk dm do dz ec ee eg er es et
    eu fi fj fk fo fr gb gd ge gf gh gi gm gn gp gr gt gu gw gy hk hm hn hr ht hu id ie il in iq
    ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz lb lc li lk lr ls lt lu lv ma mc me mg
    mh mk mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nz om pa pe pf pg
    ph pk pn pr pt pw qa re ro ru rw sa sb sc sd se sg si sk sl sm sn sr ss st su sx sy sz tc td
    tf tg th tj tl tm tn tr tt tw tz ua ug uk us uy uz va ve vg vi vn vu wf ye yt za zm zw`.split(
        /\s+/,
    ),
);
const TRAILING = '.,;:!?';
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function count(text: string, char: string): number {
    return text.split(char).length - 1;
}

/** Takes off what ends a sentence or closes a bracket that was never opened in the address. */
function trimAddress(address: string): string {
    let end = address;
    for (;;) {
        const last = end.at(-1) ?? '';
        const opener = CLOSERS[last];
        if (TRAILING.includes(last) || (opener && count(end, last) > count(end, opener))) {
            end = end.slice(0, -1);
        } else {
            return end;
        }
    }
}

/** An `http(s)` address with a host: the only kind of address the app ever opens. */
export function isWebAddress(address: string): boolean {
    try {
        const parsed = new URL(address);
        return (
            (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== ''
        );
    } catch {
        return false;
    }
}

/** An address written without a scheme is one when it ends like a domain (or starts with `www.`). */
function isBareAddress(address: string, tld: string): boolean {
    const host = address.split(/[/?#:]/)[0] ?? '';
    return host.toLowerCase().startsWith('www.') || TLDS.has(tld.toLowerCase());
}

/**
 * Splits a text into plain parts and web addresses: `http(s)://…` and anything that looks like
 * `name.tld`, which gets `https://` in front when opened. There is no `[text](address)` form on
 * purpose: the text of a link is always its destination, which matters for what other people
 * write. Anything else that has a scheme (`javascript:`, `data:`, `ftp:`) stays plain text.
 */
export function splitLinks(text: string): TextPart[] {
    const parts: TextPart[] = [];
    let from = 0;
    for (const match of text.matchAll(ADDRESS_PATTERN)) {
        const address = trimAddress(match[0]);
        const scheme = /^https?:\/\//i.test(address);
        if (scheme ? !isWebAddress(address) : !isBareAddress(address, match[1] ?? '')) continue;
        // `a@b.com` and the middle of `ftp://example.com` are not addresses of their own.
        if (!scheme && match.index > 0 && GLUED.test(text[match.index - 1] ?? '')) continue;
        if (!scheme && !isWebAddress(`https://${address}`)) continue;
        if (match.index > from) {
            parts.push({ text: text.slice(from, match.index), offset: from });
        }
        parts.push({
            text: address,
            url: scheme ? address : `https://${address}`,
            offset: match.index,
        });
        from = match.index + address.length;
    }
    if (from < text.length) parts.push({ text: text.slice(from), offset: from });
    return parts;
}

export function hasLinks(text: string): boolean {
    return splitLinks(text).some((part) => part.url !== undefined);
}
