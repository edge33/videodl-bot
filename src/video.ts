export const formats = {
  mp3: "MP3 320 kbps",
  mp4_720: "MP4 up to 720p",
  mp4_1080: "MP4 up to 1080p",
} as const;

export type Format = keyof typeof formats;

export function parseVideoId(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return;
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    /\s/.test(text.trim())
  )
    return;

  let id: string | null | undefined;
  if (url.hostname === "youtu.be") {
    id = url.pathname.slice(1);
  } else if (
    [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
    ].includes(url.hostname)
  ) {
    if (url.pathname === "/watch") {
      id = url.searchParams.get("v");
    } else {
      id = /^\/(?:shorts|embed|live)\/([^/]+)$/.exec(url.pathname)?.[1];
    }
  }
  return id && /^[\w-]{11}$/.test(id) ? id : undefined;
}
