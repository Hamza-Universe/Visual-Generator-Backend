CREATE TABLE "component_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scene_id" uuid NOT NULL,
	"component_definition_name" text NOT NULL,
	"group_id" uuid,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"transform" jsonb DEFAULT '{"rotation":0,"scaleX":1,"scaleY":1}'::jsonb NOT NULL,
	"style" jsonb DEFAULT '{"opacity":1}'::jsonb NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"z_index" integer DEFAULT 0 NOT NULL,
	"timing" jsonb DEFAULT '{"start":0,"duration":2}'::jsonb NOT NULL,
	"animation" jsonb DEFAULT '{"enter":[],"exit":[],"keyframes":[]}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scene_id" uuid NOT NULL,
	"parent_group_id" uuid,
	"name" text NOT NULL,
	"z_index" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scenes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"duration" real,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "component_instances" ADD CONSTRAINT "component_instances_scene_id_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."scenes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_instances" ADD CONSTRAINT "component_instances_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_scene_id_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."scenes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_parent_group_id_groups_id_fk" FOREIGN KEY ("parent_group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "component_instances_scene_id_idx" ON "component_instances" USING btree ("scene_id");--> statement-breakpoint
CREATE INDEX "component_instances_group_id_idx" ON "component_instances" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "component_instances_def_name_idx" ON "component_instances" USING btree ("component_definition_name");--> statement-breakpoint
CREATE INDEX "groups_scene_id_idx" ON "groups" USING btree ("scene_id");--> statement-breakpoint
CREATE INDEX "groups_parent_group_id_idx" ON "groups" USING btree ("parent_group_id");--> statement-breakpoint
CREATE INDEX "scenes_project_id_idx" ON "scenes" USING btree ("project_id");