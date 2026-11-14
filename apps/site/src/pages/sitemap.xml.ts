import { getCollection } from 'astro:content';
import { sitemapXml } from '../lib/seo';

export async function GET(): Promise<Response> {
    const docs = await getCollection('docs');
    const paths = ['/', '/docs', ...docs.map((entry) => `/docs/${entry.id}`), '/changelog'];
    return new Response(sitemapXml(paths));
}
