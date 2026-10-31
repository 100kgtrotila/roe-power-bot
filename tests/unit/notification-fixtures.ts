import type { QueueId, QueueSchedule } from "../../src/schedule/model";
export function queues(
  schedule: QueueSchedule,
): Record<QueueId, QueueSchedule> {
  return {
    "1.1": schedule,
    "1.2": schedule,
    "2.1": schedule,
    "2.2": schedule,
    "3.1": schedule,
    "3.2": schedule,
    "4.1": schedule,
    "4.2": schedule,
    "5.1": schedule,
    "5.2": schedule,
    "6.1": schedule,
    "6.2": schedule,
  };
}
