import { z } from 'zod';
import {
  VideoSpecSchema,
  type RegistryComponent,
  type Theme,
  type Issue,
} from '@app/schema';
export interface AIProvider {
  generate(input: {
    system: string;
    catalog: string;
    theme: string;
    transcript: string;
    instructions?: string;
    previousAttempt?: { spec: unknown; issues: Issue[] };
  }): Promise<unknown>;
}
export const CORE_SYSTEM_PROMPT = `You turn a spoken transcript into a JSON animation spec for an explainer video.\n\nRules:\n1. Use only components from the catalog. Never invent a component name.\n2. Every scene needs a unique id made of letters, numbers, dash or underscore. Start with a letter.\n3. Times are in seconds. Set "at" from the start time of the spoken word that the visual is about. A visual may appear up to 0.3 seconds before the word, never after it. Add a "trigger" with that word.\n4. Keep every scene inside the video: at + duration must not be more than meta.durationInSeconds. Set meta.durationInSeconds to the audio duration.\n5. Use positions from the anchor list. Use offsetX and offsetY (percent) only for small adjustments. Do not place scenes on top of each other unless one is meant to sit on another.\n6. For components that connect things, use the ids of scenes that exist in your output.\n7. Use only enter and exit styles listed for that component.\n8. Colors: use "palette:name" with names from the theme palette. Use a hex color only when the user asks for it.\n9. Prefer few, clear visuals. Do not add a visual for every sentence. One idea, one visual.\n10. Do not change the theme.`;
export const buildCatalog = (components: RegistryComponent[]) =>
  components
    .map(
      (component) =>
        `${component.name}: ${component.description}\nprops=${JSON.stringify(component.propsSchema)} defaults=${JSON.stringify(component.defaultProps)} enter=${component.enterStyles.join(',')} exit=${component.exitStyles.join(',')} refs=${component.refProps.join(',')} colors=${component.colorProps.join(',')} assets=${component.assetProps.join(',')}`,
    )
    .join('\n');
export const buildTranscript = (transcript: {
  durationSeconds?: number;
  words: { word: string; start: number; end: number }[];
}) => {
  const lines: string[] = [];
  for (let index = 0; index < transcript.words.length; index += 12) {
    const group = transcript.words.slice(index, index + 12);
    if (group.length)
      lines.push(
        `[${group[0].start.toFixed(2)}] ${group.map((word) => word.word).join(' ')}`,
      );
  }
  return `Total duration: ${transcript.durationSeconds ?? 0}s\n${lines.join('\n')}`;
};
export const buildUserMessage = (input: {
  catalog: string;
  theme: Theme;
  transcript: string;
  instructions?: string;
  maxComponents?: number | null;
  previousAttempt?: { spec: unknown; issues: Issue[] };
}) =>
  `${input.catalog}\n\nCurrent theme:\n${JSON.stringify(input.theme)}\n\nTranscript:\n${input.transcript}\n\n${input.maxComponents === null || input.maxComponents === undefined ? '' : `Use at most ${input.maxComponents} scenes in total.\n`}${input.instructions ?? ''}\n${input.previousAttempt ? `Previous output: ${JSON.stringify(input.previousAttempt.spec)}\nIssues: ${JSON.stringify(input.previousAttempt.issues)}\n` : ''}`;
export const specJsonSchema = z.toJSONSchema(VideoSpecSchema);
