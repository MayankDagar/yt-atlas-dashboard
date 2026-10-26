import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { pool, initializeDatabase } from "./db.js";
import authRouter, { requireAdmin, requireAuthenticated } from "./auth.js";
import xPostsRouter, { recoverStaleXPostCollections } from "./x-posts.js";

const app = express();
const port = Number(process.env.API_PORT || 4000);
const webOrigins = (process.env.WEB_ORIGIN || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const isAllowedWebOrigin = (origin: string | undefined) => Boolean(origin && webOrigins.includes(origin));
const workerUrl = process.env.WORKER_URL || "http://localhost:8000";
const workerToken = process.env.WORKER_TOKEN || "";
const apiPrefix = "/api/v1";

class ValidationError extends Error {}

app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});
app.use(cors({
  origin: (origin, callback) => callback(null, isAllowedWebOrigin(origin)),
  credentials: true,
}));
app.use(express.json({
  limit: "10mb",
  verify: (req, _res, buffer) => {
    (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
  },
}));
app.use((req, res, next) => {
  const isWrite = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
  if (isWrite && !req.path.startsWith(`${apiPrefix}/internal`)) {
    const origin = req.get("origin");
    if (!isAllowedWebOrigin(origin)) {
      res.status(403).json({ error: "A trusted web origin is required for this request." });
      return;
    }
  }
  next();
});

type RateLimitEntry = { count: number; resetAt: number };
const apiRateLimits = new Map<string, RateLimitEntry>();
function apiRateLimit(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  if (apiRateLimits.size > 10_000) {
    for (const [key, entry] of apiRateLimits) if (entry.resetAt <= now) apiRateLimits.delete(key);
  }
  const key = req.ip || req.socket.remoteAddress || "unknown";
  if (!apiRateLimits.has(key) && apiRateLimits.size >= 10_000) {
    const oldest = apiRateLimits.keys().next().value;
    if (oldest) apiRateLimits.delete(oldest);
  }
  let entry = apiRateLimits.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + 15 * 60 * 1000 };
    apiRateLimits.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > 1800) {
    res.setHeader("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
    res.status(429).json({ error: "Too many requests. Please try again shortly." });
    return;
  }
  next();
}
app.use(apiPrefix, apiRateLimit);

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.use(`${apiPrefix}/auth`, authRouter);
app.use(`${apiPrefix}/x-post-collections`, xPostsRouter);

app.delete(`${apiPrefix}/workspace/data`, requireAdmin, async (_req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "TRUNCATE TABLE x_post_collection_results, x_posts, x_post_collections, collection_jobs, video_engagement_snapshots, metric_snapshots, channels RESTART IDENTITY",
    );
    await client.query("COMMIT");
    res.json({ cleared: true });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

app.post(`${apiPrefix}/channels/google-sheet-csv`, requireAdmin, async (req, res, next) => {
  try {
    if (typeof req.body?.url !== "string") throw new ValidationError("Paste a Google Sheets link.");
    let sheetUrl: URL;
    try {
      sheetUrl = new URL(req.body.url.trim());
    } catch {
      throw new ValidationError("Enter a valid Google Sheets link.");
    }
    if (sheetUrl.protocol !== "https:" || sheetUrl.hostname !== "docs.google.com") {
      throw new ValidationError("Use a Google Sheets link from docs.google.com.");
    }
    const sheetMatch = sheetUrl.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:\/|$)/);
    if (!sheetMatch) throw new ValidationError("Use a Google Sheets link in the format docs.google.com/spreadsheets/d/…");

    const hashParams = new URLSearchParams(sheetUrl.hash.replace(/^#/, ""));
    const gid = sheetUrl.searchParams.get("gid") || hashParams.get("gid") || "0";
    if (!/^\d+$/.test(gid)) throw new ValidationError("The selected sheet tab is invalid.");

    const exportUrl = new URL(`https://docs.google.com/spreadsheets/d/${sheetMatch[1]}/export`);
    exportUrl.searchParams.set("format", "csv");
    exportUrl.searchParams.set("gid", gid);
    let currentUrl = exportUrl;
    let response: globalThis.Response;
    for (let redirects = 0; ; redirects += 1) {
      response = await fetch(currentUrl, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
      if (response.status < 300 || response.status >= 400) break;
      if (redirects >= 3) throw new ValidationError("Google Sheets returned too many download redirects.");
      const location = response.headers.get("location");
      if (!location) throw new ValidationError("Google Sheets returned an invalid download redirect.");
      let nextUrl: URL;
      try { nextUrl = new URL(location, currentUrl); } catch { throw new ValidationError("Google Sheets returned an invalid download redirect."); }
      const allowedDownloadHost = nextUrl.hostname === "docs.google.com" || nextUrl.hostname.endsWith(".googleusercontent.com");
      if (nextUrl.protocol !== "https:" || !allowedDownloadHost || nextUrl.username || nextUrl.password || nextUrl.port) {
        throw new ValidationError("Google Sheets returned an unexpected download location.");
      }
      currentUrl = nextUrl;
    }
    if (!response.ok) {
      throw new ValidationError("Could not load the sheet. Give it Anyone with the link viewer access and try again.");
    }
    if (currentUrl.hostname !== "docs.google.com" && !currentUrl.hostname.endsWith(".googleusercontent.com"))
      throw new ValidationError("Google Sheets returned an unexpected download location.");
    const maxBytes = 20 * 1024 * 1024;
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > maxBytes) throw new ValidationError("The exported sheet is too large to import.");
    if (!response.body) throw new ValidationError("Google Sheets returned an empty export.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        throw new ValidationError("The exported sheet is too large to import.");
      }
      chunks.push(value);
    }
    const csv = new TextDecoder("utf-8").decode(Buffer.concat(chunks));
    if (/^\s*<(?:!doctype\s+html|html)/i.test(csv)) {
      throw new ValidationError("Google Sheets could not export this sheet. Give it Anyone with the link viewer access and try again.");
    }
    res.json({ csv });
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      res.status(400).json({ error: "Google Sheets took too long to respond. Try again." });
      return;
    }
    next(error);
  }
});

function requiredText(value: unknown, label: string, maxLength = 200): string {
  if (typeof value !== "string") throw new ValidationError(`${label} is required.`);
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError(`${label} is required.`);
  if (trimmed.length > maxLength) throw new ValidationError(`${label} must be ${maxLength} characters or fewer.`);
  return trimmed;
}

