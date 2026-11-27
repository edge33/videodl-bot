import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { type TestContext, test } from "node:test";
import { GrammyError, HttpError } from "grammy";
import type { Update } from "grammy/types";
import { createBot, describeError, runBot } from "../src/bot.ts";
import { ConfigurationError } from "../src/config.ts";
import { DownloadSession } from "../src/download-session.ts";
import type { Downloader, DownloadRequest } from "../src/downloader.ts";
import { DownloadError } from "../src/process.ts";

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
  supports_guest_queries: false,
  needs_inline_query_location: false,
  has_topic_sidebar: false,
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
  downloads?: DownloadSession,
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
      { ...config, apiRoot: `http://127.0.0.1:${address.port}` },
      {
        botInfo,
      },
      downloads,
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

function videoMessage(text = "https://youtu.be/abcDEF_12-3"): Update {
  const update = command(text);
  assert(update.message);
  update.message.message_id = 101;
  delete update.message.entities;
  return update;
}

function selection(data: string): Update {
  const message = command("/start").message;
  assert(message);
  message.message_id = 202;
  return {
    update_id: 2,
    callback_query: {
      id: "selection",
      from: { id: config.allowedUserId, is_bot: false, first_name: "Owner" },
      chat_instance: "test",
      message,
      data,
    },
  };
}

async function downloadBot(
  t: TestContext,
  download: Downloader = async () => "video.mp4",
) {
  const downloads = new DownloadSession(download);
  t.after(() => downloads.stop());
  const transport = await telegramStub(
    t,
    (method, payload) => {
      if (method === "sendMessage") return messageReply(payload.text);
      return { ok: true, result: true };
    },
    downloads,
  );
  const menu = async () => {
    await transport.bot.handleUpdate(videoMessage());
    const keyboard = transport.calls.at(-1)?.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    return keyboard.inline_keyboard;
  };
  return { ...transport, downloads, menu };
}

test("format selection downloads once, reports the filename, and consumes its menu", async (t) => {
  const requests: DownloadRequest[] = [];
  const done = Promise.withResolvers<void>();
  const f = await downloadBot(t, async (request) => {
    requests.push(request);
    return "video.mp4";
  });
  f.bot.api.config.use(async (previous, method, payload, signal) => {
    const result = await previous(method, payload, signal);
    if (
      method === "sendMessage" &&
      "text" in payload &&
      payload.text === "Done: video.mp4"
    )
      done.resolve();
    return result;
  });
  const keyboard = await f.menu();
  assert.deepEqual(
    keyboard.map((row) => row[0]?.text),
    ["MP3 320 kbps", "MP4 up to 720p", "MP4 up to 1080p"],
  );
  const data = keyboard[2]?.[0]?.callback_data;
  assert(data);
  await f.bot.handleUpdate(selection(data));
  await done.promise;
  assert.deepEqual(requests, [{ videoId: "abcDEF_12-3", format: "mp4_1080" }]);
  await f.bot.handleUpdate(selection(data));
  assert.match(String(f.calls.at(-1)?.payload.text), /unavailable/);
  assert.equal(requests.length, 1);
});

test("rejects stale and malformed menus and invalid video links", async (t) => {
  const f = await downloadBot(t);
  await f.bot.handleUpdate(selection("invalid"));
  await f.bot.handleUpdate(selection("format:missing:mp3"));
  const first = await f.menu();
  await f.menu();
  await f.bot.handleUpdate(selection(first[0]?.[0]?.callback_data as string));
  assert.match(String(f.calls.at(-1)?.payload.text), /unavailable/);
  await f.bot.handleUpdate(videoMessage("https://youtube.com/playlist?list=x"));
  assert.match(String(f.calls.at(-1)?.payload.text), /one individual YouTube/);
  assert.equal(f.downloads.busy, false);
});

