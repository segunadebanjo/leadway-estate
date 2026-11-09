-- CreateEnum
CREATE TYPE "DebitNoteStatus" AS ENUM ('ISSUED', 'VOID');

-- CreateTable
CREATE TABLE "DebitNote" (
    "id" SERIAL NOT NULL,
    "noteNo" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "issueDate" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "message" TEXT,
    "status" "DebitNoteStatus" NOT NULL DEFAULT 'ISSUED',
    "voidReason" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DebitNote_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "debitNoteId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "DebitNote_noteNo_key" ON "DebitNote"("noteNo");
CREATE INDEX "DebitNote_userId_idx" ON "DebitNote"("userId");
CREATE INDEX "DebitNote_year_idx" ON "DebitNote"("year");
CREATE INDEX "Invoice_debitNoteId_idx" ON "Invoice"("debitNoteId");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_debitNoteId_fkey" FOREIGN KEY ("debitNoteId") REFERENCES "DebitNote"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DebitNote" ADD CONSTRAINT "DebitNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DebitNote" ADD CONSTRAINT "DebitNote_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
