import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVideoId } from "../src/video.ts";

const id = "abcDEF_12-3";
test("normalizes supported individual video links including Shorts and playlist parameters", () => {
  for (const url of [
    `https://youtube.com/watch?v=${id}`,
    `https://www.youtube.com/watch?v=${id}&list=playlist`,
    `http://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}?t=10`,
    ` https://www.youtube.com/shorts/${id} `,
    `https://youtube.com/embed/${id}`,
    `https://youtube.com/live/${id}`,
  ])
    assert.equal(parseVideoId(url), id);
});

test("rejects malformed, multiple, playlist-only, lookalike, and credential-bearing links", () => {
  for (const url of [
    "hello",
    "",
    "youtube.com/watch?v=abcDEF_12-3",
    "https://youtube.com/playlist?list=abc",
    "https://youtube.com/watch",
    "https://youtube.com/watch?v=short",
    "https://youtube.com/shorts/",
    "https://youtube.com/watch?v=abcDEF_12%21",
    "https://youtu.be/",
    "https://youtu.be/abcDEF_12-3/extra",
    "https://youtube.com.evil.test/watch?v=abcDEF_12-3",
    "https://other.test/watch?v=abcDEF_12-3",
    "ftp://youtube.com/watch?v=abcDEF_12-3",
    "https://user@youtube.com/watch?v=abcDEF_12-3",
    "https://:pass@youtube.com/watch?v=abcDEF_12-3",
    "https://youtube.com:8080/watch?v=abcDEF_12-3",
    "https://youtu.be/abcDEF_12-3 https://youtu.be/abcDEF_12-3",
  ])
    assert.equal(parseVideoId(url), undefined, url);
});
