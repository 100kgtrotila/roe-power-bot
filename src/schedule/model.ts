export const QUEUE_IDS = [
  "1.1",
  "1.2",
  "2.1",
  "2.2",
  "3.1",
  "3.2",
  "4.1",
  "4.2",
  "5.1",
  "5.2",
  "6.1",
  "6.2",
] as const;
export type QueueId = (typeof QUEUE_IDS)[number];
export type Selection = QueueId | "all";
export interface OutageInterval {
  startMinute: number;
  endMinute: number;
}
export type QueueSchedule =
  | { status: "pending" }
  | { status: "none" }
  | { status: "scheduled"; intervals: OutageInterval[] };
export interface DaySchedule {
  date: string;
  checkedAt?: number;
  missing?: boolean;
  queues: Record<QueueId, QueueSchedule>;
}
export interface ScheduleSnapshot {
  days: DaySchedule[];
  checkedAt: number;
}
export function isQueueId(value: string): value is QueueId {
  return QUEUE_IDS.some((queue) => queue === value);
}
