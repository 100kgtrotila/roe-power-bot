import type { AppDb } from "../db/client";
import { claimLease, releaseLease } from "../db/operations";
import {
  loadSnapshot,
  loadSourceState,
  saveRefreshResult,
} from "../db/schedule";
import { parseSchedule, ScheduleParseError } from "./parser";
import { getKyivDates } from "./time";

export const SOURCE_URL = "https://www.roe.vsei.ua/disconnections";
const TIMEOUT_MS = 10000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const INTERVAL_MS = 300000;
const LEASE_MS = 30000;

export function retryAfterDelay(value: string | null, now: number): number {
  if (!value) return 0;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const milliseconds = Number(text) * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : 0;
  }
  // Require an HTTP-date shape: Date.parse also accepts malformed numeric delays.
  if (
    !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      text,
    )
  )
    return 0;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 0;
}

async function readHtml(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const type = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (type !== "text/html" && type !== "application/xhtml+xml")
    throw new Error("Invalid source type");
  const length = response.headers.get("content-length");
  if (length && Number(length) > MAX_HTML_BYTES)
    throw new Error("Source too large");
  if (!response.body) throw new Error("Empty source");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let abortRead: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    abortRead = () => reject(new Error("Source aborted"));
    signal.addEventListener("abort", abortRead, { once: true });
  });
  let bytes = 0;
  let html = "";
  try {
    while (true) {
      if (signal.aborted) throw new Error("Source aborted");
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_HTML_BYTES) throw new Error("Source too large");
      html += decoder.decode(chunk.value, { stream: true });
    }
    return html + decoder.decode();
  } finally {
    signal.removeEventListener("abort", abortRead);
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function refreshScheduleIfDue(
  db: AppDb,
  now: number,
  fetcher: typeof fetch,
): Promise<void> {
  if ((await loadSourceState(db)).nextAttemptAt > now) return;
  const token = await claimLease(db, "source-refresh", now, LEASE_MS);
  if (!token) return;
  const started = performance.now();
  const currentTime = () => now + Math.floor(performance.now() - started);
  let retryDelay = 0;
  const progress: { stage: "request" | "http" | "body" | "parse" | "persist" } =
    { stage: "request" };
  let httpStatus: number | null = null;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const previous = await loadSourceState(db);
    if (previous.nextAttemptAt > now) return;
    // Race bounds injected fetchers and body streams even if they ignore abort.
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("Source timeout"));
      }, TIMEOUT_MS);
    });
    try {
      const snapshot = await Promise.race([
        (async () => {
          const response = await fetcher(SOURCE_URL, {
            signal: controller.signal,
            headers: { Accept: "text/html" },
          });
          httpStatus = response.status;
          progress.stage = "http";
          if (!response.ok) {
            if (response.status === 429 || response.status === 503)
              retryDelay = retryAfterDelay(
                response.headers.get("retry-after"),
                currentTime(),
              );
            await response.body?.cancel();
            throw new Error("Source HTTP failure");
          }
          progress.stage = "body";
          const html = await readHtml(response, controller.signal);
          progress.stage = "parse";
          return parseSchedule(html, currentTime());
        })(),
        timedOut,
      ]);
      progress.stage = "persist";
      const completedAt = currentTime();
      const cached = await loadSnapshot(db);
      const { today, tomorrow } = getKyivDates(completedAt);
      const retained = (cached?.days ?? []).filter(
        (day) =>
          (day.date === today || day.date === tomorrow) &&
          !snapshot.days.some((next) => next.date === day.date),
      );
      snapshot.days.push(
        ...retained.map((day) => ({
          ...day,
          checkedAt: day.checkedAt ?? cached?.checkedAt ?? now,
          missing: true,
        })),
      );
      const saved = await saveRefreshResult(
        db,
        token,
        completedAt,
        {
          lastAttemptAt: now,
          lastSuccessAt: completedAt,
          nextAttemptAt: now + INTERVAL_MS,
          failureCount: 0,
          unavailable: false,
        },
        snapshot,
      );
      if (saved)
        console.info("source_refresh_succeeded", {
          checkedAt: completedAt,
          publishedDates: snapshot.days.length - retained.length,
          retainedDates: retained.length,
        });
    } catch (error) {
      const completedAt = currentTime();
      const failureCount = Math.min(previous.failureCount + 1, 1000);
      const delay = Math.max(
        Math.min(INTERVAL_MS * 2 ** Math.min(failureCount - 1, 5), 3600000),
        retryDelay,
      );
      const saved = await saveRefreshResult(db, token, completedAt, {
        ...previous,
        lastAttemptAt: now,
        nextAttemptAt: completedAt + delay,
        failureCount,
        unavailable: true,
      });
      // ScheduleParseError messages are fixed parser strings, never upstream text.
      if (saved)
        console.warn("source_refresh_failed", {
          stage: controller.signal.aborted ? "timeout" : progress.stage,
          httpStatus,
          ...(progress.stage === "parse" && error instanceof ScheduleParseError
            ? { parseReason: error.message }
            : {}),
          failureCount,
          nextAttemptAt: completedAt + delay,
        });
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    controller.abort();
    await releaseLease(db, "source-refresh", token);
  }
}
