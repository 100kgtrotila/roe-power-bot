import { and, eq, isNull, lte, sql } from "drizzle-orm";
import type { AppDb } from "./client";
import { leases, operations } from "./schema";

function expiryAt(now: number, leaseMs: number): number {
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs <= 0 ||
    !Number.isSafeInteger(now + leaseMs)
  )
    throw new Error("Invalid lease duration");
  return now + leaseMs;
}
export async function claimOperation(
  db: AppDb,
  key: string,
  now: number,
  leaseMs: number,
): Promise<string | null> {
  const claimToken = crypto.randomUUID();
  const expiry = expiryAt(now, leaseMs);
  const rows = await db
    .insert(operations)
    .values({ key, claimToken, expiry })
    .onConflictDoUpdate({
      target: operations.key,
      set: { claimToken, expiry },
      setWhere: sql`${operations.completedAt} IS NULL AND ${operations.expiry} <= ${now}`,
    })
    .returning({ token: operations.claimToken });
  return rows[0]?.token ?? null;
}
export async function completeOperation(
  db: AppDb,
  key: string,
  claimToken: string,
): Promise<boolean> {
  const rows = await db
    .update(operations)
    .set({ completedAt: Date.now() })
    .where(
      and(
        eq(operations.key, key),
        eq(operations.claimToken, claimToken),
        isNull(operations.completedAt),
      ),
    )
    .returning({ key: operations.key });
  return rows.length === 1;
}
export async function claimLease(
  db: AppDb,
  resource: string,
  now: number,
  leaseMs: number,
): Promise<string | null> {
  const claimToken = crypto.randomUUID();
  const expiry = expiryAt(now, leaseMs);
  const rows = await db
    .insert(leases)
    .values({ resource, claimToken, expiry })
    .onConflictDoUpdate({
      target: leases.resource,
      set: { claimToken, expiry },
      setWhere: lte(leases.expiry, now),
    })
    .returning({ token: leases.claimToken });
  return rows[0]?.token ?? null;
}
export async function releaseLease(
  db: AppDb,
  resource: string,
  claimToken: string,
): Promise<void> {
  await db
    .delete(leases)
    .where(
      and(eq(leases.resource, resource), eq(leases.claimToken, claimToken)),
    );
}
export async function ownsLease(
  db: AppDb,
  resource: string,
  token: string,
  now: number,
): Promise<boolean> {
  return Boolean(
    await db
      .select({ resource: leases.resource })
      .from(leases)
      .where(
        and(
          eq(leases.resource, resource),
          eq(leases.claimToken, token),
          sql`${leases.expiry} > ${now}`,
        ),
      )
      .get(),
  );
}
