ALTER TABLE "component_instances" DROP CONSTRAINT "component_instances_group_id_groups_id_fk";
--> statement-breakpoint
ALTER TABLE "component_instances" ADD CONSTRAINT "component_instances_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;