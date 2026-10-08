ALTER TABLE "renders" ADD COLUMN "scene_id" uuid;--> statement-breakpoint
ALTER TABLE "renders" ADD COLUMN "client_key" text;--> statement-breakpoint
ALTER TABLE "renders" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "renders" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_scene_id_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."scenes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "renders_scene_id_idx" ON "renders" USING btree ("scene_id");