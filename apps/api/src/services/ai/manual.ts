import {
  CORE_SYSTEM_PROMPT,
  buildCatalog,
  buildTranscript,
  specJsonSchema,
} from './provider.js';
import type { RegistryComponent, Theme } from '@app/schema';
export class ManualProvider {
  buildPromptText(input: {
    components: RegistryComponent[];
    theme: Theme;
    transcript: {
      durationSeconds?: number;
      words: { word: string; start: number; end: number }[];
    };
    instructions?: string;
    maxComponents?: number | null;
  }) {
    return `${CORE_SYSTEM_PROMPT}\n\nComponent catalog:\n${buildCatalog(input.components)}\n\nCurrent theme:\n${JSON.stringify(input.theme)}\n\nTranscript:\n${buildTranscript(input.transcript)}\n\n${input.maxComponents === null || input.maxComponents === undefined ? '' : `Use at most ${input.maxComponents} scenes in total.\n`}${input.instructions ?? ''}\nReply with ONLY a single JSON object matching this exact shape. No markdown fences, no explanation, no text before or after the JSON.\nJSON Schema:\n${JSON.stringify(specJsonSchema)}`;
  }
}
