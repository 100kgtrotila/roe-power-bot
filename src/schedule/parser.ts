import { DomUtils, parseDocument } from "htmlparser2";
import {
  type DaySchedule,
  isQueueId,
  type OutageInterval,
  QUEUE_IDS,
  type QueueId,
  type QueueSchedule,
  type ScheduleSnapshot,
} from "./model";
import { isValidDate } from "./time";
export class ScheduleParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleParseError";
  }
}
function fail(message: string): never {
  throw new ScheduleParseError(message);
}
function parseCell(text: string): QueueSchedule {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized === "Очікується") return { status: "pending" };
  const intervals: OutageInterval[] = [];
  // No explicit none marker has been observed; all unknown/empty text fails closed.
  const expression = /(\d{2}):(\d{2})\s*[-–—]\s*(\d{2}):(\d{2})/g;
  const completeIntervals =
    /^(?:\d{2}:\d{2}\s*[-–—]\s*\d{2}:\d{2})(?:\s+\d{2}:\d{2}\s*[-–—]\s*\d{2}:\d{2})*$/;
  if (!completeIntervals.test(normalized)) fail("Unknown schedule cell");
  for (const match of normalized.matchAll(expression)) {
    const startHour = Number(match[1]);
    const startMinutes = Number(match[2]);
    const endHour = Number(match[3]);
    const endMinutes = Number(match[4]);
    const startMinute = startHour * 60 + startMinutes;
    const endMinute = endHour * 60 + endMinutes;
    if (
      startHour > 23 ||
      startMinutes > 59 ||
      endHour > 24 ||
      endMinutes > 59 ||
      (endHour === 24 && endMinutes !== 0) ||
      endMinute <= startMinute
    )
      fail("Invalid interval");
    intervals.push({ startMinute, endMinute });
  }
  if (!intervals.length) fail("Missing intervals");
  intervals.sort((a, b) => a.startMinute - b.startMinute);
  for (let index = 1; index < intervals.length; index++) {
    const previous = intervals[index - 1];
    const current = intervals[index];
    if (previous && current && previous.endMinute > current.startMinute)
      fail("Overlapping intervals");
  }
  return { status: "scheduled", intervals };
}
export function parseSchedule(
  html: string,
  checkedAt: number,
): ScheduleSnapshot {
  if (!Number.isFinite(checkedAt)) fail("Invalid check time");
  const document = parseDocument(html);
  const containers = DomUtils.findAll(
    (element) => element.attribs.id === "fetched-data-container",
    document.children,
  );
  if (containers.length !== 1) fail("Missing or duplicate schedule container");
  const container = containers[0];
  if (!container) fail("Missing schedule container");
  const tables = DomUtils.findAll(
    (element) => element.name === "table",
    container.children,
  );
  if (tables.length !== 1) fail("Missing or duplicate schedule table");
  const table = tables[0];
  if (!table) fail("Missing schedule table");
  const rows = DomUtils.findAll(
    (element) => element.name === "tr",
    table.children,
  );
  let headers: QueueId[] | undefined;
  const days: DaySchedule[] = [];
  for (const row of rows) {
    const cells = row.children.filter(
      (node) =>
        node.type === "tag" && (node.name === "td" || node.name === "th"),
    );
    const texts = cells.map((cell) =>
      DomUtils.getText(cell).replace(/\s+/g, " ").trim(),
    );
    if (
      (headers || texts[0] === "Підчерга") &&
      cells.some(
        (cell) =>
          cell.type === "tag" &&
          ((cell.attribs.colspan && cell.attribs.colspan !== "1") ||
            (cell.attribs.rowspan && cell.attribs.rowspan !== "1")),
      )
    )
      fail("Merged schedule cells");
    if (texts[0] === "Підчерга") {
      if (headers || days.length) fail("Duplicate or misplaced queue header");
      const labels = texts.slice(1);
      if (
        labels.length !== 12 ||
        !labels.every(isQueueId) ||
        new Set(labels).size !== 12
      )
        fail("Invalid queue headers");
      headers = labels;
      continue;
    }
    if (!headers) {
      const isTitle =
        texts.length === 1 && texts[0] === "Графік погодинних відключень (ГПВ)";
      const isHoursHeading =
        texts.length === 13 &&
        texts[0] === "" &&
        texts.slice(1).every((text) => text === "Години відключення");
      const isQueueGroups =
        texts.length === 6 &&
        texts.every((text, index) => text === `Черга № ${index + 1}`);
      if (!isTitle && !isHoursHeading && !isQueueGroups)
        fail("Unexpected row before queue header");
      continue;
    }
    if (cells.length !== 13) fail("Incomplete date row");
    const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(texts[0] ?? "");
    if (!match) fail("Invalid source date");
    const date = `${match[3]}-${match[2]}-${match[1]}`;
    if (!isValidDate(date) || days.some((day) => day.date === date))
      fail("Invalid or duplicate date");
    const queues: Partial<Record<QueueId, QueueSchedule>> = {};
    for (const [index, queue] of headers.entries())
      queues[queue] = parseCell(texts[index + 1] ?? "");
    // Explicit construction keeps the complete Record contract checked without a cast.
    function required(queue: QueueId): QueueSchedule {
      return queues[queue] ?? fail("Missing queue");
    }
    const complete = {
      "1.1": required("1.1"),
      "1.2": required("1.2"),
      "2.1": required("2.1"),
      "2.2": required("2.2"),
      "3.1": required("3.1"),
      "3.2": required("3.2"),
      "4.1": required("4.1"),
      "4.2": required("4.2"),
      "5.1": required("5.1"),
      "5.2": required("5.2"),
      "6.1": required("6.1"),
      "6.2": required("6.2"),
    };
    days.push({ date, queues: complete });
  }
  if (!headers || !days.length || headers.length !== QUEUE_IDS.length)
    fail("Missing schedule data");
  days.sort((a, b) => a.date.localeCompare(b.date));
  return { days, checkedAt };
}
