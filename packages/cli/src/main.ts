import { createInterface } from 'node:readline/promises';
import { colorDepth } from './banner';
import { clackUi } from './clack-ui';
import { run } from './cli';
import { serveMcp } from './mcp';

const NODE_MAJOR = Number(process.versions.node?.split('.')[0] ?? 0);
if (NODE_MAJOR < 22) {
    console.error(`palmtop: Node.js 22 or newer is required (found ${process.versions.node})`);
    process.exit(1);
}

// `palmtop mcp`: the tools for an agent, on stdio. It ends when the agent closes stdin.
if (process.argv[2] === 'mcp') {
    await serveMcp({
        input: process.stdin,
        output: process.stdout,
        stderr: (text) => console.error(text),
        entry: process.argv[1] as string,
        env: process.env,
        // The folder the agent was started in picks the project, as for the CLI.
        cwd: process.cwd(),
    });
    process.exit(0);
}

const code = await run(process.argv.slice(2), {
    entry: process.argv[1] as string,
    stdout: (text) => console.log(text),
    stderr: (text) => console.error(text),
    env: process.env,
    cwd: process.env.INIT_CWD ?? process.cwd(),
    // Only a person at a terminal can confirm a deletion; agents and scripts pass --yes.
    ...(process.stdin.isTTY &&
        process.stderr.isTTY && {
            confirm: async (question: string) => {
                const prompt = createInterface({ input: process.stdin, output: process.stderr });
                try {
                    return /^y(es)?$/i.test((await prompt.question(question)).trim());
                } finally {
                    prompt.close();
                }
            },
        }),
    // A line of text, for the questions of `palmtop invite`.
    ...(process.stdin.isTTY &&
        process.stderr.isTTY && {
            ask: async (question: string) => {
                const prompt = createInterface({ input: process.stdin, output: process.stderr });
                try {
                    return await prompt.question(question);
                } finally {
                    prompt.close();
                }
            },
        }),
    // Single keypresses and screen control, for the pairing QR code.
    ...(process.stdin.isTTY &&
        process.stdout.isTTY && {
            tty: {
                readKey: () =>
                    new Promise<string>((resolve) => {
                        const wasRaw = process.stdin.isRaw;
                        process.stdin.setRawMode(true);
                        process.stdin.resume();
                        process.stdin.once('data', (chunk: Buffer) => {
                            process.stdin.setRawMode(wasRaw);
                            process.stdin.pause();
                            resolve(chunk.toString('utf8'));
                        });
                    }),
                clear: () => process.stdout.write('\u001b[2J\u001b[3J\u001b[H'),
            },
            // The questions of `palmtop setup`.
            ui: clackUi(colorDepth(process.stdout, process.env)),
        }),
    color: colorDepth(process.stdout, process.env),
});
if (code !== 0 || process.argv[2] !== 'serve') process.exit(code);
