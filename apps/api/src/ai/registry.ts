import { or, eq } from 'drizzle-orm';
import { components } from '@app/db';
import type { Database } from '@app/db';

/**
 * Component registry access for the AI harness (Stage 4A).
 *
 * Returns every definition the user may see (public + own);
 * authorization filtering happens in the context builder via the
 * existing `isComponentVisibleToUser` rule. Single source: the
 * database registry — never a hand-maintained duplicate list.
 */
export interface AIRegistryDefinition {
  id: string;
  name: string;
  description: string;
  propsSchema: Record<string, unknown>;
  defaultProps: Record<string, unknown>;
  refProps: string[];
  enterStyles: string[];
  exitStyles: string[];
  colorProps: string[];
  assetProps: string[];
  userId: string | null;
  isPublic: boolean;
}

export const listDefinitionsForAI = async (
  db: Database,
  userId: string,
): Promise<AIRegistryDefinition[]> => {
  const rows = await db
    .select({
      id: components.id,
      name: components.name,
      description: components.description,
      propsSchema: components.propsSchema,
      defaultProps: components.defaultProps,
      refProps: components.refProps,
      enterStyles: components.enterStyles,
      exitStyles: components.exitStyles,
      colorProps: components.colorProps,
      assetProps: components.assetProps,
      userId: components.userId,
      isPublic: components.isPublic,
    })
    .from(components)
    .where(or(eq(components.isPublic, true), eq(components.userId, userId)));
  return rows.map((row) => ({
    ...row,
    propsSchema: (row.propsSchema ?? {}) as Record<string, unknown>,
    defaultProps: (row.defaultProps ?? {}) as Record<string, unknown>,
    refProps: row.refProps ?? [],
    enterStyles: row.enterStyles ?? [],
    exitStyles: row.exitStyles ?? [],
    colorProps: row.colorProps ?? [],
    assetProps: row.assetProps ?? [],
  }));
};
