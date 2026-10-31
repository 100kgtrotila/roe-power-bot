import { expect, it } from "vitest";
import { getScheduleView, planChanges } from "../../src/notifications/changes";
import {
  renderReminder,
  renderSchedule,
} from "../../src/notifications/messages";
import { planReminders } from "../../src/notifications/reminders";
import { QUEUE_IDS } from "../../src/schedule/model";
import { queues } from "./notification-fixtures";

const now = Date.parse("2026-11-01T15:50:00Z");
const view = getScheduleView(
  {
    days: [
      {
        date: "2026-11-01",
        queues: queues({
          status: "scheduled",
          intervals: [{ startMinute: 1080, endMinute: 1200 }],
        }),
      },
    ],
    checkedAt: now,
  },
  "all",
  now,
);
const source = {
  lastAttemptAt: now,
  lastSuccessAt: now,
  nextAttemptAt: now,
  failureCount: 1,
  unavailable: true,
};
it("renders full plain text graph with source warning and change marks", () => {
  const parts = renderSchedule(view, source, planChanges(null, view));
  const text = parts.join("\n");
  expect(text).toContain("1 листопада");
  expect(text).toContain("18:00–20:00");
  expect(text).toContain("змінено");
  expect(text).toContain("Перевірено:");
  expect(text).toContain("https://www.roe.vsei.ua/disconnections");
  expect(text).toContain(
    "Не вдалося оновити графік; показано останні збережені дані",
  );
  expect(text).not.toContain("Сайт недоступний");
  expect(QUEUE_IDS.every((q) => text.includes(`Підчерга ${q}`))).toBe(true);
  expect(parts.every((p) => p.length <= 4000)).toBe(true);
});
it("groups own intervals under one readable date and queue heading", () => {
  const own = getScheduleView(
    {
      checkedAt: now,
      days: [
        {
          date: "2026-11-01",
          queues: queues({
            status: "scheduled",
            intervals: [
              { startMinute: 480, endMinute: 600 },
              { startMinute: 960, endMinute: 1080 },
            ],
          }),
        },
      ],
    },
    "1.2",
    now,
  );
  const parts = renderSchedule(own, { ...source, unavailable: false });
  expect(parts).toHaveLength(1);
  const text = parts.join("\n");
  expect(text).toContain("Сьогодні");
  expect(text).toContain("1 листопада");
  expect(text.match(/Підчерга 1\.2/g)).toHaveLength(1);
  expect(text).toContain("08:00–10:00\n16:00–18:00");
});
it("late graph carries countdown and receipts suppress separate reminder", () => {
  const user = {
    telegramId: "1",
    selection: "all" as const,
    updatesEnabled: true,
    remindersEnabled: true,
    reminderMinutes: 30 as const,
    revision: 1,
  };
  const due = planReminders(user, view, now, []);
  const first = due[0];
  if (!first) throw new Error("Expected due reminder");
  expect(renderReminder(first, now)).toContain("До відключення 10 хвилин");
  expect(
    renderSchedule(view, source, planChanges(null, view), due, now).join("\n"),
  ).toContain("До відключення 10 хвилин");
  expect(
    planReminders(
      user,
      view,
      now,
      due.flatMap((n) => n.receipts),
    ),
  ).toHaveLength(0);
});

it("splits long graphs into complete intervals with provenance in each part", () => {
  const intervals = Array.from({ length: 120 }, (_, index) => ({
    startMinute: index * 10,
    endMinute: index * 10 + 5,
  }));
  const large = getScheduleView(
    {
      days: [
        {
          date: "2026-11-01",
          queues: queues({ status: "scheduled", intervals }),
        },
      ],
      checkedAt: now,
    },
    "all",
    now,
  );
  const parts = renderSchedule(large, source, planChanges(null, large));
  expect(parts.length).toBeGreaterThan(1);
  expect(
    parts.every(
      (p) =>
        p.length <= 4000 && p.includes("Джерело:") && p.includes("Перевірено:"),
    ),
  ).toBe(true);
  expect(parts.join("\n").match(/\d{2}:\d{2}–\d{2}:\d{2}/g)).toHaveLength(1440);
});
it("repeats retained-date warning and original check time on every multipart message", () => {
  const intervals = Array.from({ length: 80 }, (_, index) => ({
    startMinute: index * 10,
    endMinute: index * 10 + 5,
  }));
  const retained = getScheduleView(
    {
      days: [
        {
          date: "2026-11-01",
          missing: true,
          checkedAt: now - 3600000,
          queues: queues({ status: "scheduled", intervals }),
        },
        { date: "2026-11-02", queues: queues({ status: "pending" }) },
      ],
      checkedAt: now,
    },
    "all",
    now,
  );
  const parts = renderSchedule(retained, { ...source, unavailable: false });
  expect(parts.length).toBeGreaterThan(1);
  const retainedParts = parts.filter((p) => p.includes("Підчерга"));
  expect(retainedParts.length).toBeGreaterThan(1);
  for (const part of retainedParts) {
    expect(part).toContain("Дата відсутня в останній відповіді джерела");
    expect(part).toContain("16:50");
    expect(part).not.toContain("Сайт недоступний");
    expect(part.length).toBeLessThanOrEqual(4000);
  }
});
it("marks pending transitions and renders unavailable empty data honestly", () => {
  const pending = getScheduleView(
    {
      days: [{ date: "2026-11-01", queues: queues({ status: "pending" }) }],
      checkedAt: now,
    },
    "all",
    now,
    source,
  );
  const prior = {
    "2026-11-01": {
      selection: "all" as const,
      queues: view.days[0]?.queues ?? {},
    },
  };
  expect(
    renderSchedule(pending, source, planChanges(prior, pending)).join("\n"),
  ).toContain("Графік уточнюється");
  expect(pending.stale).toBe(true);
  expect(renderSchedule({ ...pending, days: [] }, source).join("\n")).toContain(
    "Графік ще не опубліковано",
  );
});
it("keeps long previous schedules readable without exceeding limits", () => {
  const intervals = Array.from({ length: 720 }, (_, index) => ({
    startMinute: index * 2,
    endMinute: index * 2 + 1,
  }));
  const previous = {
    "2026-11-01": {
      selection: "all" as const,
      queues: queues({ status: "scheduled", intervals }),
    },
  };
  const parts = renderSchedule(view, source, planChanges(previous, view));
  expect(parts.every((part) => part.length <= 4000)).toBe(true);
  expect(parts.join("\n")).toContain("Було:");
});
