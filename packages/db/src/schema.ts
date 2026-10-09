import {
  bigint,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
  index,
  uniqueIndex,
  boolean,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
};
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  // Additive (0005). 'user' for everyone existing; 'admin' is granted explicitly.
  role: text('role').default('user').notNull(),
  ...timestamps,
});
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    userIndex: index('password_reset_tokens_user_id_idx').on(table.userId),
  }),
);
export const projects = pgTable('projects',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    spec: jsonb('spec').notNull(),
    maxComponents: integer('max_components'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    // Additive (0005). Existing projects default to landscape, the current behavior.
    aspect: text('aspect').default('landscape').notNull(),
    ...timestamps,
  },
  (table) => ({ userIndex: index('projects_user_id_idx').on(table.userId) }),
);
export const components = pgTable('components', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').unique().notNull(),
  displayName: text('display_name').notNull(),
  description: text('description').notNull(),
  propsSchema: jsonb('props_schema').notNull(),
  defaultProps: jsonb('default_props').default({}).notNull(),
  enterStyles: text('enter_styles').array().notNull(),
  exitStyles: text('exit_styles').array().default([]).notNull(),
  colorProps: text('color_props').array().default([]).notNull(),
  refProps: text('ref_props').array().default([]).notNull(),
  assetProps: text('asset_props').array().default([]).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  isPublic: boolean('is_public').default(false).notNull(),
  ...timestamps,
}, (table) => ({
  userIndex: index('components_user_id_idx').on(table.userId),
  publicIndex: index('components_is_public_idx').on(table.isPublic),
}));
export const assets = pgTable(
  'assets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    kind: text('kind').notNull(),
    originalName: text('original_name').notNull(),
    storageKey: text('storage_key').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    durationSeconds: real('duration_seconds'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    createdAt: timestamps.createdAt,
  },
  (table) => ({
    userIndex: index('assets_user_id_idx').on(table.userId),
    projectIndex: index('assets_project_id_idx').on(table.projectId),
  }),
);
export const scenes = pgTable(
  'scenes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    duration: real('duration'),
    meta: jsonb('meta'),
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  },
  (table) => ({
    projectIndex: index('scenes_project_id_idx').on(table.projectId),
  }),
);
export const componentInstances = pgTable(
  'component_instances',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sceneId: uuid('scene_id')
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    componentDefinitionId: uuid('component_definition_id')
      .notNull()
      .references(() => components.id, { onDelete: 'restrict' }),
  groupId: uuid('group_id').references(() => groups.id, { onDelete: 'set null' }),
    props: jsonb('props').default({}).notNull(),
    position: jsonb('position').default({ x: 0, y: 0 }).notNull(),
    size: jsonb('size').default({ width: 100, height: 100 }).notNull(),
    transform: jsonb('transform').default({ rotation: 0, scaleX: 1, scaleY: 1 }).notNull(),
    style: jsonb('style').default({ opacity: 1 }).notNull(),
    visible: boolean('visible').default(true).notNull(),
    zIndex: integer('z_index').default(0).notNull(),
    timing: jsonb('timing').default({ start: 0, duration: 2 }).notNull(),
    animation: jsonb('animation').default({ enter: [], exit: [], keyframes: [] }).notNull(),
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  },
  (table) => ({
    sceneIndex: index('component_instances_scene_id_idx').on(table.sceneId),
    groupIndex: index('component_instances_group_id_idx').on(table.groupId),
    definitionIndex: index('component_instances_definition_id_idx').on(table.componentDefinitionId),
  }),
);
export const groups = pgTable(
  'groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sceneId: uuid('scene_id')
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
   parentGroupId: uuid('parent_group_id').references((): AnyPgColumn => groups.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    zIndex: integer('z_index').default(0).notNull(),
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  },
  (table) => ({
    sceneIndex: index('groups_scene_id_idx').on(table.sceneId),
    parentGroupIndex: index('groups_parent_group_id_idx').on(table.parentGroupId),
  }),
);
export const transcripts = pgTable(
  'transcripts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    language: text('language'),
    text: text('text').notNull(),
    words: jsonb('words').notNull(),
    durationSeconds: real('duration_seconds'),
    createdAt: timestamps.createdAt,
  },
  (table) => ({
    assetIndex: index('transcripts_asset_id_idx').on(table.assetId),
  }),
);
export const assetShareLinks = pgTable(
  'asset_share_links',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    assetIndex: index('asset_share_links_asset_id_idx').on(table.assetId),
    userIndex: index('asset_share_links_user_id_idx').on(table.userId),
  }),
);
export const renders = pgTable(
  'renders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Stage 3F: which scene a scene-document render belongs to (null for
    // legacy VideoSpec rows). SET NULL preserves history when a scene is
    // deleted.
    sceneId: uuid('scene_id').references(() => scenes.id, {
      onDelete: 'set null',
    }),
    // Stage 3F: optional client-provided idempotency key for duplicate
    // protection. Guarded at the application level (non-terminal match on
    // scene + key returns the existing row); no unique constraint so
    // legitimate repeat renders always remain possible.
    clientKey: text('client_key'),
    status: text('status').notNull(),
    progress: integer('progress').default(0).notNull(),
    specSnapshot: jsonb('spec_snapshot').notNull(),
    outputAssetId: uuid('output_asset_id').references(() => assets.id),
    error: text('error'),
    // Stage 3F: lifecycle timestamps (null until the transition happens).
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    projectIndex: index('renders_project_id_idx').on(table.projectId),
    sceneIndex: index('renders_scene_id_idx').on(table.sceneId),
  }),
);

