import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { GrammyError, HttpError } from "grammy";
import type { Update } from "grammy/types";
import { createBot, describeError, runBot } from "../src/bot.ts";

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

test("a shutdown requested before startup makes no Telegram calls", async () => {
  const shutdown = new AbortController();
  shutdown.abort();
  await runBot(createBot(config), shutdown.signal);
});

test("polling shuts down cleanly and acknowledges the last update", {
  timeout: 5000,
}, async (t) => {
  const polled = Promise.withResolvers<void>();
  const calls: string[] = [];
  let pollCount = 0;
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
              result: [{ ...command("/start", 999), update_id: 42 }],
            }),
          );
        } else {
          // Keep the long poll open until the shutdown aborts its request.
          polled.resolve();
        }
      } else {
        assert.equal(payload.offset, 43);
        res.end(JSON.stringify({ ok: true, result: [] }));
      }
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
  await running;
  assert.equal(bot.isRunning(), false);
  assert.deepEqual(calls, [
    "getMe",
    "deleteWebhook",
    "getUpdates",
    "getUpdates",
    "getUpdates",
  ]);
});
