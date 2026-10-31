import { and, eq, gt } from "drizzle-orm";
import { Api } from "grammy";
import { parseAllowedIds } from "./config";
import { createDb } from "./db/client";
import { claimLease, ownsLease, releaseLease } from "./db/operations";
import { loadSnapshot, loadSourceState } from "./db/schedule";
import { deliveries, schedulerState, subscribers } from "./db/schema";
import type { Env } from "./index";
import { getScheduleView, planChanges } from "./notifications/changes";
import {
  deliverDue,
  loadNotificationState,
  loadReminderReceipts,
} from "./notifications/delivery";
import { renderReminder, renderSchedule } from "./notifications/messages";
import type { DeliveryPayload } from "./notifications/model";
import { planReminders } from "./notifications/reminders";
import { revalidateDelivery } from "./notifications/revalidate";
import { refreshScheduleIfDue } from "./schedule/source";
import { getKyivDates, getOutageStart } from "./schedule/time";

interface SchedulerOptions {
  api?: Api;
  fetcher?: typeof fetch;
  clock?: () => number;
}
const PAGE_SIZE = 5;
const LEASE_MS = 55000;

/** Scheduled time is informational: after downtime, decisions use actual current time. */
export async function runScheduled(
  env: Env,
  _scheduledTime: number,
  options: SchedulerOptions = {},
): Promise<void> {
  if (!env.DB || !env.BOT_TOKEN?.trim()) return;
  const clock = options.clock ?? Date.now;
  const db = createDb(env.DB);
  const token = await claimLease(db, "scheduler", clock(), LEASE_MS);
  if (!token) return;
  const allowed = parseAllowedIds(env.ALLOWED_TELEGRAM_IDS);
  const valid = () => ownsLease(db, "scheduler", token, clock());
  const validate = revalidateDelivery(db);
  const guard =
    "EXISTS (SELECT 1 FROM leases WHERE resource='scheduler' AND claim_token=? AND expiry>?)";
  try {
    await refreshScheduleIfDue(db, clock(), options.fetcher ?? fetch);
    const cursor = (await db.select().from(schedulerState).get())?.cursor ?? "";
    let page = await db
      .select()
      .from(subscribers)
      .where(gt(subscribers.telegramId, cursor))
      .orderBy(subscribers.telegramId)
      .limit(PAGE_SIZE);
    if (!page.length && cursor)
      page = await db
        .select()
        .from(subscribers)
        .orderBy(subscribers.telegramId)
        .limit(PAGE_SIZE);
    for (const subscriber of page) {
      if (!(await valid())) return;
      const now = clock();
      if (subscriber.selection && allowed.has(subscriber.telegramId)) {
        const snapshot = await loadSnapshot(db);
        if (snapshot) {
          const source = await loadSourceState(db);
          const view = getScheduleView(
            snapshot,
            subscriber.selection,
            now,
            source,
          );
          const receipts = await loadReminderReceipts(
            db,
            subscriber.telegramId,
          );
          // Retire removed starts, not changed ends; a restored start is eligible again.
          for (const receipt of receipts) {
            const schedule = view.days.find((day) => day.date === receipt.date)
              ?.queues[receipt.queue];
            if (
              schedule?.status === "scheduled" &&
              schedule.intervals.some(
                (interval) =>
                  getOutageStart(receipt.date, interval.startMinute) ===
                  receipt.start,
              )
            )
              continue;
            await db.$client
              .prepare(
                `DELETE FROM reminder_receipts WHERE telegram_id=? AND date=? AND queue=? AND start=? AND generation=? AND ${guard}`,
              )
              .bind(
                subscriber.telegramId,
                receipt.date,
                receipt.queue,
                receipt.start,
                receipt.generation,
                token,
                clock(),
              )
              .run();
          }
          const changes = subscriber.updatesEnabled
            ? planChanges(
                await loadNotificationState(db, subscriber.telegramId),
                view,
              )
            : [];
          const reminders = planReminders(
            subscriber,
            view,
            now,
            await loadReminderReceipts(db, subscriber.telegramId),
          );
          const pending = await db
            .select()
            .from(deliveries)
            .where(
              and(
                eq(deliveries.telegramId, subscriber.telegramId),
                eq(deliveries.status, "pending"),
              ),
            );
          let pendingGraph = false;
          const reserved = new Set<string>();
          for (const row of pending) {
            if (row.type === "direct") continue;
            const payload =
              row.revision === subscriber.revision && row.expiresAt > now
                ? await validate(row, now)
                : null;
            // Add newly due reminders to a fresh graph operation, never mutate sent semantics.
            const missingReminder =
              row.type === "change" &&
              reminders.some((notice) =>
                notice.receipts.some(
                  (receipt) =>
                    !row.payload.receipts?.some(
                      (r) =>
                        r.queue === receipt.queue && r.start === receipt.start,
                    ),
                ),
              );
            if (
              !payload ||
              payload.parts.length !== row.payload.parts.length ||
              missingReminder
            ) {
              await db.$client
                .prepare(
                  `UPDATE deliveries SET status='cancelled' WHERE key=? AND status='pending' AND (claim_token IS NULL OR claim_expiry<=?) AND ${guard}`,
                )
                .bind(row.key, now, token, clock())
                .run();
              // A live sender owns this intent until its own revalidation or confirmation.
              if (row.claimToken && (row.claimExpiry ?? 0) > now) {
                if (row.type === "change") pendingGraph = true;
                for (const r of row.payload.receipts ?? [])
                  reserved.add(`${r.queue}:${r.start}`);
              }
              continue;
            }
            if (row.type === "change") pendingGraph = true;
            for (const r of payload.receipts ?? [])
              reserved.add(`${r.queue}:${r.start}`);
          }
          const insert = async (
            type: "change" | "reminder",
            payload: DeliveryPayload,
            expiresAt: number,
          ) => {
            await db.$client
              .prepare(
                `INSERT INTO deliveries(key,telegram_id,type,due_at,payload,revision,expires_at,status) SELECT ?,?,?,?,?,?,?,'pending' WHERE ${guard} AND EXISTS(SELECT 1 FROM subscribers WHERE telegram_id=? AND revision=?)`,
              )
              .bind(
                `automatic:${crypto.randomUUID()}`,
                subscriber.telegramId,
                type,
                now,
                JSON.stringify(payload),
                subscriber.revision,
                expiresAt,
                token,
                clock(),
                subscriber.telegramId,
                subscriber.revision,
              )
              .run();
          };
          if (changes.length && !pendingGraph) {
            const attached = reminders.filter(
              (notice) =>
                !notice.receipts.some((r) =>
                  reserved.has(`${r.queue}:${r.start}`),
                ),
            );
            const payload: DeliveryPayload = {
              automaticView: view,
              automaticChanges: changes,
              automaticReminders: attached,
              parts: renderSchedule(view, source, changes, attached, now),
              baselines: Object.fromEntries(
                view.days.map((day) => [
                  day.date,
                  { selection: view.selection, queues: day.queues },
                ]),
              ),
              receipts: attached.flatMap((notice) => notice.receipts),
            };
            await insert(
              "change",
              payload,
              attached.length
                ? Math.min(...attached.map((n) => n.start))
                : now + 86400000,
            );
          } else if (!pendingGraph) {
            for (const notice of reminders) {
              if (
                notice.receipts.some((r) =>
                  reserved.has(`${r.queue}:${r.start}`),
                )
              )
                continue;
              await insert(
                "reminder",
                {
                  automaticView: view,
                  automaticReminders: [notice],
                  parts: [renderReminder(notice, now)],
                  receipts: notice.receipts,
                },
                notice.start,
              );
            }
          }
        }
      }
      await db.$client
        .prepare(
          `INSERT INTO scheduler_state(id,cursor) SELECT 1,? WHERE ${guard} ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor WHERE ${guard}`,
        )
        .bind(subscriber.telegramId, token, clock(), token, clock())
        .run();
    }
    if (!(await valid())) return;
    const api = options.api ?? new Api(env.BOT_TOKEN, { timeoutSeconds: 10 });
    await deliverDue(db, api, allowed, clock(), {
      clock,
      maxParts: 5,
      maxDeliveries: 10,
      revalidate: async (row, now) =>
        (await valid()) ? validate(row, now) : null,
    });
    const today = getKyivDates(clock()).today;
    const cutoff = clock() - 7 * 86400000;
    await db.$client.batch([
      db.$client
        .prepare(`DELETE FROM operations WHERE completed_at<? AND ${guard}`)
        .bind(cutoff, token, clock()),
      db.$client
        .prepare(
          `DELETE FROM deliveries WHERE status!='pending' AND expires_at<? AND ${guard}`,
        )
        .bind(cutoff, token, clock()),
      db.$client
        .prepare(`DELETE FROM reminder_receipts WHERE date<? AND ${guard}`)
        .bind(today, token, clock()),
      db.$client
        .prepare(`DELETE FROM notification_state WHERE date<? AND ${guard}`)
        .bind(today, token, clock()),
    ]);
  } finally {
    await releaseLease(db, "scheduler", token);
  }
}
