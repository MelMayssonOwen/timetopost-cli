import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { CliError } from './api.js';
const TYPES = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
};
/** http(s) URLs pass through; local files go through presign -> PUT -> confirm. */
export async function resolveMedia(api, items, log) {
    const out = [];
    for (const item of items) {
        if (/^https?:\/\//i.test(item)) {
            out.push(item);
            continue;
        }
        const contentType = TYPES[extname(item).toLowerCase()];
        if (!contentType)
            throw new CliError(`Unsupported media type for "${item}". Supported: ${Object.keys(TYPES).join(' ')}`);
        let size;
        try {
            size = (await stat(item)).size;
        }
        catch {
            throw new CliError(`Media file not found: ${item}`);
        }
        const bytes = await readFile(item);
        log(`Uploading ${basename(item)} (${size} bytes)...`);
        const presign = await api.post('/api/media/presign', { filename: basename(item), contentType, size });
        if (!presign?.uploadUrl || !presign?.key)
            throw new CliError('Media presign returned no upload URL.');
        let put;
        try {
            put = await fetch(presign.uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: bytes });
        }
        catch (e) {
            throw new CliError(`Media upload failed: ${e.message}`, 3);
        }
        if (!put.ok)
            throw new CliError(`Media upload failed (HTTP ${put.status}).`);
        const confirm = await api.post('/api/media/confirm', { key: presign.key, contentType, size });
        const url = confirm?.asset?.publicUrl ?? confirm?.asset?.url ?? presign.publicUrl;
        if (!url)
            throw new CliError('Media confirm returned no public URL.');
        out.push(url);
    }
    return out;
}
