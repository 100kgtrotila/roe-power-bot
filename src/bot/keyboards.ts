import { InlineKeyboard, Keyboard } from "grammy";
import type { Subscriber } from "../db/subscriptions";
import { QUEUE_IDS } from "../schedule/model";
import type { BotView } from "./callbacks";

export const MENU_ACTIONS = {
  "📅 Мій графік": "schedule",
  "📋 Усі черги": "all",
  "🔢 Моя підчерга": "select",
  "🔔 Нагадування": "reminders",
  "⚙️ Налаштування": "manage",
  "🟢 Стан перевірок": "status",
} satisfies Record<string, BotView>;

export function mainKeyboard(): Keyboard {
  return new Keyboard()
    .text("📅 Мій графік")
    .text("📋 Усі черги")
    .row()
    .text("🔢 Моя підчерга")
    .text("🔔 Нагадування")
    .row()
    .text("⚙️ Налаштування")
    .text("🟢 Стан перевірок")
    .resized()
    .persistent();
}

export function keyboard(
  user: Subscriber,
  page: BotView,
): InlineKeyboard | Keyboard {
  if (page === "menu") return mainKeyboard();
  const kb = new InlineKeyboard();
  const id = user.telegramId;
  const button = (label: string, action: string) =>
    kb.text(label, `${id}:${action}`);
  if (page === "select") {
    for (const queue of QUEUE_IDS) {
      button(
        `${user.selection === queue ? "✓ " : ""}${queue}`,
        `select:${queue}`,
      );
      if (queue === "2.2" || queue === "4.2" || queue === "6.2") kb.row();
    }
    button(`${user.selection === "all" ? "✓ " : ""}Усі підчерги`, "select:all");
    kb.row();
  } else if (page === "reminders") {
    for (const n of [15, 30, 60])
      button(
        `${user.reminderMinutes === n ? "✓ " : ""}${n} хв`,
        `interval:${n}`,
      );
    kb.row();
    button(
      user.remindersEnabled ? "Вимкнути нагадування" : "Увімкнути нагадування",
      `reminders:${user.remindersEnabled ? "off" : "on"}`,
    );
    kb.row();
  } else if (page === "manage") {
    button(
      user.updatesEnabled ? "Вимкнути оновлення" : "Увімкнути оновлення",
      `updates:${user.updatesEnabled ? "off" : "on"}`,
    );
    kb.row();
    button(
      user.remindersEnabled ? "Вимкнути нагадування" : "Увімкнути нагадування",
      `reminders:${user.remindersEnabled ? "off" : "on"}`,
    );
    kb.row();
    button("Вимкнути все", "stop:all");
    kb.row();
  }
  if (page === "manage") {
    button("Допомога", "view:help");
    kb.row();
  }
  button("🏠 Головне меню", "view:menu");
  return kb;
}
