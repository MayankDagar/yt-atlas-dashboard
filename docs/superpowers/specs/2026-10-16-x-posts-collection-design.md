# X Posts Collection Design

## Goal

Add an independent X Posts page to YT Atlas where an administrator can search public X posts by topic and date range, review saved results, open posts and authors on X, and export the results to Excel.

## Agreed product behavior

- Add **X Posts** as a separate item in the workspace sidebar and a separate hash route/page.
- Let an administrator enter one or more keywords/topics, a start date, an end date, and a result limit up to 100 posts per topic. The default limit is 100.
- Search in **Top** order. There is no Latest 50 mode and no time-of-day filter.
- Collect each topic independently, with at most one Apify Actor run active at a time. This preserves the per-topic result cap and follows the Actor's single-concurrent-run policy.
- Persist collections and posts so results remain available after navigation and refresh. Deduplicate posts by X post ID while retaining which topic searches matched each post.
- Show a collection's progress/state and its post results. Display date, post text, author name and handle, likes, reposts, replies, and clickable post/author links.
- Provide Excel export for the displayed collection results, including post and author URLs.
- The Apify token is configured on the server in `.env`; it is never sent to the browser.
- The app supports testing through Apify's Free Plan Demo Mode. The Actor currently documents a limit of five runs per month and ten items per run for Free Plan users; the UI must explain that a requested limit above ten may still yield at most ten during free-tier tests.

## Current application context

- The web app is a Next.js/React client dashboard with hash-based navigation in `apps/web/components/dashboard.tsx` and shared styles in `apps/web/app/globals.css`.
- The API is an Express/TypeScript service in `apps/api/src/index.ts` backed by PostgreSQL through `apps/api/src/db.ts` and ordered SQL migrations.
- Existing admin-only actions use `requireAdmin`; read endpoints use `requireAuthenticated`.
- The Docker Compose `api` service passes configuration from `.env` into the API container. The Apify token must follow this server-only configuration pattern.

## Recommended architecture

Use the existing Express API and PostgreSQL database rather than adding another service. PostgreSQL is the app's durable source of truth for collection inputs, statuses, normalized X posts, and collection/topic provenance. Apify's per-run default dataset is only an intermediate transfer copy. After the API retrieves the dataset and successfully commits/validates its records in PostgreSQL, it deletes the Apify dataset. If import fails, retain the dataset temporarily for recovery and let Apify's documented default seven-day retention clean it up; record a cleanup failure without discarding the PostgreSQL copy. Actor run metadata/logs may remain in the user's Apify account according to Apify retention, but scraped post records are stored in the app's PostgreSQL database. The browser submits a collection request to an authenticated admin endpoint. The API validates and records a queued collection, then runs the Apify Actor asynchronously from the server. It serializes topic runs because the Actor says only one concurrent run is supported. The API polls each Actor run, retrieves its default dataset after completion, normalizes the records, and stores them. Authenticated read endpoints expose job status, collection history, and paginated posts. The browser polls the job endpoint while collection is active.

Actor integration uses `apidojo/twitter-scraper-lite`. For each topic, send `searchTerms: [topic]`, `sort: "Top"`, `maxItems: requestedLimit`, and the selected date bounds using the Actor's documented `start` and `end` inputs. Use the Apify run API asynchronously, then fetch dataset items using the returned `defaultDatasetId`; do not hold the browser request open for the duration of a scrape.

### Persistence model

- `x_post_collections`: one user-submitted request, normalized query inputs, date range, requested maximum, status (`queued`, `running`, `completed`, `partial`, `failed`), progress counters, error summary, and timestamps.
- `x_posts`: normalized post data keyed by the stable X post ID, including text, post URL, created time, language, author ID/name/handle/profile URL, likes, reposts, replies, quotes, and last-seen timestamp.
- `x_post_collection_results`: join rows connecting collection, topic, and post ID. This allows a post matched by multiple topics to appear once in a combined collection while preserving match provenance.

Post counts and engagement values are stored as integers where available; unavailable Actor fields remain null rather than being shown as zero. Upserts refresh the saved post fields while preserving stable IDs. A repeat post found by a later collection updates its saved values and adds collection/topic provenance.

## Page behavior

The separate page contains:

