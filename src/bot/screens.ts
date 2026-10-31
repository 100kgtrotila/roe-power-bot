import type { SourceState } from "../db/schedule";
import type { Subscriber } from "../db/subscriptions";
import type { BotAction, BotView } from "./callbacks";
import { HELP } from "./commands";

function selectionLabel(user: Subscriber): string {
  return user.selection === "all"
    ? "усі підчерги"
    : (user.selection ?? "ще не обрано");
}

export function renderScreen(user: Subscriber, page: BotView): string {
  const titles: Record<BotView, string> = {
    menu: "⚡ Рівнеобленерго",
    select: "🔢 Моя підчерга",
    reminders: "🔔 Нагадування",
    manage: "⚙️ Налаштування",
    status: "🟢 Стан перевірок",
    help: "ℹ️ Допомога",
    schedule: "📅 Мій графік",
    all: "📋 Усі черги",
  };
  const lines = [
    titles[page],
    "",
    `Підчерга: ${selectionLabel(user)}`,
    `Оновлення: ${user.updatesEnabled ? "увімкнені" : "вимкнені"}`,
    `Нагадування: ${user.remindersEnabled ? `за ${user.reminderMinutes} хвилин` : `вимкнені · інтервал ${user.reminderMinutes} хв`}`,
  ];
  if (page === "menu")
    lines.push(
      "",
      user.selection
        ? "Обери дію кнопками внизу чату."
        : "Натисни «🔢 Моя підчерга», щоб налаштувати свій графік.",
    );
  if (page === "select")
    lines.push(
      "",
      "Обери одну підчергу або підпишись на всі. Поточний вибір позначено ✓.",
    );
  if (page === "reminders")
    lines.push(
      "",
      "Обери, за скільки хвилин нагадувати. Інтервал зберігається навіть коли нагадування вимкнені.",
    );
  if (page === "manage")
    lines.push(
      "",
      "Оновлення графіка й нагадування вмикаються окремо. Для повної паузи натисни «Вимкнути все».",
    );
  if (page === "help") lines.push("", HELP);
  return lines.join("\n");
}

export function actionConfirmation(action: BotAction): string | undefined {
  if (action.kind === "select")
    return action.selection === "all"
      ? "✓ Обрано всі підчерги."
      : `✓ Обрано підчергу ${action.selection}.`;
  if (action.kind === "interval")
    return `✓ Збережено інтервал: ${action.minutes} хв.`;
  if (action.kind === "updates")
    return `✓ Оновлення ${action.enabled ? "увімкнено" : "вимкнено"}.`;
  if (action.kind === "reminders")
    return `✓ Нагадування ${action.enabled ? "увімкнено" : "вимкнено"}.`;
  if (action.kind === "stop") return "✓ Оновлення й нагадування вимкнено.";
  return undefined;
}

export function withConfirmation(
  parts: string[],
  confirmation: string | undefined,
): string[] {
  const first = parts[0];
  if (!confirmation || first === undefined) return parts;
  if (first.length + confirmation.length + 2 <= 4096)
    return [`${confirmation}\n\n${first}`, ...parts.slice(1)];
  return [confirmation, ...parts];
}

export function renderSourceStatus(source: SourceState, now: number): string {
  const timestamp = (value: number | null) =>
    value === null
      ? "ще немає"
      : new Intl.DateTimeFormat("uk-UA", {
          timeZone: "Europe/Kyiv",
          dateStyle: "short",
          timeStyle: "short",
        }).format(value);
  const status =
    source.lastAttemptAt === null
      ? "⏳ Сайт ще не перевірено."
      : source.unavailable
        ? "⚠️ Не вдалося зчитати сайт. Збережені дані можуть бути застарілими."
        : source.lastSuccessAt === null
          ? "⏳ Дані ще не зчитано."
          : now > source.nextAttemptAt + 120000
            ? "⚠️ Перевірка затримується. Дані можуть бути застарілими."
            : "✓ Дані успішно зчитано.";
  return [
    status,
    "",
    `Остання спроба: ${timestamp(source.lastAttemptAt)}`,
    `Успішне зчитування: ${timestamp(source.lastSuccessAt)}`,
    source.lastAttemptAt === null
      ? "Наступна спроба: очікується перший запуск."
      : source.nextAttemptAt > now
        ? `Наступна спроба: не раніше ${timestamp(source.nextAttemptAt)}`
        : "Наступна спроба: очікується.",
    "",
    "Час Києва. Стан збереженої перевірки; ця кнопка не запускає запит до сайту.",
  ].join("\n");
}
