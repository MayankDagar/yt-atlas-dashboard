import { Router } from "express";
import { pool } from "./db.js";
import { requireAdmin, requireAuthenticated } from "./auth.js";
import { buildXPostsXlsx, type XPostExportRow } from "./x-post-export.js";

const router = Router();
const apifyToken = process.env.APIFY_API_TOKEN?.trim() || "";
const actorId = "apidojo~twitter-scraper-lite";
const apiRoot = "https://api.apify.com/v2";
const pageSize = 50;
const demoLimit = 10;

type TopicState = { topic: string; status: "queued" | "running" | "completed" | "failed"; postsFound: number; error?: string };
type XPost = XPostExportRow & { authorId: string | null };
type JsonObject = Record<string, unknown>;

class XInputError extends Error {}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function textValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function countValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return value.trim();
  }
  return null;
}

function safeXUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseDate(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function normalizePost(value: unknown): XPost | null {
  if (!isObject(value)) return null;
  const author = isObject(value.author) ? value.author : isObject(value.user) ? value.user : {};
  const postId = textValue(value.id, value.id_str, value.tweetId, value.tweet_id);
  if (!postId || !/^\d{5,30}$/.test(postId)) return null;
  const handle = textValue(author.userName, author.username, author.screen_name, author.handle, value.authorHandle)?.replace(/^@/, "") || null;
  const authorUrl = safeXUrl(author.url) || safeXUrl(author.twitterUrl) || (handle && /^[a-zA-Z0-9_]{1,30}$/.test(handle) ? `https://x.com/${handle}` : null);
  const postUrl = safeXUrl(value.url) || safeXUrl(value.twitterUrl) || safeXUrl(value.tweetUrl) || `https://x.com/i/web/status/${postId}`;
  return {
    postId,
    postUrl,
    postText: textValue(value.text, value.fullText, value.full_text, value.tweetText) || "",
    createdAt: parseDate(value.createdAt ?? value.created_at ?? value.date),
    language: textValue(value.lang, value.language),
    authorId: textValue(author.id, author.id_str),
    authorName: textValue(author.name, author.displayName, author.display_name, value.authorName),
    authorHandle: handle,
    authorUrl,
    likesCount: countValue(value.likeCount, value.favorite_count, value.likes),
    repostsCount: countValue(value.retweetCount, value.retweet_count, value.reposts),
    repliesCount: countValue(value.replyCount, value.reply_count, value.replies),
    quotesCount: countValue(value.quoteCount, value.quote_count, value.quotes),
    topics: [],
  };
}

async function apifyRequest(path: string, init: RequestInit = {}): Promise<globalThis.Response> {
  const response = await fetch(`${apiRoot}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apifyToken}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    signal: init.signal || AbortSignal.timeout(30_000),
  });
  return response;
}

async function responseJson(response: globalThis.Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

async function updateProgress(collectionId: string, progress: TopicState[], completed: number, postsSaved: number | null, errors: string[]): Promise<void> {
  await pool.query(
    `UPDATE x_post_collections SET topic_progress = $2::jsonb, topics_completed = $3,
       posts_saved = COALESCE($4, posts_saved), error_summary = $5 WHERE id = $1::uuid`,
    [collectionId, JSON.stringify(progress), completed, postsSaved, errors.length ? errors.join("; ").slice(0, 4000) : null],
  );
}

async function saveTopicPosts(collectionId: string, topic: string, records: unknown[]): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const record of records) {
      const post = normalizePost(record);
      if (!post) continue;
      await client.query(
        `INSERT INTO x_posts
           (post_id, post_url, post_text, created_at, language, author_id, author_name, author_handle, author_url,
            likes_count, reposts_count, replies_count, quotes_count, observed_at)
         VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9, $10::bigint, $11::bigint, $12::bigint, $13::bigint, NOW())
         ON CONFLICT (post_id) DO UPDATE SET post_url = EXCLUDED.post_url, post_text = EXCLUDED.post_text,
           created_at = COALESCE(EXCLUDED.created_at, x_posts.created_at), language = COALESCE(EXCLUDED.language, x_posts.language),
           author_id = COALESCE(EXCLUDED.author_id, x_posts.author_id), author_name = COALESCE(EXCLUDED.author_name, x_posts.author_name),
           author_handle = COALESCE(EXCLUDED.author_handle, x_posts.author_handle), author_url = COALESCE(EXCLUDED.author_url, x_posts.author_url),
           likes_count = COALESCE(EXCLUDED.likes_count, x_posts.likes_count), reposts_count = COALESCE(EXCLUDED.reposts_count, x_posts.reposts_count),
           replies_count = COALESCE(EXCLUDED.replies_count, x_posts.replies_count), quotes_count = COALESCE(EXCLUDED.quotes_count, x_posts.quotes_count),
           observed_at = NOW()`,
        [post.postId, post.postUrl, post.postText, post.createdAt, post.language, post.authorId, post.authorName, post.authorHandle,
          post.authorUrl, post.likesCount, post.repostsCount, post.repliesCount, post.quotesCount],
      );
      await client.query(
        `INSERT INTO x_post_collection_results (collection_id, topic, post_id)
         VALUES ($1::uuid, $2, $3) ON CONFLICT DO NOTHING`,
        [collectionId, topic, post.postId],
      );
    }
    const { rows } = await client.query<{ count: string }>(
      "SELECT COUNT(DISTINCT post_id)::text AS count FROM x_post_collection_results WHERE collection_id = $1::uuid",
      [collectionId],
    );
    const count = Number(rows[0]?.count || 0);
    await client.query("UPDATE x_post_collections SET posts_saved = $2 WHERE id = $1::uuid", [collectionId, count]);
    await client.query("COMMIT");
    return count;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function runActor(topic: string, maxItems: number, startDate: string, endDate: string): Promise<{ runId: string; datasetId: string }> {
  const started = await apifyRequest(`/actors/${actorId}/runs?waitForFinish=0`, {
    method: "POST",
    body: JSON.stringify({ searchTerms: [topic], sort: "Top", maxItems, start: startDate, end: endDate }),
  });
  const startedBody = await responseJson(started);
  const run = isObject(startedBody) && isObject(startedBody.data) ? startedBody.data : null;
  const runId = run && typeof run.id === "string" ? run.id : null;
  if (!started.ok || !runId) throw new Error(`Apify could not start this topic (HTTP ${started.status}).`);
  if (typeof run.defaultDatasetId !== "string") throw new Error("Apify did not provide a results dataset for this topic.");
  return { runId, datasetId: run.defaultDatasetId };
}

async function waitForActor(runId: string): Promise<boolean> {
  const timeoutAt = Date.now() + 20 * 60 * 1000;
  while (Date.now() < timeoutAt) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const response = await apifyRequest(`/actor-runs/${encodeURIComponent(runId)}`);
    const body = await responseJson(response);
    const data = isObject(body) && isObject(body.data) ? body.data : null;
    if (!response.ok || !data || typeof data.status !== "string") throw new Error(`Could not check the Apify run (HTTP ${response.status}).`);
    if (data.status === "SUCCEEDED") return true;
    if (["FAILED", "ABORTED", "TIMED-OUT"].includes(data.status)) return false;
  }
  await apifyRequest(`/actor-runs/${encodeURIComponent(runId)}/abort`, { method: "POST" }).catch(() => undefined);
  throw new Error("The Apify run took too long and was stopped.");
}

async function readDataset(datasetId: string, maxItems: number): Promise<unknown[]> {
  const response = await apifyRequest(`/datasets/${encodeURIComponent(datasetId)}/items?clean=true&format=json&limit=${maxItems}`);
  const data = await responseJson(response);
  if (!response.ok || !Array.isArray(data)) throw new Error(`Could not retrieve Apify results (HTTP ${response.status}).`);
  return data;
}

async function deleteDataset(datasetId: string): Promise<void> {
  const response = await apifyRequest(`/datasets/${encodeURIComponent(datasetId)}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
}

async function processCollection(collectionId: string): Promise<void> {
  const collectionResult = await pool.query<{
    topics: string[]; start_date: string; end_date: string; max_items: number; topic_progress: TopicState[];
  }>("SELECT topics, start_date::text, end_date::text, max_items, topic_progress FROM x_post_collections WHERE id = $1::uuid", [collectionId]);
  if (!collectionResult.rowCount) return;
  const collection = collectionResult.rows[0];
  const progress = Array.isArray(collection.topic_progress) ? collection.topic_progress : collection.topics.map((topic) => ({ topic, status: "queued" as const, postsFound: 0 }));
  const errors: string[] = [];
  let completed = 0;
  let succeeded = 0;
  await pool.query("UPDATE x_post_collections SET status = 'running', started_at = NOW() WHERE id = $1::uuid", [collectionId]);

  for (const [index, topic] of collection.topics.entries()) {
    progress[index] = { topic, status: "running", postsFound: 0 };
    await updateProgress(collectionId, progress, completed, null, errors);
    let datasetId: string | null = null;
    try {
      const run = await runActor(topic, collection.max_items, collection.start_date, collection.end_date);
      datasetId = run.datasetId;
      await pool.query("UPDATE x_post_collections SET actor_run_ids = array_append(actor_run_ids, $2) WHERE id = $1::uuid", [collectionId, run.runId]);
      if (!await waitForActor(run.runId)) throw new Error("Apify could not complete this topic.");
      const records = await readDataset(run.datasetId, collection.max_items);
      const postsSaved = await saveTopicPosts(collectionId, topic, records);
      succeeded += 1;
      progress[index] = { topic, status: "completed", postsFound: records.filter((record) => normalizePost(record)).length };
      completed += 1;
      await updateProgress(collectionId, progress, completed, postsSaved, errors);
      try { await deleteDataset(run.datasetId); } catch { errors.push(`${topic}: results were saved, but Apify's temporary dataset could not be deleted.`); }
    } catch (error) {
      const summary = error instanceof Error ? error.message.slice(0, 500) : "The topic collection failed.";
      errors.push(`${topic}: ${summary}`);
      progress[index] = { topic, status: "failed", postsFound: 0, error: summary };
      completed += 1;
      await updateProgress(collectionId, progress, completed, Number((await pool.query<{ posts_saved: number }>("SELECT posts_saved FROM x_post_collections WHERE id = $1::uuid", [collectionId])).rows[0]?.posts_saved || 0), errors);
      // Keep an unimported dataset for recovery; unnamed datasets expire under Apify's default retention.
      void datasetId;
    }
  }

  const status = succeeded === collection.topics.length ? "completed" : succeeded > 0 ? "partial" : "failed";
  await pool.query(
    `UPDATE x_post_collections SET status = $2, topics_completed = $3, error_summary = $4, finished_at = NOW()
     WHERE id = $1::uuid`,
    [collectionId, status, completed, errors.length ? errors.join("; ").slice(0, 4000) : null],
  );
}

export async function recoverStaleXPostCollections(): Promise<void> {
  const { rows } = await pool.query<{ id: string; actor_run_ids: string[] }>(
    "SELECT id, actor_run_ids FROM x_post_collections WHERE status IN ('queued', 'running')",
  );
  if (apifyToken) {
    for (const row of rows) {
      for (const runId of row.actor_run_ids) {
        await apifyRequest(`/actor-runs/${encodeURIComponent(runId)}/abort`, { method: "POST" }).catch(() => undefined);
      }
    }
  }
  await pool.query(
    `UPDATE x_post_collections SET status = 'failed', error_summary = 'The API restarted before this collection finished.', finished_at = NOW()
     WHERE status IN ('queued', 'running')`,
  );
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function todayInIndia(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-${parts.find((part) => part.type === "day")?.value}`;
}

function validateRequest(body: unknown): { topics: string[]; startDate: string; endDate: string; maxItems: number } {
  if (!isObject(body) || !Array.isArray(body.topics) || body.topics.length < 1 || body.topics.length > 20) {
    throw new XInputError("Enter between 1 and 20 topics.");
  }
  const topics = body.topics.map((topic) => {
    if (typeof topic !== "string" || !topic.trim() || topic.trim().length > 200) throw new XInputError("Each topic must contain 1–200 characters.");
    return topic.trim();
  });
  if (new Set(topics.map((topic) => topic.toLocaleLowerCase())).size !== topics.length) throw new XInputError("Remove duplicate topics.");
  if (!isDate(body.startDate) || !isDate(body.endDate) || body.startDate > body.endDate) throw new XInputError("Choose a valid date range.");
  if (body.endDate > todayInIndia()) throw new XInputError("Choose an end date that is today or earlier (IST).");
  const maxItems = body.maxItems;
  if (typeof maxItems !== "number" || !Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100) throw new XInputError("Choose a result limit from 1 to 100.");
  return { topics, startDate: body.startDate, endDate: body.endDate, maxItems };
}

router.post("/", requireAdmin, async (req, res, next) => {
  try {
    if (!apifyToken) {
      res.status(503).json({ error: "Add APIFY_API_TOKEN to .env, then restart the API to collect X posts." });
      return;
    }
    const input = validateRequest(req.body);
    const progress: TopicState[] = input.topics.map((topic) => ({ topic, status: "queued", postsFound: 0 }));
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO x_post_collections (topics, start_date, end_date, max_items, status, topics_total, topic_progress)
       VALUES ($1::text[], $2::date, $3::date, $4, 'queued', $5, $6::jsonb) RETURNING id`,
      [input.topics, input.startDate, input.endDate, input.maxItems, input.topics.length, JSON.stringify(progress)],
    );
    const collectionId = rows[0].id;
    res.status(202).json({ collectionId, status: "queued", demoItemCap: demoLimit });
    void processCollection(collectionId).catch(async () => {
      await pool.query(
        `UPDATE x_post_collections SET status = 'failed', error_summary = 'The collection stopped unexpectedly.', finished_at = NOW()
         WHERE id = $1::uuid AND status IN ('queued', 'running')`,
        [collectionId],
      ).catch(() => undefined);
    });
  } catch (error) {
    if (error instanceof XInputError) { res.status(400).json({ error: error.message }); return; }
    if ((error as { code?: string })?.code === "23505") { res.status(409).json({ error: "An X post collection is already queued or running." }); return; }
    next(error);
  }
});

