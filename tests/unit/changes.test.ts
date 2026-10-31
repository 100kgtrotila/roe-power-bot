import { describe, expect, it } from "vitest";
import { getScheduleView, planChanges } from "../../src/notifications/changes";
import type { QueueSchedule } from "../../src/schedule/model";
import { queues } from "./notification-fixtures";

const now = Date.parse("2026-11-01T10:00:00Z");
function view(schedule: QueueSchedule, date = "2026-11-01") {
  const dayQueues = queues(schedule);
  return getScheduleView(
    { days: [{ date, queues: dayQueues }], checkedAt: now },
    "1.1",
    now,
  );
}
const hours: QueueSchedule = {
  status: "scheduled",
  intervals: [{ startMinute: 1080, endMinute: 1200 }],
};
describe("changes", () => {
  it.each([
    [null, { status: "pending" }, 0],
    [{ status: "pending" }, hours, 1],
    [hours, hours, 0],
    [hours, { status: "pending" }, 1],
    [{ status: "pending" }, { status: "pending" }, 0],
    [hours, { status: "none" }, 1],
    [{ status: "none" }, { status: "none" }, 0],
  ] as const)(
    "compares last successful state %j to %j",
    (before, after, count) => {
      const previous = before
        ? {
            "2026-11-01": {
              selection: "1.1" as const,
              queues: { "1.1": before },
            },
          }
        : null;
      expect(planChanges(previous, view(after))).toHaveLength(count);
    },
  );
  it("notifies again on A to B to A and ignores check time", () => {
    const a = view(hours),
      b = view({ status: "none" });
    const baseline = {
      "2026-11-01": { selection: a.selection, queues: a.days[0]?.queues ?? {} },
    };
    expect(planChanges(baseline, b)).toHaveLength(1);
    expect(
      planChanges(
        {
          "2026-11-01": {
            selection: b.selection,
            queues: b.days[0]?.queues ?? {},
          },
        },
        a,
      ),
    ).toHaveLength(1);
    expect(planChanges(baseline, { ...a, checkedAt: now + 1 })).toHaveLength(0);
  });
  it("keeps today and tomorrow and excludes past dates", () => {
    expect(view(hours, "2026-10-31").days).toHaveLength(0);
    expect(planChanges(null, view(hours, "2026-11-02"))).toHaveLength(1);
  });
});

it("groups all queues per date and ignores unrelated queues in own view", () => {
  const before = queues(hours),
    after = { ...before, "2.1": { status: "pending" as const } };
  const snapshot = {
    days: [
      { date: "2026-11-01", queues: after },
      { date: "2026-11-02", queues: before },
    ],
    checkedAt: now,
  };
  const own = getScheduleView(snapshot, "1.1", now);
  expect(
    planChanges(
      { "2026-11-01": { selection: "1.1", queues: { "1.1": hours } } },
      own,
    ).map((n) => n.date),
  ).toEqual(["2026-11-02"]);
  const all = getScheduleView(snapshot, "all", now);
  const notices = planChanges(
    { "2026-11-01": { selection: "all", queues: before } },
    all,
  );
  expect(notices).toHaveLength(2);
  expect(notices[0]?.changes.map((c) => c.queue)).toEqual(["2.1"]);
  expect(notices[0]?.view.days).toHaveLength(2);
});
