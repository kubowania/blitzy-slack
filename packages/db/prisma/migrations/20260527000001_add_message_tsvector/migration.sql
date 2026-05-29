-- Add a generated tsvector column for full-text search per AAP §0.4.4.
-- The column is STORED so PostgreSQL can serve queries via the GIN index
-- without recomputing tsvector on every read.

ALTER TABLE "Message"
  ADD COLUMN "contentSearch" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED;

-- GIN index supports tsquery '@@' operator efficiently.
CREATE INDEX "Message_contentSearch_idx" ON "Message" USING GIN ("contentSearch");
