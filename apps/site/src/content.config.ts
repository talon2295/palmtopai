import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

/** Docs pages, in sidebar order (`order`). The file name is the URL: `/docs/<name>`. */
const docs = defineCollection({
    loader: glob({ pattern: '*.md', base: './src/content/docs' }),
    schema: z.object({
        title: z.string(),
        description: z.string(),
        order: z.number(),
    }),
});

/** One entry per CLI version, newest first on the page. The file name is the version. */
const changelog = defineCollection({
    // The default id drops the dots of the version (`070`).
    loader: glob({
        pattern: '*.md',
        base: './src/content/changelog',
        generateId: ({ entry }) => entry.replace(/\.md$/, ''),
    }),
    schema: z.object({
        date: z.coerce.date(),
        summary: z.string(),
    }),
});

export const collections = { docs, changelog };
