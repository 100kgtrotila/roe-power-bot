import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { createDb } from "../../src/db/client";
import { claimLease } from "../../src/db/operations";
import {
  loadSnapshot,
  loadSourceState,
  saveRefreshResult,
  saveSnapshot,
  saveSourceState,
} from "../../src/db/schedule";
import { saveSubscriber } from "../../src/db/subscriptions";
import { refreshScheduleIfDue } from "../../src/schedule/source";

const html = `<div id="fetched-data-container"><table><tr><td>Підчерга</td>${Array.from({ length: 12 }, (_, i) => `<td>${Math.floor(i / 2) + 1}.${(i % 2) + 1}</td>`).join("")}</tr><tr><td>31.10.2026</td>${"<td>Очікується</td>".repeat(12)}</tr></table></div>`;
const good = () =>
  new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

test.each([
  ["http", 403, async () => new Response(null, { status: 403 })],
  [
    "parse",
    200,
    async () =>
      new Response("<html>changed layout</html>", {
        headers: { "content-type": "text/html" },
      }),
  ],
  [
    "request",
    null,
    async () => {
      throw new Error("secret credential in upstream exception");
    },
  ],
] as const)(
  "diagnostics distinguish %s failure without raw exception text",
  async (stage, httpStatus, fetcher) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const db = createDb(env.DB);
      await refreshScheduleIfDue(db, 1000, fetcher);
      expect(warning.mock.calls).toEqual([
        [
          "source_refresh_failed",
          expect.objectContaining({ stage, httpStatus, failureCount: 1 }),
        ],
      ]);
      expect(JSON.stringify(warning.mock.calls)).not.toContain(
        "secret credential",
      );
      expect((await loadSourceState(db)).unavailable).toBe(true);
    } finally {
      warning.mockRestore();
    }
  },
);

test("successful refresh logs confirmed processing and a skipped poll does not log a fake success", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const db = createDb(env.DB);
    await refreshScheduleIfDue(db, 1000, async () => good());
    await refreshScheduleIfDue(db, 1001, async () => good());
    expect(info.mock.calls).toEqual([
      [
        "source_refresh_succeeded",
        expect.objectContaining({ publishedDates: 1, retainedDates: 0 }),
      ],
    ]);
    expect((await loadSourceState(db)).lastSuccessAt).not.toBeNull();
  } finally {
    info.mockRestore();
  }
});
test("20 subscribers and concurrent refresh share one fetch and persist cadence", async () => {
  const db = createDb(env.DB);
  for (let i = 0; i < 20; i++)
    await saveSubscriber(
      db,
      {
        telegramId: String(i),
        selection: "1.1",
        updatesEnabled: true,
        remindersEnabled: false,
        reminderMinutes: 30,
        revision: 1,
      },
      0,
    );
  const fetcher = vi.fn<typeof fetch>(async () => good());
  await Promise.all(
    Array.from({ length: 20 }, () =>
      refreshScheduleIfDue(createDb(env.DB), 1000, fetcher),
    ),
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  await refreshScheduleIfDue(createDb(env.DB), 300999, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await loadSourceState(db)).nextAttemptAt).toBeGreaterThanOrEqual(
    301000,
  );
  expect((await loadSnapshot(db))?.days).toHaveLength(1);
});

