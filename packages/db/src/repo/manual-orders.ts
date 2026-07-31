import { and, eq } from 'drizzle-orm';
import {
  manualOrders,
  type ManualOrderInsert,
  type ManualOrderRow,
} from '../schema/manual-orders.js';
import type { ProfileScope } from './_scoped.js';

export async function findByBinanceOrderId(
  scope: ProfileScope,
  binanceOrderId: bigint,
): Promise<ManualOrderRow | null> {
  const rows = await scope.db
    .select()
    .from(manualOrders)
    .where(
      and(
        eq(manualOrders.profileId, scope.profileId),
        eq(manualOrders.binanceOrderId, binanceOrderId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function upsert(
  scope: ProfileScope,
  input: Omit<ManualOrderInsert, 'profileId'>,
): Promise<ManualOrderRow> {
  const [row] = await scope.db
    .insert(manualOrders)
    .values({ ...input, profileId: scope.profileId })
    .onConflictDoUpdate({
      target: [manualOrders.profileId, manualOrders.binanceOrderId],
      set: { status: input['status'], raw: input['raw'] },
    })
    .returning();
  if (!row) throw new Error('manual-orders.upsert: insert returned no rows');
  return row;
}
