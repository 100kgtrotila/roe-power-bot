import { expect, it } from "vitest";
import type { Subscriber } from "../../src/db/subscriptions";
import { getScheduleView } from "../../src/notifications/changes";
import { planReminders } from "../../src/notifications/reminders";
import type { QueueSchedule } from "../../src/schedule/model";
import { queues } from "./notification-fixtures";

const subscriber: Subscriber = {
  telegramId: "1",
  selection: "all",
  updatesEnabled: true,
  remindersEnabled: true,
  reminderMinutes: 30,
  revision: 1,
};
const start = Date.parse("2026-11-01T16:00:00Z"); // 18:00 Kyiv
function makeView(
  status: QueueSchedule = {
    status: "scheduled",
    intervals: [{ startMinute: 1080, endMinute: 1200 }],
  },
) {
  return getScheduleView(
    {
      days: [{ date: "2026-11-01", queues: queues(status) }],
      checkedAt: start - 600000,
    },
    "all",
    start - 600000,
  );
}
it.each([15, 30, 60] as const)(
  "is due at the %i minute boundary",
  (minutes) => {
    const v = makeView();
    expect(
      planReminders(
        { ...subscriber, reminderMinutes: minutes },
        v,
        start - minutes * 60000 - 1,
        [],
      ),
    ).toHaveLength(0);
    const notices = planReminders(
      { ...subscriber, reminderMinutes: minutes },
      v,
      start - minutes * 60000,
      [],
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.start).toBe(start);
    expect(notices[0]?.receipts).toHaveLength(12);
  },
);
it("does not repeat delivered starts, including end-only edits", () => {
  const v = makeView();
  const notices = planReminders(subscriber, v, start - 600000, []);
  expect(
    planReminders(
      subscriber,
      makeView({
        status: "scheduled",
        intervals: [{ startMinute: 1080, endMinute: 1260 }],
      }),
      start - 600000,
      notices.flatMap((n) => n.receipts),
    ),
  ).toHaveLength(0);
  expect(planReminders(subscriber, v, start, [])).toHaveLength(0);
  expect(
    planReminders(
      subscriber,
      makeView({ status: "pending" }),
      start - 600000,
      [],
    ),
  ).toHaveLength(0);
  expect(
    planReminders(subscriber, makeView({ status: "none" }), start - 600000, []),
  ).toHaveLength(0);
  expect(
    planReminders(
      subscriber,
      { ...v, stale: true, sourceUnavailable: true },
      start - 600000,
      [],
    )[0]?.stale,
  ).toBe(true);
});

it("skips ambiguous DST starts and disabled or different selection", () => {
  const v = getScheduleView(
    {
      days: [
        {
          date: "2026-10-25",
          queues: queues({
            status: "scheduled",
            intervals: [{ startMinute: 210, endMinute: 300 }],
          }),
        },
      ],
      checkedAt: 0,
    },
    "all",
    Date.parse("2026-10-25T00:00:00Z"),
  );
  expect(
    planReminders(subscriber, v, Date.parse("2026-10-25T00:30:00Z"), []),
  ).toHaveLength(0);
  expect(
    planReminders(
      { ...subscriber, remindersEnabled: false },
      makeView(),
      start - 600000,
      [],
    ),
  ).toHaveLength(0);
  expect(
    planReminders(
      { ...subscriber, selection: "1.1" },
      makeView(),
      start - 600000,
      [],
    ),
  ).toHaveLength(0);
});
it("allows rescheduled starts but retains end-only receipts; coordinator retires obsolete starts", () => {
  const original = makeView({
    status: "scheduled",
    intervals: [{ startMinute: 960, endMinute: 1020 }],
  });
  const old = planReminders(
    subscriber,
    original,
    Date.parse("2026-11-01T13:50:00Z"),
    [],
  ).flatMap((n) => n.receipts);
  expect(
    planReminders(subscriber, makeView(), start - 600000, old),
  ).toHaveLength(1);
  // After retirement of obsolete 16:00 receipts, a newly restored 16:00 can notify again.
  expect(
    planReminders(subscriber, original, Date.parse("2026-11-01T13:50:00Z"), []),
  ).toHaveLength(1);
});
