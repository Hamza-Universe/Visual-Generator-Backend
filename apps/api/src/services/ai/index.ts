import type { AIProvider } from './provider.js';
import { GeminiProvider } from './gemini.js';
export const createAIProvider = (input: {
  provider: string;
  apiKey: string;
  model: string;
}): AIProvider => {
  if (!input.apiKey || !input.model) throw new Error('MISSING_CONFIG');
  if (input.provider === 'gemini')
    return new GeminiProvider(input.apiKey, input.model);
  throw new Error(`Unsupported AI provider ${input.provider}`);
};
export type { AIProvider } from './provider.js';
export { ManualProvider } from './manual.js';
