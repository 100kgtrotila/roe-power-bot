import { env } from "cloudflare:workers";
import { Api, GrammyError } from "grammy";
import nodeFetch from "node-fetch";
import { expect, test } from "vitest";
import { createDb } from "../../src/db/client";
import { deliveries } from "../../src/db/schema";
import { getSubscriber, saveSubscriber } from "../../src/db/subscriptions";
import {
  deliverDue,
  enqueueDelivery,
  loadNotificationState,
  loadReminderReceipts,
} from "../../src/notifications/delivery";

const allowed = new Set(["123"]);
async function setup() {
  const db = createDb(env.DB);
  await saveSubscriber(
    db,
    {
      telegramId: "123",
      selection: "1.1",
      updatesEnabled: true,
      remindersEnabled: true,
      reminderMinutes: 30,
      revision: 1,
    },
    0,
  );
  return db;
}
function fake(send: (text: string) => Promise<void>) {
  const outbound = Object.assign(
    async (
      _url: Parameters<typeof nodeFetch>[0],
      init?: Parameters<typeof nodeFetch>[1],
    ) => {
      const payload: unknown = JSON.parse(String(init?.body));
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("text" in payload) ||
        typeof payload.text !== "string"
      )
        throw new Error("Bad payload");
      try {
        await send(payload.text);
      } catch (error: unknown) {
        if (error instanceof GrammyError)
          return new Response(
            JSON.stringify({
              ok: false,
              error_code: error.error_code,
              description: error.description,
              parameters: error.parameters,
            }),
            { headers: { "content-type": "application/json" } },
          );
        throw error;
      }
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 1,
            date: 1,
            chat: { id: 123, type: "private", first_name: "Test" },
            text: payload.text,
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
    nodeFetch,
  );
  const api = new Api("test", { fetch: outbound });
  return api;
}
const intent = {
  key: "change:123:1:transition-1",
  telegramId: "123",
  kind: "change",
  parts: ["a", "b", "c"],
  dueAt: 100,
  subscriberRevision: 1,
  expiresAt: 999999,
  baselines: { "2026-10-31": { selection: "1.1", queues: {} } },
  receipts: [
    { date: "2026-10-31", queue: "1.1", start: 500, generation: "500" },
  ],
} as const;
function input() {
  return {
    ...intent,
    parts: [...intent.parts],
    receipts: [...intent.receipts],
  };
}
test("deduplicates enqueue and concurrent send; commits full metadata", async () => {
  const db = await setup();
  await Promise.all([
    enqueueDelivery(db, input()),
    enqueueDelivery(db, input()),
  ]);
  const sent: string[] = [];
  const api = fake(async (t) => {
    sent.push(t);
  });
  await Promise.all([
    deliverDue(db, api, allowed, 100),
    deliverDue(createDb(env.DB), api, allowed, 100),
  ]);
  expect(sent).toEqual(["a", "b", "c"]);
  expect(await loadNotificationState(db, "123")).toEqual(intent.baselines);
  expect(await loadReminderReceipts(db, "123")).toEqual(intent.receipts);
});

test("part budget yields a durable cursor and releases the claim for next invocation", async () => {
  const db = await setup();
  await enqueueDelivery(db, input());
  const sent: string[] = [];
  const api = fake(async (text) => {
    sent.push(text);
  });
  await deliverDue(db, api, allowed, 100, { maxParts: 1 });
  expect(sent).toEqual(["a"]);
  expect(await loadNotificationState(db, "123")).toBeNull();
  expect((await db.select().from(deliveries).get())?.claimToken).toBeNull();
  await deliverDue(db, api, allowed, 101, { maxParts: 1 });
  await deliverDue(db, api, allowed, 102, { maxParts: 1 });
  expect(sent).toEqual(["a", "b", "c"]);
  expect(await loadNotificationState(db, "123")).toEqual(intent.baselines);
});
test("restart resumes cursor after timeout without premature baseline", async () => {
  const db = await setup();
  await enqueueDelivery(db, input());
  const sent: string[] = [];
  await deliverDue(
    db,
    fake(async (t) => {
      if (t === "b") throw new Error("timeout");
      sent.push(t);
    }),
    allowed,
    100,
    { clock: () => 100 },
  );
  expect(await loadNotificationState(db, "123")).toBeNull();
  expect(await loadReminderReceipts(db, "123")).toEqual([]);
  await deliverDue(
    createDb(env.DB),
    fake(async (t) => {
      sent.push(t);
    }),
    allowed,
    30100,
  );
  expect(sent).toEqual(["a", "b", "c"]);
  expect((await db.select().from(deliveries).get())?.status).toBe("sent");
});

