import { isQueueId, type Selection } from "../schedule/model";
export type BotView =
  | "schedule"
  | "all"
  | "select"
  | "reminders"
  | "manage"
  | "help"
  | "menu"
  | "status";
export type BotAction = { owner: string } & (
  | {
      kind: "view";
      view: BotView;
    }
  | { kind: "select"; selection: Selection }
  | { kind: "interval"; minutes: 15 | 30 | 60 }
  | { kind: "updates" | "reminders"; enabled: boolean }
  | { kind: "stop" }
);
export function parseCallback(data: string): BotAction | null {
  const [owner, kind, value, ...extra] = data.split(":");
  if (!owner || !/^[1-9]\d*$/.test(owner) || extra.length) return null;
  if (
    kind === "view" &&
    (value === "schedule" ||
      value === "all" ||
      value === "select" ||
      value === "reminders" ||
      value === "manage" ||
      value === "help" ||
      value === "menu" ||
      value === "status")
  )
    return { owner, kind, view: value };
  if (kind === "select" && value && (value === "all" || isQueueId(value)))
    return { owner, kind, selection: value };
  if (
    kind === "interval" &&
    (value === "15" || value === "30" || value === "60")
  )
    return {
      owner,
      kind,
      minutes: value === "15" ? 15 : value === "30" ? 30 : 60,
    };
  if (
    (kind === "updates" || kind === "reminders") &&
    (value === "on" || value === "off")
  )
    return { owner, kind, enabled: value === "on" };
  if (kind === "stop" && value === "all") return { owner, kind };
  return null;
}
