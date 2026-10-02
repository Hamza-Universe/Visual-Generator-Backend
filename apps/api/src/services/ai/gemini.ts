import { GoogleGenAI } from '@google/genai';
import {
  CORE_SYSTEM_PROMPT,
  buildUserMessage,
  type AIProvider,
} from './provider.js';
import { AppError } from '../../errors.js';

export class GeminiProvider implements AIProvider {
  private readonly client: GoogleGenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
    client?: GoogleGenAI,
  ) {
    this.client = client ?? new GoogleGenAI({ apiKey });
  }

  async generate(
    input: Parameters<AIProvider['generate']>[0],
  ): Promise<unknown> {
    let theme: never;
    try {
      theme = JSON.parse(input.theme) as never;
    } catch {
      throw new AppError('INVALID_GENERATION', 'Invalid theme payload', 400);
    }
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: buildUserMessage({
        ...input,
        theme,
      }),
      config: {
        systemInstruction: `${input.system || CORE_SYSTEM_PROMPT}\n\nReturn only one JSON object.`,
        responseMimeType: 'application/json',
      },
    });
    const text = response.text;
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AppError(
        'INVALID_GENERATION',
        'Gemini returned invalid JSON',
        502,
      );
    }
  }
}