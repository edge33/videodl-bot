import { statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Format } from "./video.ts";

export type JobState =
  | "queued"
  | "active"
  | "completed"
  | "failed"
  | "cancelled";
export interface Job {
  id: number;
  video_id: string;
  format: Format;
  state: JobState;
  retry_count: number;
  filename: string | null;
  outcome: string | null;
  status_chat_id: number | null;
  status_message_id: number | null;
}
export type Selection =
  | { kind: "queued" | "shared" | "completed"; job: Job }
  | { kind: "unavailable" }
  | { kind: "full" };

export class QueueStore {
  readonly #db: DatabaseSync;
  readonly #downloadDir: string;
  readonly #maxPending: number;

  constructor(db: DatabaseSync, downloadDir: string, maxPending = 20) {
    this.#db = db;
    this.#downloadDir = downloadDir;
    this.#maxPending = maxPending;
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS menus (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        source_message_id INTEGER NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0,
        UNIQUE(chat_id, source_message_id)
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL,
        format TEXT NOT NULL CHECK(format IN ('mp3', 'mp4_720', 'mp4_1080')),
        state TEXT NOT NULL CHECK(state IN ('queued','active','completed','failed','cancelled')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        filename TEXT,
        outcome TEXT,
        status_chat_id INTEGER,
        status_message_id INTEGER
      );
      CREATE TABLE IF NOT EXISTS job_deadlines (
        job_id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notifications (
        job_id INTEGER PRIMARY KEY, text TEXT NOT NULL, attempted_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS pending_video_format
        ON jobs(video_id, format) WHERE state IN ('queued','active');
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_job
        ON jobs((1)) WHERE state = 'active';
    `);
  }

  menu(videoId: string, chatId: number, messageId: number): number {
    const row = this.#db
      .prepare(`
      INSERT INTO menus(video_id, chat_id, source_message_id) VALUES (?, ?, ?)
      ON CONFLICT(chat_id, source_message_id) DO UPDATE SET chat_id = excluded.chat_id
      RETURNING id
    `)
      .get(videoId, chatId, messageId) as { id: number };
    return row.id;
  }

  select(menuId: number, chatId: number, format: Format): Selection {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#select(menuId, chatId, format);
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #select(menuId: number, chatId: number, format: Format): Selection {
    const menu = this.#db
      .prepare(
        "SELECT video_id FROM menus WHERE id = ? AND chat_id = ? AND consumed = 0",
      )
      .get(menuId, chatId) as { video_id: string } | undefined;
    if (!menu) return { kind: "unavailable" };
    const pending = this.#db
      .prepare(
        "SELECT * FROM jobs WHERE video_id = ? AND format = ? AND state IN ('queued','active')",
      )
      .get(menu.video_id, format) as Job | undefined;
    let result: Selection;
    if (pending) {
      result = { kind: "shared", job: pending };
    } else {
      const completed = this.#db
        .prepare(
          "SELECT * FROM jobs WHERE video_id = ? AND format = ? AND state = 'completed' ORDER BY id DESC",
        )
        .all(menu.video_id, format) as unknown as Job[];
      const reusable = completed.find(
        (job) =>
          job.filename !== null &&
          statSync(join(this.#downloadDir, job.filename), {
            throwIfNoEntry: false,
          })?.isFile(),
      );
      if (reusable) {
        result = { kind: "completed", job: reusable };
      } else {
        const { count } = this.#db
          .prepare("SELECT count(*) AS count FROM jobs WHERE state = 'queued'")
          .get() as { count: number };
        if (count >= this.#maxPending) return { kind: "full" };
        const job = this.#db
          .prepare(
            "INSERT INTO jobs(video_id, format, state) VALUES (?, ?, 'queued') RETURNING *",
          )
          .get(menu.video_id, format) as unknown as Job;
        result = { kind: "queued", job };
      }
    }
    this.#db.prepare("UPDATE menus SET consumed = 1 WHERE id = ?").run(menuId);
    return result;
  }

  get(id: number): Job | undefined {
    return this.#db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
      | Job
      | undefined;
  }

  list(pendingOnly = false): Job[] {
    return this.#db
      .prepare(
        pendingOnly
          ? "SELECT * FROM jobs WHERE state IN ('active','queued') ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, id"
          : "SELECT * FROM jobs ORDER BY id DESC LIMIT 10",
      )
      .all() as unknown as Job[];
  }

  claim(): Job | undefined {
    // A single write statement is atomic, even with a second database connection.
    return this.#db
      .prepare(`
      UPDATE jobs SET state = 'active', outcome = NULL
      WHERE id = (SELECT id FROM jobs WHERE state = 'queued' ORDER BY id LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM jobs WHERE state = 'active')
      RETURNING *
    `)
      .get() as Job | undefined;
  }

  statusMessage(id: number, chatId: number, messageId: number): void {
    this.#db
      .prepare(
        "UPDATE jobs SET status_chat_id = ?, status_message_id = ? WHERE id = ?",
      )
      .run(chatId, messageId, id);
  }

  cancel(id: number): boolean {
    return (
      this.#db
        .prepare(`
      UPDATE jobs SET state = 'cancelled', outcome = 'Cancelled by owner.'
      WHERE id = ? AND state IN ('queued','active')
    `)
        .run(id).changes === 1
    );
  }

  complete(id: number, filename: string): void {
    if (
      !filename ||
      basename(filename) !== filename ||
      filename === "." ||
      filename === ".."
    ) {
      throw new Error(
        "Downloader must return a filename within the output directory.",
      );
    }
    this.#db
      .prepare(
        "UPDATE jobs SET state = 'completed', filename = ?, outcome = 'Completed.' WHERE id = ? AND state = 'active'",
      )
      .run(filename, id);
  }

  notificationJobs(): (Job & {
    notified_text: string | null;
    attempted_at: number | null;
  })[] {
    return this.#db
      .prepare(`SELECT jobs.*, notifications.text AS notified_text, notifications.attempted_at
      FROM jobs LEFT JOIN notifications ON jobs.id = notifications.job_id
      WHERE status_chat_id IS NOT NULL AND status_message_id IS NOT NULL ORDER BY jobs.id`)
      .all() as unknown as (Job & {
      notified_text: string | null;
      attempted_at: number | null;
    })[];
  }

  notificationAttempt(id: number, text: string, time: number): void {
    this.#db
      .prepare(`INSERT INTO notifications(job_id, text, attempted_at) VALUES (?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET text = excluded.text, attempted_at = excluded.attempted_at`)
      .run(id, text, time);
  }

  preparePublication(id: number, filename: string): void {
    this.#db
      .prepare("UPDATE jobs SET filename = ? WHERE id = ? AND state = 'active'")
      .run(filename, id);
  }

  startedAt(id: number, now: number): number {
    return (
      this.#db
        .prepare(`INSERT INTO job_deadlines(job_id, started_at) VALUES (?, ?)
      ON CONFLICT(job_id) DO UPDATE SET job_id = excluded.job_id RETURNING started_at`)
        .get(id, now) as { started_at: number }
    ).started_at;
  }

  retry(id: number): void {
    this.#db
      .prepare("UPDATE jobs SET retry_count = retry_count + 1 WHERE id = ?")
      .run(id);
  }

  fail(id: number, outcome = "Download failed."): void {
    this.#db
      .prepare(
        "UPDATE jobs SET state = 'failed', outcome = ? WHERE id = ? AND state = 'active'",
      )
      .run(outcome, id);
  }

  recover(): void {
    this.#db.exec(
      "UPDATE jobs SET state = 'queued', outcome = 'Interrupted; waiting to resume.' WHERE state = 'active'",
    );
  }
}
