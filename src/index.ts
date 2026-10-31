import { webhookCallback } from "grammy";
import { createBot } from "./bot";
import { parseAllowedIds } from "./config";
import { createDb } from "./db/client";
import { revalidateDelivery } from "./notifications/revalidate";
import { runScheduled } from "./scheduled";

export interface Env {
  DB?: D1Database;
  ALLOWED_TELEGRAM_IDS?: string;
  BOT_TOKEN?: string;
  WEBHOOK_SECRET?: string;
}

export default {
  scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): void {
    ctx.waitUntil(runScheduled(env, controller.scheduledTime));
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "ok" });
    }
    if (pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

    const token = env.BOT_TOKEN?.trim();
    const secret = env.WEBHOOK_SECRET?.trim();
    if (!token || !secret) {
      return new Response("Bot is not configured", { status: 503 });
    }
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      if (!env.DB)
        return new Response("Bot is not configured", { status: 503 });
      const db = createDb(env.DB);
      const bot = createBot(token, {
        db,
        revalidate: revalidateDelivery(db),
        allowedIds: parseAllowedIds(env.ALLOWED_TELEGRAM_IDS),
        now: Date.now,
      });
      const handleWebhook = webhookCallback(bot, "cloudflare-mod", {
        secretToken: secret,
        onTimeout: "throw",
        timeoutMilliseconds: 15_000,
      });
      return await handleWebhook(request);
    } catch {
      // Raw Telegram errors may contain sensitive request details.
      console.error("telegram_webhook_failed");
      return new Response("Webhook temporarily unavailable", { status: 503 });
    }
  },
};
