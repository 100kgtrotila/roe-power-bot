import { env } from "cloudflare:workers";
import { Api } from "grammy";
import nodeFetch from "node-fetch";
import { expect, test } from "vitest";
import { createDb } from "../../src/db/client";
import {
  loadSnapshot,
  loadSourceState,
  saveSnapshot,
  saveSourceState,
} from "../../src/db/schedule";
import { saveSubscriber } from "../../src/db/subscriptions";
import { getScheduleView } from "../../src/notifications/changes";
import { loadReminderReceipts } from "../../src/notifications/delivery";
import { planReminders } from "../../src/notifications/reminders";
import { QUEUE_IDS, type Selection } from "../../src/schedule/model";
import { runScheduled } from "../../src/scheduled";

const initial = Date.UTC(2026, 9, 31, 10);
function setup() {
  let now = initial;
  let cell = "Очікується";
  let date = "31.10.2026";
  let allowed = "42";
  let offline = false;
  let failSend = false;
  let onSend: (() => Promise<void>) | undefined;
  const messages: string[] = [];
  let fetches = 0;
  const api = new Api("test", {
    timeoutSeconds: 10,
    fetch: Object.assign(
      async (
        _url: Parameters<typeof nodeFetch>[0],
        init?: Parameters<typeof nodeFetch>[1],
      ) => {
        if (onSend) {
          const hook = onSend;
          onSend = undefined;
          await hook();
        }
        if (failSend) throw new Error("offline");
        messages.push(JSON.parse(String(init?.body)).text);
        return new Response(JSON.stringify({ ok: true, result: true }), {
          headers: { "content-type": "application/json" },
        });
      },
      nodeFetch,
    ),
  });
  const fetcher: typeof fetch = async () => {
    fetches++;
    if (offline) return new Response(null, { status: 503 });
    return new Response(
      `<div id="fetched-data-container"><table><tr><td>Підчерга</td>${Array.from({ length: 12 }, (_, i) => `<td>${Math.floor(i / 2) + 1}.${(i % 2) + 1}</td>`).join("")}</tr><tr><td>${date}</td>${`<td>${cell}</td>`.repeat(12)}</tr></table></div>`,
      { headers: { "content-type": "text/html" } },
    );
  };
  return {
    messages,
    set: (value: string) => {
      cell = value;
    },
    fetches: () => fetches,
    day: (value: string) => {
      date = value;
    },
    allowed: (value: string) => {
      allowed = value;
    },
    offline: (value: boolean) => {
      offline = value;
    },
    fail: (value: boolean) => {
      failSend = value;
    },
    duringSend: (hook: () => Promise<void>) => {
      onSend = hook;
    },
    tick: async (advance = 300000) => {
      await runScheduled(
        { DB: env.DB, BOT_TOKEN: "test", ALLOWED_TELEGRAM_IDS: allowed },
        now,
        { api, fetcher, clock: () => now },
      );
      now += advance;
    },
    at: (value: number) => {
      now = value;
    },
  };
}
async function subscriber(
  remindersEnabled = false,
  selection: Selection = "1.1",
  updatesEnabled = true,
) {
  await saveSubscriber(
    createDb(env.DB),
    {
      telegramId: "42",
      selection,
      updatesEnabled,
      remindersEnabled,
      reminderMinutes: 30,
      revision: 1,
    },
    0,
  );
}
test("waiting, hours, unchanged, changed, clarification, restored hours, none survive restarts", async () => {
  await subscriber();
  const s = setup();
  for (const value of [
    "Очікується",
    "18:00-20:00",
    "18:00-20:00",
    "19:00-21:00",
    "Очікується",
    "18:00-20:00",
  ]) {
    s.set(value);
    await s.tick();
  }
  // No none marker has been verified on the live site. Exercise domain none
  // from persisted state rather than teaching the parser an invented spelling.
  const db = createDb(env.DB);
  const snapshot = await loadSnapshot(db);
  if (!snapshot) throw new Error("missing snapshot");
  for (const day of snapshot.days)
    for (const queue of QUEUE_IDS) day.queues[queue] = { status: "none" };
  await saveSnapshot(db, snapshot);
  await saveSourceState(db, {
    ...(await loadSourceState(db)),
    nextAttemptAt: initial + 86400000,
  });
  await s.tick();
  expect(s.messages).toHaveLength(5);
  expect(s.messages[2]).toContain("Графік уточнюється");
  expect(s.messages[4]).toContain("Відключень немає");
});

test("concurrent cron claims share one fetch and one graph", async () => {
  await subscriber();
  const s = setup();
  s.set("18:00-20:00");
  await Promise.all([s.tick(0), s.tick(0)]);
  expect(s.fetches()).toBe(1);
  expect(s.messages).toHaveLength(1);
});

test("failed delivery is cancelled after user stops and revision changes", async () => {
  await subscriber();
  const s = setup();
  s.set("18:00-20:00");
  s.fail(true);
  await s.tick();
  expect(s.messages).toHaveLength(0);
  await saveSubscriber(
    createDb(env.DB),
    {
      telegramId: "42",
      selection: "2.2",
      updatesEnabled: false,
      remindersEnabled: false,
      reminderMinutes: 30,
      revision: 2,
    },
    1,
  );
  s.fail(false);
  await s.tick();
  expect(s.messages).toHaveLength(0);
});

test("removing the user from allowlist prevents queued automatic delivery", async () => {
  await subscriber();
  const s = setup();
  s.set("18:00-20:00");
  s.fail(true);
  await s.tick();
  s.fail(false);
  s.allowed("");
  await s.tick();
  expect(s.messages).toHaveLength(0);
});

