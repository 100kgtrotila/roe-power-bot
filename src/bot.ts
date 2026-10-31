import { Bot, type BotConfig, type Context } from "grammy";
import { type BotAction, parseCallback } from "./bot/callbacks";
import { keyboard, MENU_ACTIONS } from "./bot/keyboards";
import { revalidateDirectDelivery } from "./bot/revalidate";
import {
  actionConfirmation,
  renderScreen,
  renderSourceStatus,
  withConfirmation,
} from "./bot/screens";
import type { AppDb } from "./db/client";
import { claimLease, claimOperation, releaseLease } from "./db/operations";
import { loadSnapshot, loadSourceState } from "./db/schedule";
import { getSubscriber, type Subscriber } from "./db/subscriptions";
import { getScheduleView } from "./notifications/changes";
import { deliverDue, loadReminderReceipts } from "./notifications/delivery";
import { renderSchedule } from "./notifications/messages";
import type { DeliveryPayload } from "./notifications/model";
import { planReminders } from "./notifications/reminders";

export interface BotServices {
  db: AppDb;
  allowedIds: ReadonlySet<string>;
  now: () => number;
  revalidate?: import("./notifications/delivery").RevalidateDelivery;
}
export function createBot(
  token: string,
  services: BotServices,
  options: BotConfig<Context> = {},
): Bot {
  const bot = new Bot(token, {
    ...options,
    client: { timeoutSeconds: 10, ...options.client },
  });
  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (
      ctx.chat?.type !== "private" ||
      id === undefined ||
      String(ctx.chat.id) !== String(id) ||
      !services.allowedIds.has(String(id))
    )
      return;
    await next();
  });
  async function handle(ctx: Context, action: BotAction): Promise<void> {
    const { db, now: clock } = services;
    const now = clock();
    const id = String(ctx.from?.id);
    if (action.owner !== id) return;
    const operation = `telegram:${ctx.update.update_id}`;
    const owner = await claimLease(db, `user:${id}`, now, 60000);
    if (!owner) throw new Error("User busy");
    try {
      const claim = await claimOperation(db, operation, now, 60000);
      if (!claim) {
        const row = await db.$client
          .prepare("SELECT completed_at FROM operations WHERE key = ?")
          .bind(operation)
          .first<{ completed_at: number | null }>();
        if (row?.completed_at === null) throw new Error("Update busy");
        return;
      }
      const old = await getSubscriber(db, id);
      const user: Subscriber = old
        ? { ...old }
        : {
            telegramId: id,
            selection: null,
            updatesEnabled: true,
            remindersEnabled: false,
            reminderMinutes: 15,
            revision: 1,
          };
      let page = action.kind === "view" ? action.view : "menu";
      let graph = page === "schedule" || page === "all";
      if (action.kind === "select") {
        user.selection = action.selection;
        graph = true;
      }
      if (action.kind === "interval") {
        user.reminderMinutes = action.minutes;
        page = "reminders";
      }
      if (action.kind === "updates") {
        user.updatesEnabled = action.enabled;
        graph = action.enabled;
        page = "manage";
      }
      if (action.kind === "reminders") {
        user.remindersEnabled = action.enabled;
        graph = action.enabled;
        page = "reminders";
      }
      if (action.kind === "stop") {
        user.updatesEnabled = false;
        user.remindersEnabled = false;
        page = "manage";
      }
      const mutated =
        old &&
        (user.selection !== old.selection ||
          user.updatesEnabled !== old.updatesEnabled ||
          user.remindersEnabled !== old.remindersEnabled ||
          user.reminderMinutes !== old.reminderMinutes);
      if (mutated && old) user.revision = old.revision + 1;
      const payload: DeliveryPayload = {
        parts: [renderScreen(user, page)],
        replyMarkup: keyboard(user, page),
      };
      if (page === "status")
        payload.parts = [
          `${renderScreen(user, page)}\n\n${renderSourceStatus(await loadSourceState(db), now)}`,
        ];
      if (graph) {
        const selection = page === "all" ? "all" : user.selection;
        if (!selection) {
          payload.parts = ["Оберіть підчергу для перегляду свого графіка."];
          payload.replyMarkup = keyboard(user, "select");
        } else {
          const snapshot = await loadSnapshot(db);
          const source = await loadSourceState(db);
          if (!snapshot)
            payload.parts = [
              "Немає збережених даних графіка. Зараз неможливо перевірити публікацію. Спробуйте пізніше.",
            ];
          else {
            const view = getScheduleView(snapshot, selection, now, source);
            const reminders =
              page === "all"
                ? []
                : planReminders(
                    user,
                    view,
                    now,
                    old?.selection !== user.selection
                      ? []
                      : await loadReminderReceipts(db, id),
                  );
            payload.directView = view;
            payload.directReminders = reminders;
            payload.parts = renderSchedule(view, source, [], reminders, now);
            if (page !== "all") {
              payload.baselines = Object.fromEntries(
                view.days.map((day) => [
                  day.date,
                  { selection, queues: day.queues },
                ]),
              );
              payload.receipts = reminders.flatMap((notice) => notice.receipts);
            }
          }
        }
      }
      const confirmation = actionConfirmation(action);
      if (confirmation) {
        payload.directConfirmation = confirmation;
        payload.parts = withConfirmation(payload.parts, confirmation);
      }
      // All effects and durable reply intent commit in one local D1 transaction.
      const guard =
        "EXISTS (SELECT 1 FROM operations WHERE key = ? AND claim_token = ? AND completed_at IS NULL AND expiry > ?) AND EXISTS (SELECT 1 FROM leases WHERE resource = ? AND claim_token = ? AND expiry > ?)";
      const commitAt = clock();
      const ownership = [
        operation,
        claim,
        commitAt,
        `user:${id}`,
        owner,
        commitAt,
      ];
      const revisionGuard = old
        ? "EXISTS (SELECT 1 FROM subscribers WHERE telegram_id = ? AND revision = ?)"
        : "NOT EXISTS (SELECT 1 FROM subscribers WHERE telegram_id = ?)";
      const expected = old ? [id, old.revision] : [id];
      const statements: D1PreparedStatement[] = [
        db.$client
          .prepare(
            `UPDATE operations SET completed_at=? WHERE key=? AND ${guard} AND ${revisionGuard}`,
          )
          .bind(commitAt, operation, ...ownership, ...expected),
      ];
      const committedGuard = guard.replace(
        "completed_at IS NULL",
        `completed_at = ${commitAt}`,
      );
      statements.push(
        db.$client
          .prepare(
            `INSERT INTO subscribers (telegram_id,selection,updates_enabled,reminders_enabled,reminder_minutes,revision) SELECT ?,?,?,?,?,? WHERE ${committedGuard} ON CONFLICT(telegram_id) DO UPDATE SET selection=excluded.selection,updates_enabled=excluded.updates_enabled,reminders_enabled=excluded.reminders_enabled,reminder_minutes=excluded.reminder_minutes,revision=excluded.revision`,
          )
          .bind(
            id,
            user.selection,
            Number(user.updatesEnabled),
            Number(user.remindersEnabled),
            user.reminderMinutes,
            user.revision,
            ...ownership,
          ),
      );
      if (old && old.selection !== user.selection) {
        statements.push(
          db.$client
            .prepare(
              `DELETE FROM notification_state WHERE telegram_id=? AND ${committedGuard}`,
            )
            .bind(id, ...ownership),
        );
        statements.push(
          db.$client
            .prepare(
              `DELETE FROM reminder_receipts WHERE telegram_id=? AND ${committedGuard}`,
            )
            .bind(id, ...ownership),
        );
      }
      statements.push(
        db.$client
          .prepare(
            `INSERT INTO deliveries (key,telegram_id,type,due_at,payload,revision,expires_at,status) SELECT ?,?,'direct',?,?,?,?,'pending' WHERE ${committedGuard} ON CONFLICT(key) DO NOTHING`,
          )
          .bind(
            operation,
            id,
            now,
            JSON.stringify(payload),
            user.revision,
            now + 86400000,
            ...ownership,
          ),
      );
      const results = await db.$client.batch(statements);
      if (results[0]?.meta.changes !== 1)
        throw new Error("Update ownership lost");
    } finally {
      await releaseLease(db, `user:${id}`, owner);
    }
    await deliverDue(db, bot.api, services.allowedIds, clock(), {
      clock,
      revalidate: async (delivery, time) =>
        delivery.type === "direct"
          ? revalidateDirectDelivery(db, delivery, time)
          : services.revalidate
            ? services.revalidate(delivery, time)
            : delivery.payload,
    });
  }
  const privateChat = bot.chatType("private");
  for (const [command, view] of [
    ["start", "menu"],
    ["schedule", "schedule"],
    ["all", "all"],
    ["queue", "select"],
    ["reminders", "reminders"],
    ["stop", "manage"],
    ["help", "help"],
    ["status", "status"],
  ] as const) {
    privateChat.command(command, (ctx) =>
      handle(ctx, { owner: String(ctx.from.id), kind: "view", view }),
    );
  }
  for (const [text, view] of Object.entries(MENU_ACTIONS)) {
    privateChat.hears(text, (ctx) =>
      handle(ctx, { owner: String(ctx.from.id), kind: "view", view }),
    );
  }
  privateChat.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery();
    const action = parseCallback(ctx.callbackQuery.data);
    if (action) await handle(ctx, action);
  });
  return bot;
}
