import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { type Api, GrammyError } from "grammy";
import type { AppDb } from "../db/client";
import {
  deliveries,
  notificationState,
  reminderReceipts,
  subscribers,
} from "../db/schema";
import { getSubscriber } from "../db/subscriptions";
import type { NotificationState } from "./changes";
import type { DeliveryPayload, ReminderReceipt } from "./model";

export interface DeliveryIntent extends DeliveryPayload {
  key: string;
  telegramId: string;
  kind: "change" | "reminder" | "direct";
  dueAt: number;
  subscriberRevision: number;
  expiresAt: number;
}
export type QueuedDelivery = typeof deliveries.$inferSelect;
/** Reflow is safe before sending; accepted parts must keep their exact boundaries. */
export function canContinueDelivery(
  row: Readonly<QueuedDelivery>,
  payload: DeliveryPayload | null,
): payload is DeliveryPayload {
  return (
    payload !== null &&
    payload.parts.length > 0 &&
    (row.partCursor === 0 ||
      (payload.parts.length === row.payload.parts.length &&
        payload.parts
          .slice(0, row.partCursor)
          .every((part, index) => part === row.payload.parts[index])))
  );
}
/** Must inspect latest snapshot/source; null cancels obsolete content. Called before EVERY part.
 * Return updated stale-warning text with the same group size and confirmation metadata. */
export type RevalidateDelivery = (
  delivery: Readonly<QueuedDelivery>,
  now: number,
) => Promise<DeliveryPayload | null>;
export interface DeliveryOptions {
  revalidate?: RevalidateDelivery;
  maxParts?: number;
  maxDeliveries?: number;
  /** Injectable wall clock for deterministic lease-expiry tests. Defaults to elapsed real time. */
  clock?: () => number;
}
const LEASE_MS = 60000;
const RETRY_MS = 30000;
const MAX_ATTEMPTS = 8;

export async function enqueueDelivery(
  db: AppDb,
  intent: DeliveryIntent,
): Promise<void> {
  if (
    !intent.key ||
    intent.parts.length === 0 ||
    intent.parts.some((p) => !p || p.length > 4096) ||
    intent.expiresAt <= intent.dueAt
  )
    throw new Error("Invalid delivery intent");
  const {
    key,
    telegramId,
    kind,
    dueAt,
    subscriberRevision,
    expiresAt,
    ...payload
  } = intent;
  await db
    .insert(deliveries)
    .values({
      key,
      telegramId,
      type: kind,
      dueAt,
      revision: subscriberRevision,
      expiresAt,
      payload,
      status: "pending",
    })
    .onConflictDoNothing();
}
export async function loadNotificationState(
  db: AppDb,
  telegramId: string,
): Promise<NotificationState | null> {
  const rows = await db
    .select()
    .from(notificationState)
    .where(eq(notificationState.telegramId, telegramId));
  return rows.length
    ? Object.fromEntries(rows.map((r) => [r.date, r.baseline]))
    : null;
}
export async function loadReminderReceipts(
  db: AppDb,
  telegramId: string,
): Promise<ReminderReceipt[]> {
  return db
    .select({
      date: reminderReceipts.date,
      queue: reminderReceipts.queue,
      start: reminderReceipts.start,
      generation: reminderReceipts.generation,
    })
    .from(reminderReceipts)
    .where(eq(reminderReceipts.telegramId, telegramId));
}
function owner(row: QueuedDelivery, token: string, now: number) {
  return and(
    eq(deliveries.key, row.key),
    eq(deliveries.claimToken, token),
    eq(deliveries.status, "pending"),
    sql`${deliveries.claimExpiry} > ${now}`,
  );
}
/** Atomic full-group confirmation, fenced by ownership AND current subscription revision.
 * Telegram acceptance and this commit cannot be atomic: a crash between them can repeat a part. */
