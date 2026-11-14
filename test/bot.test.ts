import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { GrammyError, HttpError } from "grammy";
import type { Update } from "grammy/types";
import { createBot, describeError, runBot } from "../src/bot.ts";
import { ConfigurationError } from "../src/config.ts";

const config = {
  token: "123456:abcdefghijklmnopqrstuvwxyz_12345678",
  allowedUserId: 123456789,
};
const botInfo = {
  id: 123456,
  is_bot: true as const,
  first_name: "Test bot",
  username: "videodl_test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

function command(
  text: string,
  userId = config.allowedUserId,
  chatType: "private" | "group" | "supergroup" = "private",
): Update {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      from: { id: userId, is_bot: false, first_name: "Test user" },
      chat:
        chatType === "private"
          ? { id: userId, type: "private", first_name: "Test user" }
          : { id: -123, type: chatType, title: "Test group" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: text.length }],
    },
  };
}

test("only the owner in a private chat can reach command handlers", async (t) => {
  const replies: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.url, `/bot${config.token}/sendMessage`);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString()) as Record<
      string,
      unknown
    >;
    replies.push(payload);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        result: {
          message_id: 1,
          date: 0,
          chat: { id: config.allowedUserId, type: "private" },
          text: payload.text,
        },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === "object");
  const bot = createBot(config, {
    botInfo,
    client: { apiRoot: `http://127.0.0.1:${address.port}` },
  });
  let callbackHandled = false;
  bot.on("callback_query", () => {
    callbackHandled = true;
  });

  await bot.handleUpdate(command("/start", 999));
  await bot.handleUpdate(command("/help", 999));
  await bot.handleUpdate(command("/start", config.allowedUserId, "group"));
  await bot.handleUpdate(command("/help", config.allowedUserId, "supergroup"));
  await bot.handleUpdate({ update_id: 4 });
  const missingSender = command("/start");
  assert(missingSender.message);
  // Malformed external updates must fail closed even if Telegram's types require a sender.
  Reflect.deleteProperty(missingSender.message, "from");
  await bot.handleUpdate(missingSender);
  const botSender = command("/start");
  assert(botSender.message?.from);
  botSender.message.from.is_bot = true;
  await bot.handleUpdate(botSender);
  const message = command("/start").message;
  assert(message);
  await bot.handleUpdate({
    update_id: 2,
    callback_query: {
      id: "unauthorized",
      from: { id: 999, is_bot: false, first_name: "Other user" },
      chat_instance: "test",
      message,
      data: "future-menu",
    },
  });
  assert.equal(callbackHandled, false);
  await bot.handleUpdate({
    update_id: 3,
    callback_query: {
      id: "owner",
      from: { id: config.allowedUserId, is_bot: false, first_name: "Owner" },
      chat_instance: "test",
      message,
      data: "future-menu",
    },
  });
  assert.equal(callbackHandled, true);
  assert.equal(replies.length, 0);

  await bot.handleUpdate(command("/start"));
  await bot.handleUpdate(command("/help"));
  assert.equal(replies.length, 2);
  assert(replies.every((reply) => reply.chat_id === config.allowedUserId));
  assert.match(String(replies[0]?.text), /\/help/);
  assert.match(String(replies[1]?.text), /\/start/);
});

test("error reporting never includes raw errors, tokens, or payloads", () => {
  for (const error of [
    new Error(config.token),
    new HttpError("Network failure", new Error(config.token)),
    new GrammyError(
      "API failure",
      { ok: false, error_code: 403, description: config.token },
      "sendMessage",
      { text: "private message" },
    ),
  ]) {
    const message = describeError(error);
    assert(!message.includes(config.token));
    assert(!message.includes("private message"));
  }
});

test("reports actionable configuration, authentication, and polling conflict errors", () => {
  assert.equal(
    describeError(new ConfigurationError("Missing required setting.")),
    "Missing required setting.",
  );
  for (const [code, expected] of [
    [401, /rejected the bot token/],
    [409, /another bot instance/],
  ] as const) {
    const error = new GrammyError(
      "API failure",
      { ok: false, error_code: code, description: config.token },
      "getUpdates",
      {},
    );
    assert.match(describeError(error), expected);
    assert(!describeError(error).includes(config.token));
  }
});

