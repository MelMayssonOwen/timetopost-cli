import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const DEFAULT_API_URL = 'https://api.timetopost.co';
export function configDir(env) {
    if (env.TTP_CONFIG_DIR)
        return env.TTP_CONFIG_DIR;
    const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
    return join(base, 'timetopost');
}
export function credentialsPath(env) {
    return join(configDir(env), 'credentials.json');
}
export async function readCredentials(env) {
    try {
        const parsed = JSON.parse(await readFile(credentialsPath(env), 'utf8'));
        return typeof parsed?.token === 'string' && parsed.token ? parsed : null;
    }
    catch {
        return null;
    }
}
export async function writeCredentials(env, creds) {
    const dir = configDir(env);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = credentialsPath(env);
    await writeFile(file, JSON.stringify({ ...creds, savedAt: new Date().toISOString() }, null, 2) + '\n', {
        mode: 0o600,
    });
    await chmod(file, 0o600);
    return file;
}
export async function deleteCredentials(env) {
    try {
        await rm(credentialsPath(env));
        return true;
    }
    catch {
        return false;
    }
}
/** TTP_TOKEN wins, then TIMETOPOST_API_TOKEN, then the stored credentials file. */
export async function resolveToken(env) {
    if (env.TTP_TOKEN?.trim())
        return { token: env.TTP_TOKEN.trim(), source: 'TTP_TOKEN' };
    if (env.TIMETOPOST_API_TOKEN?.trim()) {
        return { token: env.TIMETOPOST_API_TOKEN.trim(), source: 'TIMETOPOST_API_TOKEN' };
    }
    const creds = await readCredentials(env);
    return creds ? { token: creds.token, source: 'credentials file' } : null;
}
