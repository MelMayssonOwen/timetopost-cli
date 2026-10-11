#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { run } from './cli.js';
async function readStdin() {
    const chunks = [];
    for await (const c of process.stdin)
        chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
}
function promptHidden(question) {
    return new Promise((resolve, reject) => {
        if (!process.stdin.isTTY) {
            // Piped input: read one line without echo concerns.
            const rl = createInterface({ input: process.stdin });
            rl.once('line', (l) => {
                rl.close();
                resolve(l);
            });
            rl.once('close', () => resolve(''));
            return;
        }
        process.stderr.write(question);
        const stdin = process.stdin;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        let buf = '';
        const onData = (ch) => {
            for (const c of ch) {
                if (c === '\r' || c === '\n' || c === '\u0004') {
                    stdin.setRawMode(false);
                    stdin.pause();
                    stdin.removeListener('data', onData);
                    process.stderr.write('\n');
                    return resolve(buf);
                }
                if (c === '\u0003') {
                    stdin.setRawMode(false);
                    process.stderr.write('\n');
                    return reject(new Error('Cancelled'));
                }
                if (c === '\u007f' || c === '\b')
                    buf = buf.slice(0, -1);
                else
                    buf += c;
            }
        };
        stdin.on('data', onData);
    });
}
function openBrowser(url) {
    const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => { });
    child.unref();
}
const io = {
    env: process.env,
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
    stdinIsTTY: !!process.stdin.isTTY,
    readStdin,
    promptHidden,
    openBrowser,
};
run(process.argv.slice(2), io).then((code) => {
    process.exitCode = code;
}, (e) => {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exitCode = 1;
});