test("changed multipart boundaries cannot skip intervals or confirm an incomplete delivery", async () => {
  const db = await setup();
  await enqueueDelivery(db, input());
  const sent: string[] = [];
  const api = fake(async (text) => {
    sent.push(text);
  });
  await deliverDue(db, api, allowed, 100, { maxParts: 1 });
  await deliverDue(db, api, allowed, 101, {
    revalidate: async (row) => ({
      ...row.payload,
      parts: ["a plus b", "c", "d"],
    }),
  });
  expect(sent).toEqual(["a"]);
  expect(await loadNotificationState(db, "123")).toBeNull();
  expect((await db.select().from(deliveries).get())?.status).toBe("cancelled");
});

test("an unsent intent can adopt new formatting with a different part count", async () => {
  const db = await setup();
  await enqueueDelivery(db, input());
  const sent: string[] = [];
  await deliverDue(
    db,
    fake(async (text) => {
      sent.push(text);
    }),
    allowed,
    100,
    {
      revalidate: async (row) => ({ ...row.payload, parts: ["a and b", "c"] }),
    },
  );
  expect(sent).toEqual(["a and b", "c"]);
  expect(await loadNotificationState(db, "123")).toEqual(intent.baselines);
  expect((await db.select().from(deliveries).get())?.status).toBe("sent");
});
test("revision changed during group cancels remaining parts", async () => {
  const db = await setup();
  await enqueueDelivery(db, input());
  const sent: string[] = [];
  await deliverDue(
    db,
    fake(async (t) => {
      sent.push(t);
      const s = await getSubscriber(db, "123");
      if (s)
        await saveSubscriber(
          db,
          { ...s, revision: 2, updatesEnabled: false },
          1,
        );
    }),
    allowed,
    100,
  );
  expect(sent).toEqual(["a"]);
  expect(await loadNotificationState(db, "123")).toBeNull();
});
test("allowlist removal and expired intent never send", async () => {
  const db = await setup();
  await enqueueDelivery(db, input());
  let calls = 0;
  await deliverDue(
    db,
    fake(async () => {
      calls++;
    }),
    new Set(),
    100,
  );
  expect(calls).toBe(0);
});
test("429 defers and 403 disables both automatic switches", async () => {
  const db = await setup();
  await enqueueDelivery(db, input());
  await deliverDue(
    db,
    fake(async () => {
      throw new GrammyError(
        "limited",
        {
          ok: false,
          error_code: 429,
          description: "limited",
          parameters: { retry_after: 60 },
        },
        "sendMessage",
        {},
      );
    }),
    allowed,
    100,
    { clock: () => 100 },
  );
  expect((await db.select().from(deliveries).get())?.dueAt).toBe(60100);
  await deliverDue(
    db,
    fake(async () => {
      throw new GrammyError(
        "blocked",
        { ok: false, error_code: 403, description: "blocked" },
        "sendMessage",
        {},
      );
    }),
    allowed,
    60100,
  );
  expect(await getSubscriber(db, "123")).toMatchObject({
    updatesEnabled: false,
    remindersEnabled: false,
    revision: 2,
  });
});

