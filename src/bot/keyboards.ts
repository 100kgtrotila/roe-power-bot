import { InlineKeyboard } from "grammy";
import type { Subscriber } from "../db/subscriptions";
import { QUEUE_IDS } from "../schedule/model";
export function keyboard(user: Subscriber, page: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  const id = user.telegramId;
  const button = (label: string, action: string) =>
    kb.text(label, `${id}:${action}`);
  if (page === "select") {
    for (const queue of QUEUE_IDS) {
      button(queue, `select:${queue}`);
      if (queue.endsWith(".2")) kb.row();
    }
    button("Усі підчерги", "select:all");
    kb.row();
  } else if (page === "reminders") {
    for (const n of [15, 30, 60]) button(`${n} хв`, `interval:${n}`);
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
  button("Мій графік", "view:schedule");
  button("Усі черги", "view:all");
  kb.row();
  button("Обрати підчергу", "view:select");
  button("Нагадування", "view:reminders");
  kb.row();
  button("Керування сповіщеннями", "view:manage");
  kb.row();
  button("Допомога", "view:help");
  return kb;
}