router.get("/", requireAuthenticated, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, topics, start_date AS "startDate", end_date AS "endDate", max_items AS "maxItems",
         status, topics_total AS "topicsTotal", topics_completed AS "topicsCompleted", posts_saved AS "postsSaved",
         topic_progress AS "topicProgress", error_summary AS "errorSummary", created_at AS "createdAt",
         started_at AS "startedAt", finished_at AS "finishedAt"
       FROM x_post_collections ORDER BY created_at DESC LIMIT 50`,
    );
    res.json({ collections: rows, demoItemCap: demoLimit });
  } catch (error) { next(error); }
});

router.get("/:id", requireAuthenticated, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, topics, start_date AS "startDate", end_date AS "endDate", max_items AS "maxItems",
         status, topics_total AS "topicsTotal", topics_completed AS "topicsCompleted", posts_saved AS "postsSaved",
         topic_progress AS "topicProgress", error_summary AS "errorSummary", created_at AS "createdAt",
         started_at AS "startedAt", finished_at AS "finishedAt"
       FROM x_post_collections WHERE id = $1::uuid`, [req.params.id],
    );
    if (!rows.length) { res.status(404).json({ error: "X post collection not found." }); return; }
    res.json({ collection: rows[0], demoItemCap: demoLimit });
  } catch (error) { next(error); }
});

