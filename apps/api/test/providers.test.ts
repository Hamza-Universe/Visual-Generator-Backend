import { describe, expect, it, vi } from 'vitest';
import { GeminiProvider } from '../src/services/ai/gemini.js';
import { ManualProvider } from '../src/services/ai/manual.js';

const input = {
  system: 'custom system',
  catalog: 'Label: text',
  theme: JSON.stringify({ palette: { text: '#000000' } }),
  transcript: 'Total duration: 1s',
  instructions: 'Keep it simple',
};

describe('AI providers', () => {
  it('uses Gemini JSON response mode', async () => {
    const generateContent = vi.fn(async () => ({ text: '{"version":1}' }));
    const provider = new GeminiProvider('test-key', 'gemini-test', {
      models: { generateContent },
    } as never);
    await provider.generate(input);
    const request = generateContent.mock.calls[0][0] as {
      model: string;
      config: { responseMimeType: string };
    };
    expect(request.model).toBe('gemini-test');
    expect(request.config.responseMimeType).toBe('application/json');
  });

  it('builds a self-contained manual prompt without making a network call', () => {
    const prompt = new ManualProvider().buildPromptText({
      components: [],
      theme: {
        background: { type: 'color', color: '#000000' },
        palette: {},
        fontFamily: 'Inter',
        speed: 1,
        defaultEasing: 'ease-out',
      },
      transcript: { durationSeconds: 1, words: [] },
      instructions: 'Use one visual',
    });
    expect(prompt).toContain('Use one visual');
    expect(prompt).toContain('Reply with ONLY a single JSON object');
    expect(prompt).toContain('JSON Schema:');
  });

});
