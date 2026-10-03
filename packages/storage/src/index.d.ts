import { createReadStream } from 'node:fs';
export interface StorageProvider {
    save(input: {
        sourcePath?: string;
        data?: Uint8Array;
        extension: string;
    }): Promise<string>;
    path(key: string): string;
    stream(key: string): ReturnType<typeof createReadStream>;
    remove(key: string): Promise<void>;
}
export declare class LocalStorage implements StorageProvider {
    private readonly root;
    constructor(root: string);
    save(input: {
        sourcePath?: string;
        data?: Uint8Array;
        extension: string;
    }): Promise<string>;
    path(key: string): string;
    stream(key: string): import("node:fs").ReadStream;
    remove(key: string): Promise<void>;
}