async function queryCollectionPosts(collectionId: string, topic: string | null, limit?: number, offset = 0): Promise<XPostExportRow[]> {
  const { rows } = await pool.query<XPostExportRow>(
    `SELECT p.post_id AS "postId", p.post_url AS "postUrl", p.post_text AS "postText", p.created_at AS "createdAt",
       p.author_name AS "authorName", p.author_handle AS "authorHandle", p.author_url AS "authorUrl",
       p.likes_count AS "likesCount", p.reposts_count AS "repostsCount", p.replies_count AS "repliesCount",
       p.quotes_count AS "quotesCount", p.language,
       ARRAY_AGG(DISTINCT r.topic ORDER BY r.topic) AS topics
     FROM x_post_collection_results r JOIN x_posts p ON p.post_id = r.post_id
     WHERE r.collection_id = $1::uuid AND ($2::text IS NULL OR r.topic = $2)
     GROUP BY p.post_id ORDER BY p.created_at DESC NULLS LAST, p.post_id
     ${limit === undefined ? "" : "LIMIT $3 OFFSET $4"}`,
    limit === undefined ? [collectionId, topic] : [collectionId, topic, limit, offset],
  );
  return rows;
}

router.get("/:id/posts", requireAuthenticated, async (req, res, next) => {
  try {
    const pageValue = Number(req.query.page ?? 0);
    const page = Number.isInteger(pageValue) && pageValue >= 0 ? Math.min(pageValue, 100_000) : 0;
    const topic = typeof req.query.topic === "string" && req.query.topic.trim() ? req.query.topic.trim() : null;
    const exists = await pool.query("SELECT 1 FROM x_post_collections WHERE id = $1::uuid", [req.params.id]);
    if (!exists.rowCount) { res.status(404).json({ error: "X post collection not found." }); return; }
    const filter = topic ? "AND r.topic = $2" : "";
    const count = await pool.query<{ count: string }>(
      `SELECT COUNT(DISTINCT r.post_id)::text AS count FROM x_post_collection_results r
       WHERE r.collection_id = $1::uuid ${filter}`,
      topic ? [req.params.id, topic] : [req.params.id],
    );
    const posts = await queryCollectionPosts(req.params.id, topic, pageSize, page * pageSize);
    res.json({ posts, total: Number(count.rows[0]?.count || 0), page, pageSize });
  } catch (error) { next(error); }
});

router.get("/:id/export", requireAuthenticated, async (req, res, next) => {
  try {
    const topic = typeof req.query.topic === "string" && req.query.topic.trim() ? req.query.topic.trim() : null;
    const exists = await pool.query("SELECT 1 FROM x_post_collections WHERE id = $1::uuid", [req.params.id]);
    if (!exists.rowCount) { res.status(404).json({ error: "X post collection not found." }); return; }
    const posts = await queryCollectionPosts(req.params.id, topic);
    const file = buildXPostsXlsx(posts);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="x-posts-${req.params.id}.xlsx"`);
    res.setHeader("Content-Length", String(file.byteLength));
    res.send(file);
  } catch (error) { next(error); }
});

export default router;
