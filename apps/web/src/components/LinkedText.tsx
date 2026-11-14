import type { ReactNode } from 'react';
import { splitLinks } from '@/lib/linkify';

/** A text where the web addresses open in a new tab; the rest is as written. */
export function LinkedText({ text }: { text: string }) {
    return (
        <>
            {splitLinks(text).map(
                (part): ReactNode =>
                    part.url ? (
                        <a
                            key={part.offset}
                            href={part.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline underline-offset-2 break-all"
                        >
                            {part.text}
                        </a>
                    ) : (
                        <span key={part.offset}>{part.text}</span>
                    ),
            )}
        </>
    );
}
