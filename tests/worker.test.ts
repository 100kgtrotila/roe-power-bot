import { describe, expect, it } from "vitest";
import worker from "../src/index";

const env = { BOT_TOKEN: "123:test-token", WEBHOOK_SECRET: "test-secret" };

describe("Worker HTTP boundary", () => {
  it("exposes health without requiring Telegram credentials", async () => {
    const response = await worker.fetch(
      new Request("https://bot.test/health"),
      {},
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("rejects unknown paths", async () => {
    const response = await worker.fetch(
      new Request("https://bot.test/unknown"),
      env,
    );
    expect(response.status).toBe(404);
  });

  it("accepts only POST on the webhook", async () => {
    const response = await worker.fetch(
      new Request("https://bot.test/webhook"),
      env,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });

  it.each([undefined, "wrong-secret"])(
    "rejects an invalid webhook secret (%s)",
    async (secret) => {
      const headers = new Headers();
      if (secret) headers.set("X-Telegram-Bot-Api-Secret-Token", secret);
      const response = await worker.fetch(
        new Request("https://bot.test/webhook", {
          method: "POST",
          headers,
          body: "{}",
        }),
        env,
      );
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(env.BOT_TOKEN);
    },
  );

  it.each([
    {},
    { BOT_TOKEN: env.BOT_TOKEN },
    { WEBHOOK_SECRET: env.WEBHOOK_SECRET },
    { BOT_TOKEN: " ", WEBHOOK_SECRET: env.WEBHOOK_SECRET },
  ])(
    "fails closed when credentials are not configured (%j)",
    async (config) => {
      const response = await worker.fetch(
        new Request("https://bot.test/webhook", {
          method: "POST",
          headers: { "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET },
          body: "{}",
        }),
        config,
      );
      expect(response.status).toBe(503);
    },
  );
});
