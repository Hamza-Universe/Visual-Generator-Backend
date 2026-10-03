import { createReadStream } from 'node:fs';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface StorageProvider { save(input: { sourcePath?: string; data?: Uint8Array; extension: string }): Promise<string>; path(key: string): string; stream(key: string): ReturnType<typeof createReadStream>; remove(key: string): Promise<void>; }
export class LocalStorage implements StorageProvider {
  constructor(private readonly root: string) {}
  async save(input: { sourcePath?: string; data?: Uint8Array; extension: string }): Promise<string> { await mkdir(this.root, { recursive: true }); const key = `${randomUUID()}${input.extension}`; const target = this.path(key); if (input.sourcePath) { const data = await import('node:fs/promises').then((fs) => fs.readFile(input.sourcePath!)); await writeFile(target, data); } else await writeFile(target, input.data ?? new Uint8Array()); return key; }
  path(key: string): string { const root = resolve(this.root); const target = resolve(root, key); const relativeTarget = relative(root, target); if (isAbsolute(relativeTarget) || relativeTarget.startsWith('..')) throw new Error('Invalid storage key'); return join(root, relativeTarget); }
  stream(key: string) { return createReadStream(this.path(key)); }
  async remove(key: string): Promise<void> { await unlink(this.path(key)); }
}
