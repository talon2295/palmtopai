import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { serveMcp } from '../src/mcp';

type Content = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;

/** Runs `palmtop mcp` over streams, with a stand-in for the CLI, and returns the answers by id. */
async function serve(
    requests: object[],
    run: NonNullable<Parameters<typeof serveMcp>[0]['run']>,
): Promise<Map<number, { result?: { content: Content; isError?: boolean } }>> {
    const input = new PassThrough();
    const lines: string[] = [];
    const done = serveMcp({
        input,
        output: { write: (chunk) => lines.push(chunk) },
        stderr: () => {},
        entry: 'palmtop',
        env: {},
        cwd: '.',
        run,
    });
    for (const request of requests) input.write(`${JSON.stringify(request)}\n`);
    input.end();
    await done;
    return new Map(
        lines
            .flatMap((chunk) => chunk.split('\n'))
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .map((message) => [message.id, message]),
    );
}

const call = (id: number, name: string, args: object = {}) => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
});

describe('the feedback tool gives the screenshots as images', () => {
    test('each screenshot of the feedback follows its text as an image', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'palmtop-mcp-'));
        try {
            const first = join(dir, 'one.jpg');
            const gone = join(dir, 'gone.jpg');
            await writeFile(first, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
            const answers = await serve(
                [call(1, 'session_start', { title: 'x' }), call(2, 'feedback'), call(3, 'show')],
                async (argv, io) => {
                    if (argv[0] === 'session') {
                        io.stdout(JSON.stringify({ ref: 'abc123', title: 'x' }));
                    } else if (argv[0] === 'feedback') {
                        io.stdout(`- Header\n  screenshot: ${first}`);
                        io.attach?.({ path: first, mime: 'image/jpeg' });
                        io.attach?.({ path: gone, mime: 'image/jpeg' });
                    } else {
                        io.stdout('shown');
                    }
                    return 0;
                },
            );
            const feedback = answers.get(2)?.result?.content as Content;
            expect(feedback).toEqual([
                { type: 'text', text: `- Header\n  screenshot: ${first}` },
                {
                    type: 'image',
                    data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64'),
                    mimeType: 'image/jpeg',
                },
            ]);
            // Other tools give text only.
            expect(answers.get(3)?.result?.content).toEqual([{ type: 'text', text: 'shown' }]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
