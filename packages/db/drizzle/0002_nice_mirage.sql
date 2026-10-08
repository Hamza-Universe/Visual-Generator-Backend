DROP INDEX IF EXISTS "component_instances_def_name_idx";--> statement-breakpoint
ALTER TABLE "component_instances" ADD COLUMN "component_definition_id" uuid;--> statement-breakpoint
ALTER TABLE "component_instances" ADD COLUMN "position" jsonb DEFAULT '{"x":0,"y":0}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "component_instances" ADD COLUMN "size" jsonb DEFAULT '{"width":100,"height":100}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "component_instances" SET "component_definition_id" = "components"."id" FROM "components" WHERE "components"."name" = "component_instances"."component_definition_name";--> statement-breakpoint
DELETE FROM "component_instances" WHERE "component_definition_id" IS NULL AND "component_definition_name" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "component_instances" ALTER COLUMN "component_definition_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "component_instances" DROP COLUMN "component_definition_name";--> statement-breakpoint
ALTER TABLE "component_instances" ADD CONSTRAINT "component_instances_component_definition_id_components_id_fk" FOREIGN KEY ("component_definition_id") REFERENCES "public"."components"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "component_instances_definition_id_idx" ON "component_instances" USING btree ("component_definition_id");