test("reminder at 30 minutes is independent of updates and deduplicates minute ticks", async () => {
  await subscriber(true, "1.1", false);
  const s = setup();
  s.set("18:00-20:00");
  s.at(Date.UTC(2026, 9, 31, 15, 29));
  await s.tick(60000);
  expect(s.messages).toHaveLength(0);
  await s.tick(60000);
  await s.tick();
  expect(s.messages).toHaveLength(1);
  expect(s.messages[0]).toContain("До відключення 30 хвилин");
  s.at(Date.UTC(2026, 9, 31, 16, 1));
  await s.tick();
  expect(s.messages).toHaveLength(1);
});

test("source outage is silent but due cached reminders warn, recovery does not repeat graph", async () => {
  await subscriber(true);
  const s = setup();
  s.set("18:00-20:00");
  s.at(Date.UTC(2026, 9, 31, 15));
  await s.tick();
  s.offline(true);
  s.at(Date.UTC(2026, 9, 31, 15, 30));
  await s.tick();
  expect(s.messages).toHaveLength(2);
  expect(s.messages[1]).toContain("Сайт недоступний");
  s.offline(false);
  s.at(Date.UTC(2026, 9, 31, 15, 40));
  await s.tick();
  expect(s.messages).toHaveLength(2);
});

test("all mode groups equal late starts into one graph and twelve receipts", async () => {
  await subscriber(true, "all");
  const s = setup();
  s.set("18:00-20:00");
  s.at(Date.UTC(2026, 9, 31, 15, 45));
  await s.tick(60000);
  await s.tick();
  expect(s.messages).toHaveLength(1);
  expect(s.messages[0]?.match(/До відключення/g)).toHaveLength(1);
  expect(await loadReminderReceipts(createDb(env.DB), "42")).toHaveLength(12);
});

test("replacement and restoration of an outage start re-enables reminder, end-only edits do not", async () => {
  await subscriber(true);
  const s = setup();
  s.at(Date.UTC(2026, 9, 31, 15, 35));
  for (const value of [
    "18:00-20:00",
    "18:00-21:00",
    "19:00-21:00",
    "18:00-20:00",
  ]) {
    s.set(value);
    await s.tick();
  }
  expect(s.messages).toHaveLength(4);
  expect(
    s.messages.filter((message) => message.includes("До відключення")),
  ).toHaveLength(2);
  expect(await loadReminderReceipts(createDb(env.DB), "42")).toHaveLength(1);
});

test("missing today is retained with original provenance without false whole-site outage", async () => {
  await subscriber(true);
  const s = setup();
  s.set("18:00-20:00");
  s.at(Date.UTC(2026, 9, 31, 15));
  await s.tick();
  const first = await loadSnapshot(createDb(env.DB));
  s.day("01.11.2026");
  s.set("00:00-01:00");
  s.at(Date.UTC(2026, 9, 31, 15, 5));
  await s.tick();
  const snapshot = await loadSnapshot(createDb(env.DB));
  expect(snapshot?.days.find((day) => day.date === "2026-10-31")).toMatchObject(
    { missing: true, checkedAt: first?.checkedAt },
  );
  expect(s.messages.at(-1)).toContain("Дата відсутня");
  expect(s.messages.at(-1)).not.toContain("Сайт недоступний");
  s.at(Date.UTC(2026, 9, 31, 15, 30));
  await s.tick();
  expect(s.messages.at(-1)).toContain("Дата відсутня");
  expect(s.messages.at(-1)).not.toContain("Сайт недоступний");
  if (!snapshot) throw new Error("missing snapshot");
  const reminderTime = Date.UTC(2026, 9, 31, 21, 30);
  const view = getScheduleView(
    snapshot,
    "1.1",
    reminderTime,
    await loadSourceState(createDb(env.DB)),
  );
  const freshSubscriber = {
    telegramId: "42",
    selection: "1.1",
    updatesEnabled: true,
    remindersEnabled: true,
    reminderMinutes: 30,
    revision: 1,
  } satisfies import("../../src/db/subscriptions").Subscriber;
  expect(planReminders(freshSubscriber, view, reminderTime, [])[0]?.stale).toBe(
    false,
  );
  s.at(reminderTime);
  await s.tick();
  expect(s.messages.at(-1)).toContain("До відключення 30 хвилин");
  expect(s.messages.at(-1)).not.toContain("Сайт недоступний");
});

test("midnight drops expired queued dates but publishes tomorrow immediately", async () => {
  await subscriber();
  const s = setup();
  s.set("18:00-20:00");
  s.fail(true);
  await s.tick();
  s.day("01.11.2026");
  s.set("08:00-10:00");
  s.fail(false);
  s.at(Date.UTC(2026, 9, 31, 22));
  await s.tick();
  expect(s.messages).toHaveLength(1);
  expect(s.messages[0]).toContain("2026-11-01");
  expect(s.messages[0]).not.toContain("2026-10-31");
});

test("lease expiration during send prevents confirmation and cleanup by stale owner", async () => {
  await subscriber();
  const s = setup();
  s.set("18:00-20:00");
  s.duringSend(async () => {
    s.at(initial + 60000);
  });
  await s.tick();
  const state = await env.DB.prepare(
    "SELECT count(*) AS count FROM notification_state",
  ).first<{ count: number }>();
  expect(state?.count).toBe(0);
});
test("late publication sends graph and one receipt instead of a second reminder", async () => {
  await subscriber(true);
  const s = setup();
  s.at(Date.UTC(2026, 9, 31, 15, 45));
  s.set("18:00-20:00");
  await s.tick(60000);
  await s.tick();
  expect(s.messages).toHaveLength(1);
  expect(s.messages[0]).toContain("До відключення 15 хвилин");
  expect(await loadReminderReceipts(createDb(env.DB), "42")).toHaveLength(1);
});
