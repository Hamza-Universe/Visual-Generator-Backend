/**
 * Manual live smoke test for the Stage 4B bounded agent.
 *
 * Seeds a temporary scene (title + overlapping equation), runs ONE bounded
 * agent request through the real database and the real provider, prints the
 * outcome, and always cleans up the seeded rows. The automated test suite
 * never runs this script (no key required, no free-tier requests burned).
 *
 * Usage:
 *   OPENROUTER_API_KEY=... DATABASE_URL=... pnpm --filter @app/api exec tsx scripts/agent-smoke.ts
 *
 * Exit codes: 0 = completed with verification passed, 1 = non-completed
 * status (printed), 2 = missing OPENROUTER_API_KEY or DATABASE_URL.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  createDb,
  componentInstances,
  components,
  groups,
  projects,
  scenes,
  users,
} from '@app/db';
import { runSceneAgent } from '../src/ai/agent.js';
import { createSceneAIProvider } from '../src/ai/provider.js';
import { listDefinitionsForAI } from '../src/ai/registry.js';

const apiKey = process.env.OPENROUTER_API_KEY ?? '';
const databaseUrl = process.env.DATABASE_URL ?? '';
if (!apiKey || !databaseUrl) {
  console.log(
    '[agent-smoke] OPENROUTER_API_KEY and DATABASE_URL are required; skipping live test.',
  );
  process.exit(2);
}

const suffix = Date.now().toString(36);
const labelName = `SmokeLabel_${suffix}`;

const main = async () => {
  const db = createDb(databaseUrl);
  const userId = randomUUID();
  const labelId = randomUUID();
  const titleId = randomUUID();
  const equationId = randomUUID();
  let projectId = '';
  let sceneId = '';

  try {
    // -- seed: user → project → scene → definition → overlapping instances --
    await db.insert(users).values({
      id: userId,
      name: 'Agent smoke',
      email: `agent-smoke-${suffix}@example.com`,
      passwordHash: 'smoke',
    });
    const [project] = await db
      .insert(projects)
      .values({ name: `Agent smoke ${suffix}`, spec: {}, userId })
      .returning();
    projectId = project.id;
    const [scene] = await db
      .insert(scenes)
      .values({ projectId, name: 'Agent smoke scene' })
      .returning();
    sceneId = scene.id;
    await db.insert(components).values({
      id: labelId,
      name: labelName,
      displayName: 'Smoke Label',
      description: 'Temporary definition created by the agent smoke test',
      propsSchema: {
        type: 'object',
        properties: { text: { type: 'string' }, fontSize: { type: 'number' } },
      },
      defaultProps: { text: 'Label', fontSize: 16 },
      enterStyles: [],
      exitStyles: [],
      colorProps: [],
      refProps: [],
      assetProps: [],
      userId,
      isPublic: false,
    });
    await db.insert(componentInstances).values([
      {
        id: titleId,
        sceneId,
        componentDefinitionId: labelId,
        props: { text: 'Title', fontSize: 24 },
        position: { x: 100, y: 100 },
        size: { width: 300, height: 40 },
      },
      {
        id: equationId,
        sceneId,
        componentDefinitionId: labelId,
        props: { text: 'F = ma', fontSize: 24 },
        position: { x: 100, y: 120 },
        size: { width: 220, height: 48 },
      },
    ]);
    console.log('[agent-smoke] seeded scene', sceneId, '(title y=100, equation y=120 — overlapping)');

    const provider = createSceneAIProvider({
      apiKey,
      model: process.env.OPENROUTER_MODEL || 'openrouter/free',
      ...(process.env.OPENROUTER_BASE_URL
        ? { baseUrl: process.env.OPENROUTER_BASE_URL }
        : {}),
    });
    const definitions = await listDefinitionsForAI(db, userId);

    // -- one bounded agent request through the real application path --
    const result = await runSceneAgent({
      db,
      sceneId,
      userId,
      prompt: 'Move the equation below the title so they do not overlap.',
      provider,
      definitions,
    });

    console.log('[agent-smoke] status:      ', result.status);
    console.log(
      '[agent-smoke] iterations:  ',
      result.iterations,
      '| tool calls:',
      result.toolCalls,
      '| model calls:',
      result.modelCalls,
    );
    console.log(
      '[agent-smoke] plans:       ',
      result.plans.length,
      '| applied operations:',
      JSON.stringify(result.appliedOperations),
    );
    console.log(
      '[agent-smoke] verification:',
      JSON.stringify(result.verification),
    );
    console.log(
      '[agent-smoke] failure:     ',
      result.failure ? `${result.failure.code}: ${result.failure.message}` : 'none',
    );
    console.log(
      '[agent-smoke] final positions:',
      result.document.components
        .map((c) => `${String((c.props ?? {}).text)}=(${c.position.x},${c.position.y})`)
        .join(' '),
    );
    console.log('[agent-smoke] usage:       ', JSON.stringify(result.meta.usage ?? {}));

    const verified = result.status === 'completed' && result.verification?.passed === true;
    process.exitCode = verified ? 0 : 1;
  } finally {
    // -- cleanup: always remove the temporary rows --
    try {
      if (sceneId) {
        await db.delete(componentInstances).where(eq(componentInstances.sceneId, sceneId));
        await db.delete(groups).where(eq(groups.sceneId, sceneId));
        await db.delete(scenes).where(eq(scenes.id, sceneId));
      }
      await db.delete(components).where(eq(components.name, labelName));
      if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
      await db.delete(users).where(eq(users.id, userId));
      console.log('[agent-smoke] cleaned up seeded rows');
    } catch (error) {
      console.error('[agent-smoke] cleanup failed:', error);
    }
  }
};

main().catch((error) => {
  console.error('[agent-smoke] failed:', error);
  process.exitCode = 1;
});
