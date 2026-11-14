// pm2 configuration of the relay: `pm2 startOrReload apps/relay/ecosystem.config.cjs --update-env`.
// The relay listens on 127.0.0.1 only: nginx terminates TLS and forwards to it.
const path = require('node:path');

module.exports = {
    apps: [
        {
            name: 'palmtop-relay',
            script: path.join(__dirname, 'src', 'main.ts'),
            // pm2 must find bun: set BUN_PATH (e.g. /home/ubuntu/.bun/bin/bun) if it is not on
            // the PATH of the pm2 daemon.
            interpreter: process.env.BUN_PATH || 'bun',
            cwd: path.join(__dirname, '..', '..'),
            instances: 1, // rooms live in memory: never run more than one instance
            exec_mode: 'fork',
            autorestart: true,
            max_memory_restart: '512M',
            kill_timeout: 5000,
            time: true,
            env: {
                NODE_ENV: 'production',
                HOST: '127.0.0.1',
                PORT: '8787',
                TRUST_PROXY: '1',
                // Statistics (`bun run stats`): on 127.0.0.1 only, never proxied by nginx. Data in
                // DATA_DIR, default ~/.palmtop-relay.
                ADMIN_PORT: '8788',
                WEB_ROOT: path.join(__dirname, '..', 'web', 'dist'),
                CLI_ROOT: path.join(__dirname, '..', '..', 'packages', 'cli', 'dist'),
            },
        },
    ],
};
