import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { copyText } from '@/lib/clipboard';

/** How long the button shows the green check after a copy. */
export const COPIED_MS = 2_000;

/**
 * A command or a string to take away: a box on a line of its own, with a button that copies it
 * exactly as written (the text on the clipboard is the text of the block, nothing else).
 */
export function CodeBlock({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);
    const code = useRef<HTMLElement>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    useEffect(() => () => clearTimeout(timer.current), []);

    async function copy() {
        if (await copyText(text)) {
            setCopied(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), COPIED_MS);
        } else if (code.current) {
            // No clipboard here: select the text so the person can copy it by hand.
            window.getSelection()?.selectAllChildren(code.current);
        }
    }

    return (
        <div className="relative rounded-lg border border-zinc-200 bg-zinc-100 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100">
            <pre className="m-0 min-h-11 px-3 py-3 pr-12 font-mono text-[13px] leading-snug break-words whitespace-pre-wrap [overflow-wrap:anywhere]">
                <code ref={code}>{text}</code>
            </pre>
            <button
                type="button"
                onClick={copy}
                aria-label={copied ? 'Copied' : 'Copy'}
                className="absolute top-1.5 right-1.5 flex size-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
                {copied ? (
                    <Check className="size-4 text-emerald-600 dark:text-emerald-400" />
                ) : (
                    <Copy className="size-4" />
                )}
            </button>
            <span role="status" className="sr-only">
                {copied ? 'Copied' : ''}
            </span>
        </div>
    );
}
