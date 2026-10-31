import type { AppDb } from "../db/client";
import { loadSnapshot, loadSourceState } from "../db/schedule";
import { getScheduleView, sameView } from "../notifications/changes";
import type { QueuedDelivery } from "../notifications/delivery";
import { renderSchedule } from "../notifications/messages";
import type { DeliveryPayload } from "../notifications/model";
import { withConfirmation } from "./screens";
/** Keep the original display semantics; only regenerate time and source-health text. */
export async function revalidateDirectDelivery(
  db: AppDb,
  delivery: Readonly<QueuedDelivery>,
  now: number,
): Promise<DeliveryPayload | null> {
  const original = delivery.payload.directView;
  if (!original) return delivery.payload;
  const snapshot = await loadSnapshot(db);
  if (!snapshot) return null;
  const source = await loadSourceState(db);
  const view = getScheduleView(snapshot, original.selection, now, source);
  if (!sameView(view, original)) return null;
  const reminders = (delivery.payload.directReminders ?? []).map((notice) => ({
    ...notice,
    stale:
      (view.sourceUnavailable ?? view.stale) ||
      (view.days.find((day) => day.date === notice.date)?.missing ?? false),
    checkedAt:
      view.days.find((day) => day.date === notice.date)?.checkedAt ??
      view.checkedAt,
    missing:
      view.days.find((day) => day.date === notice.date)?.missing ?? false,
  }));
  if (reminders.some((notice) => notice.start <= now)) return null;
  return {
    ...delivery.payload,
    directView: view,
    directReminders: reminders,
    parts: withConfirmation(
      renderSchedule(view, source, [], reminders, now),
      delivery.payload.directConfirmation,
    ),
  };
}
