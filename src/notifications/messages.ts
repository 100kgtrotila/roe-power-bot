import type { SourceState } from "../db/schedule";
import { QUEUE_IDS, type QueueSchedule } from "../schedule/model";
import { getKyivDates } from "../schedule/time";
import type { ChangeNotice, ScheduleView } from "./changes";
import type { ReminderNotice } from "./reminders";

const SOURCE = "https://www.roe.vsei.ua/disconnections";
const WARNING =
  "Не вдалося оновити графік; показано останні збережені дані. Інформація може бути застарілою.";
const MAX_LENGTH = 4000;
function clock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
function checked(timestamp: number): string {
  return `Перевірено: ${new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", dateStyle: "short", timeStyle: "short" }).format(timestamp)}, час Києва`;
}
function dateTitle(date: string, now: number): string {
  const { today, tomorrow } = getKyivDates(now);
  const label =
    date === today ? "Сьогодні, " : date === tomorrow ? "Завтра, " : "";
  const formatted = new Intl.DateTimeFormat("uk-UA", {
    timeZone: "Europe/Kyiv",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(Date.parse(`${date}T12:00:00Z`));
  return `📅 ${label}${formatted}`;
}

/** Group intervals under one heading, repeating it only when a queue spans parts. */
function queueRecords(
  title: string,
  lines: string[],
  capacity: number,
): string[] {
  const records: string[] = [];
  let body = title;
  for (const line of lines) {
    if (body.length + line.length + 1 > capacity) {
      if (body === title)
        throw new Error("Schedule record exceeds message limit");
      records.push(body);
      body = `${title} · продовження`;
    }
    if (body.length + line.length + 1 > capacity)
      throw new Error("Schedule record exceeds message limit");
    body += `\n${line}`;
  }
  records.push(body);
  return records;
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
  // Every chunk carries retained-date provenance, including chunks starting mid-day.
  const retainedDates = view.days.filter((day) => day.missing);
  const footer = [
    retainedDates.length
      ? `Остання відповідь джерела:\n${checked(view.checkedAt)}`
      : checked(view.checkedAt),
    ...retainedDates.map(
      (day) =>
        `${dateTitle(day.date, now)}: Дата відсутня в останній відповіді джерела; збережені дані можуть бути застарілими.\n${checked(day.checkedAt ?? view.checkedAt)}`,
    ),
    `Джерело: ${SOURCE}`,
    ...(source.unavailable ? [WARNING] : []),
  ].join("\n");
  const records: string[] = [];
  for (const day of view.days) {
    for (const queue of QUEUE_IDS) {
      const schedule = day.queues[queue];
      if (!schedule) continue;
      const change = changes
        .find((notice) => notice.date === day.date)
        ?.changes.find((item) => item.queue === queue);
      const title = `${dateTitle(day.date, now)}\n⚡ Підчерга ${queue}${change ? " — змінено" : ""}\n`;
      const lines =
        schedule.status === "pending" &&
        change?.previous?.status === "scheduled"
          ? ["Графік уточнюється"]
          : scheduleLines(schedule);
      if (change?.previous)
        lines.push(
          "",
          ...scheduleLines(change.previous).map((line) => `Було: ${line}`),
        );
      records.push(
        ...queueRecords(title, lines, MAX_LENGTH - footer.length - 2),
      );
    }
  }
  for (const reminder of reminders) records.push(renderReminder(reminder, now));
  if (records.length === 0) records.push("Графік ще не опубліковано");
  return chunks(records, footer);
}
export function renderReminder(notice: ReminderNotice, now: number): string {
  return [
    `${dateTitle(notice.date, now)}\n🔔 До відключення ${Math.max(0, Math.ceil((notice.start - now) / 60000))} хвилин`,
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
