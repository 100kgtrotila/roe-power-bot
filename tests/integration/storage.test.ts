import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { createDb } from "../../src/db/client";
import {
  claimLease,
  claimOperation,
  completeOperation,
  releaseLease,
} from "../../src/db/operations";
import { getSubscriber, saveSubscriber } from "../../src/db/subscriptions";

test("persists subscriptions and rejects stale revisions", async () => {
  const db = createDb(env.DB);
  const subscriber = {
    telegramId: "123",
    selection: "1.1",
    updatesEnabled: true,
    remindersEnabled: false,
    reminderMinutes: 30,
    revision: 1,
  } as const;
  expect(await getSubscriber(db, "123")).toBeNull();
  expect(await saveSubscriber(db, subscriber, 0)).toBe(true);
  expect(await getSubscriber(createDb(env.DB), "123")).toEqual(subscriber);
  expect(await saveSubscriber(db, { ...subscriber, selection: "2.1" }, 0)).toBe(
    false,
  );
  expect(await getSubscriber(db, "123")).toEqual(subscriber);
  const winner = { ...subscriber, selection: "3.1", revision: 2 } as const;
  expect(await saveSubscriber(db, winner, 1)).toBe(true);
  expect(
    await saveSubscriber(
      db,
      { ...subscriber, selection: "4.1", revision: 2 },
      1,
    ),
  ).toBe(false);
  expect(await getSubscriber(createDb(env.DB), "123")).toEqual(winner);
});
test("operation ownership, expiry and permanent deduplication", async () => {
  const db = createDb(env.DB);
  const first = await claimOperation(db, "update:1", 100, 10);
  expect(first).toBeTypeOf("string");
  expect(await claimOperation(db, "update:1", 101, 10)).toBeNull();
  const second = await claimOperation(db, "update:1", 110, 10);
  expect(second).toBeTypeOf("string");
  if (!first || !second) throw new Error("Missing claims");
  expect(await completeOperation(db, "update:1", first)).toBe(false);
  expect(await completeOperation(db, "update:1", second)).toBe(true);
  expect(await claimOperation(db, "update:1", 1000, 10)).toBeNull();
});
test("released recurring leases can be claimed again without stale owners releasing them", async () => {
  const db = createDb(env.DB);
  const first = await claimLease(db, "source", 10, 10);
  expect(await claimLease(db, "source", 11, 10)).toBeNull();
  const second = await claimLease(db, "source", 20, 10);
  if (!first || !second) throw new Error("Missing claims");
  await releaseLease(db, "source", first);
  expect(await claimLease(db, "source", 21, 10)).toBeNull();
  await releaseLease(db, "source", second);
  expect(await claimLease(db, "source", 22, 10)).toBeTypeOf("string");
});

import {
  loadSnapshot,
  loadSourceState,
  saveSnapshot,
  saveSourceState,
} from "../../src/db/schedule";
import { subscribers } from "../../src/db/schema";

test("snapshot and source state survive client recreation", async () => {
  const db = createDb(env.DB);
  expect(await loadSnapshot(db)).toBeNull();
  expect(await loadSourceState(db)).toEqual({
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextAttemptAt: 0,
    failureCount: 0,
    unavailable: false,
  });
  const snapshot = { days: [], checkedAt: 123 };
  const state = {
    lastAttemptAt: 100,
    lastSuccessAt: 90,
    nextAttemptAt: 200,
    failureCount: 1,
    unavailable: true,
  };
  await saveSnapshot(db, snapshot);
  await saveSourceState(db, state);
  expect(await loadSnapshot(createDb(env.DB))).toEqual(snapshot);
  expect(await loadSourceState(createDb(env.DB))).toEqual(state);
  await saveSnapshot(db, { ...snapshot, checkedAt: 124 });
  expect(await loadSnapshot(db)).toEqual({ ...snapshot, checkedAt: 124 });
});
test("D1 rejects unsupported selections and reminder intervals", async () => {
  await expect(
    env.DB.prepare("INSERT INTO subscribers VALUES (?, ?, ?, ?, ?, ?)")
      .bind("invalid", "7.1", 1, 0, 30, 1)
      .run(),
  ).rejects.toThrow();
  await expect(
    env.DB.prepare("INSERT INTO subscribers VALUES (?, ?, ?, ?, ?, ?)")
      .bind("invalid", "1.1", 1, 0, 45, 1)
      .run(),
  ).rejects.toThrow();
  expect(await createDb(env.DB).select().from(subscribers)).toEqual([]);
});
test("simultaneous claims have exactly one owner", async () => {
  const results = await Promise.all([
    claimOperation(createDb(env.DB), "race", 1, 100),
    claimOperation(createDb(env.DB), "race", 1, 100),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
});

import {
  deliveries,
  notificationState,
  reminderReceipts,
} from "../../src/db/schema";
import type { DeliveryPayload } from "../../src/notifications/model";

test("typed delivery metadata persists and D1 batch rolls back partial writes", async () => {
  const db = createDb(env.DB);
  await saveSubscriber(
    db,
    {
      telegramId: "456",
      selection: "1.1",
      updatesEnabled: true,
      remindersEnabled: true,
      reminderMinutes: 15,
      revision: 1,
    },
    0,
  );
  const payload: DeliveryPayload = {
    parts: ["first", "second"],
    baseline: {
      date: "2026-10-31",
      value: { selection: "1.1", queues: { "1.1": { status: "none" } } },
    },
    receipt: {
      date: "2026-10-31",
      queue: "1.1",
      start: 123,
      generation: "generation-1",
    },
  };
  await db.insert(deliveries).values({
    key: "delivery",
    telegramId: "456",
    type: "update",
    dueAt: 123,
    payload,
    revision: 1,
    status: "pending",
  });
  expect(
    (await createDb(env.DB).select().from(deliveries).get())?.payload,
  ).toEqual(payload);
  await expect(
    db.batch([
      db.insert(notificationState).values({
        telegramId: "456",
        date: "2026-10-31",
        baseline: { selection: "1.1", queues: {} },
      }),
      db.insert(reminderReceipts).values({
        telegramId: "missing",
        date: "2026-10-31",
        queue: "1.1",
        start: 123,
        generation: "bad",
      }),
    ]),
  ).rejects.toThrow();
  expect(await db.select().from(notificationState)).toEqual([]);
});
