import { createReadStream } from 'node:fs';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
export class LocalStorage {
    root;
    constructor(root) {
        this.root = root;
    }
    async save(input) { await mkdir(this.root, { recursive: true }); const key = `${randomUUID()}${input.extension}`; const target = this.path(key); if (input.sourcePath) {
        const data = await import('node:fs/promises').then((fs) => fs.readFile(input.sourcePath));
        await writeFile(target, data);
    }
    else
        await writeFile(target, input.data ?? new Uint8Array()); return key; }
    path(key) { const root = resolve(this.root); const target = resolve(root, key); const relativeTarget = relative(root, target); if (isAbsolute(relativeTarget) || relativeTarget.startsWith('..'))
        throw new Error('Invalid storage key'); return join(root, relativeTarget); }
    stream(key) { return createReadStream(this.path(key)); }
    async remove(key) { await unlink(this.path(key)); }
}