test("minute ticks keep successful fetch starts five minutes apart despite response latency", async () => {
  const db = createDb(env.DB);
  const starts: number[] = [];
  for (let minute = 0; minute <= 10; minute++) {
    const now = 1000 + minute * 60000;
    await refreshScheduleIfDue(db, now, async () => {
      starts.push(now);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return good();
    });
  }
  expect(starts).toEqual([1000, 301000, 601000]);
});
test.each([
  [
    "429 seconds",
    () =>
      new Response(null, { status: 429, headers: { "retry-after": "1200" } }),
    1200000,
  ],
  [
    "503 date",
    () =>
      new Response(null, {
        status: 503,
        headers: { "retry-after": "Thu, 01 Jan 1970 00:30:00 GMT" },
      }),
    1799000,
  ],
  ["wrong type", () => new Response(html), 300000],
  [
    "partial table",
    () =>
      new Response(html.replace("<td>Очікується</td>", ""), {
        headers: { "content-type": "text/html" },
      }),
    300000,
  ],
  [
    "large stream",
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(2097153));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/html" } },
      ),
    300000,
  ],
] as const)("%s preserves snapshot", async (_label, response, delay) => {
  const db = createDb(env.DB);
  const snapshot = { days: [], checkedAt: 5 };
  await saveSnapshot(db, snapshot);
  await saveSourceState(db, {
    lastAttemptAt: 5,
    lastSuccessAt: 5,
    nextAttemptAt: 0,
    failureCount: 0,
    unavailable: false,
  });
  const fetcher: typeof fetch = async () => response();
  await refreshScheduleIfDue(db, 1000, fetcher);
  expect(await loadSnapshot(db)).toEqual(snapshot);
  const state = await loadSourceState(db);
  expect(state).toMatchObject({
    lastSuccessAt: 5,
    unavailable: true,
    failureCount: 1,
  });
  expect(state.nextAttemptAt).toBeGreaterThanOrEqual(1000 + delay);
});
test("timeout aborts the request and preserves previous data", async () => {
  vi.useFakeTimers();
  try {
    const db = createDb(env.DB);
    const snapshot = { days: [], checkedAt: 5 };
    await saveSnapshot(db, snapshot);
    await saveSourceState(db, {
      lastAttemptAt: 5,
      lastSuccessAt: 5,
      nextAttemptAt: 0,
      failureCount: 0,
      unavailable: false,
    });
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fetcher: typeof fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
        entered();
      });
    const pending = refreshScheduleIfDue(db, 1000, fetcher);
    await started;
    await vi.advanceTimersByTimeAsync(10000);
    await pending;
    expect((await loadSourceState(db)).unavailable).toBe(true);
    expect(await loadSnapshot(db)).toEqual(snapshot);
    expect(await loadSourceState(db)).toMatchObject({
      lastSuccessAt: 5,
      failureCount: 1,
    });
    expect((await loadSourceState(db)).nextAttemptAt).toBeGreaterThanOrEqual(
      301000,
    );
  } finally {
    vi.useRealTimers();
  }
});
test("expired and replaced owners cannot write either snapshot or state", async () => {
  const db = createDb(env.DB);
  const token = await claimLease(db, "source-refresh", 0, 10);
  if (!token) throw new Error("missing claim");
  const state = {
    lastAttemptAt: 1,
    lastSuccessAt: 1,
    nextAttemptAt: 300001,
    failureCount: 0,
    unavailable: false,
  };
  expect(
    await saveRefreshResult(db, token, 10, state, { days: [], checkedAt: 1 }),
  ).toBe(false);
  await claimLease(db, "source-refresh", 10, 100);
  expect(
    await saveRefreshResult(db, token, 11, state, { days: [], checkedAt: 1 }),
  ).toBe(false);
  expect(await loadSnapshot(db)).toBeNull();
  expect((await loadSourceState(db)).lastAttemptAt).toBeNull();
});

test("persistent backoff grows to 60 minutes and successful recovery resets failures", async () => {
  const db = createDb(env.DB);
  const fetcher: typeof fetch = async () => new Response(null, { status: 503 });
  let now = 1000;
  for (const minutes of [5, 10, 20, 40, 60, 60]) {
    await refreshScheduleIfDue(createDb(env.DB), now, fetcher);
    const state = await loadSourceState(db);
    expect(state.nextAttemptAt - now).toBeGreaterThanOrEqual(minutes * 60000);
    expect(state.nextAttemptAt - now).toBeLessThan(minutes * 60000 + 1000);
    now = state.nextAttemptAt;
  }
  const recovered: typeof fetch = async () => good();
  await refreshScheduleIfDue(db, now, recovered);
  expect(await loadSourceState(db)).toMatchObject({
    failureCount: 0,
    unavailable: false,
  });
  expect((await loadSnapshot(db))?.days).toHaveLength(1);
});

test("timeout also bounds a stalled response stream", async () => {
  vi.useFakeTimers();
  try {
    const db = createDb(env.DB);
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fetcher: typeof fetch = async () => {
      entered();
      return new Response(new ReadableStream(), {
        headers: { "content-type": "text/html" },
      });
    };
    const pending = refreshScheduleIfDue(db, 1000, fetcher);
    await started;
    await vi.advanceTimersByTimeAsync(10000);
    await pending;
    expect((await loadSourceState(db)).unavailable).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
