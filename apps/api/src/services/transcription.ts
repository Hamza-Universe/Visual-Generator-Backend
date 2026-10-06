import { GoogleGenAI } from '@google/genai';
import { unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { AppError } from '../errors.js';
import { TranscriptSchema } from '@app/schema';

const exec = promisify(execFile);
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const toWslPath = (filePath: string) => {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(filePath);
  if (!match) return filePath;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`;
};

const runFfmpeg = async (args: string[]) => {
  if (process.platform !== 'win32') return exec('ffmpeg', args);

  try {
    return await exec('ffmpeg', args);
  } catch (nativeError) {
    try {
      const wslArgs = args.map((arg, index) =>
        index > 0 && (args[index - 1] === '-i' || index === args.length - 1)
          ? toWslPath(arg)
          : arg,
      );
      return await exec('wsl.exe', ['ffmpeg', ...wslArgs]);
    } catch {
      throw nativeError;
    }
  }
};

export interface TranscriptionProvider {
  transcribe(input: {
    filePath: string;
    language?: string;
    mimeType?: string;
  }): Promise<{
    text: string;
    language?: string;
    durationSeconds?: number;
    words: { word: string; start: number; end: number }[];
  }>;
}

export class GeminiTranscriptionProvider implements TranscriptionProvider {
  private readonly client: GoogleGenAI;

  constructor(private readonly apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async transcribe(input: {
    filePath: string;
    language?: string;
    mimeType?: string;
  }) {
    if (!this.apiKey)
      throw new AppError(
        'MISSING_CONFIG',
        'GEMINI_API_KEY is required for transcription',
        500,
      );
    const needsExtraction = input.mimeType?.startsWith('video/') === true;
    let transcriptionPath = input.filePath;
    let temporaryPath: string | undefined;
    try {
      if (needsExtraction) {
        temporaryPath = join(tmpdir(), `visual-diagram-${randomUUID()}.mp3`);
        await runFfmpeg([
          '-y',
          '-i',
          input.filePath,
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-codec:a',
          'libmp3lame',
          temporaryPath,
        ]);
        transcriptionPath = temporaryPath;
      }
      const uploaded = await this.client.files.upload({
        file: transcriptionPath,
        config: { mimeType: needsExtraction ? 'audio/mpeg' : input.mimeType ?? 'audio/mpeg' },
      });
      if (!uploaded.uri || !uploaded.mimeType)
        throw new AppError(
          'TRANSCRIPTION_FAILED',
          'Gemini did not return an uploaded media reference',
          502,
        );
      let media = uploaded;
      for (let attempt = 0; attempt < 30 && media.state !== 'ACTIVE'; attempt += 1) {
        if (media.state === 'FAILED')
          throw new AppError('TRANSCRIPTION_FAILED', media.error?.message ?? 'Gemini could not process the uploaded media', 502);
        if (!media.name) break;
        await sleep(1000);
        media = await this.client.files.get({ name: media.name });
      }
      if (media.state !== 'ACTIVE')
        throw new AppError('TRANSCRIPTION_FAILED', 'Gemini media processing timed out', 504);
      const response = await this.client.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { fileData: { fileUri: media.uri, mimeType: media.mimeType } },
              {
                text: `Transcribe this media${input.language ? ` in ${input.language}` : ''}. Return only JSON with this shape: {"text": string, "language": string, "durationSeconds": number, "words": [{"word": string, "start": number, "end": number}]}. Include every spoken word with timestamps in seconds.`,
              },
            ],
          },
        ],
        config: { responseMimeType: 'application/json' },
      });
      let data: {
        text: string;
        language?: string;
        durationSeconds?: number;
        words?: { word: string; start: number; end: number }[];
      };
      try {
        data = JSON.parse(response.text ?? '{}') as typeof data;
      } catch {
        throw new AppError('TRANSCRIPTION_FAILED', 'Gemini returned invalid JSON for the transcript', 502);
      }
      const parsed = TranscriptSchema.safeParse(data);
      if (!parsed.success)
        throw new AppError(
          'TRANSCRIPTION_FAILED',
          'Gemini returned an invalid transcript',
          502,
          parsed.error.issues,
        );
      return {
        text: parsed.data.text,
        language: parsed.data.language,
        durationSeconds: parsed.data.durationSeconds,
        words: parsed.data.words,
      };
    } finally {
      if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

export const checkFfmpeg = async (logger: {
  warn: (message: string) => void;
}) => {
  try {
    await runFfmpeg(['-version']);
  } catch {
    logger.warn(
      'ffmpeg is not installed; video and oversized transcription preprocessing is unavailable',
    );
  }
};