test("expired worker cannot advance cursor or confirm replacement claim", async () => {
  const db = await setup();
  await enqueueDelivery(db, { ...input(), parts: ["a"] });
  let finish: () => void = () => {};
  let entered: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let time = 100;
  const old = deliverDue(
    db,
    fake(async () => {
      entered();
      await blocked;
    }),
    allowed,
    100,
    { clock: () => time },
  );
  await ready;
  time = 60101;
  await deliverDue(
    createDb(env.DB),
    fake(async () => {}),
    allowed,
    time,
    { clock: () => time },
  );
  finish();
  await old;
  expect(await db.select().from(deliveries).get()).toMatchObject({
    status: "sent",
    partCursor: 1,
    attempts: 0,
  });
  expect(await loadReminderReceipts(db, "123")).toEqual(intent.receipts);
});
test("revalidation cancels obsolete graph before retry and prevents confirmation", async () => {
  const db = await setup();
  await enqueueDelivery(db, input());
  let count = 0;
  await deliverDue(
    db,
    fake(async () => {
      count++;
    }),
    allowed,
    100,
    { revalidate: async (row) => (row.partCursor === 0 ? row.payload : null) },
  );
  expect(count).toBe(1);
  expect(await loadNotificationState(db, "123")).toBeNull();
  expect((await db.select().from(deliveries).get())?.status).toBe("cancelled");
});
test("expiry and disabled reminders cancel without HTTP", async () => {
  const db = await setup();
  const s = await getSubscriber(db, "123");
  if (!s) throw new Error("Missing subscriber");
  await saveSubscriber(db, { ...s, remindersEnabled: false, revision: 2 }, 1);
  await enqueueDelivery(db, {
    ...input(),
    key: "reminder",
    kind: "reminder",
    subscriberRevision: 2,
  });
  await enqueueDelivery(db, {
    ...input(),
    key: "expired",
    kind: "direct",
    subscriberRevision: 2,
    expiresAt: 101,
  });
  let count = 0;
  await deliverDue(
    db,
    fake(async () => {
      count++;
    }),
    allowed,
    102,
  );
  expect(count).toBe(0);
  expect(
    (await db.select().from(deliveries)).every((r) => r.status === "cancelled"),
  ).toBe(true);
});
test("direct messages retain inline buttons and multi-date baseline", async () => {
  const db = await setup();
  const markup = {
    inline_keyboard: [[{ text: "Меню", callback_data: "menu" }]],
  };
  await enqueueDelivery(db, {
    ...input(),
    kind: "direct",
    parts: ["one"],
    replyMarkup: markup,
    baselines: {
      ...intent.baselines,
      "2026-11-01": { selection: "1.1", queues: {} },
    },
  });
  const bodies: unknown[] = [];
  const outbound = Object.assign(
    async (
      _url: Parameters<typeof nodeFetch>[0],
      init?: Parameters<typeof nodeFetch>[1],
    ) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 1,
            date: 1,
            chat: { id: 123, type: "private" },
          },
        }),
      );
    },
    nodeFetch,
  );
  await deliverDue(db, new Api("test", { fetch: outbound }), allowed, 100);
  expect(bodies).toEqual([
    expect.objectContaining({
      reply_markup: markup,
      link_preview_options: { is_disabled: true },
    }),
  ]);
  expect(
    Object.keys((await loadNotificationState(db, "123")) ?? {}),
  ).toHaveLength(2);
});
test("bounds a stalled HTTP request without advancing cursor", async () => {
  const db = await setup();
  await enqueueDelivery(db, { ...input(), parts: ["a"] });
  await deliverDue(
    db,
    fake(async () => new Promise<void>(() => {})),
    allowed,
    100,
  );
  expect(await db.select().from(deliveries).get()).toMatchObject({
    status: "pending",
    partCursor: 0,
    attempts: 1,
  });
  expect(await loadNotificationState(db, "123")).toBeNull();
}, 20000);
test("stale due candidate cannot bypass retry_after recorded by another worker", async () => {
  const db = await setup();
  await enqueueDelivery(db, { ...input(), parts: ["target"] });
  await enqueueDelivery(db, {
    ...input(),
    key: "0-blocker",
    parts: ["blocker"],
  });
  let entered: () => void = () => {};
  let release: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent: string[] = [];
  const staleWorker = deliverDue(
    db,
    fake(async (text) => {
      sent.push(text);
      if (text === "blocker") {
        entered();
        await gate;
      }
    }),
    allowed,
    100,
    { clock: () => 100 },
  );
  await ready;
  await deliverDue(
    createDb(env.DB),
    fake(async () => {
      throw new GrammyError(
        "limited",
        {
          ok: false,
          error_code: 429,
          description: "limited",
          parameters: { retry_after: 60 },
        },
        "sendMessage",
        {},
      );
    }),
    allowed,
    100,
    { clock: () => 100 },
  );
  release();
  await staleWorker;
  expect(sent).toEqual(["blocker"]);
  expect(
    (await db.select().from(deliveries)).find((row) => row.key === intent.key),
  ).toMatchObject({
    status: "pending",
    dueAt: 60100,
    attempts: 1,
    partCursor: 0,
  });
});
test("429 retry_after starts when the delayed failure is received", async () => {
  const db = await setup();
  await enqueueDelivery(db, input());
  let time = 100;
  await deliverDue(
    db,
    fake(async () => {
      time = 10100;
      throw new GrammyError(
        "limited",
        {
          ok: false,
          error_code: 429,
          description: "limited",
          parameters: { retry_after: 60 },
        },
        "sendMessage",
        {},
      );
    }),
    allowed,
    100,
    { clock: () => time },
  );
  expect((await db.select().from(deliveries).get())?.dueAt).toBe(70100);
});