function optionalText(value: unknown, label: string, maxLength = 160): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ValidationError(`${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new ValidationError(`${label} must be ${maxLength} characters or fewer.`);
  return trimmed || null;
}

type KeywordSourceVideo = {
  id: string;
  title: string;
  description: string;
  status?: string;
};
const KEYWORD_ALGORITHM_VERSION = 3;
const keywordStopWords = new Set((
  "a about above after again against all am an and any are as at be because been before being below " +
  "between both but by can could did do does doing down during each few for from further had has have " +
  "having he her here hers herself him himself his how i if in into is it its itself just me more most " +
  "my myself no nor not of off on once only or other our ours ourselves out over own same she should so " +
  "some such than that the their theirs them themselves then there these they this those through to too " +
  "under until up very was we were what when where which while who whom why will with would you your yours " +
  "yourself yourselves hai hain ho hun ka ki ke ko mein main me se par aur bhi nahi nahin ye yeh woh vah " +
  "iska uska iske uske unke inki unki tak liye laga gaye gaya kar kiya karein karna apna apne apni jo jab tab " +
  "tha thi the raha rahe rahi ne ek do is us yah ve " +
  "official video videos channel subscribe follow watch please thank thanks new latest live shorts short " +
  "click link links visit website today yesterday tomorrow breaking update updates news report reports " +
  "followed subscribe subscribers description tags hashtag full watch now dont must also just like share " +
  "youtube www com http https aaj tak aajtak hindi viral trending top"
).split(/\s+/));
const keywordPromotionalLine = /\b(?:subscribe|follow us|join us|download our app|for more updates|stay tuned|watch now|like and share|visit our website|whatsapp channel|facebook|instagram|twitter|telegram)\b/i;

function localKeywords(title: string, description: string): string[] {
  type Candidate = { score: number; terms: Set<string>; titleMatch: boolean };
  const candidates = new Map<string, Candidate>();
  const descriptionText = description
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .split(/\r?\n|[.!?।]+/)
    .filter((line) => line.trim() && !keywordPromotionalLine.test(line))
    .join("\n")
    .slice(0, 1800);
  const sources = [
    { text: title, weight: 10, inTitle: true },
    { text: descriptionText, weight: 1.8, inTitle: false },
  ];

  for (const source of sources) {
    for (const segment of source.text.split(/[\n:|.!?।]+/)) {
      const cleaned = segment.normalize("NFKC").toLocaleLowerCase();
      // Keep Devanagari combining marks attached to their words.
      const tokens = (cleaned.match(/#[\p{L}\p{M}\p{N}_]+|[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu) ?? [])
        .map((token) => ({ value: token.replace(/^#/, "").replace(/[’']/g, ""), hashtag: token.startsWith("#") }));
      const isUseful = (term: string) => !keywordStopWords.has(term) && !/^\d+$/.test(term) && [...term].length > 1;
      const add = (phrase: string, terms: string[], score: number) => {
        const existing = candidates.get(phrase);
        if (existing) {
          existing.score += score * (source.inTitle && !existing.titleMatch ? 1 : 0.12);
          existing.titleMatch ||= source.inTitle;
        } else candidates.set(phrase, { score, terms: new Set(terms), titleMatch: source.inTitle });
      };

      // Use isolated title words only when a short title has too few phrases.
      if (source.inTitle) tokens.forEach(({ value, hashtag }, index) => {
        if (isUseful(value) && [...value].length >= 3) {
          add(value, [value], 2.5 + Math.min([...value].length, 16) * 0.08 + (index < 5 ? 1 : 0) + (hashtag ? 0.7 : 0));
        }
      });

      for (let start = 0; start < tokens.length; start += 1) {
        for (let end = start + 2; end <= Math.min(tokens.length, start + 5); end += 1) {
          let first = start;
          let last = end;
          while (first < last && keywordStopWords.has(tokens[first].value)) first += 1;
          while (last > first && keywordStopWords.has(tokens[last - 1].value)) last -= 1;
          if (last - first < 2) continue;
          const phraseTokens = tokens.slice(first, last);
          const meaningful = phraseTokens.filter(({ value }) => isUseful(value));
          if (meaningful.length < 2 || new Set(meaningful.map(({ value }) => value)).size !== meaningful.length) continue;
          if (meaningful.length / phraseTokens.length < 0.5) continue;

          const phrase = phraseTokens.map(({ value }) => value).join(" ");
          const hashtagBonus = phraseTokens.some(({ hashtag }) => hashtag) ? 0.8 : 0;
          const positionBonus = source.inTitle && first < 6 ? 2 : 0;
          const score = source.weight * (2 + meaningful.length * 1.5) + positionBonus + hashtagBonus + Math.min(phrase.length, 48) * 0.025;
          add(phrase, meaningful.map(({ value }) => value), score);
        }
      }
    }
  }

  const selected: string[] = [];
  const selectedTerms: Set<string>[] = [];
  const ranked = [...candidates.entries()].sort((a, b) =>
    Number(b[1].titleMatch) - Number(a[1].titleMatch) || b[1].score - a[1].score || b[1].terms.size - a[1].terms.size);
  for (const [phrase, candidate] of ranked) {
    const tooSimilar = selectedTerms.some((chosen) => {
      const overlap = [...candidate.terms].filter((term) => chosen.has(term)).length;
      return overlap > 0 && overlap / Math.min(candidate.terms.size, chosen.size) >= 0.8;
    });
    if (tooSimilar) continue;
    selected.push(phrase);
    selectedTerms.push(candidate.terms);
    if (selected.length === 5) break;
  }
  return selected;
}

let keywordQueueRunning = false;
async function processKeywordQueue(): Promise<void> {
  if (keywordQueueRunning) return;
  keywordQueueRunning = true;
  let batch: KeywordSourceVideo[] = [];
  try {
    const candidates = await pool.query<KeywordSourceVideo>(
      `SELECT id::text AS id, COALESCE(video_title, '') AS title, COALESCE(video_description, '') AS description, keyword_status AS status
       FROM video_engagement_snapshots
       WHERE expires_at > NOW() AND keywords_generated_at IS NULL
         AND (keyword_status = 'pending'
           OR keyword_status IN ('needs_transcript', 'transcribing')
           OR (keyword_status = 'processing' AND keyword_updated_at < NOW() - INTERVAL '10 minutes'))
       ORDER BY observed_at DESC
       LIMIT 500`,
      [],
    );
    batch = candidates.rows;
    if (batch.length) {
      await pool.query(
        `UPDATE video_engagement_snapshots SET keyword_status = 'processing', keyword_updated_at = NOW()
         WHERE id = ANY($1::bigint[])`,
        [batch.map((video) => video.id)],
      );
    }
    const updates = batch.map((video) => ({ id: video.id, keywords: localKeywords(video.title, video.description) }));
    await pool.query(
      `UPDATE video_engagement_snapshots AS target
       SET keyword_status = 'ready', keyword_source = 'metadata', keyword_algorithm_version = ${KEYWORD_ALGORITHM_VERSION},
           keywords = ARRAY(SELECT jsonb_array_elements_text(item.keywords)),
           keywords_generated_at = NOW(), keyword_updated_at = NOW()
       FROM jsonb_to_recordset($1::jsonb) AS item(id text, keywords jsonb)
       WHERE target.id = item.id::bigint AND target.expires_at > NOW()`,
      [JSON.stringify(updates)],
    );
  } catch (error) {
    console.error("Keyword generation batch failed:", error instanceof Error ? error.message.slice(0, 200) : "Unknown error");
  } finally {
    keywordQueueRunning = false;
    if (batch.length === 500) setImmediate(() => void processKeywordQueue());
  }
}

app.get(`${apiPrefix}/dashboard/summary`, requireAuthenticated, async (_req, res, next) => {
  try {
    const result = await pool.query(
      `WITH latest_views AS (
         SELECT DISTINCT ON (channel_id) channel_id, views_total, observed_at
         FROM metric_snapshots
         WHERE expires_at > NOW()
         ORDER BY channel_id, observed_at DESC
       ), latest_engagement AS (
         SELECT DISTINCT ON (channel_id, youtube_video_id)
           channel_id, youtube_video_id, views_count, likes_count, comments_count, shares_count
         FROM video_engagement_snapshots
         WHERE expires_at > NOW()
         ORDER BY channel_id, youtube_video_id, observed_at DESC
       )
       SELECT
         (SELECT COUNT(*)::text FROM channels WHERE is_active = TRUE) AS channels,
         COUNT(latest_views.channel_id)::text AS "channelsWithViews",
         (SELECT COUNT(*)::text
          FROM latest_engagement v JOIN channels active_channels ON active_channels.id = v.channel_id
          WHERE active_channels.is_active = TRUE
            AND (v.views_count IS NOT NULL OR v.likes_count IS NOT NULL OR v.comments_count IS NOT NULL OR v.shares_count IS NOT NULL)) AS "videosTracked",
         GREATEST(
           MAX(latest_views.observed_at),
           (SELECT MAX(v.observed_at) FROM video_engagement_snapshots v
            JOIN channels active_channels ON active_channels.id = v.channel_id
            WHERE active_channels.is_active = TRUE AND v.expires_at > NOW())
         ) AS as_of
       FROM channels c
       LEFT JOIN latest_views ON latest_views.channel_id = c.id
       WHERE c.is_active = TRUE`,
    );
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

const analyticsCtes = `
  WITH active_channels AS (
    SELECT id, channel_name, youtube_channel_id, category, state, region, district,
      subscriber_count, youtube_video_count, manual_contact_details, outreach_status
    FROM channels WHERE is_active = TRUE
  ), latest_channel_views AS (
    SELECT DISTINCT ON (channel_id) channel_id, views_total
    FROM metric_snapshots WHERE expires_at > NOW()
    ORDER BY channel_id, observed_at DESC
  ), latest_video_metrics AS (
    SELECT DISTINCT ON (channel_id, youtube_video_id)
      channel_id, youtube_video_id, published_at, views_count, likes_count, comments_count
    FROM video_engagement_snapshots WHERE expires_at > NOW()
    ORDER BY channel_id, youtube_video_id, observed_at DESC
  ), channel_metrics AS (
    SELECT channel_id,
      COUNT(*) FILTER (WHERE views_count IS NOT NULL OR likes_count IS NOT NULL OR comments_count IS NOT NULL) AS video_count,
      COALESCE(SUM(views_count), 0) AS video_views,
      COALESCE(SUM(likes_count), 0) AS likes,
      COALESCE(SUM(comments_count), 0) AS comments,
      CASE WHEN COALESCE(SUM(views_count), 0) > 0
        THEN SUM(likes_count)::numeric * 100 / SUM(views_count) ELSE NULL END AS like_rate
    FROM latest_video_metrics GROUP BY channel_id
  )`;

app.get(`${apiPrefix}/analytics/national`, requireAuthenticated, async (_req, res, next) => {
  try {
    const [summary, states, categories] = await Promise.all([
      pool.query(
        `${analyticsCtes}
         SELECT COUNT(*)::text AS "channelCount",
           COUNT(DISTINCT NULLIF(BTRIM(c.state), ''))::text AS "stateCount",
           COALESCE(SUM(c.subscriber_count), 0)::text AS "subscriberCount",
           COALESCE(SUM(v.views_total), 0)::text AS "channelViews",
           COALESCE(SUM(c.youtube_video_count), 0)::text AS "youtubeVideoCount",
           COALESCE(SUM(m.video_count), 0)::text AS "videosWithEngagement",
           COALESCE(SUM(m.video_views), 0)::text AS "videoViews",
           COALESCE(SUM(m.likes), 0)::text AS likes,
           COALESCE(SUM(m.comments), 0)::text AS comments,
           COALESCE(SUM(m.likes), 0)::numeric * 100 / NULLIF(SUM(m.video_views), 0) AS "likeRate",
           COUNT(*) FILTER (WHERE COALESCE(jsonb_array_length(c.manual_contact_details->'emails'), 0) > 0
             OR COALESCE(jsonb_array_length(c.manual_contact_details->'phones'), 0) > 0)::text AS "directContactChannels",
           COUNT(*) FILTER (WHERE COALESCE(jsonb_array_length(c.manual_contact_details->'socialLinks'), 0) > 0
             OR COALESCE(jsonb_array_length(c.manual_contact_details->'websites'), 0) > 0)::text AS "socialContactChannels",
           COUNT(*) FILTER (WHERE COALESCE(jsonb_array_length(c.manual_contact_details->'emails'), 0) = 0
             AND COALESCE(jsonb_array_length(c.manual_contact_details->'phones'), 0) = 0
             AND COALESCE(jsonb_array_length(c.manual_contact_details->'socialLinks'), 0) = 0
             AND COALESCE(jsonb_array_length(c.manual_contact_details->'websites'), 0) = 0)::text AS "channelsWithoutContacts",
           COUNT(*) FILTER (WHERE c.outreach_status = 'not_contacted')::text AS "outreachNotContacted",
           COUNT(*) FILTER (WHERE c.outreach_status = 'contacted')::text AS "outreachContacted",
           COUNT(*) FILTER (WHERE c.outreach_status = 'responded')::text AS "outreachResponded",
           COUNT(*) FILTER (WHERE c.outreach_status = 'partner')::text AS "outreachPartner",
           COUNT(*) FILTER (WHERE c.outreach_status = 'not_interested')::text AS "outreachNotInterested",
           COUNT(*) FILTER (WHERE c.outreach_status IS NULL)::text AS "outreachUntracked",
           (SELECT COUNT(*)::text FROM latest_video_metrics video
            JOIN active_channels active ON active.id = video.channel_id
            WHERE video.published_at >= NOW() - INTERVAL '30 days') AS "recentUploadsCollected"
         FROM active_channels c
         LEFT JOIN latest_channel_views v ON v.channel_id = c.id
         LEFT JOIN channel_metrics m ON m.channel_id = c.id`,
      ),
      pool.query(
        `${analyticsCtes}
         SELECT c.state, COUNT(*)::text AS "channelCount",
           COALESCE(SUM(c.subscriber_count), 0)::text AS "subscriberCount",
           COALESCE(SUM(v.views_total), 0)::text AS "channelViews",
           COALESCE(SUM(c.youtube_video_count), 0)::text AS "youtubeVideoCount",
           COUNT(*) FILTER (WHERE COALESCE(jsonb_array_length(c.manual_contact_details->'emails'), 0) > 0
             OR COALESCE(jsonb_array_length(c.manual_contact_details->'phones'), 0) > 0
             OR COALESCE(jsonb_array_length(c.manual_contact_details->'socialLinks'), 0) > 0
             OR COALESCE(jsonb_array_length(c.manual_contact_details->'websites'), 0) > 0)::text AS "contactChannels",
           (SELECT COUNT(*)::text FROM latest_video_metrics recent_video
            JOIN active_channels recent_channel ON recent_channel.id = recent_video.channel_id
            WHERE LOWER(BTRIM(recent_channel.state)) = LOWER(BTRIM(c.state))
              AND recent_video.published_at >= NOW() - INTERVAL '30 days') AS "recentUploadsCollected",
           COALESCE(SUM(m.video_count), 0)::text AS "videosWithEngagement",
           COALESCE(SUM(m.video_views), 0)::text AS "videoViews",
           COALESCE(SUM(m.likes), 0)::text AS likes,
           COALESCE(SUM(m.comments), 0)::text AS comments,
           COUNT(*) FILTER (WHERE m.like_rate >= 4)::text AS "highEngagement",
           COUNT(*) FILTER (WHERE m.like_rate >= 2 AND m.like_rate < 4)::text AS "goodEngagement",
           COUNT(*) FILTER (WHERE m.like_rate >= 1 AND m.like_rate < 2)::text AS "averageEngagement",
           COUNT(*) FILTER (WHERE m.like_rate < 1)::text AS "lowEngagement",
           COUNT(*) FILTER (WHERE m.like_rate IS NULL)::text AS "notMeasured"
         FROM active_channels c
         LEFT JOIN latest_channel_views v ON v.channel_id = c.id
         LEFT JOIN channel_metrics m ON m.channel_id = c.id
         GROUP BY c.state ORDER BY SUM(v.views_total) DESC NULLS LAST, c.state`,
      ),
      pool.query(
        `${analyticsCtes}
         SELECT c.category, COUNT(*)::text AS "channelCount",
           COALESCE(SUM(c.subscriber_count), 0)::text AS "subscriberCount",
           COALESCE(SUM(v.views_total), 0)::text AS "channelViews",
           COUNT(*) FILTER (WHERE COALESCE(jsonb_array_length(c.manual_contact_details->'emails'), 0) > 0
             OR COALESCE(jsonb_array_length(c.manual_contact_details->'phones'), 0) > 0
             OR COALESCE(jsonb_array_length(c.manual_contact_details->'socialLinks'), 0) > 0
             OR COALESCE(jsonb_array_length(c.manual_contact_details->'websites'), 0) > 0)::text AS "contactChannels"
         FROM active_channels c
         LEFT JOIN latest_channel_views v ON v.channel_id = c.id
         GROUP BY c.category ORDER BY COUNT(*) DESC, c.category`,
      ),
    ]);
    res.json({ summary: summary.rows[0], states: states.rows, categories: categories.rows });
  } catch (error) {
    next(error);
  }
});

app.get(`${apiPrefix}/analytics/states/:state`, requireAuthenticated, async (req, res, next) => {
  try {
    const state = requiredText(req.params.state, "State", 120);
    const isUnspecifiedLocation = state === "__unspecified_state__";
    const statePredicate = (alias: string) => isUnspecifiedLocation
      ? `NULLIF(BTRIM(${alias}.state), '') IS NULL`
      : `LOWER(BTRIM(${alias}.state)) = LOWER(BTRIM($1))`;
    const stateQueryParams = isUnspecifiedLocation ? [] : [state];
    const [summary, districts, categories, engagementDistribution] = await Promise.all([
      pool.query(
        `${analyticsCtes}
         SELECT COUNT(*)::text AS "channelCount",
           (COUNT(DISTINCT LOWER(NULLIF(BTRIM(c.district), ''))) FILTER (
             WHERE NULLIF(BTRIM(c.district), '') IS NOT NULL
               AND LOWER(BTRIM(c.district)) NOT IN ('state-wide / not stated', 'district not specified', 'not specified', 'n/a', 'na', '-', '—')
           ))::text AS "districtsRepresented",
           COUNT(*) FILTER (WHERE NULLIF(BTRIM(c.district), '') IS NULL
             OR LOWER(BTRIM(c.district)) IN ('state-wide / not stated', 'district not specified', 'not specified', 'n/a', 'na', '-', '—'))::text AS "channelsMissingDistrict",
           COALESCE(SUM(c.subscriber_count), 0)::text AS "subscriberCount",
           COALESCE(SUM(v.views_total), 0)::text AS "channelViews",
           COALESCE(SUM(c.youtube_video_count), 0)::text AS "youtubeVideoCount",
           COALESCE(SUM(m.video_count), 0)::text AS "videosWithEngagement",
           COALESCE(SUM(m.video_views), 0)::text AS "videoViews",
           COALESCE(SUM(m.likes), 0)::text AS likes,
           COALESCE(SUM(m.comments), 0)::text AS comments,
           COALESCE(SUM(m.likes), 0)::numeric * 100 / NULLIF(SUM(m.video_views), 0) AS "likeRate",
           (SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (
              ORDER BY video.likes_count::double precision * 100.0 / video.views_count
            )::text
            FROM latest_video_metrics video
            JOIN active_channels metric_channels ON metric_channels.id = video.channel_id
            WHERE ${statePredicate("metric_channels")}
              AND video.views_count > 0 AND video.likes_count IS NOT NULL) AS "medianLikeRate",
           COUNT(*) FILTER (WHERE COALESCE(jsonb_array_length(c.manual_contact_details->'emails'), 0) > 0
             OR COALESCE(jsonb_array_length(c.manual_contact_details->'phones'), 0) > 0)::text AS "directContactChannels",
           COUNT(*) FILTER (WHERE COALESCE(jsonb_array_length(c.manual_contact_details->'socialLinks'), 0) > 0
             OR COALESCE(jsonb_array_length(c.manual_contact_details->'websites'), 0) > 0)::text AS "socialContactChannels",
           COUNT(*) FILTER (WHERE COALESCE(jsonb_array_length(c.manual_contact_details->'emails'), 0) = 0
             AND COALESCE(jsonb_array_length(c.manual_contact_details->'phones'), 0) = 0
             AND COALESCE(jsonb_array_length(c.manual_contact_details->'socialLinks'), 0) = 0
             AND COALESCE(jsonb_array_length(c.manual_contact_details->'websites'), 0) = 0)::text AS "channelsWithoutContacts",
           (SELECT COUNT(*)::text FROM latest_video_metrics video
            JOIN active_channels video_channel ON video_channel.id = video.channel_id
            WHERE ${statePredicate("video_channel")}
              AND video.published_at >= NOW() - INTERVAL '30 days') AS "recentUploadsCollected",
           (SELECT COUNT(*)::text FROM active_channels known_channel
            WHERE ${statePredicate("known_channel")}
              AND EXISTS (SELECT 1 FROM latest_video_metrics known_video
                          WHERE known_video.channel_id = known_channel.id AND known_video.published_at IS NOT NULL)
              AND NOT EXISTS (SELECT 1 FROM latest_video_metrics recent_video
                              WHERE recent_video.channel_id = known_channel.id
                                AND recent_video.published_at >= NOW() - INTERVAL '30 days')) AS "channelsWithoutRecentUploads",
           ARRAY(SELECT known_channel.id::text FROM active_channels known_channel
            WHERE ${statePredicate("known_channel")}
              AND EXISTS (SELECT 1 FROM latest_video_metrics known_video
                          WHERE known_video.channel_id = known_channel.id AND known_video.published_at IS NOT NULL)
              AND NOT EXISTS (SELECT 1 FROM latest_video_metrics recent_video
                              WHERE recent_video.channel_id = known_channel.id
                                AND recent_video.published_at >= NOW() - INTERVAL '30 days')) AS "channelsWithoutRecentUploadsIds"
         FROM active_channels c
         LEFT JOIN latest_channel_views v ON v.channel_id = c.id
         LEFT JOIN channel_metrics m ON m.channel_id = c.id
         WHERE ${statePredicate("c")}`, stateQueryParams,
      ),
      pool.query(
        `${analyticsCtes}
         SELECT CASE WHEN NULLIF(BTRIM(c.district), '') IS NULL
               OR LOWER(BTRIM(c.district)) IN ('state-wide / not stated', 'district not specified', 'not specified', 'n/a', 'na', '-', '—')
             THEN 'District not specified' ELSE BTRIM(c.district) END AS district,
           COUNT(*)::text AS "channelCount",
           COALESCE(SUM(c.subscriber_count), 0)::text AS "subscriberCount",
           COALESCE(SUM(v.views_total), 0)::text AS "channelViews",
           COALESCE(SUM(m.video_count), 0)::text AS "videosWithEngagement",
           COALESCE(SUM(m.video_views), 0)::text AS "videoViews",
           COALESCE(SUM(m.likes), 0)::text AS likes,
           COALESCE(SUM(m.comments), 0)::text AS comments
         FROM active_channels c
         LEFT JOIN latest_channel_views v ON v.channel_id = c.id
         LEFT JOIN channel_metrics m ON m.channel_id = c.id
         WHERE ${statePredicate("c")}
         GROUP BY 1 ORDER BY COUNT(*) DESC, district`, stateQueryParams,
      ),
      pool.query(
        `${analyticsCtes}
         SELECT c.category, COUNT(*)::text AS "channelCount",
           COALESCE(SUM(c.subscriber_count), 0)::text AS "subscriberCount",
           COALESCE(SUM(v.views_total), 0)::text AS "channelViews"
         FROM active_channels c
         LEFT JOIN latest_channel_views v ON v.channel_id = c.id
         WHERE ${statePredicate("c")}
         GROUP BY c.category ORDER BY COUNT(*) DESC, c.category`, stateQueryParams,
      ),
      pool.query(
        `${analyticsCtes}
         SELECT CASE
             WHEN m.like_rate IS NULL THEN 'Not measured'
             WHEN m.like_rate >= 4 THEN 'High (4+)'
             WHEN m.like_rate >= 2 THEN 'Good (2–4)'
             WHEN m.like_rate >= 1 THEN 'Average (1–2)'
             ELSE 'Low (<1)'
           END AS level,
           COUNT(*)::text AS "channelCount"
         FROM active_channels c
         LEFT JOIN channel_metrics m ON m.channel_id = c.id
         WHERE ${statePredicate("c")}
         GROUP BY 1
         ORDER BY MIN(CASE WHEN m.like_rate >= 4 THEN 1 WHEN m.like_rate >= 2 THEN 2
           WHEN m.like_rate >= 1 THEN 3 WHEN m.like_rate < 1 THEN 4 ELSE 5 END)`, stateQueryParams,
      ),
    ]);
    if (!Number(summary.rows[0]?.channelCount)) {
      res.status(404).json({ error: `No channels are registered for ${isUnspecifiedLocation ? "Location not specified" : state}.` });
      return;
    }
    res.json({ state: isUnspecifiedLocation ? "Location not specified" : state, summary: summary.rows[0], districts: districts.rows, categories: categories.rows, engagementDistribution: engagementDistribution.rows });
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.get(`${apiPrefix}/channels`, requireAuthenticated, async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
         c.id, c.youtube_channel_id AS "youtubeChannelId", c.channel_name AS "channelName",
         c.category, c.state, c.region, c.district, c.subscriber_count::text AS "subscriberCount", c.is_active AS "isActive",
         c.outreach_status AS "outreachStatus",
         COALESCE(c.manual_contact_details, '{"emails": [], "phones": [], "socialLinks": [], "websites": []}'::jsonb) AS "contactDetails",
         COALESCE(jsonb_array_length(c.manual_contact_details->'emails'), 0)::text AS "emailCount",
         COALESCE(jsonb_array_length(c.manual_contact_details->'phones'), 0)::text AS "phoneCount",
         COALESCE(jsonb_array_length(c.manual_contact_details->'socialLinks'), 0)::text AS "socialLinkCount",
         COALESCE(jsonb_array_length(c.manual_contact_details->'websites'), 0)::text AS "websiteCount",
         c.created_at AS "createdAt",
         v.views_total::text AS "viewsTotal", v.observed_at AS "viewsObservedAt",
         e.video_count::text AS "videosTracked", e.video_views AS "videoViews", e.likes,
         e."engagementRate", e."medianEngagementRate",
         e.observed_at AS "engagementObservedAt"
       FROM channels c
       LEFT JOIN LATERAL (
         SELECT views_total, observed_at
         FROM metric_snapshots
         WHERE channel_id = c.id AND expires_at > NOW()
         ORDER BY observed_at DESC LIMIT 1
       ) v ON TRUE
       LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE latest.views_count IS NOT NULL OR latest.likes_count IS NOT NULL
             OR latest.comments_count IS NOT NULL OR latest.shares_count IS NOT NULL) AS video_count,
             MAX(latest.observed_at) AS observed_at,
             COALESCE(SUM(latest.views_count), 0)::text AS video_views,
             COALESCE(SUM(latest.likes_count), 0)::text AS likes,
             CASE WHEN COALESCE(SUM(latest.views_count), 0) > 0
               THEN SUM(latest.likes_count)::numeric * 100 / SUM(latest.views_count) END AS "engagementRate",
          (PERCENTILE_CONT(0.5) WITHIN GROUP (
            ORDER BY latest.likes_count::double precision * 100.0 / NULLIF(latest.views_count, 0)
          ) FILTER (WHERE latest.views_count > 0 AND latest.likes_count IS NOT NULL))::text AS "medianEngagementRate"
         FROM (
           SELECT DISTINCT ON (youtube_video_id) youtube_video_id, views_count, likes_count,
             comments_count, shares_count, observed_at
           FROM video_engagement_snapshots
           WHERE channel_id = c.id AND expires_at > NOW()
           ORDER BY youtube_video_id, observed_at DESC
         ) latest
       ) e ON TRUE
       WHERE c.is_active = TRUE
       ORDER BY c.channel_name ASC`,
    );
    res.json({ channels: result.rows });
  } catch (error) {
    next(error);
  }
});

