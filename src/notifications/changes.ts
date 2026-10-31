import type { SourceState } from "../db/schedule";
import {
  QUEUE_IDS,
  type QueueId,
  type QueueSchedule,
  type ScheduleSnapshot,
  type Selection,
} from "../schedule/model";
import { getKyivDates } from "../schedule/time";
import type { NotificationBaseline } from "./model";
export interface ScheduleView {
  selection: Selection;
  days: {
    date: string;
    queues: Partial<Record<QueueId, QueueSchedule>>;
    checkedAt?: number;
    missing?: boolean;
  }[];
  checkedAt: number;
  stale: boolean;
  sourceUnavailable?: boolean;
}
/** Last successfully displayed or delivered baseline for each date. */
export type NotificationState = Record<string, NotificationBaseline>;
export interface ChangeNotice {
  date: string;
  view: ScheduleView;
  changes: {
    queue: QueueId;
    previous: QueueSchedule | null;
    current: QueueSchedule;
  }[];
}
export function getScheduleView(
  snapshot: ScheduleSnapshot,
  selection: Selection,
  now: number,
  source?: SourceState,
): ScheduleView {
  const { today, tomorrow } = getKyivDates(now);
  return {
    selection,
    checkedAt: snapshot.checkedAt,
    sourceUnavailable: source?.unavailable ?? false,
    stale:
      (source?.unavailable ?? false) ||
      snapshot.days.some(
        (day) => (day.date === today || day.date === tomorrow) && day.missing,
      ),
    days: snapshot.days
      .filter((day) => day.date === today || day.date === tomorrow)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((day) => ({
        date: day.date,
        ...(day.missing
          ? { missing: true, checkedAt: day.checkedAt ?? snapshot.checkedAt }
          : {}),
        queues:
          selection === "all"
            ? { ...day.queues }
            : { [selection]: day.queues[selection] },
      })),
  };
}
export function sameView(a: ScheduleView, b: ScheduleView): boolean {
  const semantics = (view: ScheduleView) =>
    view.days.map((day) => ({ date: day.date, queues: day.queues }));
  return (
    a.selection === b.selection &&
    JSON.stringify(semantics(a)) === JSON.stringify(semantics(b))
  );
}
function sameSchedule(a: QueueSchedule | undefined, b: QueueSchedule): boolean {
  if (!a || a.status !== b.status) return false;
  if (a.status !== "scheduled" || b.status !== "scheduled") return true;
  return (
    a.intervals.length === b.intervals.length &&
    a.intervals.every(
      (interval, index) =>
        interval.startMinute === b.intervals[index]?.startMinute &&
        interval.endMinute === b.intervals[index]?.endMinute,
    )
  );
}
export function planChanges(
  previous: NotificationState | null,
  current: ScheduleView,
): ChangeNotice[] {
  const notices: ChangeNotice[] = [];
  for (const day of current.days) {
    const baseline = previous?.[day.date];
    const changes: ChangeNotice["changes"] = [];
    for (const queue of QUEUE_IDS) {
      const next = day.queues[queue];
      if (!next) continue;
      const before =
        baseline?.selection === current.selection
          ? baseline.queues[queue]
          : undefined;
      if (sameSchedule(before, next) || (!before && next.status === "pending"))
        continue;
      changes.push({ queue, previous: before ?? null, current: next });
    }
    if (changes.length)
      notices.push({ date: day.date, view: current, changes });
  }
  return notices;
}
