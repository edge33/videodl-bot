import assert from "node:assert/strict";
import { createServer } from "node:http";

const user = { id: 42, is_bot: false, first_name: "Test" };
const chat = { id: 42, type: "private" };
const message = (id, text) => ({
  message_id: id,
  date: 1,
  chat,
  from: user,
  text,
  ...(text === "/cancel"
    ? { entities: [{ offset: 0, length: 7, type: "bot_command" }] }
    : {}),
});
let updates = [
  { update_id: 1, message: message(10, "https://youtu.be/abcdefghijk") },
];
let nextId = 100;
let menuId,
  statusId,
  edited = false;
const deleted = new Set();
let complete = false;
createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const data = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  const method = req.url.split("/").at(-1);
  let result = true;
  try {
    if (method === "health") result = complete;
    else if (method === "getMe")
      result = {
        id: 99,
        is_bot: true,
        first_name: "Fixture",
        username: "fixture_bot",
      };
    else if (method === "getUpdates") {
      await new Promise((resolve) => setTimeout(resolve, 100));
      result = updates;
      updates = [];
    } else if (method === "sendMessage") {
      const id = nextId++;
      result = {
        ...message(id, data.text),
        from: { id: 99, is_bot: true, first_name: "Fixture" },
      };
      if (data.reply_markup) {
        menuId = id;
        updates.push({
          update_id: 2,
          callback_query: {
            id: "choice",
            from: user,
            chat_instance: "test",
            message: result,
            data: data.reply_markup.inline_keyboard[0][0].callback_data,
          },
        });
      } else if (data.text === "Download and converting") statusId = id;
      else if (/^(Done:|Download failed|Download cancelled)/.test(data.text)) {
        assert.ok(edited);
        assert.ok(deleted.has(menuId));
        assert.ok(deleted.has(statusId));
        assert.ok(!deleted.has(10));
        assert.notEqual(id, statusId);
        const expected = {
          success: "Done:",
          failure: "Download failed",
          cancel: "Download cancelled",
        }[process.env.SCENARIO];
        assert.ok(data.text.startsWith(expected));
        complete = true;
      }
    } else if (method === "editMessageText") {
      assert.equal(data.message_id, statusId);
      edited = true;
      if (process.env.SCENARIO === "cancel")
        updates.push({ update_id: 3, message: message(11, "/cancel") });
    } else if (method === "deleteMessage") deleted.add(data.message_id);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result }));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    res.writeHead(500);
    res.end();
  }
}).listen(8080, "0.0.0.0");
