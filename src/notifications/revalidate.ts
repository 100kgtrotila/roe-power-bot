import { revalidateDirectDelivery } from "../bot/revalidate";
import type { AppDb } from "../db/client";
import { loadSnapshot, loadSourceState } from "../db/schedule";
import { getSubscriber } from "../db/subscriptions";
import { getScheduleView, planChanges, sameView } from "./changes";
import {
  loadNotificationState,
  loadReminderReceipts,
  type RevalidateDelivery,
} from "./delivery";
import { renderReminder, renderSchedule } from "./messages";

export function revalidateDelivery(db: AppDb): RevalidateDelivery {
  return async (row, now) => {
    if (row.type === "direct") return revalidateDirectDelivery(db, row, now);
    const original = row.payload.automaticView;
    const subscriber = await getSubscriber(db, row.telegramId);
    const snapshot = await loadSnapshot(db);
    if (
      !original ||
      !subscriber?.selection ||
      subscriber.revision !== row.revision ||
      !snapshot
    )
      return null;
    const source = await loadSourceState(db);
    const view = getScheduleView(snapshot, subscriber.selection, now, source);
    if (!sameView(view, original)) return null;
    // Already accepted parts cannot be rewritten with a different health claim.
    if (
      row.partCursor > 0 &&
      (view.stale !== original.stale ||
        view.sourceUnavailable !== original.sourceUnavailable ||
        JSON.stringify(view.days.map((d) => d.missing)) !==
          JSON.stringify(original.days.map((d) => d.missing)))
    )
      return null;
    const receipts = await loadReminderReceipts(db, row.telegramId);
    const reminders = (row.payload.automaticReminders ?? []).map((notice) => ({
      ...notice,
      stale:
        (view.sourceUnavailable ?? view.stale) ||
        (view.days.find((d) => d.date === notice.date)?.missing ?? false),
      missing: view.days.find((d) => d.date === notice.date)?.missing ?? false,
      checkedAt:
        view.days.find((d) => d.date === notice.date)?.checkedAt ??
        view.checkedAt,
    }));
    if (
      reminders.some(
        (notice) =>
          notice.start <= now ||
          notice.receipts.some((r) =>
            receipts.some(
              (existing) =>
                existing.date === r.date &&
                existing.queue === r.queue &&
                existing.start === r.start &&
                existing.generation === r.generation,
            ),
          ),
      )
    )
      return null;
    if (reminders.length && !subscriber.remindersEnabled) return null;
    if (row.type === "reminder")
      return {
        ...row.payload,
        automaticView: view,
        automaticReminders: reminders,
        parts: reminders.map((notice) => renderReminder(notice, now)),
      };
    if (
      !subscriber.updatesEnabled ||
      !planChanges(await loadNotificationState(db, row.telegramId), view).length
    )
      return null;
    return {
      ...row.payload,
      automaticView: view,
      automaticReminders: reminders,
      parts: renderSchedule(
        view,
        source,
        row.payload.automaticChanges ?? [],
        reminders,
        now,
      ),
    };
  };
}