async function confirm(
  db: AppDb,
  row: QueuedDelivery,
  token: string,
  now: number,
): Promise<void> {
  const guard = `EXISTS (SELECT 1 FROM deliveries d JOIN subscribers s ON s.telegram_id=d.telegram_id WHERE d.key=? AND d.claim_token=? AND d.claim_expiry>? AND d.status='pending' AND d.part_cursor=? AND s.revision=d.revision)`;
  const args = [row.key, token, now, row.payload.parts.length];
  const statements: D1PreparedStatement[] = [];
  const baselines = { ...row.payload.baselines };
  if (row.payload.baseline)
    baselines[row.payload.baseline.date] = row.payload.baseline.value;
  for (const [date, value] of Object.entries(baselines))
    statements.push(
      db.$client
        .prepare(
          `INSERT INTO notification_state(telegram_id,date,baseline) SELECT ?,?,? WHERE ${guard} ON CONFLICT(telegram_id,date) DO UPDATE SET baseline=excluded.baseline`,
        )
        .bind(row.telegramId, date, JSON.stringify(value), ...args),
    );
  const receipts = [
    ...(row.payload.receipts ?? []),
    ...(row.payload.receipt ? [row.payload.receipt] : []),
  ];
  for (const r of receipts)
    statements.push(
      db.$client
        .prepare(
          `INSERT OR IGNORE INTO reminder_receipts(telegram_id,date,queue,start,generation) SELECT ?,?,?,?,? WHERE ${guard}`,
        )
        .bind(row.telegramId, r.date, r.queue, r.start, r.generation, ...args),
    );
  statements.push(
    db.$client
      .prepare(
        `UPDATE deliveries SET status='sent',claim_token=NULL,claim_expiry=NULL WHERE key=? AND ${guard}`,
      )
      .bind(row.key, ...args),
  );
  await db.$client.batch(statements);
}
export async function deliverDue(
  db: AppDb,
  api: Api,
  allowedIds: ReadonlySet<string>,
  now: number,
  options: DeliveryOptions = {},
): Promise<void> {
  const started = Date.now();
  const clock = options.clock ?? (() => now + Date.now() - started);
  const maxParts = options.maxParts ?? 50;
  let sentParts = 0;
  const due = await db
    .select()
    .from(deliveries)
    .where(and(eq(deliveries.status, "pending"), lte(deliveries.dueAt, now)))
    .orderBy(deliveries.dueAt, deliveries.key)
    .limit(options.maxDeliveries ?? 50);
  for (const candidate of due) {
    if (sentParts >= maxParts) return;
    const token = crypto.randomUUID();
    const claimed = await db
      .update(deliveries)
      .set({ claimToken: token, claimExpiry: clock() + LEASE_MS })
      .where(
        and(
          eq(deliveries.key, candidate.key),
          lte(deliveries.dueAt, clock()),
          eq(deliveries.status, "pending"),
          or(
            isNull(deliveries.claimToken),
            lte(deliveries.claimExpiry, clock()),
          ),
        ),
      )
      .returning();
    const row = claimed[0];
    if (!row) continue;
    const cancel = async () => {
      await db
        .update(deliveries)
        .set({ status: "cancelled", claimToken: null, claimExpiry: null })
        .where(owner(row, token, clock()));
    };
    try {
      while (true) {
        const subscriber = await getSubscriber(db, row.telegramId);
        if (
          !allowedIds.has(row.telegramId) ||
          !subscriber ||
          subscriber.revision !== row.revision ||
          row.expiresAt <= clock() ||
          ((row.type === "change" || row.type === "update") &&
            !subscriber.updatesEnabled) ||
          (row.type === "reminder" && !subscriber.remindersEnabled)
        ) {
          await cancel();
          break;
        }
        if (options.revalidate) {
          const payload = await options.revalidate(row, clock());
          if (!canContinueDelivery(row, payload)) {
            await cancel();
            break;
          }
          row.payload = payload;
        }
        const renewed = await db
          .update(deliveries)
          .set({ payload: row.payload, claimExpiry: clock() + LEASE_MS })
          .where(owner(row, token, clock()))
          .returning({ key: deliveries.key });
        if (!renewed.length) break;
        if (row.partCursor === row.payload.parts.length) {
          await confirm(db, row, token, clock());
          break;
        }
        if (sentParts >= maxParts) {
          // Persisted cursor resumes on the next invocation without waiting for expiry.
          await db
            .update(deliveries)
            .set({ claimToken: null, claimExpiry: null })
            .where(owner(row, token, clock()));
          return;
        }
        const part = row.payload.parts[row.partCursor];
        if (part === undefined) throw new Error("Invalid delivery cursor");
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            api.sendMessage(row.telegramId, part, {
              link_preview_options: { is_disabled: true },
              ...(row.partCursor === row.payload.parts.length - 1 &&
              row.payload.replyMarkup
                ? { reply_markup: row.payload.replyMarkup }
                : {}),
            }),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error("Delivery timeout")),
                15000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
        const advanced = await db
          .update(deliveries)
          .set({ partCursor: row.partCursor + 1 })
          .where(
            and(
              owner(row, token, clock()),
              eq(deliveries.partCursor, row.partCursor),
            ),
          )
          .returning({ cursor: deliveries.partCursor });
        if (!advanced[0]) break;
        row.partCursor = advanced[0].cursor;
        sentParts++;
      }
    } catch (error: unknown) {
      const blocked = error instanceof GrammyError && error.error_code === 403;
      const delay =
        error instanceof GrammyError && error.error_code === 429
          ? Math.max(RETRY_MS, (error.parameters.retry_after ?? 30) * 1000)
          : RETRY_MS;
      if (blocked) {
        // CAS prevents an older attempt from overwriting a newer user preference.
        await db
          .update(subscribers)
          .set({
            updatesEnabled: false,
            remindersEnabled: false,
            revision: row.revision + 1,
          })
          .where(
            and(
              eq(subscribers.telegramId, row.telegramId),
              eq(subscribers.revision, row.revision),
              sql`EXISTS (SELECT 1 FROM deliveries WHERE key=${row.key} AND claim_token=${token} AND claim_expiry>${clock()})`,
            ),
          );
      }
      await db
        .update(deliveries)
        .set({
          status:
            blocked || row.attempts + 1 >= MAX_ATTEMPTS
              ? "cancelled"
              : "pending",
          attempts: row.attempts + 1,
          dueAt: clock() + delay,
          claimToken: null,
          claimExpiry: null,
        })
        .where(owner(row, token, clock()));
    }
  }
}
