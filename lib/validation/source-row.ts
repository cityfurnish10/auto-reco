// Zod guards for connector output. Connectors parse messy external data (Mongo
// docs, sheet cells, OCR text); running rows through sourceRowSchema before the
// engine drops malformed entries instead of letting them corrupt a run.

import { z } from "zod";
import type { CityTaggedRow } from "../connectors/types";

const strOrNum = z.union([z.string(), z.number()]);

export const cityTaggedRowSchema = z.object({
  source: z.enum(["PHYSICAL", "SHEET", "DT", "ODOO"]),
  city: z.enum(["DELHI", "MUMBAI", "PUNE", "HYDERABAD", "BANGALORE"]),
  direction: z.enum(["IN", "OUT"]),
  barcode: z.string().min(1),
  status: z.string().optional(),
  date: strOrNum.optional(),
  createdOn: strOrNum.optional(),
  movementDate: strOrNum.optional(),
  soNumber: z.string().optional(),
  ticketId: z.string().optional(),
  customer: z.string().optional(),
  product: z.string().optional(),
  jobType: z.string().optional(),
});

// Keep only rows that parse; return the valid set plus a dropped count for logs.
export function validateRows(rows: unknown[]): {
  valid: CityTaggedRow[];
  dropped: number;
} {
  const valid: CityTaggedRow[] = [];
  let dropped = 0;
  for (const r of rows) {
    const parsed = cityTaggedRowSchema.safeParse(r);
    if (parsed.success) valid.push(parsed.data as CityTaggedRow);
    else dropped++;
  }
  return { valid, dropped };
}
