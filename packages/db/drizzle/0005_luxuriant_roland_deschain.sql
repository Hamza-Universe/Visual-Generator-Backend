ALTER TABLE "components" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN "is_public" text DEFAULT 'false' NOT NULL;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "components_user_id_idx" ON "components" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "components_is_public_idx" ON "components" USING btree ("is_public");