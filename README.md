
# YT Atlas

A responsive YouTube channel dashboard starter built with Next.js/React, a Node.js REST API, a Python collection worker, and PostgreSQL.

## Included in this first build

- Admin ID and password login with a server-side session cookie.
- Add channels with Channel Name, YouTube Channel ID, Category, State, optional Regional area, and optional District.
- A separate **Collect views** path for YouTube's current channel-level view count.
- A separate **Collect engagement** path that records public likes and comments per video for up to the latest 100 public uploads per channel. The limit can be lowered with `MAX_VIDEOS_PER_CHANNEL`.
- Gemma keyword extraction through OpenRouter for collected videos, plus a searchable **Video keywords** page with channel names and direct video links. It uses title and description first, then checks YouTube captions and calls Cloudflare Whisper only when captions are unavailable.
- A separate **X posts** page that searches topics through the Apify API Dojo X scraper, keeps normalized results and collection history in PostgreSQL, and exports saved posts to Excel.
- Collection job status, a responsive channel list, and the 20 most recently published videos with the raw engagement counts available for each.
- PostgreSQL migrations and API-only database access. The web app and Python worker do not connect directly to PostgreSQL.
- Public API snapshots are removed after 30 days.

Excel import, YouTube owner OAuth, share counts, and final chart choices are intentionally left for later. The workbook can be mapped to the existing channel fields when you are ready to add the importer.

## Start locally with Docker Compose

1. From this folder, copy `.env.example` to `.env` and fill in the blank credentials. Compose now refuses to start with missing database, admin, or worker credentials.

   ```sh
   cp .env.example .env
   ```

2. Generate a private worker token and set it in `.env`:

   ```sh
   openssl rand -hex 32
   ```

3. Set a unique `ADMIN_ID`, an `ADMIN_PASSWORD` with at least 12 characters, and a unique `POSTGRES_PASSWORD`; `openssl rand -hex 24` produces suitable secrets. Use the same database password in `DATABASE_URL`. Existing installations keep their stored password hashes and account IDs.

4. Create a YouTube Data API v3 key in Google Cloud, enable the **YouTube Data API v3**, restrict the key to that API, and put it in `YOUTUBE_API_KEY`. The key is used by the Python worker and is never sent to the browser.

5. Start the services the first time:

   ```sh
   docker compose up --build
   ```

   To enable **X posts**, create an API token in your Apify account settings and add it as `APIFY_API_TOKEN` in `.env` before starting the API. The token is read by the API only and is never exposed to the browser. For a first test, open **X posts**, enter one topic, choose a date range, set the limit to 10, and collect. The Actor searches using **Top** ordering; the page accepts up to 20 topics (one per line), date-only bounds, and up to 100 results per topic. The API runs topics sequentially, saves post text, author links, public engagement counts, post dates, and topic matches in PostgreSQL, and deletes each temporary Apify dataset after its rows are saved. The actor's Free Plan Demo Mode currently allows five runs per month and up to 10 items per run. On a paid actor plan, choose up to 100 results per topic in the app; actual returned results may be lower than the requested limit, and charges depend on the actor's current plan and returned items. Apify run metadata and logs remain subject to Apify's own retention settings.

   To enable keyword generation, create an OpenRouter key and set `OPENROUTER_API_KEY` in `.env`. The default model is `google/gemma-3-27b-it`; change `OPENROUTER_MODEL` to another OpenRouter model ID if needed. To enable transcript fallback, create a Cloudflare Workers AI API token with Workers AI access and copy your Cloudflare Account ID. Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in `.env`; these secrets are passed only to the Python worker. Existing YouTube captions are used first at no Cloudflare inference cost. After adding these values, rebuild the worker and restart the API: `docker compose up -d --build worker api`.

   The local Compose setup runs the web app in Next.js development mode, watches the API and collector source, and mounts your source folders into their containers. After this initial build, edits to web files hot-reload in the browser; API and collector edits restart their processes automatically. Start the existing containers later with `docker compose up -d` (without `--build`). Rebuild only after changing dependencies or a Dockerfile.

