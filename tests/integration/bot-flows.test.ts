import { env } from "cloudflare:workers";
import type { Update } from "grammy/types";
import nodeFetch from "node-fetch";
import { expect, test } from "vitest";
import { createBot } from "../../src/bot";
import { createDb } from "../../src/db/client";
import { getSubscriber } from "../../src/db/subscriptions";

const now = Date.UTC(2026, 9, 31, 10);
function setup() {
  let failSend = false;
  let timestamp = now;
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const fetch = Object.assign(
    async (
      url: Parameters<typeof nodeFetch>[0],
      init?: Parameters<typeof nodeFetch>[1],
    ) => {
      calls.push({
        method: String(url).split("/").at(-1) ?? "",
        body: JSON.parse(String(init?.body)),
      });
      if (failSend && String(url).endsWith("/sendMessage"))
        throw new Error("offline");
      return new Response(JSON.stringify({ ok: true, result: true }), {
        headers: { "content-type": "application/json" },
      });
    },
    nodeFetch,
  );
  const db = createDb(env.DB);
  const bot = createBot(
    "test",
    { db, allowedIds: new Set(["42"]), now: () => timestamp },
    {
      client: { fetch },
      botInfo: {
        id: 123,
        is_bot: true,
        first_name: "Test",
        username: "test_bot",
        can_join_groups: false,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
        can_connect_to_business: false,
        has_main_web_app: false,
        has_topics_enabled: false,
        allows_users_to_create_topics: false,
        can_manage_bots: false,
        supports_join_request_queries: false,
      },
    },
  );
  async function command(text: string, id = 1, user = 42, group = false) {
    const update: Update = {
      update_id: id,
      message: {
        message_id: id,
        date: 1,
        from: { id: user, is_bot: false, first_name: "Test" },
        chat: group
          ? { id: -42, type: "group", title: "Group" }
          : { id: user, type: "private", first_name: "Test" },
        text,
        entities: [{ type: "bot_command", offset: 0, length: text.length }],
      },
    };
    await bot.handleUpdate(update);
  }
  async function callback(data: string, id: number, user = 42) {
    await bot.handleUpdate({
      update_id: id,
      callback_query: {
        id: String(id),
        from: { id: user, is_bot: false, first_name: "Test" },
        chat_instance: "test",
        data,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: 42, type: "private", first_name: "Test" },
        },
      },
    });
  }
  return {
    db,
    calls,
    command,
    callback,
    bot,
    fail: (value: boolean) => {
      failSend = value;
    },
    advance: (value: number) => {
      timestamp += value;
    },
  };
}
test("private allowlisted onboarding is durable and duplicate updates are silent", async () => {
  const s = setup();
  await s.command("/start", 1, 99);
  await s.command("/start", 2, 42, true);
  expect(await getSubscriber(s.db, "42")).toBeNull();
  expect(s.calls).toHaveLength(0);
  await s.command("/start", 3);
  const before = s.calls.length;
  await s.command("/start", 3);
  expect(s.calls).toHaveLength(before);
  expect(await getSubscriber(s.db, "42")).toMatchObject({
    updatesEnabled: true,
    remindersEnabled: false,
    reminderMinutes: 15,
  });
});

