import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSchedule, ScheduleParseError } from "../../src/schedule/parser";

const real = readFileSync(
  "tests/fixtures/disconnections/observed-2026-10-31.html",
  "utf8",
);
const synthetic = readFileSync(
  "tests/fixtures/disconnections/synthetic-two-days.html",
  "utf8",
);
const published = readFileSync(
  "tests/fixtures/disconnections/observed-2026-11-24.html",
  "utf8",
);
describe("parseSchedule", () => {
  it("reads published hours and blank cells from the live table format", () => {
    const { days } = parseSchedule(published, 123);
    expect(days.map((day) => day.date)).toEqual(["2026-11-24", "2026-11-25"]);
    expect(days[0]?.queues["1.2"]).toEqual({
      status: "scheduled",
      intervals: [{ startMinute: 1200, endMinute: 1320 }],
    });
    expect(days[0]?.queues["3.1"]).toEqual({ status: "none" });
    expect(days[1]?.queues["1.2"]).toEqual({ status: "none" });
    expect(days[1]?.queues["6.2"]).toEqual({
      status: "scheduled",
      intervals: [{ startMinute: 1320, endMinute: 1439 }],
    });
  });
  it("reads separate paragraphs as separate intervals", () => {
    const html = published.replace(
      "20:00 - 22:00</p>",
      '09:00 - 11:00</p><p style="white-space:nowrap">20:00 - 22:00</p>',
    );
    expect(parseSchedule(html, 123).days[0]?.queues["1.1"]).toEqual({
      status: "scheduled",
      intervals: [
        { startMinute: 540, endMinute: 660 },
        { startMinute: 1200, endMinute: 1320 },
      ],
    });
  });
  it("rejects a date row preceding the queue header", () => {
    const misplaced = synthetic.replace(
      /(<tr><td>Підчерга<\/td>.*?<\/tr>)(<tr><td>31\.10\.2026<\/td>.*?<\/tr>)/,
      "$2$1",
    );
    expect(() => parseSchedule(misplaced, 123)).toThrow(ScheduleParseError);
  });
  it("rejects concatenated intervals without a boundary", () => {
    const concatenated = synthetic.replace(
      "08:00–10:00<br>23:00–24:00",
      "08:00-10:0011:00-12:00",
    );
    expect(() => parseSchedule(concatenated, 123)).toThrow(ScheduleParseError);
  });
  it("reads observed pending cells", () => {
    const result = parseSchedule(real, 123);
    expect(result.checkedAt).toBe(123);
    expect(result.days).toHaveLength(1);
    expect(result.days[0]?.date).toBe("2026-10-31");
    expect(Object.keys(result.days[0]?.queues ?? {})).toHaveLength(12);
    expect(Object.values(result.days[0]?.queues ?? {})).toEqual(
      Array.from({ length: 12 }, () => ({ status: "pending" })),
    );
  });
  it("reads two dates, reordered headers and br-separated hours", () => {
    const result = parseSchedule(synthetic, 123);
    expect(result.days.map((day) => day.date)).toEqual([
      "2026-10-31",
      "2026-11-01",
    ]);
    expect(result.days[0]?.queues["1.2"]).toEqual({
      status: "scheduled",
      intervals: [
        { startMinute: 480, endMinute: 600 },
        { startMinute: 1380, endMinute: 1440 },
      ],
    });
    expect(result.days[0]?.queues["1.1"]).toEqual({ status: "pending" });
    expect(result.days[1]?.queues["6.2"]).toEqual({
      status: "scheduled",
      intervals: [{ startMinute: 60, endMinute: 120 }],
    });
  });
  it.each([
    "",
    synthetic.replace("<td>1.2</td>", '<td colspan="2">1.2</td>'),
    real.replace("31.10.2026", "31.02.2026"),
    real.replace("Очікується", "Відключень немає"),
    real.replace("Очікується", ""),
    real.replaceAll("Очікується", ""),
    real.replace("1.2</td>", "1.1</td>"),
    synthetic.replace("08:00", "24:00"),
    synthetic.replace("10:00", "07:00"),
    synthetic.replace("08:00", "08:61"),
    synthetic.replace("<td>Очікується</td>", ""),
    synthetic.replace(
      "<td>Очікується</td>",
      "<td>Очікується</td><td>Очікується</td>",
    ),
  ])("rejects incomplete or ambiguous content", (html) => {
    expect(() => parseSchedule(html, 123)).toThrow(ScheduleParseError);
  });
});
