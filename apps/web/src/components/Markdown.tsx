import type { ReactNode } from 'react';
import { type Block, type Inline, parseInline, parseMarkdown, splitTitle } from '@/lib/markdown';
import { CodeBlock } from './CodeBlock';

function InlineNodes({ nodes }: { nodes: Inline[] }) {
    return (
        <>
            {nodes.map((node, index): ReactNode => {
                // The tree is rebuilt from the text on every render: the position is a stable key.
                const key = index;
                switch (node.kind) {
                    case 'text':
                        return <span key={key}>{node.text}</span>;
                    case 'break':
                        return <br key={key} />;
                    case 'bold':
                        return (
                            <strong key={key} className="font-semibold">
                                <InlineNodes nodes={node.children} />
                            </strong>
                        );
                    case 'italic':
                        return (
                            <em key={key}>
                                <InlineNodes nodes={node.children} />
                            </em>
                        );
                    case 'code':
                        return (
                            <code
                                key={key}
                                className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.9em] break-words dark:bg-zinc-800"
                            >
                                {node.text}
                            </code>
                        );
                    default:
                        return (
                            <span key={key}>
                                <a
                                    href={node.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="underline underline-offset-2 break-all"
                                >
                                    {node.text}
                                </a>
                                {/* A label is not the address: the host says where it really goes. */}
                                {node.label && (
                                    <span className="text-xs opacity-70"> ({node.host})</span>
                                )}
                            </span>
                        );
                }
            })}
        </>
    );
}

function BlockNode({ block }: { block: Block }) {
    switch (block.kind) {
        case 'paragraph':
            return (
                <p className="break-words">
                    <InlineNodes nodes={block.children} />
                </p>
            );
        case 'code':
            return <CodeBlock text={block.text} />;
        case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul';
            return (
                <Tag
                    start={block.ordered ? block.start : undefined}
                    className={`pl-5 break-words ${block.ordered ? 'list-decimal' : 'list-disc'}`}
                >
                    {block.items.map((item, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: the items have no identity
                        <li key={index} className="pl-0.5">
                            <InlineNodes nodes={item} />
                        </li>
                    ))}
                </Tag>
            );
        }
    }
}

/**
 * The markdown written by the agent, as React elements (never HTML). With `title`, the first line
 * is the title of the item: bold, with what follows in normal text. The font size and color come
 * from the parent.
 */
export function Markdown({
    text,
    title = false,
    className,
}: {
    text: string;
    title?: boolean;
    className?: string;
}) {
    const { title: first, rest } = title ? splitTitle(text) : { title: '', rest: text };
    const blocks = parseMarkdown(rest);
    return (
        <div className={`space-y-1.5 ${className ?? ''}`}>
            {first !== '' && (
                <p className="font-semibold break-words">
                    <InlineNodes nodes={parseInline(first)} />
                </p>
            )}
            {blocks.map((block, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the blocks have no identity
                <BlockNode key={index} block={block} />
            ))}
        </div>
    );
}

/** The title line of an item (see `splitTitle`): bold, inline markdown only. */
export function MarkdownTitle({ text }: { text: string }) {
    return (
        <p className="font-semibold break-words">
            <InlineNodes nodes={parseInline(text)} />
        </p>
    );
}

/** One line of the agent's text where no block fits (a question, an option): no title, no blocks. */
export function MarkdownInline({ text }: { text: string }) {
    return <InlineNodes nodes={parseInline(text.replace(/\s*\n\s*/g, ' ').trim())} />;
}