1. A collection form for one or more topics, From date, Through date, and max posts per topic (1–100, default 100). Dates are date-only; the UI does not request times.
2. A clear note that this searches public X posts via Apify and that search coverage/order depend on X and the Actor.
3. Recent X collections with status, topics, dates, result counts, and created time.
4. A selected collection's results table/list. Post text and author are clickable external links and open in a new tab. Results can be filtered to a topic within a collection and exported to Excel.
5. Loading, empty, partial, failed, and free-tier-limited states with actionable messages.

The page uses existing dashboard styling and responsive patterns. It is independent from YouTube collection actions and does not alter YouTube data or quota behavior.

## API surface

All routes use the existing `/api/v1` prefix and authentication middleware.

- `POST /x-post-collections` (admin): validate topics, date range, and max items; create a queued collection and return its ID/status.
- `GET /x-post-collections` (authenticated): return recent collections.
- `GET /x-post-collections/:id` (authenticated): return status, per-topic progress, counters, and summary errors.
- `GET /x-post-collections/:id/posts` (authenticated): return paginated normalized posts, optionally filtered by topic.
- `GET /x-post-collections/:id/export` (authenticated): return an Excel workbook for the selected collection and optional topic filter.

Request validation limits the topic list to 20 entries, requires non-empty distinct topics of at most 200 characters each, requires valid ordered dates, and constrains result limits to integers from 1 through 100. The API rejects future end dates. User text is passed as a search term, not interpreted as raw Apify API credentials or an arbitrary request URL.

## Failure handling and security

- Missing/invalid `APIFY_API_TOKEN` produces a clear setup error before a job is queued.
- Apify rate limits, Actor failures, malformed dataset records, and timeouts are recorded per topic. Continue to remaining topics when possible; mark the collection `partial` if at least one topic succeeded and another failed.
- Persist run IDs and status so a refresh does not lose progress. A process restart must not mark active jobs complete; stale jobs should become failed with a resumable/diagnostic error unless recovery is explicitly implemented.
- The API token stays server-side and is never included in API responses, logs, or database rows.
- External links are rendered as safe links with `target="_blank"` and `rel="noreferrer"`.
- Request concurrency is serialized for this Actor. Admins cannot launch overlapping X collections while a collection is active; the UI explains this state.
- No automated collection schedule is included.

## Limitations

- X search and this Actor may omit posts, alter ordering, or change date behavior. The UI must not promise complete coverage or an exact ranking beyond the returned Actor results.
- On Free Plan Demo Mode, collection size and run count are Actor-limited. The app reports actual returned counts and does not fabricate the requested number of results.
- This feature scrapes public X search results using Apify; it does not use the YouTube API and does not consume YouTube quota.
- Cost shown by Apify may differ based on the user's plan and Actor pricing. This initial feature does not estimate or guarantee cost.

## Acceptance criteria

1. An administrator can open X Posts from the sidebar without leaving the single-page app's route model.
2. The administrator can submit multiple topics, date-only bounds, and a per-topic maximum from 1 to 100.
3. A collection runs its topic searches serially, records progress, persists results, and reports complete/partial/failed outcomes.
4. Results show the agreed post/author/engagement fields, links, and match topic; repeated post IDs are not duplicated within a collection.
5. A user can refresh or navigate away and later view collection history and saved results.
6. A selected collection can be exported to an Excel workbook with the displayed result fields and URLs.
7. Missing credentials and Apify failures produce clear states without exposing secrets or breaking YouTube features.
8. Free-tier results are presented as returned by the Actor, including the documented ten-item demo cap.

## References

- Actor overview and pricing/usage notes: https://apify.com/apidojo/twitter-scraper-lite
- Actor input schema (`searchTerms`, `sort`, `maxItems`, `start`, `end`): https://apify.com/apidojo/twitter-scraper-lite/input-schema
- Apify Actor run API: https://docs.apify.com/api/v2/actors-actor-runs
- Apify run and dataset retrieval overview: https://docs.apify.com/academy/api/run-actor-and-retrieve-data-via-api
- Apify dataset storage and default retention: https://docs.apify.com/storage/dataset
- Apify API endpoint for deleting a dataset: https://docs.apify.com/api/v2/actor-run-dataset-delete