app.patch(`${apiPrefix}/channels/:id/outreach-status`, requireAdmin, async (req, res, next) => {
  try {
    const requestedStatus = req.body?.status;
    const outreachStatus = requestedStatus === "not_tracked" ? null : requiredText(requestedStatus, "Outreach status", 40);
    const allowedStatuses = new Set(["not_contacted", "contacted", "responded", "partner", "not_interested"]);
    if (outreachStatus !== null && !allowedStatuses.has(outreachStatus)) {
      res.status(400).json({ error: "Choose a valid outreach status." });
      return;
    }
    const result = await pool.query(
      `UPDATE channels SET outreach_status = $2, updated_at = NOW()
       WHERE id = $1::uuid AND is_active = TRUE
       RETURNING id, outreach_status AS "outreachStatus"`,
      [req.params.id, outreachStatus],
    );
    if (!result.rowCount) {
      res.status(404).json({ error: "Channel not found." });
      return;
    }
    res.json({ channel: result.rows[0] });
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.get(`${apiPrefix}/channels/:id/profile`, requireAuthenticated, async (req, res, next) => {
  try {
    const [channelResult, videosResult] = await Promise.all([
      pool.query(
        `SELECT c.id, c.youtube_channel_id AS "youtubeChannelId", c.channel_name AS "channelName",
           c.youtube_title AS "youtubeTitle", c.category, c.state, c.region, c.district,
           c.description, c.channel_published_at AS "channelPublishedAt",
           c.subscriber_count::text AS "subscriberCount", c.subscribers_hidden AS "subscribersHidden",
           c.youtube_video_count::text AS "youtubeVideoCount", c.profile_observed_at AS "profileObservedAt",
           COALESCE(c.manual_contact_details, '{"emails": [], "phones": [], "socialLinks": [], "websites": []}'::jsonb) AS "contactDetails",
           CASE WHEN c.manual_contact_details IS NOT NULL THEN 'manual' ELSE NULL END AS "contactDetailsSource",
           c.manual_contact_details_observed_at AS "contactDetailsObservedAt",
           c.created_at AS "createdAt", v.views_total::text AS "viewsTotal",
           v.observed_at AS "viewsObservedAt", e.video_count::text AS "videosTracked"
         FROM channels c
         LEFT JOIN LATERAL (
           SELECT views_total, observed_at FROM metric_snapshots
           WHERE channel_id = c.id AND expires_at > NOW()
           ORDER BY observed_at DESC LIMIT 1
         ) v ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE latest.views_count IS NOT NULL OR latest.likes_count IS NOT NULL
             OR latest.comments_count IS NOT NULL OR latest.shares_count IS NOT NULL) AS video_count
           FROM (
             SELECT DISTINCT ON (youtube_video_id) youtube_video_id, views_count, likes_count,
               comments_count, shares_count, observed_at
             FROM video_engagement_snapshots
             WHERE channel_id = c.id AND expires_at > NOW()
             ORDER BY youtube_video_id, observed_at DESC
           ) latest
         ) e ON TRUE
         WHERE c.id = $1::uuid AND c.is_active = TRUE`,
        [req.params.id],
      ),
      pool.query(
        `WITH latest AS (
           SELECT DISTINCT ON (youtube_video_id)
             youtube_video_id, video_title, keywords, published_at, is_short, views_count, likes_count,
             comments_count, shares_count, observed_at
           FROM video_engagement_snapshots
           WHERE channel_id = $1::uuid AND expires_at > NOW()
           ORDER BY youtube_video_id, observed_at DESC
         )
         SELECT youtube_video_id AS "youtubeVideoId", video_title AS "videoTitle",
           keywords,
           published_at AS "publishedAt", is_short AS "isShort", views_count::text AS "viewsCount",
           likes_count::text AS "likesCount", comments_count::text AS "commentsCount",
           shares_count::text AS "sharesCount", observed_at AS "observedAt"
         FROM latest
         ORDER BY published_at DESC NULLS LAST, observed_at DESC
         LIMIT 200`,
        [req.params.id],
      ),
    ]);
    if (!channelResult.rowCount) {
      res.status(404).json({ error: "Channel not found." });
      return;
    }
    res.json({ channel: channelResult.rows[0], videos: videosResult.rows });
  } catch (error) {
    next(error);
  }
});

app.patch(`${apiPrefix}/channels/:id/contact-details`, requireAdmin, async (req, res, next) => {
  try {
    if (!validContactDetails(req.body)) throw new ValidationError("Enter contact details using the provided fields.");
    const details = normalizeContactDetails(req.body);
    const result = await pool.query(
      `UPDATE channels
       SET manual_contact_details = $2::jsonb, manual_contact_details_observed_at = NOW(), updated_at = NOW()
       WHERE id = $1::uuid AND is_active = TRUE
       RETURNING id`,
      [req.params.id, JSON.stringify(details)],
    );
    if (!result.rowCount) {
      res.status(404).json({ error: "Channel not found." });
      return;
    }
    res.json({ contactDetails: details, contactDetailsSource: "manual" });
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.delete(`${apiPrefix}/channels/:id`, requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const deleted = await client.query<{ id: string; channel_name: string }>(
      "DELETE FROM channels WHERE id = $1::uuid RETURNING id, channel_name",
      [req.params.id],
    );
    if (!deleted.rowCount) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Channel not found." });
      return;
    }
    const { id, channel_name: channelName } = deleted.rows[0];
    await client.query(
      `WITH changed_jobs AS (
         UPDATE collection_jobs
         SET channel_ids = array_remove(channel_ids, $1::uuid),
             channels_total = CASE WHEN $1::uuid = ANY(channel_ids) THEN GREATEST(channels_total - 1, 0) ELSE channels_total END,
             channels_completed = CASE WHEN $1::uuid = ANY(channel_ids)
               THEN LEAST(channels_completed, GREATEST(channels_total - 1, 0)) ELSE channels_completed END,
             error_summary = CASE WHEN error_summary IS NULL THEN NULL ELSE NULLIF(BTRIM(
               replace(replace(error_summary, $1::text, '[deleted channel]'), $2, '[deleted channel]')
             ), '') END
         WHERE $1::uuid = ANY(channel_ids)
            OR error_summary LIKE '%' || $1::text || '%'
            OR error_summary LIKE '%' || $2 || '%'
         RETURNING id, cardinality(channel_ids) AS channels_remaining, status
       )
       UPDATE collection_jobs AS jobs
       SET status = 'failed', error_summary = COALESCE(jobs.error_summary, 'The channel was deleted before collection finished.'),
           finished_at = NOW()
       FROM changed_jobs
       WHERE jobs.id = changed_jobs.id AND changed_jobs.channels_remaining = 0
         AND changed_jobs.status IN ('queued', 'running')`,
      [id, channelName],
    );
    await client.query("COMMIT");
    res.status(204).send();
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

const importCategories = new Map([
  ["news & politics", "News & Politics"],
  ["news and politics", "News & Politics"],
  ["infotainment", "Infotainment"],
  ["people & blog", "People & Blog"],
  ["people & blogs", "People & Blog"],
]);

type KnownLocation = { state: string; district: string | null };

const indiaLocations = new Map<string, string>([
  ["andhrapradesh", "Andhra Pradesh"], ["arunachalpradesh", "Arunachal Pradesh"],
  ["assam", "Assam"], ["bihar", "Bihar"], ["chhattisgarh", "Chhattisgarh"],
  ["goa", "Goa"], ["gujarat", "Gujarat"], ["haryana", "Haryana"],
  ["himachalpradesh", "Himachal Pradesh"], ["jharkhand", "Jharkhand"],
  ["karnataka", "Karnataka"], ["kerala", "Kerala"], ["madhyapradesh", "Madhya Pradesh"],
  ["maharashtra", "Maharashtra"], ["manipur", "Manipur"], ["meghalaya", "Meghalaya"],
  ["mizoram", "Mizoram"], ["nagaland", "Nagaland"], ["odisha", "Odisha"], ["orissa", "Odisha"],
  ["punjab", "Punjab"], ["rajasthan", "Rajasthan"], ["sikkim", "Sikkim"],
  ["tamilnadu", "Tamil Nadu"], ["telangana", "Telangana"], ["tripura", "Tripura"],
  ["uttarpradesh", "Uttar Pradesh"], ["uttarakhand", "Uttarakhand"],
  ["uttrakhand", "Uttarakhand"], ["uttaranchal", "Uttarakhand"], ["westbengal", "West Bengal"],
  ["andamanandnicobarislands", "Andaman and Nicobar Islands"],
  ["andamannicobarislands", "Andaman and Nicobar Islands"], ["andamanandnicobar", "Andaman and Nicobar Islands"],
  ["andamannicobar", "Andaman and Nicobar Islands"], ["anislands", "Andaman and Nicobar Islands"],
  ["chandigarh", "Chandigarh"],
  ["dadranagarhavelianddamananddiu", "Dadra and Nagar Haveli and Daman and Diu"],
  ["dadranagarhavelianddamandiu", "Dadra and Nagar Haveli and Daman and Diu"],
  ["dadranagarhaveli", "Dadra and Nagar Haveli and Daman and Diu"],
  ["damananddiu", "Dadra and Nagar Haveli and Daman and Diu"],
  ["delhi", "Delhi"], ["nctdelhi", "Delhi"], ["nctofdelhi", "Delhi"], ["nationalcapitalterritoryofdelhi", "Delhi"],
  ["jammuandkashmir", "Jammu and Kashmir"], ["jammukashmir", "Jammu and Kashmir"], ["jk", "Jammu and Kashmir"],
  ["ladakh", "Ladakh"], ["lakshadweep", "Lakshadweep"], ["puducherry", "Puducherry"], ["pondicherry", "Puducherry"],
]);

function normalizedPlaceKey(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizedStateKey(value: string): string {
  const key = normalizedPlaceKey(value);
  if (["uttrakhand", "uttaranchal"].includes(key)) return "uttarakhand";
  return key;
}

function cleanDistrict(value: string): string {
  return value.replace(/\s*\(from videos\)\s*$/i, "").trim().replace(/\s+/g, " ");
}

function canonicalStateName(value: string, locations: KnownLocation[]): string {
  const key = normalizedStateKey(value);
  const indiaName = indiaLocations.get(key);
  if (indiaName) return indiaName;
  const known = locations.find((location) => normalizedStateKey(location.state) === key)?.state;
  if (known) return known;
  if (key === "uttarakhand") return "Uttarakhand";
  return value.trim().replace(/\s+/g, " ");
}

function canonicalDistrictName(value: string | null, state: string, locations: KnownLocation[]): string | null {
  if (!value) return null;
  const cleaned = cleanDistrict(value);
  if (!cleaned) return null;
  const key = normalizedPlaceKey(cleaned);
  const known = locations.find((location) => normalizedStateKey(location.state) === normalizedStateKey(state) &&
    location.district && normalizedPlaceKey(cleanDistrict(location.district)) === key)?.district;
  return known ? cleanDistrict(known) : cleaned;
}

app.post(`${apiPrefix}/channels/bulk-import`, requireAdmin, async (req, res, next) => {
  const rows: unknown = req.body?.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    res.status(400).json({ error: "The spreadsheet does not contain any data rows." });
    return;
  }
  if (rows.length > 2000) {
    res.status(413).json({ error: "Import up to 2,000 rows at a time." });
    return;
  }

  const rejected: Array<{ row: number; reason: string }> = [];
  const client = await pool.connect();
  let inserted = 0;
  let updated = 0;
  let duplicates = 0;
  const importedIds = new Set<string>();
  try {
    await client.query("BEGIN");
    const locationResult = await client.query<KnownLocation>(
      "SELECT DISTINCT state, district FROM channels WHERE is_active = TRUE",
    );
  const knownLocations = [...locationResult.rows];
    for (const [index, value] of rows.entries()) {
      const rowNumber = index + 2;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        rejected.push({ row: rowNumber, reason: "The row is not a valid record." });
        continue;
      }
      const row = value as Record<string, unknown>;
      let channelName: string;
      let youtubeChannelId: string;
      let category: string;
      let state: string;
      let region: string | null;
      let district: string | null;
      try {
        channelName = requiredText(row.channelName, "Channel name");
        youtubeChannelId = requiredText(row.youtubeChannelId, "Channel ID", 120);
        const categoryText = requiredText(row.category, "Category", 120);
        const normalizedCategory = importCategories.get(categoryText.toLocaleLowerCase().replace(/\s+/g, " "));
        if (!normalizedCategory) {
          rejected.push({ row: rowNumber, reason: "Category must be News & Politics, Infotainment, or People & Blog." });
          continue;
        }
        category = normalizedCategory;
        const rawState = optionalText(row.state, "State", 120) || "";
        state = rawState ? canonicalStateName(rawState, knownLocations) : "";
        region = optionalText(row.region, "Regional area", 120);
        district = canonicalDistrictName(optionalText(row.district, "District", 120), state, knownLocations);
      } catch (error) {
        rejected.push({ row: rowNumber, reason: error instanceof Error ? error.message : "A required field is missing." });
        continue;
      }

      if (importedIds.has(youtubeChannelId)) duplicates += 1;
      importedIds.add(youtubeChannelId);

      const contactLineItems = (input: unknown) => typeof input === "string"
        ? input.split(/[\n;,]+/).map((item) => item.trim()).filter(Boolean)
        : [];
      const contacts = {
        emails: contactLineItems(row.emails),
        phones: contactLineItems(row.phones),
        socialLinks: contactLineItems(row.socialLinks).map((item) => {
          const [platform, ...rest] = item.split("|");
          return { platform: rest.length ? platform.trim() : "Social link", url: (rest.length ? rest.join("|") : platform).trim() };
        }),
        websites: contactLineItems(row.websites).map((item) => {
          const [name, ...rest] = item.split("|");
          return { name: rest.length ? name.trim() : "Website", url: (rest.length ? rest.join("|") : name).trim() };
        }),
      };
      const hasContacts = Object.values(contacts).some((items) => items.length > 0);
      const contactJson = hasContacts ? JSON.stringify(normalizeContactDetails(contacts)) : null;
      const result = await client.query(
        `INSERT INTO channels (id, youtube_channel_id, channel_name, category, state, region, district, manual_contact_details, manual_contact_details_observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::jsonb, '{"emails":[],"phones":[],"socialLinks":[],"websites":[]}'::jsonb), CASE WHEN $8::jsonb IS NULL THEN NULL ELSE NOW() END)
         ON CONFLICT (youtube_channel_id) DO UPDATE SET
           channel_name = EXCLUDED.channel_name,
           category = EXCLUDED.category,
           state = CASE WHEN EXCLUDED.state = '' THEN channels.state ELSE EXCLUDED.state END,
           region = EXCLUDED.region,
           district = CASE WHEN EXCLUDED.state = '' THEN channels.district ELSE EXCLUDED.district END,
           manual_contact_details = CASE WHEN $8::jsonb IS NULL THEN channels.manual_contact_details ELSE $8::jsonb END,
           manual_contact_details_observed_at = CASE WHEN $8::jsonb IS NULL THEN channels.manual_contact_details_observed_at ELSE NOW() END,
           updated_at = NOW()
         RETURNING (xmax = 0) AS inserted`,
        [randomUUID(), youtubeChannelId, channelName, category, state, region, district, contactJson],
      );
      if (state && !knownLocations.some((location) => normalizedStateKey(location.state) === normalizedStateKey(state) &&
        normalizedPlaceKey(cleanDistrict(location.district || "")) === normalizedPlaceKey(cleanDistrict(district || "")))) {
        knownLocations.push({ state, district });
      }
      if (result.rows[0]?.inserted) inserted += 1;
      else updated += 1;
    }
    await client.query("COMMIT");
    res.status(200).json({
      inserted,
      skipped: rejected.length,
      duplicates,
      updated,
      rejected,
      additionalRejected: 0,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

app.post(`${apiPrefix}/channels`, requireAdmin, async (req, res, next) => {
  try {
    const channelName = requiredText(req.body?.channelName, "Channel name");
    const youtubeChannelId = requiredText(req.body?.youtubeChannelId, "YouTube channel ID", 120);
    const category = requiredText(req.body?.category, "Category", 120);
    const rawState = optionalText(req.body?.state, "State", 120) || "";
    const region = optionalText(req.body?.region, "Regional", 120);
    const rawDistrict = optionalText(req.body?.district, "District", 120);
    const locationResult = await pool.query<KnownLocation>("SELECT DISTINCT state, district FROM channels WHERE is_active = TRUE");
    const state = rawState ? canonicalStateName(rawState, locationResult.rows) : "";
    const district = canonicalDistrictName(rawDistrict, state, locationResult.rows);
    const id = randomUUID();
    const result = await pool.query(
      `INSERT INTO channels (id, youtube_channel_id, channel_name, category, state, region, district)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, youtube_channel_id AS "youtubeChannelId", channel_name AS "channelName",
         category, state, region, district, created_at AS "createdAt"`,
      [id, youtubeChannelId, channelName, category, state, region, district],
    );
    res.status(201).json({ channel: result.rows[0] });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      res.status(409).json({ error: "That YouTube channel ID is already in the dashboard." });
      return;
    }
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.get(`${apiPrefix}/channels/:id/trends`, requireAuthenticated, async (req, res, next) => {
  try {
    const interval = req.query.interval === "monthly" ? "monthly" : "daily";
    const bucketExpression = interval === "monthly" ? "date_trunc('month', observed_at)" : "date_trunc('day', observed_at)";
    const periodFormat = interval === "monthly" ? "YYYY-MM" : "YYYY-MM-DD";
    const result = await pool.query(
      `WITH view_bounds AS (
         SELECT ${bucketExpression} AS period,
           (array_agg(views_total ORDER BY observed_at DESC))[1] AS latest_views,
           (array_agg(views_total ORDER BY observed_at ASC))[1] AS earliest_views
         FROM metric_snapshots
         WHERE channel_id = $1::uuid AND expires_at > NOW()
         GROUP BY ${bucketExpression}
       ), view_series AS (
         SELECT period, latest_views, earliest_views,
           LAG(latest_views) OVER (ORDER BY period) AS prior_period_views
         FROM view_bounds
       ), view_growth AS (
         SELECT period,
           latest_views AS views_total,
           GREATEST(latest_views - COALESCE(prior_period_views, earliest_views), 0) AS views_gained
         FROM view_series
       ), video_snapshots AS (
         SELECT DISTINCT ON (${bucketExpression}, youtube_video_id)
           ${bucketExpression} AS period, youtube_video_id, likes_count, comments_count
         FROM video_engagement_snapshots
         WHERE channel_id = $1::uuid AND expires_at > NOW()
         ORDER BY ${bucketExpression}, youtube_video_id, observed_at DESC
       ), engagement AS (
         SELECT period,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY likes_count) FILTER (WHERE likes_count IS NOT NULL) AS median_likes,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY comments_count) FILTER (WHERE comments_count IS NOT NULL) AS median_comments
         FROM video_snapshots
         GROUP BY period
       )
       SELECT to_char(COALESCE(view_growth.period, engagement.period), '${periodFormat}') AS period,
         view_growth.views_total::text AS "viewsTotal",
         view_growth.views_gained::text AS "viewsGained",
         engagement.median_likes::text AS "medianLikes",
         engagement.median_comments::text AS "medianComments"
       FROM view_growth
       FULL OUTER JOIN engagement USING (period)
       ORDER BY period ASC`,
      [req.params.id],
    );
    res.json({ trends: result.rows });
  } catch (error) {
    next(error);
  }
});

app.get(`${apiPrefix}/videos/engagement`, requireAuthenticated, async (_req, res, next) => {
  try {
    const result = await pool.query(
      `WITH latest AS (
         SELECT DISTINCT ON (channel_id, youtube_video_id)
           channel_id, youtube_video_id, video_title, published_at, likes_count,
           comments_count, shares_count, observed_at
         FROM video_engagement_snapshots
         WHERE expires_at > NOW()
         ORDER BY channel_id, youtube_video_id, observed_at DESC
       )
       SELECT c.channel_name AS "channelName", c.id AS "channelId",
         latest.youtube_video_id AS "youtubeVideoId", latest.video_title AS "videoTitle",
         latest.published_at AS "publishedAt", latest.likes_count::text AS "likesCount",
         latest.comments_count::text AS "commentsCount", latest.shares_count::text AS "sharesCount",
         latest.observed_at AS "observedAt"
       FROM latest JOIN channels c ON c.id = latest.channel_id
       WHERE c.is_active = TRUE
       ORDER BY latest.published_at DESC NULLS LAST, latest.observed_at DESC
       LIMIT 20`,
    );
    res.json({ videos: result.rows });
  } catch (error) {
    next(error);
  }
});

app.get(`${apiPrefix}/keywords/export`, requireAuthenticated, async (req, res, next) => {
  try {
    const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : "";
    if (!query) throw new ValidationError("Enter a title, description, or video link before exporting.");
    let youtubeVideoId: string | null = null;
    try {
      const parsed = new URL(query);
      const candidate = parsed.hostname === "youtu.be"
        ? parsed.pathname.split("/").filter(Boolean)[0]
        : parsed.searchParams.get("v") || parsed.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1] || null;
      if (candidate && /^[\w-]{11}$/.test(candidate)) youtubeVideoId = candidate;
    } catch {
      if (/^[\w-]{11}$/.test(query)) youtubeVideoId = query;
    }
    const result = await pool.query(
      `WITH latest AS (
         SELECT DISTINCT ON (channel_id, youtube_video_id)
           channel_id, youtube_video_id, video_title, video_description, published_at
         FROM video_engagement_snapshots
         WHERE expires_at > NOW()
         ORDER BY channel_id, youtube_video_id, observed_at DESC
       )
       SELECT c.id AS "channelId", c.channel_name AS "channelName",
         latest.youtube_video_id AS "youtubeVideoId", latest.video_title AS "videoTitle",
         latest.video_description AS "videoDescription",
         latest.published_at AS "publishedAt",
         CASE WHEN latest.youtube_video_id = $2 THEN 'Video link'
           WHEN strpos(lower(COALESCE(latest.video_title, '')), lower($1)) > 0 THEN 'Video title'
           ELSE 'Video description' END AS "matchedIn"
       FROM latest JOIN channels c ON c.id = latest.channel_id
       WHERE c.is_active = TRUE AND (
         strpos(lower(COALESCE(latest.video_title, '')), lower($1)) > 0
         OR strpos(lower(COALESCE(latest.video_description, '')), lower($1)) > 0
         OR ($2::text IS NOT NULL AND latest.youtube_video_id = $2)
       )
       ORDER BY latest.published_at DESC NULLS LAST, c.channel_name ASC`,
      [query, youtubeVideoId],
    );
    res.json({ query, videos: result.rows });
  } catch (error) {
    next(error);
  }
});

app.get(`${apiPrefix}/keywords`, requireAuthenticated, async (req, res, next) => {
  try {
    const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : "";
    const page = Math.max(0, Math.min(199, Number.parseInt(String(req.query.page || "0"), 10) || 0));
    const videoOffset = page * 50;
    let youtubeVideoId: string | null = null;
    try {
      const parsed = new URL(query);
      const candidate = parsed.hostname === "youtu.be"
        ? parsed.pathname.split("/").filter(Boolean)[0]
        : parsed.searchParams.get("v") || parsed.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1] || null;
      if (candidate && /^[\w-]{11}$/.test(candidate)) youtubeVideoId = candidate;
    } catch {
      if (/^[\w-]{11}$/.test(query)) youtubeVideoId = query;
    }
    const [videos, videoCount, pending, total, completed, failed] = await Promise.all([
      query ? pool.query(
        `WITH latest AS (
           SELECT DISTINCT ON (channel_id, youtube_video_id)
             channel_id, youtube_video_id, video_title, video_description, published_at
           FROM video_engagement_snapshots
           WHERE expires_at > NOW()
           ORDER BY channel_id, youtube_video_id, observed_at DESC
         )
         SELECT c.id AS "channelId", c.channel_name AS "channelName",
           latest.youtube_video_id AS "youtubeVideoId", latest.video_title AS "videoTitle",
           latest.video_description AS "videoDescription", latest.published_at AS "publishedAt",
           CASE WHEN latest.youtube_video_id = $2 THEN 'Video link'
             WHEN strpos(lower(COALESCE(latest.video_title, '')), lower($1)) > 0 THEN 'Video title'
             ELSE 'Video description' END AS "matchedIn"
         FROM latest JOIN channels c ON c.id = latest.channel_id
         WHERE c.is_active = TRUE AND (
           strpos(lower(COALESCE(latest.video_title, '')), lower($1)) > 0
           OR strpos(lower(COALESCE(latest.video_description, '')), lower($1)) > 0
           OR ($2::text IS NOT NULL AND latest.youtube_video_id = $2)
         )
         ORDER BY latest.published_at DESC NULLS LAST, c.channel_name ASC LIMIT 50 OFFSET $3`,
        [query, youtubeVideoId, videoOffset],
      ) : Promise.resolve({ rows: [] }),
      query ? pool.query(
        `WITH latest AS (
           SELECT DISTINCT ON (v.channel_id, v.youtube_video_id)
             v.channel_id, v.youtube_video_id, v.video_title, v.video_description
           FROM video_engagement_snapshots v
           WHERE v.expires_at > NOW()
           ORDER BY v.channel_id, v.youtube_video_id, v.observed_at DESC
         )
         SELECT COUNT(*)::text AS count
         FROM latest JOIN channels c ON c.id = latest.channel_id
         WHERE c.is_active = TRUE AND (
           strpos(lower(COALESCE(latest.video_title, '')), lower($1)) > 0
           OR strpos(lower(COALESCE(latest.video_description, '')), lower($1)) > 0
           OR ($2::text IS NOT NULL AND latest.youtube_video_id = $2)
         )`,
        [query, youtubeVideoId],
      ) : Promise.resolve({ rows: [{ count: "0" }] }),
      pool.query(
        `WITH latest AS (
           SELECT DISTINCT ON (channel_id, youtube_video_id) channel_id, youtube_video_id, keywords_generated_at, keyword_status
           FROM video_engagement_snapshots WHERE expires_at > NOW()
           ORDER BY channel_id, youtube_video_id, observed_at DESC
         )
         SELECT COUNT(*)::text AS count FROM latest
         JOIN channels c ON c.id = latest.channel_id
         WHERE c.is_active = TRUE AND latest.keywords_generated_at IS NULL
           AND latest.keyword_status IN ('pending', 'processing', 'transcribing', 'needs_transcript')`,
      ),
      pool.query(
        `WITH latest AS (
           SELECT DISTINCT ON (channel_id, youtube_video_id) channel_id, youtube_video_id, keywords_generated_at
           FROM video_engagement_snapshots WHERE expires_at > NOW()
           ORDER BY channel_id, youtube_video_id, observed_at DESC
         ) SELECT COUNT(*)::text AS count FROM latest JOIN channels c ON c.id = latest.channel_id
           WHERE c.is_active = TRUE AND latest.keywords_generated_at IS NULL`,
      ),
      pool.query(
        `WITH latest AS (
           SELECT DISTINCT ON (channel_id, youtube_video_id) channel_id, youtube_video_id, keywords_generated_at, keyword_status
           FROM video_engagement_snapshots WHERE expires_at > NOW()
           ORDER BY channel_id, youtube_video_id, observed_at DESC
         ) SELECT COUNT(*)::text AS count FROM latest JOIN channels c ON c.id = latest.channel_id
           WHERE c.is_active = TRUE AND (latest.keywords_generated_at IS NOT NULL
             OR latest.keyword_status IN ('failed', 'transcript_unavailable'))`,
      ),
      pool.query(
        `WITH latest AS (
           SELECT DISTINCT ON (channel_id, youtube_video_id) channel_id, youtube_video_id, keyword_status
           FROM video_engagement_snapshots WHERE expires_at > NOW()
           ORDER BY channel_id, youtube_video_id, observed_at DESC
         )
         SELECT COUNT(*)::text AS count FROM latest
         JOIN channels c ON c.id = latest.channel_id
         WHERE c.is_active = TRUE AND latest.keyword_status = 'failed'`,
      ),
    ]);
    res.json({
      videos: videos.rows,
      videoCount: videoCount.rows[0]?.count || "0",
      pendingCount: pending.rows[0]?.count || "0",
      failedCount: failed.rows[0]?.count || "0",
      analysisTotalCount: total.rows[0]?.count || "0",
      analysisCompletedCount: completed.rows[0]?.count || "0",
    });
  } catch (error) {
    next(error);
  }
});

app.post(`${apiPrefix}/keywords/generate`, requireAdmin, async (_req, res, next) => {
  try {
    const pending = await pool.query(
      `WITH latest AS (
         SELECT DISTINCT ON (v.channel_id, v.youtube_video_id)
           v.id, v.channel_id, v.youtube_video_id, v.published_at,
           v.keyword_algorithm_version, v.keywords_generated_at, v.keyword_status
         FROM video_engagement_snapshots v
         WHERE v.expires_at > NOW()
         ORDER BY v.channel_id, v.youtube_video_id, v.observed_at DESC
       ), latest_batch AS (
         SELECT latest.id, latest.channel_id FROM latest
         JOIN channels c ON c.id = latest.channel_id
         WHERE c.is_active = TRUE AND (
           latest.keyword_algorithm_version < ${KEYWORD_ALGORITHM_VERSION}
           OR latest.keywords_generated_at IS NULL
           OR latest.keyword_status = 'failed'
         )
         ORDER BY latest.published_at DESC NULLS LAST
         LIMIT 50000
       ), queued AS (
         UPDATE video_engagement_snapshots target
         SET keyword_status = 'pending', keywords = '{}', keywords_generated_at = NULL,
             keyword_algorithm_version = 1, keyword_updated_at = NOW()
         FROM latest_batch
         WHERE target.id = latest_batch.id
         RETURNING target.id
       )
       SELECT COUNT(*)::int AS count FROM queued`,
    );
    const queued = Number(pending.rows[0]?.count || 0);
    res.status(202).json({ queued });
    if (queued > 0) void processKeywordQueue();
  } catch (error) {
    next(error);
  }
});

app.get(`${apiPrefix}/collection-jobs`, requireAuthenticated, async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, scope, status, channels_total AS "channelsTotal", channels_completed AS "channelsCompleted",
         error_summary AS "errorSummary", created_at AS "createdAt", finished_at AS "finishedAt"
       FROM collection_jobs ORDER BY created_at DESC LIMIT 20`,
    );
    res.json({ jobs: result.rows });
  } catch (error) {
    next(error);
  }
});

async function startCollection(
  scope: "all" | "views" | "engagement",
  res: Response,
  next: NextFunction,
  dateRange?: { after: string; before: string; afterAt?: string; beforeAt?: string },
): Promise<void> {
  try {
    const channels = await pool.query<{ id: string; youtube_channel_id: string }>(
      "SELECT id, youtube_channel_id FROM channels WHERE is_active = TRUE ORDER BY created_at ASC",
    );
    if (channels.rowCount === 0) {
      res.status(409).json({ error: "Add a channel before collecting data." });
      return;
    }
    if (process.env.YOUTUBE_API_KEY_CONFIGURED !== "true") {
      res.status(503).json({ error: "Add YOUTUBE_API_KEY to .env before starting a collection." });
      return;
    }
    if (workerToken.length < 32 || workerToken.includes("replace-with")) {
      res.status(503).json({ error: "Set a private WORKER_TOKEN of at least 32 characters in .env." });
      return;
    }

    const jobId = randomUUID();
    await pool.query(
      `INSERT INTO collection_jobs
         (id, status, scope, channel_ids, channels_total, published_after, published_before, published_after_at, published_before_at)
       VALUES ($1, 'queued', $2, $3::uuid[], $4, $5::date, $6::date, $7::timestamptz, $8::timestamptz)`,
      [jobId, scope, channels.rows.map((channel) => channel.id), channels.rows.length,
        dateRange?.after ?? null, dateRange?.before ?? null, dateRange?.afterAt ?? null, dateRange?.beforeAt ?? null],
    );

    try {
      await pool.query(
        "UPDATE collection_jobs SET status = 'running', started_at = NOW() WHERE id = $1",
        [jobId],
      );
      const response = await fetch(`${workerUrl}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-worker-token": workerToken },
        body: JSON.stringify({
          jobId,
          scope,
          ...(dateRange ? {
            publishedAfter: dateRange.afterAt ?? `${dateRange.after}T00:00:00.000Z`,
            publishedBefore: dateRange.beforeAt ?? new Date(Date.parse(`${dateRange.before}T00:00:00.000Z`) + 86_400_000).toISOString(),
          } : {}),
          channels: channels.rows.map((channel) => ({
            id: channel.id,
            youtubeChannelId: channel.youtube_channel_id,
          })),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Collector returned HTTP ${response.status}.`);
      res.status(202).json({ jobId, status: "running" });
    } catch {
      await pool.query(
        "UPDATE collection_jobs SET status = 'failed', error_summary = $2, finished_at = NOW() WHERE id = $1",
        [jobId, "Could not start the collection worker."],
      );
      res.status(502).json({ error: "Could not start the collection worker. Check that all services are running." });
    }
  } catch (error) {
    next(error);
  }
}

app.post(`${apiPrefix}/collection-jobs`, requireAdmin, (_req, res, next) => {
  void startCollection("all", res, next);
});
app.post(`${apiPrefix}/collection-jobs/views`, requireAdmin, (_req, res, next) => {
  void startCollection("views", res, next);
});
app.post(`${apiPrefix}/collection-jobs/engagement`, requireAdmin, (_req, res, next) => {
  void startCollection("engagement", res, next);
});
app.post(`${apiPrefix}/collection-jobs/engagement-range`, requireAdmin, (req, res, next) => {
  const after = typeof req.body?.startDate === "string" ? req.body.startDate : "";
  const before = typeof req.body?.endDate === "string" ? req.body.endDate : "";
  const startTime = typeof req.body?.startTime === "string" ? req.body.startTime : "";
  const endTime = typeof req.body?.endTime === "string" ? req.body.endTime : "";
  const isDate = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  if (!isDate(after) || !isDate(before)) {
    res.status(400).json({ error: "Choose valid start and end dates." });
    return;
  }
  if (Boolean(startTime) !== Boolean(endTime) || (startTime && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)))) {
    res.status(400).json({ error: "Choose both valid times in 24-hour format, or leave both blank." });
    return;
  }
  if (after > before) {
    res.status(400).json({ error: "The start date must be on or before the end date." });
    return;
  }
  if (!startTime && before > new Date().toISOString().slice(0, 10)) {
    res.status(400).json({ error: "Choose an end date that is today or earlier." });
    return;
  }
  let afterAt: string | undefined;
  let beforeAt: string | undefined;
  if (startTime && endTime) {
    const startInstant = new Date(`${after}T${startTime}:00+05:30`);
    const endMinute = new Date(`${before}T${endTime}:00+05:30`);
    if (startInstant >= new Date(endMinute.getTime() + 60_000)) {
      res.status(400).json({ error: "The start time must be before the end minute." });
      return;
    }
    if (endMinute > new Date()) {
      res.status(400).json({ error: "Choose an end time that is now or earlier (IST)." });
      return;
    }
    afterAt = startInstant.toISOString();
    beforeAt = new Date(endMinute.getTime() + 60_000).toISOString();
  }
  void startCollection("engagement", res, next, { after, before, afterAt, beforeAt });
});

app.get(`${apiPrefix}/collection-jobs/:id`, requireAuthenticated, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, scope, status, channels_total AS "channelsTotal", channels_completed AS "channelsCompleted",
         error_summary AS "errorSummary", created_at AS "createdAt", started_at AS "startedAt",
         finished_at AS "finishedAt"
       FROM collection_jobs WHERE id = $1::uuid`,
      [req.params.id],
    );
    if (!result.rowCount) {
      res.status(404).json({ error: "Collection job not found." });
      return;
    }
    res.json({ job: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

function equalSecret(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

type ViewMetric = { channelId: string; viewsTotal: number };
type VideoEngagement = {
  channelId: string;
  videoId: string;
  title: string;
  description?: string;
  publishedAt: string | null;
  isShort?: boolean;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
};
type ChannelProfile = {
  channelId: string;
  title: string;
  description: string;
  publishedAt: string | null;
  subscriberCount: number | null;
  subscribersHidden: boolean;
  videoCount: number | null;
};
type ContactDetails = {
  emails: string[];
  phones: string[];
  socialLinks: Array<{ platform: string; url: string }>;
  websites: Array<{ name: string; url: string }>;
};

function validContactDetails(value: unknown): value is ContactDetails {
  if (!value || typeof value !== "object") return false;
  const contacts = value as Partial<ContactDetails>;
  const validStrings = (items: unknown): items is string[] =>
    Array.isArray(items) && items.length <= 20 && items.every((item) => typeof item === "string" && item.length <= 240);
  return validStrings(contacts.emails) && validStrings(contacts.phones) &&
    Array.isArray(contacts.socialLinks) && contacts.socialLinks.length <= 20 &&
    contacts.socialLinks.every((item) => item && typeof item.platform === "string" && item.platform.length <= 40 &&
      typeof item.url === "string" && item.url.length <= 500) &&
    Array.isArray(contacts.websites) && contacts.websites.length <= 20 &&
    contacts.websites.every((item) => item && typeof item.name === "string" && item.name.length <= 120 &&
      typeof item.url === "string" && item.url.length <= 500);
}

function normalizeContactDetails(value: unknown): ContactDetails {
  const contacts = value as ContactDetails;
  const normalizeUrl = (raw: string): string => {
    const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new ValidationError("Contact links must be valid web addresses.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ValidationError("Contact links must use http or https.");
    }
    return parsed.toString();
  };
  const emails = contacts.emails.map((email) => email.trim().toLowerCase());
  if (emails.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new ValidationError("Enter email addresses in a valid format.");
  }
  return {
    emails: [...new Set(emails)],
    phones: [...new Set(contacts.phones.map((phone) => phone.trim()))],
    socialLinks: contacts.socialLinks.map((item) => ({ platform: item.platform.trim(), url: normalizeUrl(item.url.trim()) })),
    websites: contacts.websites.map((item) => ({ name: item.name.trim(), url: normalizeUrl(item.url.trim()) })),
  };
}
type CompletedKind = { channelId: string; kind: "views" | "engagement" };

app.post(`${apiPrefix}/internal/collection-jobs/:id/results`, async (req, res, next) => {
  const timestamp = req.get("x-worker-timestamp") || "";
  const signature = req.get("x-worker-signature") || "";
  const timestampSeconds = Number(timestamp);
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const signatureIsFresh = /^\d{10}$/.test(timestamp) && Number.isSafeInteger(timestampSeconds) &&
    Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) <= 300;
  const expectedSignature = signatureIsFresh && rawBody
    ? createHmac("sha256", workerToken).update(timestamp).update(".").update(rawBody).digest("hex")
    : "";
  if (!signatureIsFresh || !rawBody || !/^([a-f0-9]{64})$/.test(signature) || !equalSecret(signature, expectedSignature)) {
    res.status(401).json({ error: "Worker authentication failed." });
    return;
  }
  const client = await pool.connect();
  try {
    const jobId = req.params.id;
    await client.query("BEGIN");
    const jobResult = await client.query<{ channel_ids: string[]; processed_channel_ids: string[]; channels_completed: number; channels_total: number; error_summary: string | null; scope: "all" | "views" | "engagement"; status: string; callback_received_at: Date | null; published_after: string | null; published_before: string | null }>(
      "SELECT channel_ids, processed_channel_ids, channels_completed, channels_total, error_summary, scope, status, callback_received_at, published_after, published_before FROM collection_jobs WHERE id = $1::uuid FOR UPDATE",
      [jobId],
    );
    if (!jobResult.rowCount) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Collection job not found." });
      return;
    }
    const allowedIds = jobResult.rows[0].channel_ids;
    const jobScope = jobResult.rows[0].scope;
    const channelsTotal = jobResult.rows[0].channels_total;
    if (jobResult.rows[0].callback_received_at || jobResult.rows[0].status !== "running") {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "Collection results were already received or the job is no longer active." });
      return;
    }
    const batchChannelIds: string[] = Array.isArray(req.body?.channelIds) ? req.body.channelIds : allowedIds;
    if (new Set(batchChannelIds).size !== batchChannelIds.length || batchChannelIds.some((id) => !allowedIds.includes(id))) {
      throw new ValidationError("The collection result contains invalid channel IDs.");
    }
    const alreadyProcessed = new Set(jobResult.rows[0].processed_channel_ids || []);
    const newChannelIds = batchChannelIds.filter((id) => !alreadyProcessed.has(id));
    const newChannelIdSet = new Set(newChannelIds);
    const finalBatch = typeof req.body?.final === "boolean" ? req.body.final : true;
    if (newChannelIds.length === 0 && !finalBatch) {
      await client.query("COMMIT");
      res.status(200).json({ saved: 0, status: "running", channelsCompleted: jobResult.rows[0].channels_completed });
      return;
    }
    const views: ViewMetric[] = (Array.isArray(req.body?.views) ? req.body.views : []).filter((item: ViewMetric) => newChannelIdSet.has(item.channelId));
    const videoEngagement: VideoEngagement[] = (Array.isArray(req.body?.videoEngagement) ? req.body.videoEngagement : []).filter((item: VideoEngagement) => newChannelIdSet.has(item.channelId));
    const channelProfiles: ChannelProfile[] = (Array.isArray(req.body?.channelProfiles) ? req.body.channelProfiles : []).filter((item: ChannelProfile) => newChannelIdSet.has(item.channelId));
    const completedKinds: CompletedKind[] = (Array.isArray(req.body?.completedKinds) ? req.body.completedKinds : []).filter((item: CompletedKind) => newChannelIdSet.has(item.channelId));
    const errors: Array<{ channelId?: string; scraper?: string; message?: string }> = (Array.isArray(req.body?.errors) ? req.body.errors : []).filter((item: { channelId?: string }) => !item.channelId || newChannelIdSet.has(item.channelId));
    if (views.length > channelsTotal || channelProfiles.length > channelsTotal ||
        completedKinds.length > channelsTotal * 2 || errors.length > channelsTotal ||
        videoEngagement.length > channelsTotal * 5000) {
      throw new ValidationError("The collection result contains too many records.");
    }

    let saved = 0;
    const successfulKinds = new Map<string, Set<string>>();
    for (const profile of channelProfiles) {
      const validCount = (value: number | null) => value === null || (Number.isSafeInteger(value) && value >= 0);
      if (!allowedIds.includes(profile.channelId) || typeof profile.title !== "string" ||
          typeof profile.description !== "string" || profile.title.length > 200 || profile.description.length > 5000 ||
          !validCount(profile.subscriberCount) || !validCount(profile.videoCount) ||
          typeof profile.subscribersHidden !== "boolean") continue;
      await client.query(
        `UPDATE channels SET youtube_title = $2, description = $3, channel_published_at = $4::timestamptz,
           subscriber_count = $5, subscribers_hidden = $6, youtube_video_count = $7, profile_observed_at = NOW(),
           updated_at = NOW()
         WHERE id = $1::uuid`,
        [profile.channelId, profile.title, profile.description, profile.publishedAt || null,
          profile.subscriberCount, profile.subscribersHidden, profile.videoCount],
      );
      saved += 1;
    }
    for (const metric of views) {
      if (!allowedIds.includes(metric.channelId) || !Number.isSafeInteger(metric.viewsTotal) || metric.viewsTotal < 0) continue;
      await client.query(
        `INSERT INTO metric_snapshots (channel_id, views_total, expires_at)
         VALUES ($1::uuid, $2, NOW() + INTERVAL '30 days')`,
        [metric.channelId, metric.viewsTotal],
      );
      saved += 1;
    }
    for (const video of videoEngagement) {
      const validCount = (value: number | null) => value === null || (Number.isSafeInteger(value) && value >= 0);
      if (!allowedIds.includes(video.channelId) || !video.videoId || video.videoId.length > 40 ||
          typeof video.title !== "string" || (video.description !== undefined && typeof video.description !== "string") || !validCount(video.views) || !validCount(video.likes) ||
          !validCount(video.comments) || !validCount(video.shares)) continue;
      await client.query(
        `INSERT INTO video_engagement_snapshots
           (channel_id, youtube_video_id, video_title, video_description, published_at, is_short, views_count, likes_count, comments_count, shares_count, expires_at)
         VALUES ($1::uuid, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, NOW() + INTERVAL '30 days')`,
        [video.channelId, video.videoId, video.title.slice(0, 500), (video.description || "").slice(0, 5000), video.publishedAt || null,
          video.isShort === true, video.views, video.likes, video.comments, video.shares],
      );
      saved += 1;
    }
    for (const item of completedKinds) {
      if (!allowedIds.includes(item.channelId) || !["views", "engagement"].includes(item.kind)) continue;
      if (!successfulKinds.has(item.channelId)) successfulKinds.set(item.channelId, new Set());
      successfulKinds.get(item.channelId)?.add(item.kind);
    }
    const engagementChannels = new Set(
      completedKinds.filter((item) => item.kind === "engagement" && allowedIds.includes(item.channelId)).map((item) => item.channelId),
    );
    const isDateRangeCollection = jobResult.rows[0].published_after !== null || jobResult.rows[0].published_before !== null;
    for (const channelId of isDateRangeCollection ? [] : engagementChannels) {
      const currentVideoIds = videoEngagement
        .filter((video) => video.channelId === channelId && video.videoId && video.videoId.length <= 40)
        .map((video) => video.videoId);
      await client.query(
        `DELETE FROM video_engagement_snapshots
         WHERE channel_id = $1::uuid AND NOT (youtube_video_id = ANY($2::text[]))`,
        [channelId, currentVideoIds],
      );
    }
    const isSuccessful = (channelId: string): boolean => {
      const kinds = successfulKinds.get(channelId);
      if (jobScope === "views") return Boolean(kinds?.has("views"));
      if (jobScope === "engagement") return Boolean(kinds?.has("engagement"));
      return Boolean(kinds?.has("views") && kinds?.has("engagement"));
    };
    const completedChannels = jobResult.rows[0].channels_completed + newChannelIds.filter(isSuccessful).length;
    const batchErrorSummary = errors.length
      ? errors.slice(0, 10).map((item) => `${allowedIds.includes(item.channelId || "") ? item.channelId : "Channel"} ${typeof item.scraper === "string" ? item.scraper.slice(0, 40) : "collector"}: Collection failed.`).join("; ").slice(0, 2000)
      : null;
    let errorSummary = [jobResult.rows[0].error_summary, batchErrorSummary].filter(Boolean).join("; ").slice(0, 2000) || null;
    const processedChannelIds = [...new Set([...alreadyProcessed, ...newChannelIds])];
    let finalStatus = "running";
    if (!finalBatch) {
      await client.query(
        `UPDATE collection_jobs SET processed_channel_ids = $2::uuid[], channels_completed = $3, error_summary = $4
         WHERE id = $1::uuid`,
        [jobId, processedChannelIds, completedChannels, errorSummary],
      );
    } else {
      if (processedChannelIds.length < channelsTotal) {
        errorSummary = [errorSummary, "Some channel results were not received."].filter(Boolean).join("; ").slice(0, 2000);
      }
      if (completedChannels === 0 && !errorSummary) errorSummary = "No metrics were returned.";
      finalStatus = completedChannels === 0 ? "failed" : errorSummary || completedChannels < channelsTotal ? "partial" : "completed";
      await client.query(
        `UPDATE collection_jobs
         SET status = $2, processed_channel_ids = $3::uuid[], channels_completed = $4, error_summary = $5,
             finished_at = NOW(), callback_received_at = NOW()
         WHERE id = $1::uuid`,
        [jobId, finalStatus, processedChannelIds, completedChannels, errorSummary],
      );
    }
    await client.query("COMMIT");
    res.status(200).json({ saved, status: finalStatus, channelsCompleted: completedChannels });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error("API request failed:", message, error instanceof Error ? error.stack : "");
  if (res.headersSent) return;
  res.status(500).json({ error: "The request could not be completed." });
});

async function start(): Promise<void> {
  if (workerToken.length < 32 || workerToken.includes("replace-with")) {
    throw new Error("Set a private WORKER_TOKEN of at least 32 characters in .env");
  }
  await initializeDatabase();
  await recoverStaleXPostCollections();
  app.listen(port, "0.0.0.0", () => console.log(`Node API listening on port ${port}`));
  const cleanupTimer = setInterval(() => {
    void Promise.all([
      pool.query("DELETE FROM metric_snapshots WHERE expires_at <= NOW()"),
      pool.query("DELETE FROM video_engagement_snapshots WHERE expires_at <= NOW()"),
      pool.query(
        `UPDATE channels SET youtube_title = NULL, description = NULL, channel_published_at = NULL,
           subscriber_count = NULL, subscribers_hidden = FALSE, youtube_video_count = NULL, profile_observed_at = NULL,
           contact_details = '{"emails": [], "phones": [], "socialLinks": [], "websites": []}'::jsonb
         WHERE profile_observed_at <= NOW() - INTERVAL '30 days'`,
      ),
    ]).catch((error: unknown) => console.error("Retention cleanup failed:", error instanceof Error ? error.name : "Unknown error"));
  }, 60 * 60 * 1000);
  cleanupTimer.unref();
}

start().catch((error: unknown) => {
  console.error("API startup failed:", error instanceof Error ? error.name : "Unknown error");
  process.exitCode = 1;
});
