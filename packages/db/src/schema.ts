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
  isPublic: text('is_public').default('false').notNull(),
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
    status: text('status').notNull(),
    progress: integer('progress').default(0).notNull(),
    specSnapshot: jsonb('spec_snapshot').notNull(),
    outputAssetId: uuid('output_asset_id').references(() => assets.id),
    error: text('error'),
    ...timestamps,
  },
  (table) => ({
    projectIndex: index('renders_project_id_idx').on(table.projectId),
  }),
);
