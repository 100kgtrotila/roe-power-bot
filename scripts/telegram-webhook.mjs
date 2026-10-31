import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {string | undefined} value */
function webhookUrl(value) {
  if (!value) throw new Error("Вкажіть HTTPS-адресу Worker.");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["/", "/webhook"].includes(url.pathname)
  )
    throw new Error(
      "Вкажіть HTTPS-адресу Worker без параметрів, паролів та зайвих шляхів.",
    );
  url.pathname = "/webhook";
  return url.href;
}

/**
 * No raw API response or exception reaches stdout: either can contain secrets.
 * @param {string[]} args
 * @param {Record<string, string | undefined>} environment
 * @param {typeof fetch} fetcher
 * @param {(line: string) => void} write
 * @returns {Promise<number>}
 */
export async function runTelegramSetup(
  args,
  environment,
  fetcher = fetch,
  write = console.log,
) {
  const input = args[0] === "--" ? args.slice(1) : args;
  const [action, address] = input;
  if (
    !["set", "info", "id", "delete"].includes(action ?? "") ||
    input.length !== (action === "set" ? 2 : 1)
  ) {
    write(
      "Використання: telegram:webhook set <https-url> | info | id | delete",
    );
    return 1;
  }
  const token = environment.BOT_TOKEN?.trim();
  const secret = environment.WEBHOOK_SECRET?.trim();
  if (
    !token ||
    (action === "set" && (!secret || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)))
  ) {
    write(
      "Задайте BOT_TOKEN; для set також потрібен WEBHOOK_SECRET (32–256 символів A-Z, a-z, 0-9, _ або -).",
    );
    return 1;
  }
  /** @param {string} method @param {Record<string, unknown>} body @returns {Promise<unknown>} */
  const request = async (method, body = {}) => {
    const response = await fetcher(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      },
    );
    if (!response.ok) throw new Error("Telegram HTTP error");
    const data = await response.json();
    if (!isRecord(data) || data.ok !== true)
      throw new Error("Telegram API error");
    return data.result;
  };
  try {
    if (action === "set") {
      const url = webhookUrl(address);
      await request("setWebhook", {
        url,
        secret_token: secret,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
      });
      write("Webhook налаштовано.");
    } else if (action === "delete") {
      await request("deleteWebhook", { drop_pending_updates: false });
      write(
        "Webhook вимкнено. Cron продовжує працювати до окремого вимкнення.",
      );
    } else {
      const info = await request("getWebhookInfo");
      if (!isRecord(info) || typeof info.url !== "string")
        throw new Error("Malformed webhook info");
      if (action === "info") {
        write(
          JSON.stringify({
            configured: info.url.length > 0,
            pendingUpdateCount:
              typeof info.pending_update_count === "number"
                ? info.pending_update_count
                : 0,
            hasDeliveryError:
              typeof info.last_error_message === "string" &&
              info.last_error_message.length > 0,
          }),
        );
      } else {
        if (info.url) {
          write(
            "Webhook уже активний. getUpdates не запускався; використовуйте раніше збережений Telegram ID.",
          );
          return 1;
        }
        const updates = await request("getUpdates", {
          timeout: 0,
          allowed_updates: ["message", "callback_query"],
        });
        if (!Array.isArray(updates)) throw new Error("Malformed updates");
        const ids = new Set();
        for (const update of updates) {
          if (!isRecord(update) || !isRecord(update.message)) continue;
          const { from, chat } = update.message;
          if (
            isRecord(from) &&
            isRecord(chat) &&
            chat.type === "private" &&
            Number.isSafeInteger(from.id) &&
            Number(from.id) > 0 &&
            from.id === chat.id
          )
            ids.add(String(from.id));
        }
        if (!ids.size)
          write(
            "Напишіть /start своєму боту та повторіть id до реєстрації webhook.",
          );
        for (const id of ids) write(id);
      }
    }
    return 0;
  } catch {
    write(
      "Операцію не виконано. Перевірте адресу, секрети, мережу та стан Telegram API. Деталі приховано, щоб не розкрити токен.",
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runTelegramSetup(process.argv.slice(2), process.env);
}