test("a shutdown requested before startup makes no Telegram calls", async () => {
  const shutdown = new AbortController();
  shutdown.abort();
  await runBot(createBot(config), shutdown.signal);
});

for (const failAcknowledgement of [false, true]) {
  test(failAcknowledgement
    ? "shutdown reports a failed update acknowledgement"
    : "polling survives reply errors and shuts down with the last update acknowledged", {
    timeout: 5000,
  }, async (t) => {
    const polled = Promise.withResolvers<void>();
    const calls: string[] = [];
    let pollCount = 0;
    const errors: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
    const server = createServer(async (req, res) => {
      const method = req.url?.split("/").at(-1);
      assert(method);
      calls.push(method);
      res.setHeader("content-type", "application/json");
      if (method === "getMe") {
        res.end(JSON.stringify({ ok: true, result: botInfo }));
      } else if (method === "deleteWebhook") {
        res.end(JSON.stringify({ ok: true, result: true }));
      } else if (method === "getUpdates") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const payload = JSON.parse(Buffer.concat(chunks).toString()) as Record<
          string,
          unknown
        >;
        if (payload.timeout) {
          pollCount += 1;
          if (pollCount === 1) {
            res.end(
              JSON.stringify({
                ok: true,
                result: [{ ...command("/start"), update_id: 42 }],
              }),
            );
          } else {
            // Keep the long poll open until the shutdown aborts its request.
            polled.resolve();
          }
        } else {
          assert.equal(payload.offset, 43);
          res.end(
            JSON.stringify(
              failAcknowledgement
                ? { ok: false, error_code: 403, description: config.token }
                : { ok: true, result: [] },
            ),
          );
        }
      } else if (method === "sendMessage") {
        res.end(
          JSON.stringify({
            ok: false,
            error_code: 403,
            description: config.token,
          }),
        );
      } else {
        assert.fail(`Unexpected API method: ${method}`);
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    assert(address && typeof address === "object");
    const bot = createBot(config, {
      client: { apiRoot: `http://127.0.0.1:${address.port}` },
    });
    const shutdown = new AbortController();
    t.after(() => shutdown.abort());
    const running = runBot(bot, shutdown.signal);
    await polled.promise;
    shutdown.abort();
    if (failAcknowledgement) {
      await assert.rejects(running, GrammyError);
    } else {
      await running;
    }
    assert.equal(bot.isRunning(), false);
    assert.deepEqual(errors, [
      [
        "Could not handle Telegram update:",
        "Telegram API request failed (code 403).",
      ],
    ]);
    assert.deepEqual(calls, [
      "getMe",
      "deleteWebhook",
      "getUpdates",
      "sendMessage",
      "getUpdates",
      "getUpdates",
    ]);
  });
}

test("startup propagates a connection failure without starting polling", async (t) => {
  const bot = createBot(config);
  const error = new HttpError("Network failure", new Error("offline"));
  t.mock.method(bot.api, "getMe", async () => {
    throw error;
  });
  await assert.rejects(runBot(bot, new AbortController().signal), error);
  assert.equal(bot.isRunning(), false);
});

test("shutdown cancels an in-flight startup connection", async (t) => {
  const bot = createBot(config);
  const shutdown = new AbortController();
  const connecting = Promise.withResolvers<void>();
  t.mock.method(
    bot.api,
    "getMe",
    (signal: Parameters<typeof bot.api.getMe>[0]) => {
      connecting.resolve();
      return new Promise((_, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new Error("Request aborted")),
          { once: true },
        );
      });
    },
  );
  const running = runBot(bot, shutdown.signal);
  await connecting.promise;
  shutdown.abort();
  await running;
  assert.equal(bot.isRunning(), false);
});

test("a completed startup connection cannot start polling after shutdown", async (t) => {
  const bot = createBot(config);
  const shutdown = new AbortController();
  t.mock.method(bot.api, "getMe", async () => {
    shutdown.abort();
    return botInfo;
  });
  await runBot(bot, shutdown.signal);
  assert.equal(bot.isRunning(), false);
});
