# X Posts Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone X Posts sidebar page backed by Apify collection jobs, PostgreSQL storage, and Excel export.

**Architecture:** Keep the existing Next.js, Express, and PostgreSQL services. Add X-specific migrations and an API module that queues serialized Apify Actor runs, imports normalized results into PostgreSQL, deletes successfully imported datasets, and serves collection/results/export endpoints. Add a hash-routed dashboard page for collection input, progress, saved results, and export.

**Tech Stack:** Next.js 16, React 19, Express 5, TypeScript, PostgreSQL 17, Apify REST API.

**Spec:** `docs/superpowers/specs/2026-10-16-x-posts-collection-design.md`

## Global Constraints

- Keep the Apify token server-side in `.env`; never expose it to browser code or logs.
- Use `apidojo/twitter-scraper-lite` with `sort: "Top"`, date-only filters, and a per-topic limit of 1–100, default 100.
- Run one Actor call at a time and continue across topics when a topic fails.
- PostgreSQL is the durable source of truth; delete Apify datasets only after their imported records have been committed and verified.
- Preserve existing YouTube behavior and its database tables.
- Show actual returned records and clear free-tier, partial, and failure states; never imply complete X search coverage.
- Do not add scheduled collection, Latest mode, or time-of-day inputs.

## Review Focus

- Duplicate post IDs found by multiple topics must appear once per collection while retaining all matching topics.
- A failed database import must leave the Apify dataset available temporarily for recovery; a successful import must not be lost if dataset cleanup fails.
- A process restart must not silently mark an unfinished job completed.
- Free Demo Mode may return at most ten items even when the selected limit is higher.
- X-specific routes and navigation must remain isolated from existing YouTube collection behavior.

---

### Task 1: PostgreSQL schema and Apify configuration

**Files:**
- Create: `apps/api/migrations/022_x_post_collections.sql`
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Produces the tables and indexes consumed by the API module: `x_post_collections`, `x_posts`, and `x_post_collection_results`.
- Produces the server-only `APIFY_API_TOKEN` environment variable for the API container.

- [ ] Add the collection, normalized post, and collection/topic/post join tables with foreign keys, uniqueness constraints, status checks, timestamps, and query indexes as defined in the spec.
- [ ] Pass `APIFY_API_TOKEN` only to the API container; add an empty placeholder and setup guidance to `.env.example` and `README.md`.
- [ ] Confirm the migration follows the existing numbered, transaction-managed migration convention and does not alter YouTube tables.

### Task 2: Apify client, normalization, and serialized collection runner

**Files:**
- Create: `apps/api/src/x-posts.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**
- Consumes: tables from Task 1, `pool`, `requireAdmin`, `requireAuthenticated`, API prefix, and `APIFY_API_TOKEN`.
- Produces: router endpoints and a background collection runner that accepts validated topic/date/limit input, runs topics serially, and persists job progress.

- [ ] Implement the Apify REST client for starting `apidojo/twitter-scraper-lite` runs, polling run state, reading default dataset items, and deleting the dataset after a successful committed import.
- [ ] Normalize Actor records into stable X post IDs, safe X URLs, author fields, post timestamps, and nullable integer engagement fields; skip invalid records without aborting unrelated records.
- [ ] Create/upsert posts and collection/topic provenance transactionally, deduplicate by post ID within a collection, and advance per-topic progress.
- [ ] Continue to later topics after a topic-level failure; finalize job status as completed, partial, or failed based on actual per-topic outcomes.
- [ ] Store run identifiers and error summaries in PostgreSQL. On API startup, mark stale queued/running jobs failed with a diagnostic rather than falsely completing them.
- [ ] Serialize collection jobs across API instances with a PostgreSQL advisory lock or equivalent database-backed guard; reject/disable a second active collection while the Actor is busy.
- [ ] Never write the Apify token into logs, SQL rows, or API responses; retain the Apify dataset if import/verification fails, and treat post-import deletion failure as a cleanup warning.

### Task 3: Authenticated X collection API and Excel export

**Files:**
- Modify: `apps/api/src/x-posts.ts`
- Modify: `apps/api/src/index.ts`
- Create: `apps/api/src/x-post-export.ts`

**Interfaces:**
- `POST /api/v1/x-post-collections` accepts `{ topics: string[], startDate: string, endDate: string, maxItems: number }` and returns `{ collectionId, status }`.
- `GET /api/v1/x-post-collections` returns recent collections.
- `GET /api/v1/x-post-collections/:id` returns status and per-topic progress.
- `GET /api/v1/x-post-collections/:id/posts?page=&topic=` returns paginated normalized posts.
- `GET /api/v1/x-post-collections/:id/export?topic=` sends an `.xlsx` workbook with the agreed fields and URL columns.

- [ ] Validate that there are 1–20 distinct non-empty topics of at most 200 characters, ordered real dates with no future end date, and integer `maxItems` from 1–100.
- [ ] Require admin for collection creation and authenticated access for collection history, status, posts, and export.
- [ ] Return clear setup errors when `APIFY_API_TOKEN` is missing, and avoid creating a job in that case.
- [ ] Paginate saved results and support optional topic filtering without exposing Apify credentials or raw untrusted URLs.
- [ ] Build an Excel workbook from the selected collection using a dependency-free XLSX helper consistent with the web app's existing export approach; escape all user and post text as spreadsheet cell text.
- [ ] Register the X router without changing existing route behavior.

### Task 4: X Posts page, route, and sidebar navigation

**Files:**
- Modify: `apps/web/components/dashboard.tsx`
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- Adds `xPosts` to `DashboardTab`, hash route `#x-posts`, sidebar navigation, and an X Posts page component.
- Consumes the API contracts from Task 3 and existing `api`, date formatting, dashboard auth state, and design tokens.

- [ ] Add a distinct **X Posts** nav item with active/mobile behavior matching the current sidebar navigation.
- [ ] Add a page with topic entry, From/Through date-only fields, a 1–100 result limit defaulting to 100, and a clear Free Demo Mode note.
- [ ] Submit collection requests and poll status while active; show serial progress by topic and handle completed, partial, failed, empty, loading, and busy states.
- [ ] Display recent collections and a selected collection's saved results with post date/text, author/handle, likes, reposts, replies, matching topic, and clickable post/author links.
- [ ] Add optional topic filtering and an Excel export action for the selected collection.
- [ ] Match existing responsive styles and keep X Posts separate from YouTube controls and keyword navigation.

### Task 5: Documentation and integration handoff

**Files:**
- Modify: `README.md`
- Modify: `.env.example`

**Interfaces:**
- Documents the user's setup and operation path for configuring Apify and testing the X Posts feature.

- [ ] Document where to obtain/set `APIFY_API_TOKEN`, how the first test works on Free Demo Mode, the five-runs-per-month/ten-items-per-run Actor limitation, and how to reach full result caps on a paid Actor plan.
- [ ] Document PostgreSQL as durable storage and Apify's dataset as a transfer copy deleted after a verified import; explain that Actor run metadata/log retention is governed separately by Apify.
- [ ] Document the collection inputs, Top sort behavior, per-topic result limit, date-only behavior, actual returned-result limitations, saved collection page, and Excel export.

## Execution order

Complete Tasks 1–5 in order. Task 1 defines the schema/configuration boundary, Task 2 builds the runner, Task 3 exposes stable API contracts, Task 4 consumes them, and Task 5 documents the operational handoff.
