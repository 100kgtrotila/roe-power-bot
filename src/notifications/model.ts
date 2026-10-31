import type { InlineKeyboardMarkup, ReplyKeyboardMarkup } from "grammy/types";
import type { QueueId, QueueSchedule, Selection } from "../schedule/model";
export interface NotificationBaseline {
  selection: Selection;
  queues: Partial<Record<QueueId, QueueSchedule>>;
}
export interface ReminderReceipt {
  date: string;
  queue: QueueId;
  start: number;
  generation: string;
}
/** Persisted together with parts so final confirmation can update the correct baseline/receipt. */
export interface DeliveryPayload {
  parts: string[];
  directView?: import("./changes").ScheduleView;
  directReminders?: import("./reminders").ReminderNotice[];
  directConfirmation?: string;
  automaticView?: import("./changes").ScheduleView;
  automaticChanges?: import("./changes").ChangeNotice[];
  automaticReminders?: import("./reminders").ReminderNotice[];
  baselines?: Record<string, NotificationBaseline>;
  receipts?: ReminderReceipt[];
  replyMarkup?: InlineKeyboardMarkup | ReplyKeyboardMarkup;
  baseline?: { date: string; value: NotificationBaseline };
  receipt?: ReminderReceipt;
}
