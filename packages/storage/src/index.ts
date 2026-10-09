import { createReadStream } from 'node:fs';
import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export interface StorageProvider {
  save(input: {
    sourcePath?: string;
    data?: Uint8Array;
    extension: string;
  }): Promise<string>;

  path(key: string): string;

  stream(key: string): NodeJS.ReadableStream;

  remove(key: string): Promise<void>;
}

/**
 * Local filesystem storage.
 *
 * Used for local development.
 */
export class LocalStorage implements StorageProvider {
  constructor(private readonly root: string) {}

  async save(input: {
    sourcePath?: string;
    data?: Uint8Array;
    extension: string;
  }): Promise<string> {
    await mkdir(this.root, { recursive: true });

    const key = `${randomUUID()}${input.extension}`;
    const target = this.path(key);

    if (input.sourcePath) {
      const data = await readFile(input.sourcePath);
      await writeFile(target, data);
    } else {
      await writeFile(target, input.data ?? new Uint8Array());
    }

    return key;
  }

  path(key: string): string {
    const root = resolve(this.root);
    const target = resolve(root, key);
    const relativeTarget = relative(root, target);

    if (
      isAbsolute(relativeTarget) ||
      relativeTarget.startsWith('..')
    ) {
      throw new Error('Invalid storage key');
    }

    return join(root, relativeTarget);
  }

  stream(key: string) {
    return createReadStream(this.path(key));
  }

  async remove(key: string): Promise<void> {
    await unlink(this.path(key));
  }
}

/**
 * S3-compatible object storage.
 *
 * Works with Neon Object Storage and other S3-compatible providers.
 */ 
export class S3Storage implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    const endpoint = process.env.AWS_ENDPOINT_URL_S3!;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID!;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY!;
    const region = process.env.AWS_REGION!;
    const bucket = process.env.AWS_S3_BUCKET!;

    const missing: string[] = [];

    if (!endpoint) missing.push('AWS_ENDPOINT_URL_S3');
    if (!accessKeyId) missing.push('AWS_ACCESS_KEY_ID');
    if (!secretAccessKey) missing.push('AWS_SECRET_ACCESS_KEY');
    if (!region) missing.push('AWS_REGION');
    if (!bucket) missing.push('AWS_S3_BUCKET');

    if (missing.length > 0) {
      throw new Error(
        `S3 storage configuration is missing: ${missing.join(', ')}`,
      );
    }

    // At this point TypeScript still sees these values as
    // string | undefined, so explicitly narrow them.
    const s3Endpoint = endpoint;
    const s3AccessKeyId = accessKeyId;
    const s3SecretAccessKey = secretAccessKey;
    const s3Region = region;
    const s3Bucket   = bucket;

    this.bucket = s3Bucket;

    this.client = new S3Client({
      endpoint: s3Endpoint,
      region: s3Region,
      credentials: {
        accessKeyId: s3AccessKeyId,
        secretAccessKey: s3SecretAccessKey,
      },
      forcePathStyle: true,
    });
  }

  async save(input: {
    sourcePath?: string;
    data?: Uint8Array;
    extension: string;
  }): Promise<string> {
    const key = `${randomUUID()}${input.extension}`;

    let body: Uint8Array;

    if (input.sourcePath) {
      body = await readFile(input.sourcePath);
    } else {
      body = input.data ?? new Uint8Array();
    }

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
      }),
    );

    return key;
  }

  path(key: string): string {
    return key;
  }

  stream(key: string) {
    const output = new PassThrough();

    void (async () => {
      try {
        const response = await this.client.send(
          new GetObjectCommand({
            Bucket: this.bucket,
            Key: key,
          }),
        );

        if (!response.Body) {
          throw new Error(`S3 object has no body: ${key}`);
        }

        for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
          output.write(chunk);
        }

        output.end();
      } catch (error) {
        output.destroy(
          error instanceof Error
            ? error
            : new Error(String(error)),
        );
      }
    })();

    return output;
  }

  async remove(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }
} 
