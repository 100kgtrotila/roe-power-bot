import { expect, test } from "vitest";
import { runTelegramSetup } from "../../scripts/telegram-webhook.mjs";

const config = {
  BOT_TOKEN: "123:private-token",
  WEBHOOK_SECRET: "a".repeat(32),
};
function harness(responses: unknown[] = [{ ok: true, result: true }]) {
  const requests: { url: string; body: unknown }[] = [];
  const output: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json(responses.shift());
  };
  return {
    requests,
    output,
    fetcher,
    write: (line: string) => output.push(line),
  };
}

test("set registers only supported updates with secret and webhook path", async () => {
  const h = harness();
  expect(
    await runTelegramSetup(
      ["set", "https://power.example"],
      config,
      h.fetcher,
      h.write,
    ),
  ).toBe(0);
  expect(h.requests).toEqual([
    {
      url: "https://api.telegram.org/bot123:private-token/setWebhook",
      body: {
        url: "https://power.example/webhook",
        secret_token: "a".repeat(32),
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
      },
    },
  ]);
  expect(h.output.join(" ")).not.toContain(config.BOT_TOKEN);
  expect(h.output.join(" ")).not.toContain(config.WEBHOOK_SECRET);
});

test("invalid URL or missing secrets fails before HTTP", async () => {
  for (const url of [
    "http://power.example",
    "https://user:password@power.example",
    "https://power.example/other",
    "https://power.example/?token=secret",
    "invalid",
  ]) {
    const h = harness();
    expect(
      await runTelegramSetup(["set", url], config, h.fetcher, h.write),
    ).toBe(1);
    expect(h.requests).toHaveLength(0);
  }
  const h = harness();
  expect(
    await runTelegramSetup(
      ["set", "https://power.example"],
      { BOT_TOKEN: "123:token" },
      h.fetcher,
      h.write,
    ),
  ).toBe(1);
  expect(h.requests).toHaveLength(0);
});

test("info prints safe summary instead of raw Telegram response", async () => {
  const h = harness([
    {
      ok: true,
      result: {
        url: `https://example.org/${config.BOT_TOKEN}`,
        pending_update_count: 2,
        last_error_message: config.WEBHOOK_SECRET,
      },
    },
  ]);
  expect(await runTelegramSetup(["info"], config, h.fetcher, h.write)).toBe(0);
  expect(JSON.parse(h.output[0] ?? "{}")).toEqual({
    configured: true,
    pendingUpdateCount: 2,
    hasDeliveryError: true,
  });
  expect(h.output.join(" ")).not.toContain(config.BOT_TOKEN);
  expect(h.output.join(" ")).not.toContain(config.WEBHOOK_SECRET);
});

test("API and network errors fail without leaking descriptions or URLs", async () => {
  const h = harness([{ ok: false, description: config.BOT_TOKEN }]);
  expect(await runTelegramSetup(["info"], config, h.fetcher, h.write)).toBe(1);
  expect(h.output.join(" ")).not.toContain(config.BOT_TOKEN);
  const fetcher: typeof fetch = async () => {
    throw new Error(config.BOT_TOKEN);
  };
  expect(await runTelegramSetup(["info"], config, fetcher, h.write)).toBe(1);
  expect(h.output.join(" ")).not.toContain(config.BOT_TOKEN);
  expect(
    await runTelegramSetup(
      ["info"],
      config,
      async () => new Response("oops", { status: 503 }),
      h.write,
    ),
  ).toBe(1);
});

test("id refuses getUpdates while webhook is configured", async () => {
  const h = harness([
    { ok: true, result: { url: "https://power.example/webhook" } },
  ]);
  expect(await runTelegramSetup(["id"], config, h.fetcher, h.write)).toBe(1);
  expect(h.requests).toHaveLength(1);
});

test("id prints only private sender IDs and no message text", async () => {
  const h = harness([
    { ok: true, result: { url: "" } },
    {
      ok: true,
      result: [
        {
          message: {
            from: { id: 42 },
            chat: { id: 42, type: "private" },
            text: "personal text",
          },
        },
        { message: { from: { id: 42 }, chat: { id: 42, type: "private" } } },
        { message: { from: { id: 43 }, chat: { id: -100, type: "group" } } },
      ],
    },
  ]);
  expect(await runTelegramSetup(["id"], config, h.fetcher, h.write)).toBe(0);
  expect(h.output).toEqual(["42"]);
});

test("delete preserves pending updates and unknown actions do not call Telegram", async () => {
  const h = harness();
  expect(await runTelegramSetup(["delete"], config, h.fetcher, h.write)).toBe(
    0,
  );
  expect(h.requests[0]).toEqual({
    url: "https://api.telegram.org/bot123:private-token/deleteWebhook",
    body: { drop_pending_updates: false },
  });
  expect(await runTelegramSetup(["unknown"], config, h.fetcher, h.write)).toBe(
    1,
  );
  expect(h.requests).toHaveLength(1);
});
