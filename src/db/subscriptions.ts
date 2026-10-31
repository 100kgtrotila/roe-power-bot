import { and, eq } from "drizzle-orm";
import type { Selection } from "../schedule/model";
import type { AppDb } from "./client";
import { subscribers } from "./schema";
export interface Subscriber {
  telegramId: string;
  selection: Selection | null;
  updatesEnabled: boolean;
  remindersEnabled: boolean;
  reminderMinutes: 15 | 30 | 60;
  revision: number;
}
export async function getSubscriber(
  db: AppDb,
  telegramId: string,
): Promise<Subscriber | null> {
  return (
    (await db
      .select()
      .from(subscribers)
      .where(eq(subscribers.telegramId, telegramId))
      .get()) ?? null
  );
}
/** An absent subscriber has revision zero. Every successful write advances it by one. */
export async function saveSubscriber(
  db: AppDb,
  input: Subscriber,
  expectedRevision: number,
): Promise<boolean> {
  if (input.revision !== expectedRevision + 1 || expectedRevision < 0)
    return false;
  const rows =
    expectedRevision === 0
      ? await db
          .insert(subscribers)
          .values(input)
          .onConflictDoNothing()
          .returning({ id: subscribers.telegramId })
      : await db
          .update(subscribers)
          .set(input)
          .where(
            and(
              eq(subscribers.telegramId, input.telegramId),
              eq(subscribers.revision, expectedRevision),
            ),
          )
          .returning({ id: subscribers.telegramId });
  return rows.length === 1;
}
