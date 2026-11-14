import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { GrammyError, HttpError } from "grammy";
import type { Update } from "grammy/types";
import { createBot, describeError, runBot } from "../src/bot.ts";
import { ConfigurationError } from "../src/config.ts";
import { QueueStore } from "../src/queue.ts";
import type { QueueServices } from "../src/queue-handlers.ts";
import { type Downloader, QueueWorker } from "../src/worker.ts";

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
      entities: [
        {
          type: "bot_command",
          offset: 0,
          length: text.indexOf(" ") === -1 ? text.length : text.indexOf(" "),
        },
      ],
    },
  };
}

async function telegramStub(
  t: TestContext,
  handleCall: (method: string, payload: Record<string, unknown>) => unknown,
  queue?: QueueServices,
) {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    const method = req.url?.split("/").at(-1);
    assert(method);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString()) as Record<
      string,
      unknown
    >;
    calls.push({ method, payload });
    res.setHeader("content-type", "application/json");
    if (method === "getMe") {
      res.end(JSON.stringify({ ok: true, result: botInfo }));
      return;
    }
    if (method === "deleteWebhook") {
      res.end(JSON.stringify({ ok: true, result: true }));
      return;
    }
    const response = handleCall(method, payload);
    // An undefined response keeps a long poll open until the client aborts it.
    if (response !== undefined) res.end(JSON.stringify(response));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    bot: createBot(
      config,
      {
        botInfo,
        client: { apiRoot: `http://127.0.0.1:${address.port}` },
      },
      queue,
    ),
    calls,
  };
}

function messageReply(text: unknown) {
  return {
    ok: true,
    result: {
      message_id: 1,
      date: 0,
      chat: { id: config.allowedUserId, type: "private" },
      text,
    },
  };
}

