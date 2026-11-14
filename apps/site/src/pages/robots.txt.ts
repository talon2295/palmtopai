import { robotsTxt } from '../lib/seo';

export function GET(): Response {
    return new Response(robotsTxt());
}
