import { type Bot, InlineKeyboard } from "grammy";
import type { Job, QueueStore } from "./queue.ts";
import { type Format, formats, parseVideoId } from "./video.ts";
import type { QueueWorker } from "./worker.ts";

function describeJob(job: Job): string {
  const file = job.filename === null ? "" : ` — ${job.filename}`;
  const outcome = job.outcome === null ? "" : ` — ${job.outcome}`;
  return `#${job.id} ${job.video_id} · ${formats[job.format]} · ${job.state}${file}${outcome}`;
}

export interface QueueServices {
  store: QueueStore;
  worker?: QueueWorker;
}

export function registerQueueHandlers(
  bot: Bot,
  { store, worker }: QueueServices,
): void {
  bot.command("status", async (ctx) => {
    const argument = ctx.match.trim();
    let jobs: Job[];
    if (argument) {
      const job = /^[1-9]\d{0,14}$/.test(argument)
        ? store.get(Number(argument))
        : undefined;
      jobs = job ? [job] : [];
    } else {
      jobs = store.list();
    }
    await ctx.reply(
      jobs.length ? jobs.map(describeJob).join("\n") : "No matching jobs.",
    );
  });

  bot.command("queue", async (ctx) => {
    const jobs = store.list(true);
    await ctx.reply(
      jobs.length ? jobs.map(describeJob).join("\n") : "The queue is empty.",
    );
  });

  bot.command("cancel", async (ctx) => {
    const argument = ctx.match.trim();
    if (!/^[1-9]\d{0,14}$/.test(argument)) {
      await ctx.reply("Use /cancel <job-id> with an ID from /queue.");
      return;
    }
    const cancelled = await (worker ?? store).cancel(Number(argument));
    await ctx.reply(
      cancelled
        ? `Job #${argument} cancelled.`
        : "No queued or active job with that ID.",
    );
  });

  bot.on("callback_query:data", async (ctx) => {
    const match = /^format:([1-9]\d{0,14}):(mp3|mp4_720|mp4_1080)$/.exec(
      ctx.callbackQuery.data,
    );
    if (!match) {
      await ctx.answerCallbackQuery({ text: "Unknown format selection." });
      return;
    }
    const result = store.select(
      Number(match[1]),
      ctx.from.id,
      match[2] as Format,
    );
    if (result.kind === "unavailable" || result.kind === "full") {
      await ctx.answerCallbackQuery({
        text:
          result.kind === "full"
            ? "Queue full. Try this menu again after a job finishes or is cancelled."
            : "This menu was already used or is unavailable. Send the link again.",
      });
      return;
    }
    await ctx.answerCallbackQuery({
      text:
        result.kind === "queued"
          ? "Added to queue."
          : "Using the existing job.",
    });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    const reply = await ctx.reply(describeJob(result.job));
    if (result.kind === "queued") {
      store.statusMessage(result.job.id, ctx.from.id, reply.message_id);
    }
  });

  bot.on("message:text", async (ctx) => {
    const videoId = parseVideoId(ctx.message.text);
    if (!videoId) {
      await ctx.reply(
        "Send one individual YouTube video URL (watch, youtu.be, or Shorts). Playlist-only links and multiple links are unsupported.",
      );
      return;
    }
    const menuId = store.menu(videoId, ctx.from.id, ctx.message.message_id);
    const keyboard = InlineKeyboard.from(
      Object.entries(formats).map(([format, label]) => [
        InlineKeyboard.text(label, `format:${menuId}:${format}`),
      ]),
    );
    await ctx.reply(`Choose a format for ${videoId}.`, {
      reply_markup: keyboard,
    });
  });
}
