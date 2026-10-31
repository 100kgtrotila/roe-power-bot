import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import type {
  DeliveryPayload,
  NotificationBaseline,
} from "../notifications/model";
import type { QueueId, ScheduleSnapshot, Selection } from "../schedule/model";
export const subscribers = sqliteTable(
  "subscribers",
  {
    telegramId: text("telegram_id").primaryKey(),
    selection: text("selection").$type<Selection>(),
    updatesEnabled: integer("updates_enabled", { mode: "boolean" }).notNull(),
    remindersEnabled: integer("reminders_enabled", {
      mode: "boolean",
    }).notNull(),
    reminderMinutes: integer("reminder_minutes")
      .$type<15 | 30 | 60>()
      .notNull(),
    revision: integer("revision").notNull(),
  },
  (t) => [
    check(
      "selection_valid",
      sql`${t.selection} IS NULL OR ${t.selection} IN ('all','1.1','1.2','2.1','2.2','3.1','3.2','4.1','4.2','5.1','5.2','6.1','6.2')`,
    ),
    check("reminder_interval_valid", sql`${t.reminderMinutes} IN (15,30,60)`),
    check("revision_valid", sql`${t.revision} >= 1`),
    index("subscribers_active").on(t.updatesEnabled, t.remindersEnabled),
  ],
);
export const scheduleSnapshots = sqliteTable(
  "schedule_snapshots",
  {
    id: integer("id").primaryKey(),
    snapshot: text("snapshot", { mode: "json" })
      .$type<ScheduleSnapshot>()
      .notNull(),
  },
  (t) => [check("snapshot_singleton", sql`${t.id} = 1`)],
);
export const sourceState = sqliteTable(
  "source_state",
  {
    id: integer("id").primaryKey(),
    lastAttemptAt: integer("last_attempt_at"),
    lastSuccessAt: integer("last_success_at"),
    nextAttemptAt: integer("next_attempt_at").notNull(),
    failureCount: integer("failure_count").notNull(),
    unavailable: integer("unavailable", { mode: "boolean" }).notNull(),
  },
  (t) => [check("source_singleton", sql`${t.id} = 1`)],
);
export const operations = sqliteTable(
  "operations",
  {
    key: text("key").primaryKey(),
    claimToken: text("claim_token").notNull(),
    expiry: integer("expiry").notNull(),
    completedAt: integer("completed_at"),
  },
  (t) => [index("operations_expiry").on(t.expiry)],
);
export const leases = sqliteTable(
  "leases",
  {
    resource: text("resource").primaryKey(),
    claimToken: text("claim_token").notNull(),
    expiry: integer("expiry").notNull(),
  },
  (t) => [index("leases_expiry").on(t.expiry)],
);
export const schedulerState = sqliteTable("scheduler_state", {
  id: integer("id").primaryKey(),
  cursor: text("cursor").notNull(),
});
export const deliveries = sqliteTable(
  "deliveries",
  {
    key: text("key").primaryKey(),
    telegramId: text("telegram_id")
      .notNull()
      .references(() => subscribers.telegramId),
    type: text("type", {
      enum: ["update", "change", "reminder", "direct"],
    }).notNull(),
    dueAt: integer("due_at").notNull(),
    payload: text("payload", { mode: "json" })
      .$type<DeliveryPayload>()
      .notNull(),
    revision: integer("revision").notNull(),
    expiresAt: integer("expires_at").notNull().default(9007199254740991),
    claimToken: text("claim_token"),
    claimExpiry: integer("claim_expiry"),
    status: text("status", {
      enum: ["pending", "sent", "cancelled"],
    }).notNull(),
    partCursor: integer("part_cursor").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [index("deliveries_due").on(t.status, t.dueAt)],
);
export const notificationState = sqliteTable(
  "notification_state",
  {
    telegramId: text("telegram_id")
      .notNull()
      .references(() => subscribers.telegramId),
    date: text("date").notNull(),
    baseline: text("baseline", { mode: "json" })
      .$type<NotificationBaseline>()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.telegramId, t.date] })],
);
export const reminderReceipts = sqliteTable(
  "reminder_receipts",
  {
    telegramId: text("telegram_id")
      .notNull()
      .references(() => subscribers.telegramId),
    date: text("date").notNull(),
    queue: text("queue").$type<QueueId>().notNull(),
    start: integer("start").notNull(),
    generation: text("generation").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.telegramId, t.date, t.queue, t.start, t.generation],
    }),
  ],
);
