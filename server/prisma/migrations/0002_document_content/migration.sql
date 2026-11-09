-- Uploaded documents are stored in the database, so the app needs no persistent disk.
ALTER TABLE "Document" ADD COLUMN "content" BYTEA;
