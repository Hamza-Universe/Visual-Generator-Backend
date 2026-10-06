-- Add projectId column to assets table
ALTER TABLE "assets" ADD COLUMN "project_id" UUID REFERENCES "projects"("id") ON DELETE CASCADE;

-- Create index for projectId
CREATE INDEX "assets_project_id_idx" ON "assets" ("project_id");