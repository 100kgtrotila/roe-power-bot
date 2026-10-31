import type { Subscriber } from "../db/subscriptions";
import { QUEUE_IDS, type QueueId } from "../schedule/model";
import { getOutageStart } from "../schedule/time";
import type { ScheduleView } from "./changes";
import type { ReminderReceipt } from "./model";
export interface ReminderNotice {
  date: string;
  start: number;
  queueIds: QueueId[];
  stale: boolean;
  checkedAt: number;
  missing?: boolean;
  receipts: ReminderReceipt[];
}
/** Receipts must represent active starts; the coordinator retires receipts on start replacement. */
export function planReminders(
  subscriber: Subscriber,
  view: ScheduleView,
  now: number,
  receipts: ReminderReceipt[],
): ReminderNotice[] {
  if (
    !subscriber.remindersEnabled ||
    !subscriber.selection ||
    subscriber.selection !== view.selection
  )
    return [];
  const grouped = new Map<number, ReminderNotice>();
  for (const day of view.days) {
    for (const queue of QUEUE_IDS) {
      if (subscriber.selection !== "all" && subscriber.selection !== queue)
        continue;
      const schedule = day.queues[queue];
      if (schedule?.status !== "scheduled") continue;
      for (const interval of schedule.intervals) {
        const start = getOutageStart(day.date, interval.startMinute);
        if (
          start === null ||
          start <= now ||
          now < start - subscriber.reminderMinutes * 60000
        )
          continue;
        const generation = String(start);
        if (
          receipts.some(
            (receipt) =>
              receipt.date === day.date &&
              receipt.queue === queue &&
              receipt.start === start &&
              receipt.generation === generation,
          )
        )
          continue;
        let notice = grouped.get(start);
        if (!notice) {
          notice = {
            date: day.date,
            start,
            queueIds: [],
            stale:
              (view.sourceUnavailable ?? view.stale) || (day.missing ?? false),
            missing: day.missing ?? false,
            checkedAt: day.checkedAt ?? view.checkedAt,
            receipts: [],
          };
          grouped.set(start, notice);
        }
        if (notice.queueIds.includes(queue)) continue;
        notice.queueIds.push(queue);
        notice.receipts.push({ date: day.date, queue, start, generation });
      }
    }
  }
  return [...grouped.values()].sort((a, b) => a.start - b.start);
}