/**
 * Additive (0005/0006): plans, entitlements, usage, access grants, discount codes.
 * No payment provider is modelled here. Entitlements are enforced from these
 * rows so a provider can be added later without schema changes.
 */
export const plans = pgTable('plans', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Monthly render quota; null means unlimited. */
  monthlyRenderLimit: integer('monthly_render_limit'),
  /** Monthly AI operation quota; null means unlimited. */
  monthlyAiLimit: integer('monthly_ai_limit'),
  maxProjects: integer('max_projects'),
  ...timestamps,
});

export const userEntitlements = pgTable(
  'user_entitlements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'restrict' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    userIndex: index('user_entitlements_user_id_idx').on(table.userId),
  }),
);

export const usageCounters = pgTable(
  'usage_counters',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'render' | 'ai' */
    metric: text('metric').notNull(),
    /** First instant of the counted period (UTC month start). */
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    count: integer('count').default(0).notNull(),
    ...timestamps,
  },
  (table) => ({
    userPeriodUnique: uniqueIndex('usage_counters_user_metric_period_uq').on(
      table.userId,
      table.metric,
      table.periodStart,
    ),
  }),
);

export const accessGrants = pgTable(
  'access_grants',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'restrict' }),
    grantedByUserId: uuid('granted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    reason: text('reason'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    userIndex: index('access_grants_user_id_idx').on(table.userId),
  }),
);

export const discountCodes = pgTable('discount_codes', {
  id: uuid('id').defaultRandom().primaryKey(),
  /** Stored normalised (upper-case, trimmed). Unique. */
  code: text('code').notNull().unique(),
  planId: text('plan_id')
    .notNull()
    .references(() => plans.id, { onDelete: 'restrict' }),
  /** Free-period length granted on redemption, in days. */
  durationDays: integer('duration_days').notNull(),
  maxRedemptions: integer('max_redemptions'),
  redemptionCount: integer('redemption_count').default(0).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  ...timestamps,
});

export const discountRedemptions = pgTable(
  'discount_redemptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    discountCodeId: uuid('discount_code_id')
      .notNull()
      .references(() => discountCodes.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    oneRedemptionPerUser: uniqueIndex('discount_redemptions_code_user_uq').on(
      table.discountCodeId,
      table.userId,
    ),
  }),
);