test("only the owner in a private chat can reach command handlers", async (t) => {
  const replies: Record<string, unknown>[] = [];
  const { bot } = await telegramStub(t, (method, payload) => {
    assert.equal(method, "sendMessage");
    replies.push(payload);
    return messageReply(payload.text);
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

test("shutdown acknowledges the last handled update", {
  timeout: 5000,
}, async (t) => {
  const polled = Promise.withResolvers<void>();
  const { bot, calls } = await telegramStub(t, (method, payload) => {
    assert.equal(method, "getUpdates");
    if (!payload.timeout) return { ok: true, result: [] };
    if (payload.offset !== 43) {
      return {
        ok: true,
        result: [{ ...command("/start", 999), update_id: 42 }],
      };
    }
    polled.resolve();
  });
  const shutdown = new AbortController();
  t.after(() => shutdown.abort());
  const running = runBot(bot, shutdown.signal);
  await polled.promise;

  shutdown.abort();
  await running;

  assert.equal(bot.isRunning(), false);
  assert.deepEqual(calls.at(-1), {
    method: "getUpdates",
    payload: { offset: 43, limit: 1 },
  });
});

test("a failed reply is logged safely and the next command is still handled", {
  timeout: 5000,
}, async (t) => {
  const polled = Promise.withResolvers<void>();
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
  let replies = 0;
  const { bot } = await telegramStub(t, (method, payload) => {
    if (method === "sendMessage") {
      replies += 1;
      if (replies === 1)
        return { ok: false, error_code: 403, description: config.token };
      return messageReply(payload.text);
    }
    assert.equal(method, "getUpdates");
    if (!payload.timeout) return { ok: true, result: [] };
    if (payload.offset !== 44) {
      return {
        ok: true,
        result: [
          { ...command("/start"), update_id: 42 },
          { ...command("/help"), update_id: 43 },
        ],
      };
    }
    polled.resolve();
  });
  const shutdown = new AbortController();
  t.after(() => shutdown.abort());
  const running = runBot(bot, shutdown.signal);
  await polled.promise;
  shutdown.abort();
  await running;

  assert.equal(replies, 2);
  assert.deepEqual(errors, [
    [
      "Could not handle Telegram update:",
      "Telegram API request failed (code 403).",
    ],
  ]);
});

test("shutdown reports Telegram's failed acknowledgement", {
  timeout: 5000,
}, async (t) => {
  const polled = Promise.withResolvers<void>();
  const { bot } = await telegramStub(t, (method, payload) => {
    assert.equal(method, "getUpdates");
    if (!payload.timeout)
      return {
        ok: false,
        error_code: 403,
        description: "Acknowledgement rejected",
      };
    polled.resolve();
  });
  const shutdown = new AbortController();
  t.after(() => shutdown.abort());
  const running = runBot(bot, shutdown.signal);
  await polled.promise;

  shutdown.abort();
  await assert.rejects(running, { error_code: 403 });

  assert.equal(bot.isRunning(), false);
});

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

async function queueBot(
  t: TestContext,
  capacity = 20,
  downloader?: Downloader,
) {
  const directory = mkdtempSync(join(tmpdir(), "videodl-telegram-"));
  const db = new DatabaseSync(join(directory, "queue.sqlite"));
  const store = new QueueStore(db, directory, capacity);
  const worker = downloader ? new QueueWorker(store, downloader) : undefined;
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const transport = await telegramStub(
    t,
    (method, payload) => {
      if (method === "sendMessage") return messageReply(payload.text);
      assert(
        ["answerCallbackQuery", "editMessageReplyMarkup"].includes(method),
      );
      return { ok: true, result: true };
    },
    worker ? { store, worker } : { store },
  );
  return { ...transport, store, directory, worker };
}

let messageId = 100;
function videoMessage(
  text = "https://youtu.be/abcDEF_12-3",
  userId = config.allowedUserId,
): Update {
  const update = command(text, userId);
  assert(update.message);
  update.message.message_id = ++messageId;
  delete update.message.entities;
  return update;
}

function selection(
  menu: number,
  format = "mp3",
  userId = config.allowedUserId,
  chatType: "private" | "group" = "private",
): Update {
  const message = command("/start", config.allowedUserId, chatType).message;
  assert(message);
  return {
    update_id: ++messageId,
    callback_query: {
      id: String(messageId),
      from: { id: userId, is_bot: false, first_name: "Test user" },
      chat_instance: "test",
      message,
      data: `format:${menu}:${format}`,
    },
  };
}

test("owner video messages offer exactly the three agreed buttons and persist queued status", async (t) => {
  const { bot, calls, store } = await queueBot(t);
  await bot.handleUpdate(videoMessage());
  const keyboard = calls.at(-1)?.payload.reply_markup as {
    inline_keyboard: { text: string; callback_data: string }[][];
  };
  assert.deepEqual(
    keyboard.inline_keyboard.map((row) => row[0]?.text),
    ["MP3 320 kbps", "MP4 up to 720p", "MP4 up to 1080p"],
  );
  assert.equal(keyboard.inline_keyboard[0]?.[0]?.callback_data, "format:1:mp3");
  await bot.handleUpdate(selection(1, "mp4_1080"));
  assert.equal(store.list().length, 1);
  assert.equal(store.get(1)?.format, "mp4_1080");
  assert.equal(store.get(1)?.state, "queued");
  assert.equal(store.get(1)?.status_chat_id, config.allowedUserId);
  assert.equal(store.get(1)?.status_message_id, 1);
  assert.match(String(calls.at(-1)?.payload.text), /#1.*queued/);
  await bot.handleUpdate(selection(1, "mp3"));
  assert.equal(store.list().length, 1);
  assert.match(String(calls.at(-1)?.payload.text), /already used/);
});

test("queue callbacks reject other users, group chats, foreign menus, and unknown selections", async (t) => {
  const { bot, calls, store } = await queueBot(t);
  await bot.handleUpdate(videoMessage(undefined, 999));
  await bot.handleUpdate(selection(1, "mp3", 999));
  await bot.handleUpdate(selection(1, "mp3", config.allowedUserId, "group"));
  assert.equal(calls.length, 0);
  const foreign = store.menu("abcDEF_12-3", 999, 1);
  await bot.handleUpdate(selection(foreign));
  assert.match(String(calls.at(-1)?.payload.text), /unavailable/);
  await bot.handleUpdate(selection(1, "invalid"));
  assert.match(String(calls.at(-1)?.payload.text), /Unknown/);
  assert.deepEqual(store.list(), []);
});

test("invalid links explain supported input without creating menus or jobs", async (t) => {
  const { bot, calls, store } = await queueBot(t);
  await bot.handleUpdate(
    videoMessage("https://youtube.com/playlist?list=example"),
  );
  assert.match(
    String(calls.at(-1)?.payload.text),
    /one individual YouTube video URL/,
  );
  assert.deepEqual(store.list(), []);
});

test("callbacks share pending work and reuse completed files while full menus remain usable", async (t) => {
  const { bot, calls, store, directory } = await queueBot(t, 1);
  await bot.handleUpdate(videoMessage());
  await bot.handleUpdate(selection(1));
  await bot.handleUpdate(videoMessage());
  await bot.handleUpdate(selection(2));
  assert.equal(store.list().length, 1);
  assert.match(String(calls.at(-3)?.payload.text), /existing job/);
  await bot.handleUpdate(videoMessage("https://youtu.be/anotherId_1"));
  // SQLite UPSERT may leave gaps in menu IDs; use the button's persisted ID.
  const keyboard = calls.at(-1)?.payload.reply_markup as {
    inline_keyboard: { callback_data: string }[][];
  };
  const data = keyboard.inline_keyboard[0]?.[0]?.callback_data;
  assert(data);
  const menu = Number(data.split(":")[1]);
  await bot.handleUpdate(selection(menu));
  assert.match(String(calls.at(-1)?.payload.text), /Queue full/);
  store.claim();
  writeFileSync(join(directory, "fixture.mp3"), "fixture");
  store.complete(1, "fixture.mp3");
  await bot.handleUpdate(selection(menu));
  assert.equal(store.list().length, 2);
  await bot.handleUpdate(videoMessage());
  const lastKeyboard = calls.at(-1)?.payload.reply_markup as {
    inline_keyboard: { callback_data: string }[][];
  };
  const lastData = lastKeyboard.inline_keyboard[0]?.[0]?.callback_data;
  assert(lastData);
  await bot.handleUpdate(selection(Number(lastData.split(":")[1])));
  assert.match(
    String(calls.at(-1)?.payload.text),
    /completed.*fixture.mp3.*Completed/,
  );
  assert.equal(store.list().length, 2);
});

test("status, queue, and cancel commands expose durable job states and validate job IDs", async (t) => {
  const { bot, calls, store } = await queueBot(t);
  await bot.handleUpdate(command("/status"));
  assert.equal(calls.at(-1)?.payload.text, "No matching jobs.");
  await bot.handleUpdate(command("/queue"));
  assert.equal(calls.at(-1)?.payload.text, "The queue is empty.");
  await bot.handleUpdate(command("/cancel"));
  assert.match(String(calls.at(-1)?.payload.text), /Use \/cancel/);
  await bot.handleUpdate(videoMessage());
  await bot.handleUpdate(selection(1));
  await bot.handleUpdate(command("/queue"));
  assert.match(String(calls.at(-1)?.payload.text), /#1.*queued/);
  await bot.handleUpdate(command("/status"));
  assert.match(String(calls.at(-1)?.payload.text), /#1.*queued/);
  await bot.handleUpdate(command("/status 1"));
  assert.match(String(calls.at(-1)?.payload.text), /#1.*queued/);
  for (const argument of ["999", "invalid"]) {
    await bot.handleUpdate(command(`/status ${argument}`));
    assert.equal(calls.at(-1)?.payload.text, "No matching jobs.");
  }
  store.claim();
  const callsBeforeUnauthorized = calls.length;
  await bot.handleUpdate(command("/cancel 1", 999));
  await bot.handleUpdate(command("/status", 999));
  await bot.handleUpdate(command("/queue", config.allowedUserId, "group"));
  assert.equal(calls.length, callsBeforeUnauthorized);
  assert.equal(store.get(1)?.state, "active");
  await bot.handleUpdate(command("/cancel 1"));
  assert.equal(calls.at(-1)?.payload.text, "Job #1 cancelled.");
  assert.equal(store.get(1)?.state, "cancelled");
  await bot.handleUpdate(command("/status 1"));
  assert.match(
    String(calls.at(-1)?.payload.text),
    /cancelled.*Cancelled by owner/,
  );
  await bot.handleUpdate(command("/cancel 1"));
  assert.match(String(calls.at(-1)?.payload.text), /No queued or active/);
});

test("a failed Telegram notification leaves the queued job available through status", async (t) => {
  const { bot, store } = await queueBot(t);
  const menu = store.menu("abcDEF_12-3", config.allowedUserId, 1);
  bot.api.config.use(async (previous, method, payload, signal) => {
    if (method === "sendMessage") throw new Error("fixture transport failure");
    return previous(method, payload, signal);
  });
  await assert.rejects(
    bot.handleUpdate(selection(menu)),
    /fixture transport failure/,
  );
  assert.equal(store.get(1)?.state, "queued");
  assert.equal(store.get(1)?.status_message_id, null);
  assert.deepEqual(store.select(menu, config.allowedUserId, "mp3"), {
    kind: "unavailable",
  });
});

test("cancel command aborts the active fixture downloader and leaves a durable cancelled outcome", {
  timeout: 5000,
}, async (t) => {
  const started = Promise.withResolvers<void>();
  const { bot, store, worker } = await queueBot(t, 20, async (_job, signal) => {
    started.resolve();
    await new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(new Error("cancelled")), {
        once: true,
      }),
    );
    return "unreachable.mp3";
  });
  assert(worker);
  await bot.handleUpdate(videoMessage());
  await bot.handleUpdate(selection(1));
  const running = worker.drain(new AbortController().signal);
  await started.promise;
  await bot.handleUpdate(command("/cancel 1"));
  await running;
  assert.equal(store.get(1)?.state, "cancelled");
  assert.equal(store.get(1)?.outcome, "Cancelled by owner.");
});