test("queue and reminders commands open their menus without changing subscription", async () => {
  const s = setup();
  await s.command("/queue", 101);
  const queue = s.calls.at(-1)?.body;
  expect(JSON.stringify(queue?.reply_markup)).toContain("42:select:1.1");
  await s.command("/reminders", 102);
  expect(JSON.stringify(s.calls.at(-1)?.body.reply_markup)).toContain(
    "42:interval:30",
  );
  expect(await getSubscriber(s.db, "42")).toMatchObject({
    selection: null,
    remindersEnabled: false,
  });
});
test("callbacks bind owner, acknowledge first, preserve independent switches and stop opens menu", async () => {
  const s = setup();
  await s.command("/start");
  await s.callback("42:select:1.1", 2);
  await s.callback("42:reminders:on", 3);
  await s.callback("42:interval:30", 4);
  await s.command("/stop", 5);
  expect(await getSubscriber(s.db, "42")).toMatchObject({
    selection: "1.1",
    updatesEnabled: true,
    remindersEnabled: true,
    reminderMinutes: 30,
  });
  await s.callback("99:updates:off", 6);
  expect((await getSubscriber(s.db, "42"))?.updatesEnabled).toBe(true);
  const offset = s.calls.length;
  await s.callback("42:select:2.2", 7);
  expect(s.calls[offset]?.method).toBe("answerCallbackQuery");
  expect(await getSubscriber(s.db, "42")).toMatchObject({
    selection: "2.2",
    remindersEnabled: true,
    reminderMinutes: 30,
  });
  await s.callback("42:updates:off", 8);
  expect((await getSubscriber(s.db, "42"))?.remindersEnabled).toBe(true);
  await s.callback("42:stop:all", 9);
  expect(await getSubscriber(s.db, "42")).toMatchObject({
    updatesEnabled: false,
    remindersEnabled: false,
  });
});
test("empty cache says cannot check without HTTP source calls", async () => {
  const s = setup();
  await s.command("/start");
  await s.callback("42:select:1.1", 2);
  await s.command("/schedule", 3);
  expect(s.calls.some((c) => String(c.body.text).includes("збережених"))).toBe(
    true,
  );
  expect(
    s.calls.every((c) =>
      ["sendMessage", "answerCallbackQuery"].includes(c.method),
    ),
  ).toBe(true);
});

test("cached today/tomorrow display confirms own baseline; all preserves it and source failure warns", async () => {
  const s = setup();
  const { saveSnapshot, saveSourceState } = await import(
    "../../src/db/schedule"
  );
  const { queues: makeQueues } = await import("../unit/notification-fixtures");
  const { loadNotificationState } = await import(
    "../../src/notifications/delivery"
  );
  const queues = makeQueues({ status: "none" });
  await saveSnapshot(s.db, {
    checkedAt: now - 600000,
    days: [
      { date: "2026-10-31", queues },
      { date: "2026-11-01", queues },
    ],
  });
  await s.command("/start");
  await s.callback("42:select:1.1", 2);
  const baseline = await loadNotificationState(s.db, "42");
  expect(Object.keys(baseline ?? {})).toHaveLength(2);
  await s.command("/all", 3);
  expect(await loadNotificationState(s.db, "42")).toEqual(baseline);
  expect((await getSubscriber(s.db, "42"))?.selection).toBe("1.1");
  await saveSourceState(s.db, {
    lastAttemptAt: now,
    lastSuccessAt: now - 600000,
    nextAttemptAt: now + 300000,
    failureCount: 1,
    unavailable: true,
  });
  await s.command("/schedule", 4);
  expect(String(s.calls.at(-1)?.body.text)).toContain("Сайт недоступний");
  expect(String(s.calls.at(-1)?.body.text)).toContain("Перевірено:");
  expect(
    s.calls.every((c) =>
      ["sendMessage", "answerCallbackQuery"].includes(c.method),
    ),
  ).toBe(true);
});

test("repeated start preserves settings and repeated callback does not mutate", async () => {
  const s = setup();
  await s.command("/start");
  const user = await getSubscriber(s.db, "42");
  await s.callback("42:interval:60", 2);
  await s.command("/start", 3);
  expect(await getSubscriber(s.db, "42")).toMatchObject({
    reminderMinutes: 60,
    revision: (user?.revision ?? 0) + 1,
  });
  await s.callback("42:interval:60", 2);
  expect((await getSubscriber(s.db, "42"))?.revision).toBe(2);
});

