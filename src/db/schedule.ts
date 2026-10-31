import type { ScheduleSnapshot } from "../schedule/model";
import type { AppDb } from "./client";
import { scheduleSnapshots, sourceState } from "./schema";
export interface SourceState {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  nextAttemptAt: number;
  failureCount: number;
  unavailable: boolean;
}
export async function loadSnapshot(
  db: AppDb,
): Promise<ScheduleSnapshot | null> {
  return (await db.select().from(scheduleSnapshots).get())?.snapshot ?? null;
}
export async function saveSnapshot(
  db: AppDb,
  snapshot: ScheduleSnapshot,
): Promise<void> {
  await db
    .insert(scheduleSnapshots)
    .values({ id: 1, snapshot })
    .onConflictDoUpdate({ target: scheduleSnapshots.id, set: { snapshot } });
}
export async function loadSourceState(db: AppDb): Promise<SourceState> {
  const row = await db.select().from(sourceState).get();
  return row
    ? {
        lastAttemptAt: row.lastAttemptAt,
        lastSuccessAt: row.lastSuccessAt,
        nextAttemptAt: row.nextAttemptAt,
        failureCount: row.failureCount,
        unavailable: row.unavailable,
      }
    : {
        lastAttemptAt: null,
        lastSuccessAt: null,
        nextAttemptAt: 0,
        failureCount: 0,
        unavailable: false,
      };
}
export async function saveSourceState(
  db: AppDb,
  state: SourceState,
): Promise<void> {
  await db
    .insert(sourceState)
    .values({ id: 1, ...state })
    .onConflictDoUpdate({ target: sourceState.id, set: state });
}

/** Both guarded writes run in one D1 transaction; stale owners change neither row. */
export async function saveRefreshResult(
  db: AppDb,
  token: string,
  now: number,
  state: SourceState,
  snapshot?: ScheduleSnapshot,
): Promise<boolean> {
  const ownership =
    "EXISTS (SELECT 1 FROM leases WHERE resource = 'source-refresh' AND claim_token = ? AND expiry > ?)";
  const stateWrite = db.$client
    .prepare(`
    INSERT INTO source_state (id, last_attempt_at, last_success_at, next_attempt_at, failure_count, unavailable)
    SELECT 1, ?, ?, ?, ?, ? WHERE ${ownership}
    ON CONFLICT(id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_success_at = excluded.last_success_at,
      next_attempt_at = excluded.next_attempt_at, failure_count = excluded.failure_count, unavailable = excluded.unavailable
    WHERE ${ownership}`)
    .bind(
      state.lastAttemptAt,
      state.lastSuccessAt,
      state.nextAttemptAt,
      state.failureCount,
      state.unavailable ? 1 : 0,
      token,
      now,
      token,
      now,
    );
  if (!snapshot) return (await stateWrite.run()).meta.changes === 1;
  const results = await db.$client.batch([
    db.$client
      .prepare(`INSERT INTO schedule_snapshots (id, snapshot) SELECT 1, ? WHERE ${ownership}
      ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot WHERE ${ownership}`)
      .bind(JSON.stringify(snapshot), token, now, token, now),
    stateWrite,
  ]);
  return results[1]?.meta.changes === 1;
}