6. Open [http://localhost:3000](http://localhost:3000) and sign in with `ADMIN_ID` and `ADMIN_PASSWORD` from `.env`.

PostgreSQL data is kept in the `postgres_data` Docker volume. The first API start applies the SQL migrations and creates the initial admin account. Changing `ADMIN_PASSWORD` in `.env` later does not reset the stored account password. For HTTPS deployment, set `COOKIE_SECURE=true` and update `WEB_ORIGIN` and `NEXT_PUBLIC_API_BASE_URL` to your app and API hosts. Production mode always sets the session cookie’s `Secure` attribute.

Authenticated sessions are opaque random tokens stored only as hashes in PostgreSQL and sent to browsers in HttpOnly, SameSite cookies. Write requests require an exact allowed `Origin`; dashboard API traffic also has a per-IP rate limit. The collector signs callback bodies with HMAC and a five-minute timestamp window, and each job accepts one callback. Admin users can create `admin` or read-only `viewer` accounts through `POST /api/v1/auth/users`, list roles through `GET /api/v1/auth/users`, and update roles through `PATCH /api/v1/auth/users/:id/role`. Admin-only actions are checked again by the API.

## YouTube data behavior

- **Video keywords:** after engagement collection, use **Analyze videos** to start keyword generation separately. Gemma processes metadata in batches of 10 and transcript-backed videos in batches of 5. It saves five keywords when title and description are informative; otherwise the worker checks YouTube captions first and uses Cloudflare Workers AI Whisper only when captions are unavailable. `yt-dlp` streams audio to process memory; audio and transcripts are not written to local files or saved in the database. Audio extraction is capped at 20 MB in memory per video.

- **Views collector:** reads `statistics.viewCount` from the [YouTube Data API channel resource](https://developers.google.com/youtube/v3/docs/channels). The dashboard shows each channel's current total separately.
- **Engagement collector:** reads public uploads and stores each returned video's ID, title, publish date, like count, and comment count from the [YouTube Data API video resource](https://developers.google.com/youtube/v3/docs/videos). Counts hidden or omitted by YouTube remain blank. It does not add video counts into a channel-wide likes/comments total.
- **Shares:** the public Data API does not provide a share count. YouTube Analytics requests require authorization; the [Analytics API](https://developers.google.com/youtube/analytics/reference) can provide shares for channels whose owners authorize access. That OAuth flow is a later addition.
- **History and refresh:** collection is manual for now; no scrape schedule has been chosen. Public API snapshots expire after 30 days and are deleted by the API cleanup task, following the [YouTube developer data policies](https://developers.google.com/youtube/terms/developer-policies).
- **Quota and collection size:** engagement collection makes additional YouTube API calls for upload playlist pages and batches of video statistics. It scans at most `MAX_VIDEOS_PER_CHANNEL` recent public uploads (default and maximum 100) in a run. Set a lower value if you want to reduce API quota use and response size.

## API overview

All dashboard reads and writes go through the Node.js REST API under `/api/v1`:

- `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`
- `GET /dashboard/summary`, `GET /channels`, `POST /channels`
- `GET /videos/engagement`, `GET /channels/:id/trends`
- `GET /keywords?q=...`, `POST /keywords/generate`
- `POST /x-post-collections`, `GET /x-post-collections`, `GET /x-post-collections/:id/posts`, `GET /x-post-collections/:id/export`
- `POST /collection-jobs/views`, `POST /collection-jobs/engagement`, `POST /collection-jobs`
- `GET /collection-jobs`, `GET /collection-jobs/:id`

The internal worker start endpoint uses a private shared token; result callbacks use HMAC signatures and a timestamp replay window. Both are intended for service-to-service use only. SQL statements use bound parameters. Uploaded workbooks are limited by file size, archive expansion, row, column, and cell counts, then validated again by the API before import. The Google Sheets importer follows only a small number of HTTPS redirects to Google download hosts.

## Project layout

```text
apps/web/          Next.js responsive dashboard
apps/api/          Express REST API, auth, PostgreSQL access and migrations
services/collector Python FastAPI worker for YouTube Data API collection
docker-compose.yml Local PostgreSQL and service orchestration
```
