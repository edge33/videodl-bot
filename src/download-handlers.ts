import { randomUUID } from "node:crypto";
import { type Bot, InlineKeyboard } from "grammy";
import type { DownloadSession } from "./download-session.ts";
import { type Format, formats, parseVideoId } from "./video.ts";

export function registerDownloadHandlers(
  bot: Bot,
  downloads: DownloadSession,
): void {
  let menu: { id: string; videoId: string } | undefined;

  bot.command("cancel", async (ctx) => {
    await ctx.reply(
      downloads.cancel() ? "Cancellation requested." : "No active download.",
    );
  });

  bot.on("callback_query:data", async (ctx) => {
    const match = /^format:([\w-]+):(mp3|mp4_720|mp4_1080)$/.exec(
      ctx.callbackQuery.data,
    );
    if (!match || !menu || match[1] !== menu.id) {
      await ctx.answerCallbackQuery({
        text: "This menu is unavailable. Send the link again.",
      });
      return;
    }
    if (downloads.busy) {
      await ctx.answerCallbackQuery({
        text: "Busy downloading. Try again later.",
      });
      return;
    }
    const request = { videoId: menu.videoId, format: match[2] as Format };
    menu = undefined;
    try {
      await ctx.answerCallbackQuery();
      await ctx.deleteMessage();
    } catch {
      console.error("Could not update format selection.");
      await ctx.reply("Could not confirm your selection. Send the link again.");
      return;
    }
    let statusMessageId = 0;
    const chatId = ctx.chatId as number;
    if (
      !downloads.start(
        request,
        async (text) => {
          const message = await ctx.reply(text);
          statusMessageId = message.message_id;
        },
        (text) => ctx.api.editMessageText(chatId, statusMessageId, text),
        () => ctx.api.deleteMessage(chatId, statusMessageId),
      )
    ) {
      await ctx.reply("Busy downloading. Send the link again later.");
    }
  });

  bot.on("message:text", async (ctx) => {
    if (downloads.busy) {
      await ctx.reply("Busy downloading. Try again later.");
      return;
    }
    const videoId = parseVideoId(ctx.message.text);
    if (!videoId) {
      await ctx.reply(
        "Send one individual YouTube video URL (watch, youtu.be, or Shorts). Playlist-only links and multiple links are unsupported.",
      );
      return;
    }
    const id = randomUUID();
    menu = { id, videoId };
    const keyboard = InlineKeyboard.from(
      Object.entries(formats).map(([format, label]) => [
        InlineKeyboard.text(label, `format:${id}:${format}`),
      ]),
    );
    await ctx.reply("Choose a format.", { reply_markup: keyboard });
  });
}