test("busy downloads reject new requests and can be cancelled", async (t) => {
  const started = Promise.withResolvers<void>();
  const f = await downloadBot(t, async (_request, signal) => {
    started.resolve();
    await new Promise<void>((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
    return "unreachable.mp4";
  });
  const keyboard = await f.menu();
  const data = keyboard[0]?.[0]?.callback_data as string;
  // Hold a second valid menu while the session is active.
  f.downloads.start({ videoId: "anotherId_1", format: "mp3" }, async () => {});
  await started.promise;
  await f.bot.handleUpdate(videoMessage());
  assert.match(String(f.calls.at(-1)?.payload.text), /Busy/);
  await f.bot.handleUpdate(selection(data));
  assert.match(String(f.calls.at(-1)?.payload.text), /Busy/);
  await f.bot.handleUpdate(command("/cancel"));
  assert.match(String(f.calls.at(-1)?.payload.text), /Cancellation requested/);
  await f.downloads.stop();
  await f.bot.handleUpdate(command("/cancel"));
  assert.equal(f.calls.at(-1)?.payload.text, "No active download.");
});

test("a request losing the active slot during Telegram I/O receives a busy reply", async (t) => {
  const f = await downloadBot(t);
  const keyboard = await f.menu();
  t.mock.method(f.downloads, "start", () => false);
  await f.bot.handleUpdate(
    selection(keyboard[0]?.[0]?.callback_data as string),
  );
  assert.match(String(f.calls.at(-1)?.payload.text), /Busy/);
});

test("a failed download reports its safe reason to Telegram without retrying", async (t) => {
  const failed = Promise.withResolvers<void>();
  let attempts = 0;
  const f = await downloadBot(t, async () => {
    attempts++;
    throw new DownloadError("Media tool stdout exceeded the 4 MiB limit.");
  });
  f.bot.api.config.use(async (previous, method, payload, signal) => {
    const result = await previous(method, payload, signal);
    if (
      method === "sendMessage" &&
      "text" in payload &&
      String(payload.text).startsWith("Download failed:")
    )
      failed.resolve();
    return result;
  });
  const keyboard = await f.menu();
  await f.bot.handleUpdate(
    selection(keyboard[0]?.[0]?.callback_data as string),
  );
  await failed.promise;
  assert.equal(attempts, 1);
});

for (const method of ["answerCallbackQuery", "deleteMessage"] as const) {
  test(`does not download when ${method} fails`, async (t) => {
    const logs: string[] = [];
    t.mock.method(console, "error", (text: string) => logs.push(text));
    let attempts = 0;
    const f = await downloadBot(t, async () => {
      attempts++;
      return "video.mp4";
    });
    f.bot.api.config.use(async (previous, called, payload, signal) => {
      if (called === method)
        return {
          ok: false,
          error_code: 400,
          description: "secret fixture error",
        };
      return previous(called, payload, signal);
    });
    const keyboard = await f.menu();
    const data = keyboard[0]?.[0]?.callback_data as string;
    await f.bot.handleUpdate(selection(data));
    assert.equal(attempts, 0);
    assert.equal(logs.length, 1);
    assert.doesNotMatch(logs.join(""), /secret/);
    assert.equal(
      f.calls.at(-1)?.payload.text,
      "Could not confirm your selection. Send the link again.",
    );
    assert.equal(f.downloads.busy, false);
  });
}

test("edits one status message, deletes it, and sends completion as a new message", async (t) => {
  const done = Promise.withResolvers<void>();
  const f = await downloadBot(t, async (_request, _signal, progress) => {
    assert(progress);
    progress("Downloading 42%.");
    return "video.mp4";
  });
  f.bot.api.config.use(async (previous, method, payload, signal) => {
    const result = await previous(method, payload, signal);
    if (
      method === "sendMessage" &&
      "text" in payload &&
      payload.text === "Done: video.mp4"
    )
      done.resolve();
    return result;
  });
  const keyboard = await f.menu();
  await f.bot.handleUpdate(
    selection(keyboard[0]?.[0]?.callback_data as string),
  );
  await done.promise;
  assert(
    f.calls.some(
      (call) =>
        call.method === "editMessageText" &&
        call.payload.text === "Downloading 42%.",
    ),
  );
  const initial = f.calls.find(
    (call) =>
      call.method === "sendMessage" &&
      call.payload.text === "Download and converting",
  );
  assert(initial);
  const deletions = f.calls.filter((call) => call.method === "deleteMessage");
  assert.equal(deletions.length, 2);
  assert.equal(deletions[0]?.payload.message_id, 202);
  assert(!deletions.some((call) => call.payload.message_id === 101));
  const deletion = deletions[1];
  const edit = f.calls.find((call) => call.method === "editMessageText");
  assert(deletion && edit);
  assert.equal(deletion.payload.message_id, edit.payload.message_id);
  assert.equal(f.calls.at(-2)?.method, "deleteMessage");
  assert.equal(f.calls.at(-1)?.method, "sendMessage");
});

test("failed status deletion still sends the download outcome", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "error", (text: string) => logs.push(text));
  const done = Promise.withResolvers<void>();
  let deletes = 0;
  const f = await downloadBot(t);
  f.bot.api.config.use(async (previous, method, payload, signal) => {
    if (method === "deleteMessage" && ++deletes > 1)
      return {
        ok: false,
        error_code: 400,
        description: "secret fixture error",
      };
    const result = await previous(method, payload, signal);
    if (
      method === "sendMessage" &&
      "text" in payload &&
      payload.text === "Done: video.mp4"
    )
      done.resolve();
    return result;
  });
  const keyboard = await f.menu();
  await f.bot.handleUpdate(
    selection(keyboard[0]?.[0]?.callback_data as string),
  );
  await done.promise;
  assert.equal(deletes, 2);
  assert.deepEqual(logs, ["Could not delete download status."]);
});
