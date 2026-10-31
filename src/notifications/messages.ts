import type { SourceState } from "../db/schedule";
import { QUEUE_IDS, type QueueSchedule } from "../schedule/model";
import type { ChangeNotice, ScheduleView } from "./changes";
import type { ReminderNotice } from "./reminders";

const SOURCE = "https://www.roe.vsei.ua/disconnections";
const WARNING = "Сайт недоступний, інформація може бути застарілою";
const MAX_LENGTH = 4000;
function clock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
function checked(timestamp: number): string {
  return `Перевірено: ${new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", dateStyle: "short", timeStyle: "short" }).format(timestamp)}, час Києва`;
}
function scheduleLines(schedule: QueueSchedule): string[] {
  if (schedule.status === "pending") return ["Очікується"];
  if (schedule.status === "none") return ["Відключень немає"];
  return schedule.intervals.map(
    (interval) => `${clock(interval.startMinute)}–${clock(interval.endMinute)}`,
  );
}
/** Split only between complete records, repeating provenance on every part. */
function chunks(records: string[], footer: string): string[] {
  const result: string[] = [];
  let body = "";
  for (const record of records) {
    if (record.length + footer.length + 2 > MAX_LENGTH)
      throw new Error("Schedule record exceeds message limit");
    const next = body ? `${body}\n\n${record}` : record;
    if (next.length + footer.length + 2 > MAX_LENGTH) {
      result.push(`${body}\n\n${footer}`);
      body = record;
    } else body = next;
  }
  if (body) result.push(`${body}\n\n${footer}`);
  return result;
}
export function renderSchedule(
  view: ScheduleView,
  source: SourceState,
  changes: ChangeNotice[] = [],
  reminders: ReminderNotice[] = [],
  now = view.checkedAt,
): string[] {
  const records: string[] = [];
  for (const day of view.days) {
    for (const queue of QUEUE_IDS) {
      const schedule = day.queues[queue];
      if (!schedule) continue;
      const change = changes
        .find((notice) => notice.date === day.date)
        ?.changes.find((item) => item.queue === queue);
      const title = `${day.date}\nПідчерга ${queue}${change ? " — змінено" : ""}`;
      const lines =
        schedule.status === "pending" &&
        change?.previous?.status === "scheduled"
          ? ["Графік уточнюється"]
          : scheduleLines(schedule);
      // Each interval remains intact even if a queue needs multiple message parts.
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line !== undefined) records.push(`${title}\n${line}`);
      }
      if (change?.previous)
        for (const line of scheduleLines(change.previous))
          records.push(`${day.date}\nПідчерга ${queue}\nБуло: ${line}`);
    }
  }
  for (const reminder of reminders) records.push(renderReminder(reminder, now));
  if (records.length === 0) records.push("Графік ще не опубліковано");
  // Every chunk carries retained-date provenance, including chunks starting mid-day.
  const retainedDates = view.days.filter((day) => day.missing);
  const footer = [
    retainedDates.length
      ? `Остання відповідь джерела:\n${checked(view.checkedAt)}`
      : checked(view.checkedAt),
    ...retainedDates.map(
      (day) =>
        `${day.date}: Дата відсутня в останній відповіді джерела; збережені дані можуть бути застарілими.\n${checked(day.checkedAt ?? view.checkedAt)}`,
    ),
    `Джерело: ${SOURCE}`,
    ...(source.unavailable ? [WARNING] : []),
  ].join("\n");
  return chunks(records, footer);
}
export function renderReminder(notice: ReminderNotice, now: number): string {
  return [
    `${notice.date}\nДо відключення ${Math.max(0, Math.ceil((notice.start - now) / 60000))} хвилин`,
    `Підчерги: ${notice.queueIds.join(", ")}`,
    `Початок: ${new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(notice.start)}, час Києва`,
    checked(notice.checkedAt),
    `Джерело: ${SOURCE}`,
    ...(notice.stale
      ? [
          notice.missing
            ? "Дата відсутня в останній відповіді джерела; інформація може бути застарілою"
            : WARNING,
        ]
      : []),
  ].join("\n");
}
