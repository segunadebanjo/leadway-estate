-- CreateEnum
CREATE TYPE "AdjustmentKind" AS ENUM ('REDUCE', 'REVERSE');

-- CreateTable
CREATE TABLE "BillAdjustment" (
    "id" SERIAL NOT NULL,
    "invoiceId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "kind" "AdjustmentKind" NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillAdjustment_userId_idx" ON "BillAdjustment"("userId");
CREATE INDEX "BillAdjustment_invoiceId_idx" ON "BillAdjustment"("invoiceId");

-- AddForeignKey
ALTER TABLE "BillAdjustment" ADD CONSTRAINT "BillAdjustment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BillAdjustment" ADD CONSTRAINT "BillAdjustment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BillAdjustment" ADD CONSTRAINT "BillAdjustment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