test("revalidation cancels a delayed direct graph after cache changes", async () => {
  const s = setup();
  const { queues } = await import("../unit/notification-fixtures");
  const { saveSnapshot } = await import("../../src/db/schedule");
  const { deliveries } = await import("../../src/db/schema");
  const { revalidateDirectDelivery } = await import("../../src/bot/revalidate");
  await saveSnapshot(s.db, {
    checkedAt: now,
    days: [{ date: "2026-10-31", queues: queues({ status: "none" }) }],
  });
  await s.command("/start");
  await s.callback("42:select:1.1", 2);
  const row = (await s.db.select().from(deliveries)).find(
    (d) => d.key === "telegram:2",
  );
  if (!row) throw new Error("Missing intent");
  await saveSnapshot(s.db, {
    checkedAt: now,
    days: [{ date: "2026-10-31", queues: queues({ status: "pending" }) }],
  });
  expect(await revalidateDirectDelivery(s.db, row, now)).toBeNull();
});

test("failed Telegram delivery retains intent, completed update and unchanged baseline until drain succeeds", async () => {
  const s = setup();
  const { deliveries, operations } = await import("../../src/db/schema");
  const { deliverDue, loadNotificationState } = await import(
    "../../src/notifications/delivery"
  );
  s.fail(true);
  await s.command("/start");
  expect((await s.db.select().from(deliveries))[0]).toMatchObject({
    status: "pending",
    partCursor: 0,
  });
  expect((await s.db.select().from(operations))[0]?.completedAt).toBe(now);
  expect(await loadNotificationState(s.db, "42")).toBeNull();
  const count = s.calls.length;
  await s.command("/start");
  expect(s.calls).toHaveLength(count);
  s.fail(false);
  s.advance(30000);
  await deliverDue(s.db, s.bot.api, new Set(["42"]), now + 30000, {
    clock: () => now + 30000,
  });
  expect((await s.db.select().from(deliveries))[0]?.status).toBe("sent");
});

test("expired failed update claim retries without duplicating onboarding", async () => {
  const s = setup();
  const { claimOperation } = await import("../../src/db/operations");
  await claimOperation(s.db, "telegram:1", now, 1000);
  await expect(s.command("/start")).rejects.toThrow();
  expect(await getSubscriber(s.db, "42")).toBeNull();
  s.advance(1001);
  await s.command("/start");
  expect((await getSubscriber(s.db, "42"))?.revision).toBe(1);
  expect(s.calls).toHaveLength(1);
});

test("late reminder enable appends countdown to graph and confirms receipts once", async () => {
  const s = setup();
  const { queues } = await import("../unit/notification-fixtures");
  const { saveSnapshot } = await import("../../src/db/schedule");
  const { loadReminderReceipts, loadNotificationState } = await import(
    "../../src/notifications/delivery"
  );
  const { planReminders } = await import("../../src/notifications/reminders");
  const { getScheduleView, planChanges } = await import(
    "../../src/notifications/changes"
  );
  const day = queues({ status: "none" });
  day["1.1"] = {
    status: "scheduled",
    intervals: [{ startMinute: 730, endMinute: 780 }],
  };
  const snapshot = {
    checkedAt: now,
    days: [{ date: "2026-10-31", queues: day }],
  };
  await saveSnapshot(s.db, snapshot);
  await s.command("/start");
  await s.callback("42:select:1.1", 2);
  await s.callback("42:updates:off", 3);
  await s.callback("42:reminders:on", 4);
  const user = await getSubscriber(s.db, "42");
  if (!user) throw new Error("Missing user");
  expect(user.updatesEnabled).toBe(false);
  const receipts = await loadReminderReceipts(s.db, "42");
  expect(receipts).toHaveLength(1);
  expect(
    planReminders(user, getScheduleView(snapshot, "1.1", now), now, receipts),
  ).toEqual([]);
  await s.callback("42:updates:on", 5);
  expect(
    planChanges(
      await loadNotificationState(s.db, "42"),
      getScheduleView(snapshot, "1.1", now),
    ),
  ).toEqual([]);
});
