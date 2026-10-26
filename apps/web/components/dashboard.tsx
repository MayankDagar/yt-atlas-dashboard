"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChannelProfile from "./channel-profile";
import { readChannelSpreadsheet, type ChannelImportRow } from "./excel-import";
import { buildKeywordVideosXlsx, type KeywordExportVideo } from "./keyword-export";
import { displayChannelName } from "../lib/channel-name";
import { displayLocation } from "../lib/location";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "/api/v1";
const ALL_CHANNEL_FILTER_VALUE = "__all_channel_filter_values__";
const UNSPECIFIED_DISTRICT_FILTER = "__district_not_specified__";
const UNSPECIFIED_STATE_FILTER = "__unspecified_state__";
const STATE_KPI_FILTERS = ["districts", "regions", "noRecentUploads", "contact"] as const;
type StateKpiFilter = typeof STATE_KPI_FILTERS[number];
type DashboardTab = "overview" | "stateData" | "channels" | "activity" | "keywords" | "xPosts";

function readDashboardRoute(hash: string): { tab: DashboardTab; channelId: string | null; query: string } {
  const [routeWithQuery, profileSegment, encodedChannelId] = hash.replace(/^#/, "").split("/");
  const [route, queryString = ""] = routeWithQuery.split("?", 2);
  const query = new URLSearchParams(queryString).get("q") || "";
  const tab: DashboardTab = route === "state-data" ? "stateData"
    : route === "channels" ? "channels"
      : route === "collection-activity" ? "activity"
        : route === "keywords" ? "keywords"
        : route === "x-posts" ? "xPosts"
        : "overview";
  if (profileSegment === "channel" && encodedChannelId) {
    try {
      return { tab, channelId: decodeURIComponent(encodedChannelId), query };
    } catch {
      return { tab, channelId: null, query };
    }
  }
  return { tab, channelId: null, query };
}

function summarizeCollectionError(errorSummary: string): string {
  const messages = [...new Set(errorSummary.split(/;\s*/).map((entry) => entry.replace(/^(?:[0-9a-f-]{36}|Channel)\s+[^:]*:\s*/i, "").trim()).filter(Boolean))];
  return messages.length ? `${messages[0]}${messages.length > 1 ? ` (+${messages.length - 1} more errors)` : ""}` : errorSummary.trim();
}

function dashboardRoute(tab: DashboardTab, channelId: string | null, query = ""): string {
  const path = tab === "stateData" ? "state-data"
    : tab === "activity" ? "collection-activity"
      : tab === "keywords" ? "keywords"
      : tab === "xPosts" ? "x-posts"
      : tab;
  const querySuffix = tab === "keywords" && query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
  return `#${path}${channelId ? `/channel/${encodeURIComponent(channelId)}` : ""}${querySuffix}`;
}

type Channel = {
  id: string;
  youtubeChannelId: string;
  channelName: string;
  category: string;
  state: string;
  region: string | null;
  district: string | null;
  subscriberCount?: string | null;
  emailCount?: string | null;
  phoneCount?: string | null;
  socialLinkCount?: string | null;
  websiteCount?: string | null;
  outreachStatus?: "not_contacted" | "contacted" | "responded" | "partner" | "not_interested" | null;
  contactDetails?: { emails: string[]; phones: string[]; socialLinks: Array<{ platform: string; url: string }>; websites: Array<{ name: string; url: string }> };
  videoViews?: string | null;
  likes?: string | null;
  engagementRate?: string | null;
  medianEngagementRate?: string | null;
  viewsTotal: string | null;
  videosTracked: string | null;
  viewsObservedAt: string | null;
  engagementObservedAt: string | null;
  createdAt: string;
};

type Job = {
  id: string;
  jobId?: string;
  scope?: "all" | "views" | "engagement";
  status: "queued" | "running" | "completed" | "partial" | "failed";
  channelsTotal?: number;
  channelsCompleted?: number;
  errorSummary?: string | null;
  createdAt?: string;
  finishedAt?: string | null;
};

type CollectionScope = "all" | "views" | "engagement";
type TaskToastKind = "views" | "engagement" | "analysis";
type TaskToastState = "started" | "completed" | "warning" | "error";
type TaskToast = { id: string; kind: TaskToastKind; state: TaskToastState; message: string; progress?: { completed: number; total: number } };

type ApiError = Error & { status?: number };

type AnalyticsSummary = {
  channelCount: string;
  subscriberCount: string;
  channelViews: string;
  youtubeVideoCount: string;
  videosWithEngagement: string;
  videoViews: string;
  likes: string;
  comments: string;
  stateCount?: string;
  likeRate?: string | null;
  medianLikeRate?: string | null;
  directContactChannels?: string;
  socialContactChannels?: string;
  channelsWithoutContacts?: string;
  recentUploadsCollected?: string;
  districtsRepresented?: string;
  channelsMissingDistrict?: string;
  channelsWithoutRecentUploads?: string;
  channelsWithoutRecentUploadsIds?: string[];
  outreachNotContacted?: string;
  outreachContacted?: string;
  outreachResponded?: string;
  outreachPartner?: string;
  outreachNotInterested?: string;
  outreachUntracked?: string;
};

type AnalyticsBreakdown = {
  channelCount: string;
  subscriberCount: string;
  channelViews: string;
  youtubeVideoCount?: string;
  contactChannels?: string;
  recentUploadsCollected?: string;
  videosWithEngagement?: string;
  videoViews?: string;
  likes?: string;
  comments?: string;
  state?: string;
  category?: string;
  district?: string;
  highEngagement?: string;
  goodEngagement?: string;
  averageEngagement?: string;
  lowEngagement?: string;
  notMeasured?: string;
  level?: string;
};

type NationalAnalytics = {
  summary: AnalyticsSummary;
  states: AnalyticsBreakdown[];
  categories: AnalyticsBreakdown[];
};

type StateAnalytics = {
  state: string;
  summary: AnalyticsSummary;
  districts: AnalyticsBreakdown[];
  categories: AnalyticsBreakdown[];
  engagementDistribution: AnalyticsBreakdown[];
};

type ImportReport = {
  inserted: number;
  skipped: number;
  duplicates: number;
  updated: number;
  rejected: Array<{ row: number; reason: string }>;
  additionalRejected: number;
};

type ImportPreviewRow = { row: number; status: "new" | "update" | "duplicate" | "skip"; reason: string };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: "include",
      headers: { "content-type": "application/json", ...init?.headers },
      cache: "no-store",
    });
  } catch {
    throw new Error("The API is not reachable. Start the app with Docker Compose and try again.");
  }
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || "The request could not be completed.") as ApiError;
    error.status = response.status;
    throw error;
  }
  return body as T;
}

type XPostCollection = {
  id: string; topics: string[]; startDate: string; endDate: string; maxItems: number;
  status: "queued" | "running" | "completed" | "partial" | "failed";
  topicsTotal: number; topicsCompleted: number; postsSaved: number;
  topicProgress: Array<{ topic: string; status: string; postsFound: number; error?: string }>;
  errorSummary: string | null; createdAt: string; finishedAt: string | null;
};

type XPostRow = {
  postId: string; postUrl: string; postText: string; createdAt: string | null;
  authorName: string | null; authorHandle: string | null; authorUrl: string | null;
  likesCount: string | number | null; repostsCount: string | number | null;
  repliesCount: string | number | null; quotesCount: string | number | null;
  language: string | null; topics: string[];
};

function XPostsPage({ canManage }: { canManage: boolean }) {
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  const [topicsText, setTopicsText] = useState("");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [maxItems, setMaxItems] = useState(100);
  const [collections, setCollections] = useState<XPostCollection[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedTopic, setSelectedTopic] = useState("");
  const [posts, setPosts] = useState<XPostRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const active = collections.some((collection) => collection.status === "queued" || collection.status === "running");
  const selected = collections.find((collection) => collection.id === selectedId) || null;

  const loadCollections = useCallback(async () => {
    const result = await api<{ collections: XPostCollection[] }>("/x-post-collections");
    setCollections(result.collections);
    setSelectedId((current) => current && result.collections.some((item) => item.id === current) ? current : result.collections[0]?.id || "");
  }, []);

  useEffect(() => {
    let live = true;
    api<{ collections: XPostCollection[] }>("/x-post-collections")
      .then((result) => { if (live) { setCollections(result.collections); setSelectedId(result.collections[0]?.id || ""); } })
      .catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : "Could not load X collections."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => { void loadCollections().catch((reason) => setError(reason instanceof Error ? reason.message : "Could not refresh collection status.")); }, 3500);
    return () => window.clearInterval(timer);
  }, [active, loadCollections]);

  useEffect(() => {
    if (!selectedId) { setPosts([]); setTotal(0); return; }
    let live = true;
    api<{ posts: XPostRow[]; total: number; page: number }>(`/x-post-collections/${encodeURIComponent(selectedId)}/posts?page=${page}${selectedTopic ? `&topic=${encodeURIComponent(selectedTopic)}` : ""}`)
      .then((result) => { if (live) { setPosts(result.posts); setTotal(result.total); } })
      .catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : "Could not load saved posts."); });
    return () => { live = false; };
  }, [selectedId, selectedTopic, page, selected?.status, selected?.postsSaved, selected?.topicsCompleted]);

  async function startCollection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const topics = [...new Set(topicsText.split(/\r?\n/).map((topic) => topic.trim()).filter(Boolean))];
    if (!topics.length) { setError("Enter at least one topic, one per line."); return; }
    setSubmitting(true); setError("");
    try {
      const result = await api<{ collectionId: string }>("/x-post-collections", { method: "POST", body: JSON.stringify({ topics, startDate, endDate, maxItems }) });
      setTopicsText(""); setSelectedTopic(""); setPage(0); setSelectedId(result.collectionId);
      await loadCollections();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not start X post collection."); }
    finally { setSubmitting(false); }
  }

  async function exportPosts() {
    if (!selected) return;
    setError("");
    try {
      const query = selectedTopic ? `?topic=${encodeURIComponent(selectedTopic)}` : "";
      const response = await fetch(`${API_BASE}/x-post-collections/${encodeURIComponent(selected.id)}/export${query}`, { credentials: "include", cache: "no-store" });
      if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || "Could not export these posts."); }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `x-posts-${selected.id.slice(0, 8)}.xlsx`;
      document.body.append(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not export these posts."); }
  }

  const pages = Math.max(1, Math.ceil(total / 50));
  return <section className="x-posts-page">
    <section className="analytics-toolbar page-title-toolbar"><div className="analytics-page-heading"><span className="eyebrow">SOCIAL LISTENING</span><h1>X posts</h1></div></section>
    <section className="panel x-post-collection-panel">
      <div className="panel-heading"><div><h2>Find posts by topic</h2><p>Search X posts, save the results in PostgreSQL, and export them to Excel.</p></div></div>
      <form className="x-post-form" onSubmit={(event) => void startCollection(event)}>
        <label className="x-post-topics">Topics <span>One topic per line, up to 20</span><textarea value={topicsText} onChange={(event) => setTopicsText(event.target.value)} placeholder={'e.g. election results\nclimate policy'} rows={4} maxLength={4200} disabled={!canManage || submitting || active} /></label>
        <div className="x-post-form-row"><label>From<input type="date" value={startDate} max={endDate} onChange={(event) => setStartDate(event.target.value)} disabled={!canManage || submitting || active} /></label><label>Through<input type="date" value={endDate} min={startDate} max={today} onChange={(event) => setEndDate(event.target.value)} disabled={!canManage || submitting || active} /></label><label>Max posts per topic<select value={maxItems} onChange={(event) => setMaxItems(Number(event.target.value))} disabled={!canManage || submitting || active}><option value={10}>10</option><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label><button type="submit" className="button button-primary" disabled={!canManage || submitting || active}>{submitting ? "Starting…" : active ? "Collection running…" : "Collect X posts"}</button></div>
        <p className="x-post-note">Results are ordered by Top for each topic. Free demo runs return up to 10 posts per topic; higher limits depend on your Apify plan and actor access.</p>
      </form>
      {error && <div className="notice notice-error" role="alert"><span>{error}</span></div>}
    </section>
    <section className="panel x-post-history-panel"><div className="panel-heading"><div><h2>Saved collections</h2><p>Previous runs and their PostgreSQL results.</p></div><button type="button" className="button button-secondary" onClick={() => void loadCollections().catch((reason) => setError(reason instanceof Error ? reason.message : "Could not refresh collections."))}>Refresh</button></div>
      {loading ? <div className="analytics-empty">Loading saved collections…</div> : collections.length ? <div className="x-post-history">{collections.map((collection) => <button type="button" className={`x-post-history-item${selectedId === collection.id ? " selected" : ""}`} key={collection.id} onClick={() => { setSelectedId(collection.id); setSelectedTopic(""); setPage(0); }}><span className={`job-status status-${collection.status}`}><i />{collection.status}</span><span><strong>{collection.topics.join(", ")}</strong><small>{collection.postsSaved} posts · {collection.createdAt ? date(collection.createdAt) : ""}</small></span></button>)}</div> : <div className="empty-state"><h3>No X post collections yet</h3><p>Add a topic above to collect and save matching posts.</p></div>}
    </section>
    {selected && <section className="panel x-post-results-panel"><div className="panel-heading"><div><h2>Posts{selected.status === "running" || selected.status === "queued" ? " · collecting" : ""}</h2><p>{total} saved posts · {selected.startDate} to {selected.endDate}</p></div><button type="button" className="button button-secondary" onClick={() => void exportPosts()} disabled={!total}>Export Excel</button></div>
      {selected.errorSummary && <div className="notice notice-error" role="status"><span>{selected.errorSummary}</span></div>}
      <div className="x-post-topic-progress">{selected.topicProgress.map((topic) => <div key={topic.topic}><span className={`job-status status-${topic.status}`}><i />{topic.status}</span><strong>{topic.topic}</strong><small>{topic.postsFound} returned{topic.error ? ` · ${topic.error}` : ""}</small></div>)}</div>
      <div className="x-post-result-tools"><label>Topic<select value={selectedTopic} onChange={(event) => { setSelectedTopic(event.target.value); setPage(0); }}><option value="">All topics</option>{selected.topics.map((topic) => <option key={topic} value={topic}>{topic}</option>)}</select></label><span>{selected.topicsCompleted} / {selected.topicsTotal} topics finished · {selected.maxItems} max per topic</span></div>
      <div className="table-scroll"><table><thead><tr><th>POST</th><th>AUTHOR</th><th>LIKES</th><th>REPOSTS</th><th>REPLIES</th><th>DATE</th></tr></thead><tbody>{posts.map((post) => <tr key={post.postId}><td className="x-post-text-cell"><a href={post.postUrl} target="_blank" rel="noreferrer">{post.postText || "Open post"}</a><small>{post.topics.join(" · ")}</small></td><td>{post.authorUrl ? <a href={post.authorUrl} target="_blank" rel="noreferrer">{post.authorName || (post.authorHandle ? `@${post.authorHandle}` : "Author")}</a> : post.authorName || "—"}{post.authorHandle && <small className="x-post-handle">@{post.authorHandle}</small>}</td><td>{post.likesCount ?? "—"}</td><td>{post.repostsCount ?? "—"}</td><td>{post.repliesCount ?? "—"}</td><td>{post.createdAt ? date(post.createdAt) : "—"}</td></tr>)}</tbody></table></div>
      {!posts.length && <div className="analytics-empty">{selected.status === "running" || selected.status === "queued" ? "Waiting for the first topic results…" : "No saved posts for this collection."}</div>}
      <div className="table-footer"><span>Page {page + 1} of {pages}</span><div className="x-post-pagination"><button className="button button-secondary button-small" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>Previous</button><button className="button button-secondary button-small" disabled={page + 1 >= pages} onClick={() => setPage((value) => value + 1)}>Next</button></div></div>
    </section>}
  </section>;
}

type KeywordVideo = {
  channelId: string;
  channelName: string;
  youtubeVideoId: string;
  videoTitle: string;
  videoDescription: string;
  publishedAt: string | null;
  matchedIn: string;
};

type KeywordResponse = {
  videos: KeywordVideo[];
  videoCount: string;
  pendingCount: string;
  failedCount: string;
  analysisTotalCount: string;
  analysisCompletedCount: string;
};

function KeywordSearchPage({ canManage, initialQuery = "" }: { canManage: boolean; initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [data, setData] = useState<KeywordResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [analysisRunning, setAnalysisRunning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [page, setPage] = useState(0);

  useEffect(() => setQuery(initialQuery), [initialQuery]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      api<KeywordResponse>(`/keywords?q=${encodeURIComponent(query.trim())}&page=${page}`)
        .then((result) => { if (active) { setData(result); setError(""); } })
        .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Could not load keywords."); })
        .finally(() => { if (active) setLoading(false); });
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, refreshKey, page]);

  useEffect(() => {
    if (!analysisRunning) return;
    let active = true;
    const timer = window.setInterval(() => {
      api<KeywordResponse>(`/keywords?q=${encodeURIComponent(query.trim())}&page=${page}`)
        .then((result) => {
          if (!active) return;
          setData(result);
          if (Number(result.pendingCount) === 0) setAnalysisRunning(false);
        })
        .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Could not refresh keyword status."); });
    }, 3500);
    const timeout = window.setTimeout(() => setAnalysisRunning(false), 180_000);
    return () => { active = false; window.clearInterval(timer); window.clearTimeout(timeout); };
  }, [analysisRunning, query, page]);

  async function generateMissingKeywords() {
    setGenerating(true);
    setAnalysisRunning(true);
    setError("");
    try {
      const result = await api<{ queued: number }>("/keywords/generate", { method: "POST" });
      if (result.queued === 0) {
        setAnalysisRunning(false);
        setError("There are no unanalyzed collected videos. Collect engagement data first.");
        return;
      }
      setRefreshKey((value) => value + 1);
    } catch (reason) {
      setAnalysisRunning(false);
      setError(reason instanceof Error ? reason.message : "Could not start keyword generation.");
    } finally {
      setGenerating(false);
    }
  }

  async function exportMatches() {
    const searchTerm = query.trim();
    if (!searchTerm || exporting) return;
    setExporting(true);
    setError("");
    try {
      const result = await api<{ query: string; videos: KeywordExportVideo[] }>(`/keywords/export?q=${encodeURIComponent(searchTerm)}`);
      if (!result.videos.length) {
        setError("There are no matching collected videos to export.");
        return;
      }
      const workbook = buildKeywordVideosXlsx(searchTerm, result.videos);
      const url = URL.createObjectURL(workbook);
      const anchor = document.createElement("a");
      const fileTerm = searchTerm.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "search";
      anchor.href = url;
      anchor.download = `yt-atlas-${fileTerm}-videos.xlsx`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not export matching videos.");
    } finally {
      setExporting(false);
    }
  }

  const title = query.trim() ? `Videos matching “${query.trim()}”` : "Search collected videos";
  return <section className="keyword-page">
    <section className="panel keyword-search-panel">
      <div className="keyword-page-heading"><div><span className="eyebrow">VIDEO DISCOVERY</span><h1>Keywords</h1><p>Keywords are still generated for collected videos. Search matches text in video titles and descriptions, not generated keywords.</p></div>{canManage && <button type="button" className="button button-secondary" onClick={() => void generateMissingKeywords()} disabled={generating || analysisRunning}>{generating ? "Starting…" : analysisRunning ? "Analyzing videos…" : "Analyze collected videos"}</button>}</div>
      <label className="keyword-search-box"><Icon name="search" size={19} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder="Search video titles or descriptions…" aria-label="Search videos by title or description" /><span>{query.trim() ? "Title + description" : "Text search"}</span></label>
      {Number(data?.failedCount) > 0 && <div className="keyword-config-note" role="status">{number(data?.failedCount)} videos could not be analyzed. Select Analyze collected videos to retry.</div>}
      {error && <div className="notice notice-error" role="alert"><span>{error}</span></div>}
    </section>
    <section className="panel keyword-results-panel">
      <div className="panel-heading"><div><h2>{title}</h2><p>{query.trim() ? `${number(data?.videoCount)} matching videos in your database` : "Search collected video titles and descriptions."}</p></div>{query.trim() && <button type="button" className="button button-secondary keyword-export-button" onClick={() => void exportMatches()} disabled={exporting || loading || Number(data?.videoCount || 0) === 0}>{exporting ? "Preparing Excel…" : "Export Excel"}</button>}</div>
      {loading ? <div className="keyword-loading">Searching collected videos…</div> : query.trim() ? data?.videos.length ? <><div className="keyword-video-list">{data.videos.map((video) => <article className="keyword-video-row" key={`${video.channelId}-${video.youtubeVideoId}`}><span className="keyword-video-play"><Icon name="play" size={14} /></span><div className="keyword-video-copy"><a href={`https://www.youtube.com/watch?v=${encodeURIComponent(video.youtubeVideoId)}`} target="_blank" rel="noreferrer">{video.videoTitle || "Untitled video"}</a><span>{video.channelName} · {video.publishedAt ? date(video.publishedAt) : "Date unavailable"}</span>{video.videoDescription && <p>{video.videoDescription}</p>}</div><span className="matched-source">{video.matchedIn}</span><a className="keyword-open-link" href={`https://www.youtube.com/watch?v=${encodeURIComponent(video.youtubeVideoId)}`} target="_blank" rel="noreferrer" aria-label={`Open ${video.videoTitle} on YouTube`}>↗</a></article>)}</div><div className="keyword-pagination"><span>Page {page + 1} of {Math.max(1, Math.ceil(Number(data.videoCount) / 50))}</span><div><button type="button" className="button button-secondary" onClick={() => setPage((current) => Math.max(0, current - 1))} disabled={page === 0}>Previous</button><button type="button" className="button button-secondary" onClick={() => setPage((current) => current + 1)} disabled={(page + 1) * 50 >= Number(data.videoCount)}>Next</button></div></div></> : <div className="empty-state"><div className="empty-icon"><Icon name="search" size={22} /></div><h3>No videos found</h3><p>Try a different word or phrase found in a video title or description.</p></div> : null}
    </section>
  </section>;
}

function number(value: string | number | null | undefined): string {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function localDateInputValue(date: Date): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }

function locationIsMissing(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLocaleLowerCase().replace(/\s+/g, " ") || "";
  return !normalized || ["state-wide / not stated", "state wide / not stated", "statewide / not stated", "state-wide", "state wide", "statewide", "not stated", "district not specified", "district not stated", "region not specified", "region not stated", "not specified", "n/a", "na", "-", "—"].includes(normalized);
}

function districtIsMissing(value: string | null | undefined): boolean { return locationIsMissing(value); }

function compactNumber(value: string | number | null | undefined): string {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return "0";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(amount);
}

function barWidth(value: string | number | null | undefined, maximum: string | number | null | undefined): string {
  const amount = Number(value || 0);
  const max = Number(maximum || 0);
  return `${max > 0 ? Math.max(2, Math.min(100, amount / max * 100)) : 0}%`;
}

function locationKey(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
}

const indianStateKeys = new Set([
  "andhrapradesh", "arunachalpradesh", "assam", "bihar", "chhattisgarh", "goa", "gujarat", "haryana",
  "himachalpradesh", "jharkhand", "karnataka", "kerala", "madhyapradesh", "maharashtra", "manipur",
  "meghalaya", "mizoram", "nagaland", "odisha", "orissa", "punjab", "rajasthan", "sikkim", "tamilnadu",
  "telangana", "tripura", "uttarpradesh", "uttarakhand", "uttrakhand", "uttaranchal", "westbengal",
]);

const indianUnionTerritoryKeys = new Set([
  "andamanandnicobarislands", "andamannicobarislands", "andamanandnicobar", "andamannicobar", "anislands", "chandigarh",
  "dadranagarhavelianddamananddiu", "dadranagarhavelianddamandiu", "dadranagarhaveli", "damananddiu", "delhi", "nctdelhi", "nctofdelhi",
  "nationalcapitalterritoryofdelhi", "jammuandkashmir", "jammukashmir", "jk", "ladakh", "lakshadweep",
  "puducherry", "pondicherry",
]);

const indiaStateNames = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat", "Haryana",
  "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur",
  "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu",
  "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal",
];

const indiaUnionTerritoryNames = [
  "Andaman and Nicobar Islands", "Chandigarh", "Dadra and Nagar Haveli and Daman and Diu", "Delhi",
  "Jammu and Kashmir", "Ladakh", "Lakshadweep", "Puducherry",
];

function indiaLocationType(value: string): "State" | "Union Territory" | null {
  const key = locationKey(value);
  if (indianStateKeys.has(key)) return "State";
  if (indianUnionTerritoryKeys.has(key)) return "Union Territory";
  return null;
}

const dataVisualizationPalette = [
  "#267dd9", "#26d926", "#d92626", "#26d9ca", "#d926d9",
  "#d9b226", "#e3639b", "#212eba", "#e38e63", "#21ba66",
  "#63bbe3", "#b6e363", "#a563e3", "#ba2197", "#ba2147",
  "#8b26d9", "#d98826", "#ba4f21", "#4563de", "#d6d926",
  "#63ba21", "#e3b263", "#e36763", "#2182ba", "#63e3aa",
  "#e363df", "#21b0ba", "#63e369", "#e3db63", "#d92674",
  "#2626d9", "#a0d926", "#a121ba", "#e363bd", "#a1ba21",
  "#21ba94",
];

const stateVisualizationPalette = [
  "#BA798C", "#66FBCC", "#D96397", "#7DDA90", "#4A5A9A", "#81B45A", "#978AE6", "#609C8A",
  "#609EE9", "#FCDA78", "#6BCCFD", "#E88759", "#4FCDCB", "#FE7F8B", "#4DB383", "#998150",
  "#F3EE6E", "#C1B9FC", "#F9BA7A", "#46A2B6", "#C57768", "#A5F1DC", "#B04A8F", "#E3B03B",
  "#5A7FBF", "#FEA04A", "#6B7C93", "#F9E0AD",
  "#8E5CC4", "#F7AAD4", "#F2DAFE", "#F77EEC", "#C2E9F5", "#FFBCAC", "#B8C5AC", "#9BE564",
];

function stateColorMap(rows: AnalyticsBreakdown[]): Map<string, string> {
  const knownLocations = [...indiaStateNames, ...indiaUnionTerritoryNames];
  const knownKeys = new Set(knownLocations.map(locationKey));
  const additionalLocations = [...new Set(rows.map((row) => row.state || "State not specified"))]
    .filter((name) => !knownKeys.has(locationKey(name)))
    .sort((a, b) => a.localeCompare(b));
  const orderedLocations = [...knownLocations, ...additionalLocations];
  const colorByKey = new Map(orderedLocations.map((name, index) => [
    locationKey(name),
    stateVisualizationPalette[index] || `hsl(${(index * 137.508) % 360} 54% 48%)`,
  ]));

  return new Map(rows.map((row) => {
    const name = row.state || "State not specified";
    return [name, colorByKey.get(locationKey(name)) || dataVisualizationPalette[0]] as const;
  }));
}

function namedColorMap(labels: string[]): Map<string, string> {
  const orderedLabels = [...new Set(labels.map((label) => label.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return new Map(orderedLabels.map((label, index) => {
    if (index < dataVisualizationPalette.length) return [label, dataVisualizationPalette[index]] as const;
    const hue = (index * 137.508) % 360;
    return [label, `hsl(${hue} 48% 43%)`] as const;
  }));
}

const engagementBarColors: Record<string, string> = {
  "High ≥4": "#26d926",
  "Good 2–4": "#d9b226",
  "Average 1–2": "#26d9ca",
  "Low <1": "#d92626",
  "Not measured": "#8b26d9",
};

function engagementLabel(rate: string | null | undefined): string {
  const value = Number(rate);
  if (rate == null || rate === "" || !Number.isFinite(value)) return "Not measured";
  if (value >= 4) return "High";
  if (value >= 2) return "Good";
  if (value >= 1) return "Average";
  return "Low";
}

function engagementFilterKey(label: string): string {
  const normalized = label.trim().toLocaleLowerCase();
  if (normalized.startsWith("high")) return "high";
  if (normalized.startsWith("good")) return "good";
  if (normalized.startsWith("average")) return "average";
  if (normalized.startsWith("low")) return "low";
  return "not measured";
}

function hasDirectContact(channel: Channel): boolean { return Number(channel.emailCount || 0) > 0 || Number(channel.phoneCount || 0) > 0; }

function hasSocialContact(channel: Channel): boolean { return Number(channel.socialLinkCount || 0) > 0 || Number(channel.websiteCount || 0) > 0; }

function date(value: string | null | undefined): string { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Not collected yet"; }

function Icon({ name, size = 19 }: { name: string; size?: number }) {
  const props = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true as const };
  switch (name) {
    case "grid": return <svg {...props}><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>;
    case "map": return <svg {...props}><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15m6-12v15"/></svg>;
    case "users": return <svg {...props}><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
    case "activity": return <svg {...props}><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>;
    case "settings": return <svg {...props}><circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.6a8 8 0 0 1-1.6.9l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.6-.9l-1.7.6-1.4-2.4 1.4-1.1a8 8 0 0 1 0-1.9L6.7 12l1.4-2.4 1.7.6a8 8 0 0 1 1.6-.9l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.6.9l1.7-.6 1.4 2.4-1.4 1.1a8 8 0 0 1 0 1.9Z" transform="translate(-1 -1) scale(1.08)"/></svg>;
    case "trash": return <svg {...props}><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m4 4v6m6-6v6"/></svg>;
    case "filter": return <svg {...props}><path d="M4 6h16M7 12h10m-7 6h4"/></svg>;
    case "plus": return <svg {...props}><path d="M12 5v14M5 12h14"/></svg>;
    case "refresh": return <svg {...props}><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2"/></svg>;
    case "search": return <svg {...props}><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>;
    case "play": return <svg {...props}><path d="m9 6 10 6-10 6z" fill="currentColor" stroke="none"/></svg>;
    case "views": return <svg {...props}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>;
    case "eye": return <svg {...props}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>;
    case "eyeOff": return <svg {...props}><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 5.2A11.5 11.5 0 0 1 12 5c6.4 0 10 7 10 7a15.6 15.6 0 0 1-3 3.8M6.2 6.2C3.5 8 2 12 2 12s3.6 7 10 7a10.8 10.8 0 0 0 3-.4"/></svg>;
    case "heart": return <svg {...props}><path d="M20.8 8.8c0 4.1-8.8 10-8.8 10s-8.8-5.9-8.8-10A4.8 4.8 0 0 1 12 6.1a4.8 4.8 0 0 1 8.8 2.7Z"/></svg>;
    case "message": return <svg {...props}><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8A8.5 8.5 0 0 1 8.7 3.9a8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/></svg>;
    case "share": return <svg {...props}><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.7 10.7 6.6-4.4m-6.6 7 6.6 4.4"/></svg>;
    case "arrow": return <svg {...props}><path d="M7 17 17 7M7 7h10v10"/></svg>;
    case "lock": return <svg {...props}><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3"/></svg>;
    case "logout": return <svg {...props}><path d="M10 17l5-5-5-5M15 12H3"/><path d="M12 3h6a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3h-6"/></svg>;
    default: return <svg {...props}><circle cx="12" cy="12" r="9"/></svg>;
  }
}

type SearchablePickerOption = { value: string; label: string; detail?: string };

function SearchablePicker({ id, value, options, onChange, placeholder, ariaLabel, disabled = false }: { id: string; value: string; options: SearchablePickerOption[]; onChange: (value: string) => void; placeholder: string; ariaLabel: string; disabled?: boolean }) {
  const selectedOption = options.find((option) => option.value === value);
  const [query, setQuery] = useState(selectedOption?.label || "");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const matches = options.filter((option) => option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  useEffect(() => { if (!open) setQuery(selectedOption?.label || ""); }, [value, selectedOption?.label, open]);

  function choose(option: SearchablePickerOption) {
    setQuery(option.label);
    setOpen(false);
    onChange(option.value);
  }

  return <div className={`searchable-state-picker${disabled ? " is-disabled" : ""}`}>
    <div className="searchable-state-control">
      <Icon name="search" size={17} />
      <input id={id} className="searchable-state-input" role="combobox" aria-label={ariaLabel} aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-options`} aria-activedescendant={open && matches[activeIndex] ? `${id}-option-${activeIndex}` : undefined} autoComplete="off" value={query} placeholder={disabled ? "Select a state first" : placeholder} disabled={disabled} onFocus={() => { if (!disabled) { setQuery(""); setOpen(true); setActiveIndex(0); } }} onBlur={() => window.setTimeout(() => { setOpen(false); setQuery(selectedOption?.label || ""); }, 100)} onChange={(event) => { const nextQuery = event.target.value; setQuery(nextQuery); setOpen(true); setActiveIndex(0); if (!nextQuery) onChange(""); }} onKeyDown={(event) => {
        if (event.key === "Escape") { setOpen(false); return; }
        if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActiveIndex((index) => Math.min(open ? index + 1 : 0, Math.max(matches.length - 1, 0))); return; }
        if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)); return; }
        if (event.key === "Enter" && open && matches[activeIndex]) { event.preventDefault(); choose(matches[activeIndex]); }
      }} />
      <button type="button" className="searchable-state-toggle" aria-label={open ? "Close options" : "Open options"} aria-expanded={open} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => { if (!open) { setQuery(""); setActiveIndex(0); } setOpen((current) => !current); }}><svg aria-hidden="true" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4" /></svg></button>
    </div>
    {open && <div className="searchable-state-options" id={`${id}-options`} role="listbox" aria-label={ariaLabel}>
      {matches.map((option, index) => <button type="button" role="option" id={`${id}-option-${index}`} aria-selected={value === option.value} className={value === option.value ? "searchable-state-option selected" : "searchable-state-option"} key={option.value || `${id}-empty`} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(option)}><span>{option.label}</span>{option.detail && <small>{option.detail}</small>}</button>)}
      {matches.length === 0 && <p className="searchable-state-empty">No matching options</p>}
    </div>}
  </div>;
}

export default function Dashboard() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [adminId, setAdminId] = useState("");
  const [workspaceRole, setWorkspaceRole] = useState<"admin" | "viewer">("admin");
  const canManageWorkspace = workspaceRole === "admin";
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [apiError, setApiError] = useState("");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [tab, setTab] = useState<DashboardTab>("overview");
  const [globalVideoSearch, setGlobalVideoSearch] = useState("");
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [routeReady, setRouteReady] = useState(false);
  const workspaceActionsRef = useRef<HTMLDetailsElement | null>(null);
  const channelsTableScrollRef = useRef<HTMLDivElement | null>(null);
  const [selectedState, setSelectedState] = useState("");
  const [nationalStateSearch, setNationalStateSearch] = useState("");
  const [nationalMetric, setNationalMetric] = useState<"channelCount" | "subscriberCount" | "channelViews">("channelCount");
  const [stateCategoryFilter, setStateCategoryFilter] = useState("");
  const [stateEngagementFilter, setStateEngagementFilter] = useState("");
  const [stateDistrictFilter, setStateDistrictFilter] = useState("");
  const [stateSizeFilter, setStateSizeFilter] = useState("");
  const [stateContactFilter, setStateContactFilter] = useState("");
  const [stateKpiFilters, setStateKpiFilters] = useState<StateKpiFilter[]>([]);
  const [profileRefreshKey, setProfileRefreshKey] = useState(0);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState(ALL_CHANNEL_FILTER_VALUE);
  const [stateFilter, setStateFilter] = useState(ALL_CHANNEL_FILTER_VALUE);
  const [regionFilter, setRegionFilter] = useState("");
  const [districtFilter, setDistrictFilter] = useState("");
  useEffect(() => {
    setStateFilter((current) => selectedState ? selectedState : current === ALL_CHANNEL_FILTER_VALUE ? current : "");
    setRegionFilter("");
    setDistrictFilter("");
  }, [selectedState]);
  const [showAdd, setShowAdd] = useState(false);
  const [showClearDatabase, setShowClearDatabase] = useState(false);
  const [clearDatabaseBusy, setClearDatabaseBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [taskToasts, setTaskToasts] = useState<TaskToast[]>([]);
  const taskToastTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const analysisToastId = useRef("");
  const analysisToastDismissed = useRef(false);
  const [analysisTracking, setAnalysisTracking] = useState(false);
  const [analysisStarting, setAnalysisStarting] = useState(false);
  const pushTaskToast = useCallback((kind: TaskToastKind, state: TaskToastState, message: string, progress?: TaskToast["progress"]) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setTaskToasts((current) => [...current, { id, kind, state, message, progress }]);
    if (kind === "analysis" && state === "started") return id;
    taskToastTimers.current.set(id, setTimeout(() => {
      setTaskToasts((current) => current.filter((toast) => toast.id !== id));
      taskToastTimers.current.delete(id);
    }, 5_000));
    return id;
  }, []);
  const updateAnalysisToast = useCallback((state: "started" | "completed" | "warning" | "error", message: string, progress?: TaskToast["progress"]) => {
    if (state === "started" && analysisToastDismissed.current) return;
    if (state !== "started") analysisToastDismissed.current = false;
    const toastId = analysisToastId.current || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    analysisToastId.current = toastId;
    setTaskToasts((current) => current.some((toast) => toast.id === toastId)
      ? current.map((toast) => toast.id === toastId ? { ...toast, state, message, progress } : toast)
      : [...current, { id: toastId, kind: "analysis", state, message, progress }]);
    const oldTimer = taskToastTimers.current.get(toastId);
    if (oldTimer) clearTimeout(oldTimer);
    taskToastTimers.current.delete(toastId);
    if (state !== "started") {
      taskToastTimers.current.set(toastId, setTimeout(() => {
        setTaskToasts((current) => current.filter((toast) => toast.id !== toastId));
        taskToastTimers.current.delete(toastId);
        if (analysisToastId.current === toastId) analysisToastId.current = "";
      }, 5_000));
    }
  }, []);
  const dismissTaskToast = useCallback((id: string) => {
    const timer = taskToastTimers.current.get(id);
    if (timer) clearTimeout(timer);
    taskToastTimers.current.delete(id);
    if (analysisToastId.current === id) {
      analysisToastId.current = "";
      analysisToastDismissed.current = true;
    }
    setTaskToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const [collectionJobs, setCollectionJobs] = useState<Partial<Record<CollectionScope, string>>>({});
  const [startingCollections, setStartingCollections] = useState<Set<CollectionScope>>(() => new Set());
  const [rangeStartDate, setRangeStartDate] = useState("");
  const [rangeEndDate, setRangeEndDate] = useState("");
  const [rangeStartTime, setRangeStartTime] = useState("");
  const [rangeEndTime, setRangeEndTime] = useState("");
  const [nationalAnalytics, setNationalAnalytics] = useState<NationalAnalytics | null>(null);
  const [stateAnalytics, setStateAnalytics] = useState<StateAnalytics | null>(null);
  const [stateAnalyticsLoading, setStateAnalyticsLoading] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importRows, setImportRows] = useState<ChannelImportRow[]>([]);
  const [importFileName, setImportFileName] = useState("");
  const [importReport, setImportReport] = useState<ImportReport | null>(null);
  const [importNoticeReport, setImportNoticeReport] = useState<ImportReport | null>(null);
  const [showImportSkipReasons, setShowImportSkipReasons] = useState(false);
  const [importError, setImportError] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [googleSheetUrl, setGoogleSheetUrl] = useState("");
  const [googleSheetBusy, setGoogleSheetBusy] = useState(false);
  const modalBusyRef = useRef({ clearDatabaseBusy, importBusy, googleSheetBusy });
  modalBusyRef.current = { clearDatabaseBusy, importBusy, googleSheetBusy };

  useEffect(() => () => {
    taskToastTimers.current.forEach((timer) => clearTimeout(timer));
    taskToastTimers.current.clear();
  }, []);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileMenuOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileMenuOpen]);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const dialog = document.querySelector<HTMLElement>('.modal[role="dialog"]');
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.getAttribute('aria-hidden') !== 'true');
    (dialog.querySelector<HTMLElement>('.clear-database-modal .button-secondary')
      || dialog.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled)')
      || focusable()[0])?.focus();
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        const busyState = modalBusyRef.current;
        if (showClearDatabase && !busyState.clearDatabaseBusy) setShowClearDatabase(false);
        else if (showImport && !busyState.importBusy && !busyState.googleSheetBusy) {
          setShowImport(false);
          setImportRows([]);
          setImportFileName("");
          setImportReport(null);
          setImportError("");
          setGoogleSheetUrl("");
          if (importInputRef.current) importInputRef.current.value = "";
        }
        else if (showAdd) setShowAdd(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); dialog.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', handleDialogKeys);
    return () => {
      document.removeEventListener('keydown', handleDialogKeys);
      previousFocus?.focus();
    };
  }, [showAdd, showClearDatabase, showImport]);

  useEffect(() => {
    const restoreRoute = () => {
      const route = readDashboardRoute(window.location.hash);
      setTab(route.tab);
      setSelectedChannelId(route.channelId);
      setGlobalVideoSearch(route.query);
      setRouteReady(true);
    };
    restoreRoute();
    window.addEventListener("popstate", restoreRoute);
    window.addEventListener("hashchange", restoreRoute);
    return () => {
      window.removeEventListener("popstate", restoreRoute);
      window.removeEventListener("hashchange", restoreRoute);
    };
  }, []);

  useEffect(() => {
    if (!routeReady) return;
    const route = dashboardRoute(tab, selectedChannelId, globalVideoSearch);
    if (window.location.hash !== route) window.history.pushState({ dashboardRoute: true }, "", route);
  }, [routeReady, tab, selectedChannelId, globalVideoSearch]);

  const importPreview = useMemo<ImportPreviewRow[]>(() => {
    const knownIds = new Set(channels.map((channel) => channel.youtubeChannelId.trim()));
    const seenIds = new Set<string>();
    const categories = new Set(["news & politics", "infotainment", "people & blog"]);
    return importRows.map((row, index) => {
      const id = row.youtubeChannelId.trim();
      if (!row.channelName.trim()) return { row: index + 2, status: "skip", reason: "Channel name is required." };
      if (row.channelName.trim().length > 200) return { row: index + 2, status: "skip", reason: "Channel name is longer than 200 characters." };
      if (!id) return { row: index + 2, status: "skip", reason: "Channel ID is required." };
      if (id.length > 120) return { row: index + 2, status: "skip", reason: "Channel ID is longer than 120 characters." };
      if (!row.category.trim()) return { row: index + 2, status: "skip", reason: "Category is required." };
      if (!categories.has(row.category.trim().toLocaleLowerCase().replace(/\s+/g, " "))) return { row: index + 2, status: "skip", reason: "Category must be News & Politics, Infotainment, or People & Blog." };
      if (seenIds.has(id)) return { row: index + 2, status: "duplicate", reason: "Repeated channel ID in this sheet; this row will update the earlier row." };
      seenIds.add(id);
      if (knownIds.has(id)) return { row: index + 2, status: "update", reason: "Channel ID already exists; details will be updated." };
      return { row: index + 2, status: "new", reason: "New channel." };
    });
  }, [channels, importRows]);

  const refresh = useCallback(async () => {
    const [channelResponse, jobResponse, nationalResponse] = await Promise.all([
      api<{ channels: Channel[] }>('/channels'),
      api<{ jobs: Job[] }>('/collection-jobs'),
      api<NationalAnalytics>('/analytics/national'),
    ]);
    setChannels(channelResponse.channels);
    setJobs(jobResponse.jobs);
    setNationalAnalytics(nationalResponse);
  }, []);

  useEffect(() => {
    api<{ adminId: string; role: "admin" | "viewer" }>('/auth/me')
      .then(async (data) => {
        setAdminId(data.adminId);
        setWorkspaceRole(data.role);
        setSignedIn(true);
        try { await refresh(); } catch (error) { setApiError(error instanceof Error ? error.message : "Could not load the dashboard."); }
      })
      .catch(() => setSignedIn(false));
  }, [refresh]);

  useEffect(() => {
    const jobsToCheck = Object.entries(collectionJobs) as Array<[CollectionScope, string]>;
    if (!jobsToCheck.length || !signedIn) return;
    let checking = false;
    const timer = window.setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        await Promise.all(jobsToCheck.map(async ([scope, jobId]) => {
          try {
            const data = await api<{ job: Job }>(`/collection-jobs/${jobId}`);
            if (["completed", "partial", "failed"].includes(data.job.status)) {
              setCollectionJobs((current) => {
                if (current[scope] !== jobId) return current;
                const next = { ...current };
                delete next[scope];
                return next;
              });
              const toastState: TaskToastState = data.job.status === "completed" ? "completed" : data.job.status === "partial" ? "warning" : "error";
              if (scope === "all") {
                pushTaskToast("views", toastState, `Views collection ${data.job.status === "completed" ? "completed" : data.job.status === "partial" ? "finished with issues" : "failed"}.`);
                pushTaskToast("engagement", toastState, `Engagement collection ${data.job.status === "completed" ? "completed" : data.job.status === "partial" ? "finished with issues" : "failed"}.`);
              } else {
                const label = scope === "views" ? "Views collection" : "Engagement collection";
                pushTaskToast(scope === "views" ? "views" : "engagement", toastState, `${label} ${data.job.status === "completed" ? "completed" : data.job.status === "partial" ? "finished with issues" : "failed"}.`);
              }
              await refresh();
              setProfileRefreshKey((value) => value + 1);
            }
          } catch (error) {
            setCollectionJobs((current) => {
              if (current[scope] !== jobId) return current;
              const next = { ...current };
              delete next[scope];
              return next;
            });
            setApiError(error instanceof Error ? error.message : "Could not check collection progress.");
          }
        }));
      } finally {
        checking = false;
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [collectionJobs, signedIn, refresh, pushTaskToast]);

  useEffect(() => {
    if (!analysisTracking || !signedIn) return;
    let active = true;
    let checking = false;
    let finished = false;
    const checkAnalysis = async () => {
      if (checking || finished) return;
      checking = true;
      try {
        const status = await api<{
          pendingCount: string;
          failedCount: string;
          analysisTotalCount: string;
          analysisCompletedCount: string;
        }>("/keywords");
        if (!active) return;
        const total = Number(status.analysisTotalCount) || 0;
        const completed = Math.min(total, Number(status.analysisCompletedCount) || 0);
        if (Number(status.pendingCount) === 0) {
          finished = true;
          setAnalysisTracking(false);
          setProfileRefreshKey((value) => value + 1);
          const failedCount = Number(status.failedCount);
          const message = failedCount > 0
            ? `Video analysis completed with ${number(failedCount)} videos needing a retry.`
            : "Video analysis completed.";
          updateAnalysisToast(failedCount > 0 ? "warning" : "completed", message, { completed: total, total });
        } else {
          const done = Math.max(completed, total - Number(status.pendingCount));
          updateAnalysisToast("started", `Analyzing ${number(done)} of ${number(total)} videos…`, { completed: done, total });
        }
      } catch {
        // Keep polling through temporary API errors; the work continues in the API service.
      } finally {
        checking = false;
      }
    };
    void checkAnalysis();
    const timer = window.setInterval(() => void checkAnalysis(), 2_500);
    return () => { active = false; window.clearInterval(timer); };
  }, [analysisTracking, signedIn, updateAnalysisToast]);

  useEffect(() => {
    if (!signedIn || tab !== "stateData" || !selectedState) return;
    let active = true;
    setStateAnalyticsLoading(true);
    setApiError("");
    api<StateAnalytics>(`/analytics/states/${encodeURIComponent(selectedState)}`)
      .then((data) => { if (active) setStateAnalytics(data); })
      .catch((error) => { if (active) setApiError(error instanceof Error ? error.message : "Could not load state analytics."); })
      .finally(() => { if (active) setStateAnalyticsLoading(false); });
    return () => { active = false; };
  }, [signedIn, tab, selectedState]);

  const hasChannelFilter = Boolean(search.trim() || categoryFilter || stateFilter || regionFilter || districtFilter);

  const filteredChannels = useMemo(() => {
    if (!hasChannelFilter) return [];
    const term = search.trim().toLocaleLowerCase();
    return channels.filter((channel) => [channel.channelName, channel.youtubeChannelId, channel.category, channel.state, channel.region, channel.district]
      .some((value) => !term || value?.toLocaleLowerCase().includes(term))
      && (!categoryFilter || categoryFilter === ALL_CHANNEL_FILTER_VALUE || channel.category === categoryFilter)
      && (!stateFilter || stateFilter === ALL_CHANNEL_FILTER_VALUE
        || (stateFilter === UNSPECIFIED_STATE_FILTER ? !channel.state?.trim() : channel.state?.trim() === stateFilter))
      && (!regionFilter || regionFilter === ALL_CHANNEL_FILTER_VALUE || channel.region?.trim() === regionFilter)
      && (!districtFilter || districtFilter === ALL_CHANNEL_FILTER_VALUE || channel.district?.trim() === districtFilter))
      .sort((left, right) => Number(right.subscriberCount || 0) - Number(left.subscriberCount || 0));
  }, [channels, search, categoryFilter, stateFilter, regionFilter, districtFilter, hasChannelFilter]);

  useEffect(() => {
    if (selectedChannelId || tab !== "channels") return;
    const scrollArea = channelsTableScrollRef.current;
    if (!scrollArea) return;

    const handleWheel = (event: WheelEvent) => {
      const modeScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scrollArea.clientHeight : 1;
      const delta = event.deltaY * modeScale;
      const maxScrollTop = scrollArea.scrollHeight - scrollArea.clientHeight;
      const atTop = scrollArea.scrollTop <= 0;
      const atBottom = scrollArea.scrollTop >= maxScrollTop - 1;
      if (!delta || (delta < 0 && atTop) || (delta > 0 && atBottom)) return;

      event.preventDefault();
      scrollArea.scrollTop += delta * 0.75;
    };

    scrollArea.addEventListener("wheel", handleWheel, { passive: false });
    return () => scrollArea.removeEventListener("wheel", handleWheel);
  }, [tab, selectedChannelId, filteredChannels.length]);

  const filterOptions = useMemo(() => {
    const values = (field: "category" | "state") => Array.from(
      new Set(channels.map((channel) => channel[field]?.trim()).filter((value): value is string => Boolean(value))),
    ).sort((a, b) => a.localeCompare(b));
    return {
      categories: values("category"),
      states: values("state"),
      hasUnspecifiedState: channels.some((channel) => !channel.state?.trim()),
    };
  }, [channels]);

  useEffect(() => {
    if (tab === "stateData" && !selectedState) {
      const firstState = filterOptions.hasUnspecifiedState ? UNSPECIFIED_STATE_FILTER : filterOptions.states[0];
      if (firstState) setSelectedState(firstState);
    }
  }, [tab, selectedState, filterOptions.states, filterOptions.hasUnspecifiedState]);

  const statePickerOptions = useMemo<SearchablePickerOption[]>(() => [
    ...(filterOptions.hasUnspecifiedState ? [{ value: UNSPECIFIED_STATE_FILTER, label: "Location not specified", detail: "Other location" }] : []),
    ...filterOptions.states.map((value) => ({ value, label: displayLocation(value), detail: indiaLocationType(value) || "Other location" })),
  ], [filterOptions.states, filterOptions.hasUnspecifiedState]);
  const channelStatePickerOptions = useMemo<SearchablePickerOption[]>(() => [
    { value: ALL_CHANNEL_FILTER_VALUE, label: "All states and UTs" },
    ...(filterOptions.hasUnspecifiedState ? [{ value: UNSPECIFIED_STATE_FILTER, label: "Location not specified", detail: "Other location" }] : []),
    ...filterOptions.states.map((value) => {
      const locationType = indiaLocationType(value);
      return { value, label: displayLocation(value), detail: locationType === "Union Territory" ? "UT" : locationType || "Other location" };
    }),
  ], [filterOptions.states, filterOptions.hasUnspecifiedState]);
  const stateScopedLocationOptions = useMemo(() => {
    if (!stateFilter || stateFilter === ALL_CHANNEL_FILTER_VALUE || stateFilter === UNSPECIFIED_STATE_FILTER) return { regions: [], districts: [] };
    const stateChannels = channels.filter((channel) => channel.state?.trim() === stateFilter);
    const regions = Array.from(new Set(stateChannels.map((channel) => channel.region?.trim()).filter((value): value is string => Boolean(value) && !locationIsMissing(value)))).sort((a, b) => a.localeCompare(b));
    const districtChannels = regionFilter && regionFilter !== ALL_CHANNEL_FILTER_VALUE
      ? stateChannels.filter((channel) => channel.region?.trim() === regionFilter)
      : stateChannels;
    const districts = Array.from(new Set(districtChannels.map((channel) => channel.district?.trim()).filter((value): value is string => Boolean(value) && !districtIsMissing(value)))).sort((a, b) => a.localeCompare(b));
    return { regions, districts };
  }, [channels, stateFilter, regionFilter]);
  const regionPickerOptions = useMemo<SearchablePickerOption[]>(() => [
    ...stateScopedLocationOptions.regions.map((value) => ({ value, label: displayLocation(value) })),
  ], [stateFilter, stateScopedLocationOptions.regions]);
  const districtPickerOptions = useMemo<SearchablePickerOption[]>(() => [
    ...stateScopedLocationOptions.districts.map((value) => ({ value, label: displayLocation(value) })),
  ], [stateFilter, stateScopedLocationOptions.districts]);

  const activeFilterCount = [categoryFilter, stateFilter, regionFilter, districtFilter, search.trim()]
    .filter((value) => Boolean(value) && value !== ALL_CHANNEL_FILTER_VALUE).length;

  function clearFilters() {
    setSearch("");
    setCategoryFilter(ALL_CHANNEL_FILTER_VALUE);
    setStateFilter(ALL_CHANNEL_FILTER_VALUE);
    setSelectedState("");
    setRegionFilter("");
    setDistrictFilter("");
  }

  function toggleStateKpiFilter(filter: StateKpiFilter) {
    setStateKpiFilters((current) => current.includes(filter) ? current.filter((item) => item !== filter) : [...current, filter]);
    setSearch("");
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginError("");
    setApiError("");
    setBusy(true);
    try {
      const result = await api<{ adminId: string; role: "admin" | "viewer" }>('/auth/login', {
        method: "POST",
        body: JSON.stringify({ adminId: loginId, password }),
      });
      setAdminId(result.adminId);
      setWorkspaceRole(result.role);
      setSignedIn(true);
      setPassword("");
      setSelectedChannelId(null);
      setTab("overview");
      try {
        await refresh();
      } catch (error) {
        setApiError(error instanceof Error ? error.message : "Could not load the dashboard.");
      }
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    await api('/auth/logout', { method: "POST" }).catch(() => undefined);
    setSignedIn(false);
    setChannels([]);
    setJobs([]);
  }

  async function handleClearDatabase() {
    setClearDatabaseBusy(true);
    setApiError("");
    try {
      await api('/workspace/data', { method: "DELETE" });
      setShowClearDatabase(false);
      setSelectedChannelId(null);
      setTab("overview");
      setSelectedState("");
      setChannels([]);
      setJobs([]);
      setNationalAnalytics(null);
      setStateAnalytics(null);
      setStateCategoryFilter("");
      setStateEngagementFilter("");
      setStateDistrictFilter("");
      setStateSizeFilter("");
      setStateContactFilter("");
      setStateKpiFilters([]);
      setSearch("");
      clearFilters();
      setNotice("Workspace data and collection history were cleared. Your admin login remains available.");
      try {
        await refresh();
      } catch (error) {
        setApiError(error instanceof Error ? `Workspace data was cleared, but the dashboard could not refresh: ${error.message}` : "Workspace data was cleared, but the dashboard could not refresh.");
      }
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "The database could not be cleared.");
    } finally {
      setClearDatabaseBusy(false);
    }
  }

  async function handleChannelDeleted() {
    setSelectedChannelId(null);
    setNotice("The channel and its stored data were deleted.");
    setApiError("");
    try {
      await refresh();
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "The channel was deleted, but the dashboard could not refresh.");
    }
  }

  async function handleAddChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setApiError("");
    try {
      await api('/channels', {
        method: "POST",
        body: JSON.stringify({
          channelName: form.get("channelName"),
          youtubeChannelId: form.get("youtubeChannelId"),
          category: form.get("category"),
          state: form.get("state"),
          region: form.get("region"),
          district: form.get("district"),
        }),
      });
      setShowAdd(false);
      setNotice("Channel added. Refresh metrics to collect its current YouTube data.");
      await refresh();
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Could not add the channel.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSpreadsheetPicked(event: FormEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    setImportError("");
    setImportRows([]);
    setImportReport(null);
    if (!file) return;
    setGoogleSheetUrl("");
    try {
      const rows = await readChannelSpreadsheet(file);
      setImportRows(rows);
      setImportFileName(file.name);
    } catch (error) {
      setImportFileName("");
      setImportError(error instanceof Error ? error.message : "Could not read this spreadsheet.");
    }
  }

  async function handleGoogleSheetLoad() {
    if (!googleSheetUrl.trim()) return;
    setGoogleSheetBusy(true);
    setImportError("");
    setImportRows([]);
    setImportFileName("");
    setImportReport(null);
    if (importInputRef.current) importInputRef.current.value = "";
    try {
      const { csv } = await api<{ csv: string }>("/channels/google-sheet-csv", {
        method: "POST",
        body: JSON.stringify({ url: googleSheetUrl.trim() }),
      });
      const file = new File([csv], "Google Sheets.csv", { type: "text/csv" });
      const rows = await readChannelSpreadsheet(file);
      setImportRows(rows);
      setImportFileName("Google Sheets");
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Could not load this Google Sheet.");
    } finally {
      setGoogleSheetBusy(false);
    }
  }

  function openImport() {
    setImportRows([]);
    setImportFileName("");
    setImportReport(null);
    setImportError("");
    setGoogleSheetUrl("");
    setShowImport(true);
  }

  async function handleImportChannels() {
    if (!importRows.length) return;
    setImportBusy(true);
    setImportError("");
    setImportReport(null);
    try {
      const result = await api<ImportReport>("/channels/bulk-import", {
        method: "POST",
        body: JSON.stringify({ rows: importRows }),
      });
      setImportReport(result);
      setImportNoticeReport(result.skipped > 0 ? result : null);
      setShowImportSkipReasons(false);
      setNotice(`Spreadsheet import finished: ${number(result.inserted)} added, ${number(result.updated)} updated, and ${number(result.skipped)} skipped.`);
      await refresh();
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Could not import these channels.");
    } finally {
      setImportBusy(false);
    }
  }

  function closeWorkspaceActions() {
    if (workspaceActionsRef.current) workspaceActionsRef.current.open = false;
  }

  function renderWorkspaceActions() {
    if (!canManageWorkspace) return null;
    return <details className="workspace-actions-menu" ref={workspaceActionsRef}>
      <summary className="button button-secondary">Workspace actions <span aria-hidden="true">▾</span></summary>
      <div className="workspace-actions-popover">
        <button type="button" onClick={() => { closeWorkspaceActions(); setShowAdd(true); }}><Icon name="plus" size={15} />Add channel</button>
        <button type="button" onClick={() => { closeWorkspaceActions(); openImport(); }}><Icon name="plus" size={15} />Add from Excel</button>
      </div>
    </details>;
  }

  function closeImport() {
    setShowImport(false);
    setImportRows([]);
    setImportFileName("");
    setImportReport(null);
    setImportError("");
    setGoogleSheetUrl("");
    if (importInputRef.current) importInputRef.current.value = "";
  }

  function openState(state: string) {
    setSelectedState(state);
    setSelectedChannelId(null);
    setStateAnalytics(null);
    setTab("stateData");
  }

  function showStateContactGroup(group: "direct" | "social" | "none") {
    setStateContactFilter((current) => current === group ? "" : group);
    setSearch("");
  }

  function showStateCategory(category: string) {
    setStateCategoryFilter((current) => current === category ? "" : category);
    setSearch("");
  }

  function showStateEngagement(label: string) {
    const group = engagementFilterKey(label);
    setStateEngagementFilter((current) => current === group ? "" : group);
    setSearch("");
  }

  function collectionActive(scope: CollectionScope) {
    if (startingCollections.has(scope) || collectionJobs[scope]) return true;
    if (scope === "all") return Boolean(collectionJobs.views || collectionJobs.engagement || startingCollections.has("views") || startingCollections.has("engagement"));
    return Boolean(collectionJobs.all || startingCollections.has("all"));
  }

  async function handleCollect(scope: CollectionScope = "all") {
    if (collectionActive(scope)) return;
    setStartingCollections((current) => new Set(current).add(scope));
    setNotice("");
    setApiError("");
    try {
      const route = scope === "all" ? "/collection-jobs" : `/collection-jobs/${scope}`;
      const result = await api<{ jobId: string }>(route, { method: "POST", body: "{}" });
      setCollectionJobs((current) => ({ ...current, [scope]: result.jobId }));
      if (scope === "all") {
        pushTaskToast("views", "started", "Views collection started.");
        pushTaskToast("engagement", "started", "Engagement collection started.");
      } else {
        pushTaskToast(scope === "views" ? "views" : "engagement", "started", `${scope === "views" ? "Views" : "Engagement"} collection started.`);
      }
      await refresh();
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Could not start a collection.");
    } finally {
      setStartingCollections((current) => {
        const next = new Set(current);
        next.delete(scope);
        return next;
      });
    }
  }

  async function handleCollectUploadRange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const hasCompleteTimeRange = Boolean(rangeStartTime) === Boolean(rangeEndTime);
    if (!rangeStartDate || !rangeEndDate || rangeStartDate > rangeEndDate || !hasCompleteTimeRange ||
      (rangeStartDate === rangeEndDate && rangeStartTime && rangeEndTime && rangeStartTime > rangeEndTime) ||
      collectionActive("engagement")) return;
    setStartingCollections((current) => new Set(current).add("engagement"));
    setNotice("");
    setApiError("");
    try {
      const result = await api<{ jobId: string }>("/collection-jobs/engagement-range", {
        method: "POST",
        body: JSON.stringify({ startDate: rangeStartDate, endDate: rangeEndDate, startTime: rangeStartTime, endTime: rangeEndTime }),
      });
      setCollectionJobs((current) => ({ ...current, engagement: result.jobId }));
      pushTaskToast("engagement", "started", `Collecting videos published ${rangeStartDate}${rangeStartTime ? ` ${rangeStartTime}` : ""} through ${rangeEndDate}${rangeEndTime ? ` ${rangeEndTime} IST` : ""}.`);
      await refresh();
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Could not start date-range collection.");
    } finally {
      setStartingCollections((current) => {
        const next = new Set(current);
        next.delete("engagement");
        return next;
      });
    }
  }

  async function handleAnalyzeVideos() {
    if (!canManageWorkspace || analysisStarting || analysisTracking) return;
    setAnalysisStarting(true);
    setApiError("");
    analysisToastDismissed.current = false;
    try {
      const result = await api<{ queued: number }>("/keywords/generate", { method: "POST" });
      if (result.queued === 0) {
        pushTaskToast("analysis", "warning", "No unanalyzed collected videos are waiting.");
        return;
      }
      updateAnalysisToast("started", `Video analysis started for ${number(result.queued)} collected videos…`, { completed: 0, total: result.queued });
      setAnalysisTracking(true);
    } catch (error) {
      pushTaskToast("analysis", "error", error instanceof Error ? error.message : "Could not start video analysis.");
    } finally {
      setAnalysisStarting(false);
    }
  }

  function handleGlobalVideoSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextQuery = globalVideoSearch.trim();
    if (!nextQuery) return;
    setGlobalVideoSearch(nextQuery);
    setSelectedChannelId(null);
    setTab("keywords");
    setMobileMenuOpen(false);
  }

  function openVideoDiscovery() {
    if (selectedChannelId) setSelectedChannelId(null);
    setTab("keywords");
    setMobileMenuOpen(false);
  }

  function renderAnalyzeVideosButton() {
    return <button className="button button-secondary" onClick={() => void handleAnalyzeVideos()} disabled={!canManageWorkspace || channels.length === 0 || analysisStarting || analysisTracking}>
      {analysisStarting ? "Starting analysis…" : analysisTracking ? "Analyzing videos…" : "Analyze videos"}
    </button>;
  }

  async function handleOutreachStatusChange(channelId: string, status: NonNullable<Channel["outreachStatus"]> | "not_tracked") {
    setBusy(true);
    setApiError("");
    try {
      await api(`/channels/${channelId}/outreach-status`, { method: "PATCH", body: JSON.stringify({ status }) });
      await refresh();
      setNotice("Outreach status saved.");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Could not save the outreach status.");
    } finally {
      setBusy(false);
    }
  }

  if (signedIn === null) {
    return <main className="boot-screen" role="status" aria-live="polite"><div className="loader-mark" aria-hidden="true"><Icon name="play" size={24} /></div><span>Opening your workspace…</span></main>;
  }

  if (!signedIn) {
    return (
      <main className="login-layout">
        <a className="skip-link" href="#login-form">Skip to sign in</a>
        <header className="login-header">
          <div className="login-header-brand"><span className="brand-mark"><Icon name="play" size={16} /></span><span>YT <strong>Atlas</strong></span></div>
        </header>
        <section className="login-panel" id="login-form" tabIndex={-1}>
          <div className="login-form-wrap"><p className="eyebrow">ADMIN WORKSPACE</p><h1>Welcome back</h1><p className="muted">Sign in with your dashboard admin ID.</p>
            <form className="login-form" onSubmit={handleLogin} aria-busy={busy} aria-describedby={loginError ? "login-error" : undefined}>
              <label htmlFor="admin-id">Admin ID</label><input id="admin-id" name="adminId" autoComplete="username" value={loginId} onChange={(event) => setLoginId(event.target.value)} required placeholder="Enter your admin ID" />
              <label htmlFor="admin-password">Password</label><div className="password-field"><input id="admin-password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required placeholder="Enter your password" /><button className="password-toggle" type="button" aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} onClick={() => setShowPassword((visible) => !visible)}><Icon name={showPassword ? "eyeOff" : "eye"} size={17} /></button></div>
              {loginError && <p className="form-error" id="login-error" role="alert">{loginError}</p>}
              <button className="button button-primary button-wide" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}<Icon name="arrow" size={17} /></button>
            </form>
            <p className="login-foot"><Icon name="lock" size={15} /> Private admin access · Your data stays in your workspace</p>
          </div>
          <span className="login-version">© 2026 YT ATLAS <span>·</span> PRIVATE ANALYTICS</span>
        </section>
        <aside className="login-art" aria-hidden="true">
          <div className="login-art-grid" />
          <div className="login-copy">
            <h1>Every channel,<br />in clear view.</h1>
            <p className="login-subcopy">A private workspace for channel growth, audience engagement, and regional coverage.</p>
            <div className="login-showcase-shell">
              <div className="login-dashboard-preview">
                <div className="preview-topbar"><span className="preview-brand"><i><Icon name="play" size={9} /></i><span>YT <strong>Atlas</strong></span></span><span className="preview-placeholder-pill" /></div>
                <div className="preview-insight-heading"><span>WORKSPACE INSIGHTS</span><i /></div>
                <div className="preview-visual-grid">
                  <section className="preview-visual-card preview-trend-card" aria-label="Illustrative trend chart">
                    <div className="preview-visual-title"><i /><i /></div>
                    <svg className="preview-line-chart" viewBox="0 0 420 112" preserveAspectRatio="none" aria-hidden="true">
                      <defs><linearGradient id="preview-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#d8ff45" stopOpacity=".38" /><stop offset="1" stopColor="#d8ff45" stopOpacity="0" /></linearGradient></defs>
                      <path className="preview-chart-gridline" d="M0 22H420M0 56H420M0 90H420" />
                      <path className="preview-area-fill" d="M0 88 C28 81 34 71 62 76 S97 61 123 68 S159 43 188 56 S225 60 252 42 S288 57 318 35 S359 45 388 20 S408 27 420 12 V112 H0Z" />
                      <path className="preview-trend-line" d="M0 88 C28 81 34 71 62 76 S97 61 123 68 S159 43 188 56 S225 60 252 42 S288 57 318 35 S359 45 388 20 S408 27 420 12" />
                      <circle cx="318" cy="35" r="4" className="preview-chart-point" />
                    </svg>
                    <div className="preview-chart-axis"><i /><i /><i /><i /><i /></div>
                  </section>
                  <section className="preview-visual-card preview-bars-card" aria-label="Illustrative activity analysis">
                    <div className="preview-visual-title"><i /><i /></div>
                    <div className="preview-bar-chart" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
                    <div className="preview-chart-axis"><i /><i /><i /></div>
                  </section>
                  <section className="preview-visual-card preview-mix-card" aria-label="Illustrative audience mix">
                    <div className="preview-visual-title"><i /><i /></div>
                    <div className="preview-mix-content"><div className="preview-donut" aria-hidden="true"><i /></div><div className="preview-legend" aria-hidden="true"><i /><i /><i /><i /></div></div>
                  </section>
                  <section className="preview-visual-card preview-analysis-card" aria-label="Illustrative channel analysis">
                    <div className="preview-visual-title"><i /><i /></div>
                    <div className="preview-analysis-rows" aria-hidden="true"><i /><i /><i /><i /></div>
                  </section>
                </div>
              </div>
            </div>
          </div>
          <span className="art-orbit orbit-one" /><span className="art-orbit orbit-two" />
        </aside>
      </main>
    );
  }

  const selectedStateChannels = channels.filter((channel) => selectedState === UNSPECIFIED_STATE_FILTER
    ? !channel.state?.trim()
    : channel.state?.trim().toLocaleLowerCase() === selectedState.trim().toLocaleLowerCase());
  const representedDistrictCount = new Set(selectedStateChannels
    .map((channel) => channel.district?.trim().toLocaleLowerCase().replace(/\s+/g, " ") || "")
    .filter((value) => !locationIsMissing(value))).size;
  const representedRegionCount = new Set(selectedStateChannels
    .map((channel) => channel.region?.trim().toLocaleLowerCase().replace(/\s+/g, " ") || "")
    .filter((value) => !locationIsMissing(value))).size;
  const stateAnyContactChannels = selectedStateChannels.filter((channel) => hasDirectContact(channel) || hasSocialContact(channel)).length;
  const visibleStateChannels = selectedStateChannels.filter((channel) => {
    const rateGroup = engagementLabel(channel.engagementRate).toLocaleLowerCase();
    const subscribers = Number(channel.subscriberCount || 0);
    const sizeMatches = !stateSizeFilter
      || (stateSizeFilter === "mega" && subscribers >= 1_000_000)
      || (stateSizeFilter === "macro" && subscribers >= 100_000 && subscribers < 1_000_000)
      || (stateSizeFilter === "mid" && subscribers >= 10_000 && subscribers < 100_000)
      || (stateSizeFilter === "micro" && subscribers > 0 && subscribers < 10_000);
    const contactMatches = !stateContactFilter
      || (stateContactFilter === "direct" && hasDirectContact(channel))
      || (stateContactFilter === "social" && hasSocialContact(channel))
      || (stateContactFilter === "none" && !hasDirectContact(channel) && !hasSocialContact(channel));
    const districtMatches = !stateDistrictFilter
      || (stateDistrictFilter === UNSPECIFIED_DISTRICT_FILTER ? districtIsMissing(channel.district) : channel.district === stateDistrictFilter);
    const kpiMatches = stateKpiFilters.every((filter) => {
      if (filter === "districts") return !districtIsMissing(channel.district);
      if (filter === "regions") return !locationIsMissing(channel.region);
      if (filter === "noRecentUploads") return Boolean(stateAnalytics?.summary.channelsWithoutRecentUploadsIds?.includes(channel.id));
      return hasDirectContact(channel) || hasSocialContact(channel);
    });
    return (!stateCategoryFilter || channel.category === stateCategoryFilter)
      && (!stateEngagementFilter || rateGroup === stateEngagementFilter)
      && districtMatches
      && sizeMatches
      && contactMatches
      && kpiMatches;
  });
  const displayStateChannels = visibleStateChannels.filter((channel) => !search.trim()
    || [channel.channelName, channel.youtubeChannelId, channel.district, channel.category]
      .some((value) => value?.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  const selectedNationalState = nationalAnalytics?.states.find((state) => (state.state || "") === (selectedState === UNSPECIFIED_STATE_FILTER ? "" : selectedState));
  const selectedNationalChannels = channels.filter((channel) => selectedState === UNSPECIFIED_STATE_FILTER
    ? !channel.state?.trim()
    : channel.state === selectedState);
  const selectedNationalCategories = Array.from(new Set(selectedNationalChannels.map((channel) => channel.category)))
    .map((category) => {
      const members = selectedNationalChannels.filter((channel) => channel.category === category);
      return {
        category,
        channelCount: String(members.length),
        subscriberCount: String(members.reduce((sum, channel) => sum + Number(channel.subscriberCount || 0), 0)),
        channelViews: String(members.reduce((sum, channel) => sum + Number(channel.viewsTotal || 0), 0)),
      } satisfies AnalyticsBreakdown;
    }).sort((left, right) => Number(right.channelCount) - Number(left.channelCount));
  const selectedStateDirectContacts = selectedNationalChannels.filter(hasDirectContact).length;
  const selectedStateSocialOnly = selectedNationalChannels.filter((channel) => !hasDirectContact(channel) && hasSocialContact(channel)).length;
  const selectedStateNoContacts = selectedNationalChannels.filter((channel) => !hasDirectContact(channel) && !hasSocialContact(channel)).length;
  const nationalMetricLabel = nationalMetric === "channelCount" ? "Channels" : nationalMetric === "subscriberCount" ? "Subscribers" : "Channel views";
  const stateFilterCount = [stateCategoryFilter, stateEngagementFilter, stateDistrictFilter, stateSizeFilter, stateContactFilter].filter(Boolean).length + stateKpiFilters.length;
  const nationalSummary = nationalAnalytics?.summary;
  const stateSummary = stateAnalytics?.summary;

  const nationalStateColors = stateColorMap(nationalAnalytics?.states || []);
  const todayDate = localDateInputValue(new Date());
  const visibleNationalStates = (nationalAnalytics?.states || []).filter((state) => displayLocation(state.state || "Location not specified").toLocaleLowerCase().includes(nationalStateSearch.trim().toLocaleLowerCase()));
  const overviewBarColors = namedColorMap([
    ...(nationalAnalytics?.categories.map((category) => category.category || "Other") || []),
    "Email or phone", "Social / website only", "No saved details",
  ]);

  return (
    <div className={`app-shell${selectedChannelId ? " channel-profile-view" : ""}`}>
      <a className="skip-link" href="#main-content" tabIndex={showAdd || showClearDatabase || showImport ? -1 : 0}>Skip to main content</a>
      <header className="app-header">
        <div className="app-header-inner">
          <button type="button" className="mobile-menu-toggle" aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"} aria-expanded={mobileMenuOpen} aria-controls="workspace-navigation" onClick={() => setMobileMenuOpen((open) => !open)}>
            <span /><span /><span />
          </button>
          <a href="#overview" className="brand" onClick={(event) => { event.preventDefault(); window.history.replaceState(null, "", "#overview"); window.location.reload(); }}><span className="brand-mark"><Icon name="play" size={16} /></span><span>YT <span className="brand-light-text">Atlas</span></span></a>
          <form className="global-video-search" role="search" onSubmit={handleGlobalVideoSearchSubmit}>
            <Icon name="search" size={17} />
            <input aria-label="Search videos by title, description, or link" placeholder="Search video titles or descriptions…" value={globalVideoSearch} onFocus={openVideoDiscovery} onChange={(event) => setGlobalVideoSearch(event.target.value)} />
          </form>
        </div>
      </header>
      <aside className={mobileMenuOpen ? "sidebar mobile-menu-open" : "sidebar"} inert={showAdd || showClearDatabase || showImport}>
        <p className="nav-label">WORKSPACE</p>
        <nav id="workspace-navigation" className="side-nav" aria-label="Main navigation">
          <button type="button" aria-current={tab === "overview" ? "page" : undefined} className={tab === "overview" ? "nav-item active" : "nav-item"} onClick={() => { setSelectedChannelId(null); setTab("overview"); setMobileMenuOpen(false); }}><Icon name="grid" />Overview</button>
          <button type="button" aria-current={tab === "stateData" ? "page" : undefined} className={tab === "stateData" ? "nav-item active" : "nav-item"} onClick={() => { setSelectedChannelId(null); setTab("stateData"); setMobileMenuOpen(false); }}><Icon name="map" />State data</button>
          <button type="button" aria-current={tab === "channels" ? "page" : undefined} className={tab === "channels" ? "nav-item active" : "nav-item"} onClick={() => { setSelectedChannelId(null); setTab("channels"); setMobileMenuOpen(false); }}><Icon name="users" />Channels<span className="nav-count">{channels.length}</span></button>
          <button type="button" aria-current={tab === "activity" ? "page" : undefined} className={tab === "activity" ? "nav-item active" : "nav-item"} onClick={() => { setSelectedChannelId(null); setTab("activity"); setMobileMenuOpen(false); }}><Icon name="activity" />Collection activity</button>
          <button type="button" aria-current={tab === "xPosts" ? "page" : undefined} className={tab === "xPosts" ? "nav-item active" : "nav-item"} onClick={() => { setSelectedChannelId(null); setTab("xPosts"); setMobileMenuOpen(false); }}><Icon name="message" />X posts</button>
        </nav>
        <div className="sidebar-bottom">{canManageWorkspace && <button type="button" title="Clear Database" className="nav-item clear-database-item" onClick={() => { setMobileMenuOpen(false); setShowClearDatabase(true); }}><Icon name="trash" />Clear Database</button>}<div className="user-card"><span className="user-avatar" aria-hidden="true">{adminId.slice(0, 2).toUpperCase()}</span><span className="user-name"><strong>{adminId}</strong><small>{canManageWorkspace ? "Administrator" : "Read-only viewer"}</small></span><button type="button" className="icon-button logout-button" title="Sign out" aria-label="Sign out" onClick={() => { setMobileMenuOpen(false); void handleLogout(); }}><Icon name="logout" size={17} /><span className="mobile-signout-label">Sign out</span></button></div></div>
      </aside>
      {mobileMenuOpen && <button type="button" className="mobile-menu-backdrop" aria-label="Close navigation menu" onClick={() => setMobileMenuOpen(false)} inert={showAdd || showClearDatabase || showImport} />}

      <main className="main-area" id="main-content" tabIndex={-1} inert={showAdd || showClearDatabase || showImport}>
        <div className={`content-wrap${selectedChannelId ? " channel-profile-content" : tab === "channels" ? " channels-page-content" : tab === "activity" ? " activity-page-content" : ""}`}>
          {!selectedChannelId && (tab === "channels" || tab === "activity") && <section className="analytics-toolbar page-title-toolbar"><div className="analytics-page-heading"><h1>{tab === "channels" ? "Channels" : "Collection activity"}</h1></div>{tab === "activity" && <div className="heading-actions"><button className="button button-secondary" onClick={() => handleCollect("views")} disabled={!canManageWorkspace || channels.length === 0 || collectionActive("views")}><Icon name="views" size={16} />{collectionActive("views") ? "Collecting views…" : "Collect views"}</button><button className="button button-secondary" onClick={() => handleCollect("engagement")} disabled={!canManageWorkspace || channels.length === 0 || collectionActive("engagement")}><Icon name="heart" size={16} />{collectionActive("engagement") ? "Collecting engagement…" : "Collect engagement"}</button>{renderAnalyzeVideosButton()}{renderWorkspaceActions()}</div>}</section>}
          {selectedChannelId ? <section className="profile-toolbar"><button className="text-back" onClick={() => setSelectedChannelId(null)}>← All channels</button><div className="heading-actions"><button className="button button-secondary" onClick={() => handleCollect("views")} disabled={!canManageWorkspace || channels.length === 0 || collectionActive("views")}><Icon name="views" size={16} />{collectionActive("views") ? "Collecting views…" : "Collect views"}</button><button className="button button-secondary" onClick={() => handleCollect("engagement")} disabled={!canManageWorkspace || channels.length === 0 || collectionActive("engagement")}><Icon name="heart" size={16} />{collectionActive("engagement") ? "Collecting engagement…" : "Collect engagement"}</button>{renderAnalyzeVideosButton()}{renderWorkspaceActions()}</div></section> : tab === "channels" && <section className="filter-toolbar" aria-label="Channel filters">
            <div className="filter-options">
              <span className="filter-label"><Icon name="filter" size={16} />Filters</span>
              <label className="filter-select-wrap"><span className="filter-control-heading">Category</span><select className="filter-select" aria-label="Filter by category" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value={ALL_CHANNEL_FILTER_VALUE}>All categories</option>{filterOptions.categories.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
              <div className="filter-select-wrap"><span className="filter-control-heading">State or UT</span><SearchablePicker id="channel-state-filter" value={stateFilter} options={channelStatePickerOptions} ariaLabel="Filter by state or union territory" placeholder="Search states and UTs…" onChange={(value) => { setStateFilter(value); setSelectedState(value === ALL_CHANNEL_FILTER_VALUE ? "" : value); setRegionFilter(""); setDistrictFilter(""); }} /></div>
              <div className="filter-select-wrap"><span className="filter-control-heading">Region</span><SearchablePicker id="channel-region-filter" value={regionFilter} options={regionPickerOptions} ariaLabel="Filter by region" placeholder="Search regions…" disabled={!stateFilter || stateFilter === ALL_CHANNEL_FILTER_VALUE || stateFilter === UNSPECIFIED_STATE_FILTER} onChange={(value) => { setRegionFilter(value); setDistrictFilter(""); }} /></div>
              <div className="filter-select-wrap"><span className="filter-control-heading">District</span><SearchablePicker id="channel-district-filter" value={districtFilter} options={districtPickerOptions} ariaLabel="Filter by district" placeholder="Search districts…" disabled={!stateFilter || stateFilter === ALL_CHANNEL_FILTER_VALUE || stateFilter === UNSPECIFIED_STATE_FILTER} onChange={setDistrictFilter} /></div>
              <button className="filter-reset" type="button" onClick={clearFilters} disabled={activeFilterCount === 0}>Clear{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}</button>
            </div>
            <div className="heading-actions"><button className="button button-secondary" onClick={() => handleCollect("views")} disabled={!canManageWorkspace || channels.length === 0 || collectionActive("views")}><Icon name="views" size={16} />{collectionActive("views") ? "Collecting views…" : "Collect views"}</button><button className="button button-secondary" onClick={() => handleCollect("engagement")} disabled={!canManageWorkspace || channels.length === 0 || collectionActive("engagement")}><Icon name="heart" size={16} />{collectionActive("engagement") ? "Collecting engagement…" : "Collect engagement"}</button>{renderAnalyzeVideosButton()}{renderWorkspaceActions()}</div>
          </section>}
          {!selectedChannelId && (tab === "overview" || tab === "stateData") && <section className="analytics-toolbar">
            <div className="analytics-page-heading"><h1>{tab === "overview" ? "Overview" : "State data"}</h1></div>
            <div className="heading-actions"><button className="button button-secondary" onClick={() => handleCollect("views")} disabled={!canManageWorkspace || channels.length === 0 || collectionActive("views")}><Icon name="views" size={16} />{collectionActive("views") ? "Collecting views…" : "Collect views"}</button><button className="button button-secondary" onClick={() => handleCollect("engagement")} disabled={!canManageWorkspace || channels.length === 0 || collectionActive("engagement")}><Icon name="heart" size={16} />{collectionActive("engagement") ? "Collecting engagement…" : "Collect engagement"}</button><details className="date-range-collection"><summary className="button button-secondary">Collect date range <span aria-hidden="true">▾</span></summary><form className="date-range-popover" onSubmit={(event) => void handleCollectUploadRange(event)}><strong>Videos published during</strong><div className="date-range-fields"><label>From<div className="date-range-inputs"><input aria-label="Start date" type="date" required max={rangeEndDate || todayDate} value={rangeStartDate} onChange={(event) => setRangeStartDate(event.target.value)} /><input aria-label="Start time (IST, optional)" type="time" value={rangeStartTime} onChange={(event) => setRangeStartTime(event.target.value)} /></div></label><label>Through<div className="date-range-inputs"><input aria-label="End date" type="date" required min={rangeStartDate || undefined} max={todayDate} value={rangeEndDate} onChange={(event) => setRangeEndDate(event.target.value)} /><input aria-label="End time (IST, optional)" type="time" value={rangeEndTime} onChange={(event) => setRangeEndTime(event.target.value)} /></div></label></div><p>Times are optional and use IST. Choose both times to filter by time; the end minute is included. Leave both blank to collect whole days.</p><button className="button button-primary" type="submit" disabled={!canManageWorkspace || channels.length === 0 || collectionActive("engagement") || !rangeStartDate || !rangeEndDate || rangeStartDate > rangeEndDate || (Boolean(rangeStartTime) !== Boolean(rangeEndTime)) || (rangeStartDate === rangeEndDate && rangeStartTime > rangeEndTime)}>{collectionActive("engagement") ? "Collecting engagement…" : "Collect matching videos"}</button></form></details>{renderAnalyzeVideosButton()}{renderWorkspaceActions()}</div>
          </section>}
          {(apiError || notice) && <div className={apiError ? "notice notice-error" : "notice"} role={apiError ? "alert" : "status"} aria-live={apiError ? "assertive" : "polite"}><div className="notice-copy"><span>{apiError || notice}</span>{!apiError && (notice.startsWith("Excel import finished:") || notice.startsWith("Excel contact update finished:")) && importNoticeReport && <><button className="notice-skip-toggle" type="button" aria-expanded={showImportSkipReasons} onClick={() => setShowImportSkipReasons((current) => !current)}>{showImportSkipReasons ? "Hide skipped row details" : "Why were " + number(importNoticeReport.skipped) + " rows skipped?"}</button>{showImportSkipReasons && <ul className="notice-skip-list">{importNoticeReport.rejected.map((item) => <li key={"notice-row-" + item.row}>Row {item.row}: {item.reason}</li>)}{importNoticeReport.additionalRejected > 0 && <li>{number(importNoticeReport.additionalRejected)} more skipped rows have no detail in this report.</li>}</ul>}</>}</div><button type="button" onClick={() => { setApiError(""); setNotice(""); setImportNoticeReport(null); setShowImportSkipReasons(false); }} aria-label="Dismiss notification">×</button></div>}

          {selectedChannelId ? <ChannelProfile channelId={selectedChannelId} refreshKey={profileRefreshKey} onBack={() => setSelectedChannelId(null)} onDeleted={handleChannelDeleted} onKeywordClick={(keyword) => { setGlobalVideoSearch(keyword); setSelectedChannelId(null); setTab("keywords"); setMobileMenuOpen(false); }} canManage={canManageWorkspace} /> : <>
          {tab === "overview" && <section className="analytics-page">
            {!nationalSummary ? <div className="panel analytics-loading">Loading national channel totals…</div> : <>
              <section className="analytics-kpis national-kpis" aria-label="National channel metrics">
                <article className="stat-card"><span className="stat-label">States covered</span><strong className="stat-value">{number(nationalSummary.stateCount)}</strong><span className="stat-detail">With channels in this workspace</span></article>
                <article className="stat-card"><span className="stat-label">Channels tracked</span><strong className="stat-value">{number(nationalSummary.channelCount)}</strong><span className="stat-detail">Across all registered states</span></article>
                <article className="stat-card"><span className="stat-label">Direct contact available</span><strong className="stat-value">{number(nationalSummary.directContactChannels)}</strong><span className="stat-detail">Email or phone saved for a channel</span></article>
                <article className="stat-card"><span className="stat-label">Recent uploads collected</span><strong className="stat-value">{number(nationalSummary.recentUploadsCollected)}</strong><span className="stat-detail">Published in the last 30 days</span></article>
              </section>
              <section className="overview-insights-grid national-insights-grid">
                <article className="panel analytics-panel national-states-panel">
                  <div className="panel-heading"><div><h2>National overview</h2><p>Channel coverage by state. Select a state to inspect its totals.</p></div><span className="count-badge">{number(nationalAnalytics?.states.length || 0)} states</span></div>
                  {nationalAnalytics?.states.length ? <div className="national-state-content">
                    <div className="state-legend-picker state-legend-picker-full">
                      <label className="state-legend-search"><Icon name="search" size={15} /><input aria-label="Search states and union territories" placeholder="Search states or UTs…" value={nationalStateSearch} onChange={(event) => setNationalStateSearch(event.target.value)} /></label>
                      <div className="state-legend">
                        {!nationalStateSearch.trim() && <button type="button" aria-pressed={!selectedState} className={!selectedState ? "state-legend-row all-states selected" : "state-legend-row all-states"} onClick={() => setSelectedState("")}><i /><span>All locations</span><strong>{number(nationalSummary.channelCount)}</strong></button>}
                        {visibleNationalStates.map((state) => { const type = indiaLocationType(state.state || ""); const stateValue = state.state || UNSPECIFIED_STATE_FILTER; const isSelected = stateValue === selectedState; return <button type="button" key={state.state || UNSPECIFIED_STATE_FILTER} aria-pressed={isSelected} className={isSelected ? "state-legend-row selected" : "state-legend-row"} onClick={() => setSelectedState(isSelected ? "" : stateValue)}><i style={{ background: nationalStateColors.get(state.state || "State not specified") }} /><span>{displayLocation(state.state || "Location not specified")}</span><small className="state-type-badge">{type === "Union Territory" ? "UT" : type || "Other"}</small><strong>{number(state.channelCount)}</strong></button>; })}
                        {visibleNationalStates.length === 0 && <p className="state-legend-empty">No matching states or union territories</p>}
                      </div>
                    </div>
                    <div className="selected-state-summary"><div className="selected-state-heading"><div><span>{selectedNationalState ? "Selected state" : "Showing"}</span><h3>{selectedNationalState ? displayLocation(selectedNationalState.state) : "All states"}</h3></div><button className="button button-secondary button-small" onClick={() => selectedNationalState && openState(selectedNationalState.state || "")} disabled={!selectedNationalState}>Open state data<Icon name="arrow" size={14} /></button></div>
                      {selectedNationalState ? <div className="selected-state-stats"><div><span>Channels</span><strong>{number(selectedNationalState.channelCount)}</strong></div><div><span>Videos published (30 days)</span><strong>{number(selectedNationalState.recentUploadsCollected)}</strong></div><div><span>Channels with contacts</span><strong>{number(selectedNationalState.contactChannels)}</strong></div></div> : <div className="analytics-empty">Select a state with registered channels.</div>}
                      {selectedNationalCategories.length > 0 && <div className="selected-state-categories"><strong>Categories in {displayLocation(selectedNationalState?.state)}</strong>{selectedNationalCategories.map((category) => <div className="category-mini-row" key={category.category}><span>{category.category}</span><i><b style={{ width: barWidth(category.channelCount, selectedNationalCategories[0]?.channelCount), background: overviewBarColors.get(category.category || "Other") }} /></i><small>{number(category.channelCount)}</small></div>)}</div>}
                      {selectedNationalState && <div className="selected-state-breakdowns">
                        <div><strong>Engagement level</strong>{[["High ≥4", selectedNationalState.highEngagement], ["Good 2–4", selectedNationalState.goodEngagement], ["Average 1–2", selectedNationalState.averageEngagement], ["Low <1", selectedNationalState.lowEngagement], ["Not measured", selectedNationalState.notMeasured]].map(([label, value]) => <div className="category-mini-row" key={label}><span>{label}</span><i><b style={{ width: barWidth(value, selectedNationalState.channelCount), background: engagementBarColors[String(label)] }} /></i><small>{number(value)}</small></div>)}</div>
                        <div><strong>Contact details</strong><div className="category-mini-row"><span>Email or phone</span><i><b style={{ width: barWidth(selectedStateDirectContacts, selectedNationalState.channelCount), background: overviewBarColors.get("Email or phone") }} /></i><small>{number(selectedStateDirectContacts)}</small></div><div className="category-mini-row"><span>Social / website only</span><i><b style={{ width: barWidth(selectedStateSocialOnly, selectedNationalState.channelCount), background: overviewBarColors.get("Social / website only") }} /></i><small>{number(selectedStateSocialOnly)}</small></div><div className="category-mini-row"><span>No saved details</span><i><b style={{ width: barWidth(selectedStateNoContacts, selectedNationalState.channelCount), background: overviewBarColors.get("No saved details") }} /></i><small>{number(selectedStateNoContacts)}</small></div></div>
                      </div>}
                    </div>
                  </div> : <div className="analytics-empty">Add channels to see state coverage here.</div>}
                </article>

                <article className="panel analytics-panel national-metric-panel">
                  <div className="panel-heading"><div><h2>{nationalMetricLabel} by state</h2><p>Compare tracked channels across states.</p></div></div>
                  <div className="metric-switch" role="group" aria-label="Choose overview metric">{([["channelCount", "Channels"], ["subscriberCount", "Subscribers"], ["channelViews", "Views"]] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={nationalMetric === key} className={nationalMetric === key ? "active" : ""} onClick={() => setNationalMetric(key)}>{label}</button>)}</div>
                  {nationalAnalytics?.states.length ? <div className="analytics-bars national-metric-bars">{[...nationalAnalytics.states].sort((a, b) => Number(b[nationalMetric] || 0) - Number(a[nationalMetric] || 0)).map((state) => { const stateValue = state.state || UNSPECIFIED_STATE_FILTER; return <button type="button" className="analytics-bar-row state-bar-row" key={state.state || UNSPECIFIED_STATE_FILTER} onClick={() => { setSelectedState(stateValue); openState(stateValue); }}><span className="analytics-bar-label"><strong>{displayLocation(state.state || "Location not specified")}</strong><small>{number(state.channelCount)} channels</small></span><span className="analytics-track"><i style={{ width: barWidth(state[nationalMetric], Math.max(...nationalAnalytics.states.map((item) => Number(item[nationalMetric] || 0))) || 0), backgroundColor: nationalStateColors.get(state.state || "State not specified") }} /></span><span className="analytics-bar-value">{nationalMetric === "channelCount" ? number(state[nationalMetric]) : compactNumber(state[nationalMetric])}</span></button>; })}</div> : <div className="analytics-empty">State metrics will appear after channels are added.</div>}
                </article>

                <article className="panel analytics-panel">
                  <div className="panel-heading"><div><h2>Channel categories</h2><p>Workspace totals by the category assigned to each channel.</p></div></div>
                  {nationalAnalytics?.categories.length ? <div className="analytics-bars">{nationalAnalytics.categories.map((category) => <div className="analytics-bar-row" key={category.category}><span className="analytics-bar-label"><strong>{category.category}</strong><small>{compactNumber(category.subscriberCount)} subscribers</small></span><span className="analytics-track"><i style={{ width: barWidth(category.channelCount, nationalAnalytics.categories[0]?.channelCount), background: overviewBarColors.get(category.category || "Other") }} /></span><span className="analytics-bar-value">{number(category.channelCount)}</span></div>)}</div> : <div className="analytics-empty">No channel categories are available yet.</div>}
                </article>

                <article className="panel analytics-panel national-engagement-panel">
                  <div className="panel-heading"><div><h2>Engagement by state</h2><p>Channels grouped by likes per 100 collected video views.</p></div></div>
                  {nationalAnalytics?.states.length ? <div className="engagement-state-list"><div className="engagement-state-rows">{nationalAnalytics.states.map((state) => { const values = [Number(state.highEngagement || 0), Number(state.goodEngagement || 0), Number(state.averageEngagement || 0), Number(state.lowEngagement || 0), Number(state.notMeasured || 0)]; const total = values.reduce((sum, value) => sum + value, 0); return <div className="engagement-state-row" key={state.state}><strong>{displayLocation(state.state || "State not specified")}</strong><div className="engagement-stack" aria-label={`${displayLocation(state.state)}: High ${number(values[0])}, Good ${number(values[1])}, Average ${number(values[2])}, Low ${number(values[3])}, Not measured ${number(values[4])} channels`}>{values.map((value, index) => <i key={index} style={{ width: `${total ? value / total * 100 : 0}%`, backgroundColor: Object.values(engagementBarColors)[index] }} />)}</div><small>{number(total)} channels</small></div>; })}</div><div className="engagement-legend">{Object.entries(engagementBarColors).map(([label, color]) => <span key={label}><i style={{ backgroundColor: color }} />{label}</span>)}</div></div> : <div className="analytics-empty">Engagement levels appear after video metrics are collected.</div>}
                </article>

                <article className="panel analytics-panel national-outreach-panel">
                  <div className="panel-heading"><div><h2>Outreach funnel</h2><p>Current status for channels in this workspace.</p></div></div>
                  <div className="outreach-status-list">{[{ label: "Not tracked", value: nationalSummary.outreachUntracked, color: "#26d926" }, { label: "Not contacted", value: nationalSummary.outreachNotContacted, color: "#d9b226" }, { label: "Contacted", value: nationalSummary.outreachContacted, color: "#26d9ca" }].map(({ label, value, color }) => <div className="outreach-status-row" key={label}><span>{label}</span><i><b style={{ width: barWidth(value, nationalSummary.channelCount), background: color }} /></i><strong>{number(value)}</strong></div>)}</div>
                </article>
              </section>
            </>}
          </section>}

          {tab === "stateData" && <section className="analytics-page state-analytics-page">
            <div className="state-picker-row"><label htmlFor="state-picker">State or UT</label><SearchablePicker id="state-picker" value={selectedState} options={statePickerOptions} ariaLabel="Search and choose a state or union territory" placeholder="Search states and UTs…" onChange={(state) => { setSelectedState(state); setStateAnalytics(null); setStateCategoryFilter(""); setStateEngagementFilter(""); setStateDistrictFilter(""); setStateSizeFilter(""); setStateContactFilter(""); setStateKpiFilters([]); }} /><span>State data is calculated from channels registered in this location.</span></div>
            {!selectedState ? <div className="panel analytics-empty-state"><div className="empty-icon"><Icon name="map" size={22} /></div><h3>{statePickerOptions.length ? "Choose a location to view its data" : "No locations to show yet"}</h3><p>{statePickerOptions.length ? "Search or choose a state, union territory, or unspecified location above to see its channels and metrics." : "State data will appear when channels are registered."}</p></div>
              : stateAnalyticsLoading ? <div className="panel analytics-loading">Loading {selectedState === UNSPECIFIED_STATE_FILTER ? "Location not specified" : displayLocation(selectedState)} data…</div>
                : stateAnalytics && stateSummary ? <>
                  <section className="analytics-kpis state-kpis" aria-label={`${displayLocation(stateAnalytics.state)} channel metrics`}>
                    <article className="stat-card"><span className="stat-label">Channels</span><strong className="stat-value">{number(stateSummary.channelCount)}</strong><span className="stat-detail">Registered in {displayLocation(stateAnalytics.state)}</span></article>
                    <button type="button" className={`stat-card state-kpi-toggle${stateKpiFilters.includes("districts") ? " is-filter-active" : ""}`} aria-pressed={stateKpiFilters.includes("districts")} onClick={() => toggleStateKpiFilter("districts")}><span className="stat-label">Districts represented</span><strong className="stat-value">{number(representedDistrictCount)}</strong><span className="stat-detail">With at least one registered channel</span></button>
                    <button type="button" className={`stat-card state-kpi-toggle${stateKpiFilters.includes("regions") ? " is-filter-active" : ""}`} aria-pressed={stateKpiFilters.includes("regions")} onClick={() => toggleStateKpiFilter("regions")}><span className="stat-label">Regions represented</span><strong className="stat-value">{number(representedRegionCount)}</strong><span className="stat-detail">With at least one registered channel</span></button>
                    <article className="stat-card"><span className="stat-label">Videos published (30 days)</span><strong className="stat-value">{number(stateSummary.recentUploadsCollected)}</strong><span className="stat-detail">Across channels in {displayLocation(stateAnalytics.state)}</span></article>
                    <button type="button" className={`stat-card state-kpi-toggle${stateKpiFilters.includes("noRecentUploads") ? " is-filter-active" : ""}`} aria-pressed={stateKpiFilters.includes("noRecentUploads")} onClick={() => toggleStateKpiFilter("noRecentUploads")}><span className="stat-label">Channels with no recent uploads</span><strong className="stat-value">{number(stateSummary.channelsWithoutRecentUploads)}</strong><span className="stat-detail">Among channels with collected video data</span></button>
                    <button type="button" className={`stat-card state-kpi-toggle${stateKpiFilters.includes("contact") ? " is-filter-active" : ""}`} aria-pressed={stateKpiFilters.includes("contact")} onClick={() => toggleStateKpiFilter("contact")}><span className="stat-label">Contact available</span><strong className="stat-value">{number(stateAnyContactChannels)}</strong><span className="stat-detail">Email, phone, social, or website</span></button>
                  </section>
                  <section className="state-filter-row" aria-label="Filter state channels">
                    <label>Category<select className="filter-select" value={stateCategoryFilter} onChange={(event) => setStateCategoryFilter(event.target.value)}><option value="">All categories</option>{stateAnalytics.categories.map((category) => <option key={category.category} value={category.category}>{category.category}</option>)}</select></label>
                    <label>Engagement<select className="filter-select" value={stateEngagementFilter} onChange={(event) => setStateEngagementFilter(event.target.value)}><option value="">All levels</option>{["high", "good", "average", "low", "not measured"].map((level) => <option key={level} value={level}>{level === "not measured" ? "Not measured" : level[0].toUpperCase() + level.slice(1)}</option>)}</select></label>
                    <label>Audience size<select className="filter-select" value={stateSizeFilter} onChange={(event) => setStateSizeFilter(event.target.value)}><option value="">All sizes</option><option value="mega">Mega · 1M+</option><option value="macro">Macro · 100K–1M</option><option value="mid">Mid · 10K–100K</option><option value="micro">Micro · under 10K</option></select></label>
                    <label>Contact<select className="filter-select" value={stateContactFilter} onChange={(event) => setStateContactFilter(event.target.value)}><option value="">Any contact</option><option value="direct">Email or phone</option><option value="social">Social or website</option><option value="none">No saved details</option></select></label>
                    {stateFilterCount > 0 && <button type="button" className="filter-reset" onClick={() => { setStateCategoryFilter(""); setStateEngagementFilter(""); setStateDistrictFilter(""); setStateSizeFilter(""); setStateContactFilter(""); setStateKpiFilters([]); }}>Clear filters ({stateFilterCount})</button>}
                  </section>
                  <section className="analytics-grid state-breakdown-grid">
                    <article className="panel analytics-panel"><div className="panel-heading"><div><h2>Districts</h2><p>Channel coverage and views by district. Select a district to filter the list.</p></div><span className="count-badge district-count">{number(stateAnalytics.districts.filter((district) => !districtIsMissing(district.district)).length)} districts</span></div><div className="analytics-bars">{stateAnalytics.districts.map((district) => {
                      const districtKey = districtIsMissing(district.district) ? UNSPECIFIED_DISTRICT_FILTER : district.district || "";
                      const districtSelected = Boolean(stateDistrictFilter) && stateDistrictFilter === districtKey;
                      return <button type="button" key={district.district} aria-pressed={districtSelected} className={districtSelected ? "analytics-bar-row district-bar-row selected interactive-filter-row" : "analytics-bar-row district-bar-row interactive-filter-row"} onClick={() => { setStateDistrictFilter((current) => current === districtKey ? "" : districtKey); setSearch(""); }}><span className="analytics-bar-label"><strong>{displayLocation(district.district)}</strong><small>{number(district.channelCount)} channels</small></span><span className="analytics-track"><i style={{ width: barWidth(district.channelViews, stateAnalytics.districts[0]?.channelViews) }} /></span><span className="analytics-bar-value">{compactNumber(district.channelViews)} views</span></button>;
                    })}</div></article>
                    <article className="panel analytics-panel"><div className="panel-heading"><div><h2>Categories in {displayLocation(stateAnalytics.state)}</h2><p>Registered channel categories for this state.</p></div></div><div className="analytics-bars">{stateAnalytics.categories.map((category) => <button type="button" className="analytics-bar-row interactive-filter-row" key={category.category} aria-pressed={stateCategoryFilter === category.category} onClick={() => showStateCategory(category.category || "")}><span className="analytics-bar-label"><strong>{category.category}</strong><small>{compactNumber(category.subscriberCount)} subscribers</small></span><span className="analytics-track"><i style={{ width: barWidth(category.channelCount, stateAnalytics.categories[0]?.channelCount) }} /></span><span className="analytics-bar-value">{number(category.channelCount)}</span></button>)}</div></article>
                    <article className="panel analytics-panel"><div className="panel-heading"><div><h2>Contact availability</h2><p>Details saved for channels in {displayLocation(stateAnalytics.state)}.</p></div></div><div className="analytics-metric-list contact-availability-list"><button type="button" aria-pressed={stateContactFilter === "direct"} onClick={() => showStateContactGroup("direct")} aria-label={`${stateContactFilter === "direct" ? "Clear filter for" : "Show"} ${number(stateSummary.directContactChannels)} channels with email or phone`}><span>Email or phone</span><strong>{number(stateSummary.directContactChannels)}</strong></button><button type="button" aria-pressed={stateContactFilter === "social"} onClick={() => showStateContactGroup("social")} aria-label={`${stateContactFilter === "social" ? "Clear filter for" : "Show"} ${number(stateSummary.socialContactChannels)} channels with social link or website`}><span>Social link or website</span><strong>{number(stateSummary.socialContactChannels)}</strong></button><button type="button" aria-pressed={stateContactFilter === "none"} onClick={() => showStateContactGroup("none")} aria-label={`${stateContactFilter === "none" ? "Clear filter for" : "Show"} ${number(stateSummary.channelsWithoutContacts)} channels with no saved contact details`}><span>No saved contact details</span><strong>{number(stateSummary.channelsWithoutContacts)}</strong></button></div><p className="analytics-footnote">Select a row again to clear its filter.</p></article>
                    <article className="panel analytics-panel state-engagement-panel"><div className="panel-heading"><div><h2>Engagement spread</h2><p>Channels grouped by likes per 100 collected video views.</p></div></div>{stateAnalytics.engagementDistribution.length ? <div className="engagement-distribution">{stateAnalytics.engagementDistribution.map((level) => { const group = engagementFilterKey(level.level || ""); return <button type="button" className="engagement-distribution-row interactive-filter-row" key={level.level} aria-pressed={stateEngagementFilter === group} onClick={() => showStateEngagement(level.level || "")}><span>{level.level}</span><i><b className={`level-${(level.level || "none").toLowerCase().split(" ")[0]}`} style={{ width: barWidth(level.channelCount, stateSummary.channelCount) }} /></i><strong>{number(level.channelCount)}</strong></button>; })}</div> : <div className="analytics-empty">Collect video engagement to see this distribution.</div>}</article>
                  </section>
                  <section className="panel state-channel-panel"><div className="panel-heading"><div><h2>Channels in {displayLocation(stateAnalytics.state)}<span className="count-badge">{number(displayStateChannels.length)} of {number(selectedStateChannels.length)}</span></h2><p>Open a channel to see its collected profile.</p></div><label className="search-box"><Icon name="search" size={16} /><input aria-label="Search state channels" placeholder="Search this state…" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>{displayStateChannels.length ? <div className="table-scroll"><table><thead><tr><th>CHANNEL</th><th>CATEGORY</th><th>DISTRICT</th><th>SUBSCRIBERS</th><th>CHANNEL VIEWS</th><th title="Median likes per 100 video views">MEDIAN ENGAGEMENT</th><th>CONTACT</th><th>OUTREACH</th></tr></thead><tbody>{displayStateChannels.map((channel) => <tr key={channel.id}><td><button className="channel-profile-link" onClick={() => setSelectedChannelId(channel.id)}>{displayChannelName(channel.channelName)}</button><small className="state-channel-id">{channel.youtubeChannelId}</small></td><td><span className="category-pill">{channel.category || "Uncategorized"}</span></td><td>{displayLocation(channel.district) || "—"}</td><td className="numeric-cell">{channel.subscriberCount ? compactNumber(channel.subscriberCount) : "—"}</td><td className="numeric-cell">{channel.viewsTotal ? compactNumber(channel.viewsTotal) : "—"}</td><td>{channel.medianEngagementRate != null ? `${Number(channel.medianEngagementRate).toFixed(2)} · Median` : "—"}</td><td>{hasDirectContact(channel) ? "Email / phone" : hasSocialContact(channel) ? "Social / website" : "—"}</td><td><select className="outreach-status-select" aria-label={`Outreach status for ${displayChannelName(channel.channelName)}`} value={channel.outreachStatus || "not_tracked"} disabled={!canManageWorkspace || busy} onChange={(event) => void handleOutreachStatusChange(channel.id, event.target.value as NonNullable<Channel["outreachStatus"]> | "not_tracked")}><option value="not_tracked">Not tracked</option><option value="not_contacted">Not contacted</option><option value="contacted">Contacted</option></select></td></tr>)}</tbody></table></div> : <div className="analytics-empty">No channels match these filters.</div>}</section>
                </> : <div className="panel analytics-empty-state"><div className="empty-icon"><Icon name="map" size={22} /></div><h3>State data could not be loaded</h3><p>Refresh the page and try selecting this state again.</p></div>}
          </section>}

          {tab === "channels" && <section className={`panel channel-panel${filteredChannels.length ? " has-channel-results" : ""}`}><div className="panel-heading channel-panel-heading"><div><h2>All channels<span className="count-badge">{filteredChannels.length}</span></h2><p>Engagement counts are per channel; collection scans up to the latest 100 videos each.</p></div><div className="table-actions"><label className="search-box"><Icon name="search" size={17} /><input aria-label="Search channels" placeholder="Search channels…" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div></div>
            {filteredChannels.length === 0 ? <div className="empty-state"><div className="empty-icon"><Icon name="users" size={22} /></div><h3>{channels.length === 0 ? "Your channel list starts here" : hasChannelFilter ? "No channels match these filters" : "Choose a filter to view channels"}</h3><p>{channels.length === 0 ? "Add a YouTube channel from Workspace actions, then collect its latest public metrics." : hasChannelFilter ? "Clear a filter or search for a different channel, category, or location." : "Select a category, state or UT, region, or district, or search for a channel to show matching results."}</p></div> : <><div className="table-scroll" ref={channelsTableScrollRef}><table><thead><tr><th>CHANNEL</th><th>CATEGORY</th><th>LOCATION</th><th>VIEWS</th><th>VIDEOS WITH ENGAGEMENT</th><th>LAST COLLECTED</th><th><span className="sr-only">Open channel</span></th></tr></thead><tbody>{filteredChannels.map((channel, index) => { const collectedAt = [channel.viewsObservedAt, channel.engagementObservedAt].filter(Boolean).sort().at(-1) || null; const channelName = displayChannelName(channel.channelName); return <tr key={channel.id}><td><div className="channel-cell"><span className={`channel-avatar avatar-${index % 5}`}><Icon name="play" size={14} /></span><span className="channel-name"><button className="channel-profile-link" onClick={() => setSelectedChannelId(channel.id)} aria-label={`View ${channelName} profile`}>{channelName}</button><small>{channel.youtubeChannelId}</small></span></div></td><td><span className="category-pill">{channel.category || "Uncategorized"}</span></td><td><span className="location-cell">{[channel.state, channel.region, channel.district].filter(Boolean).map(displayLocation).join(" · ") || "—"}</span></td><td className="numeric-cell">{channel.viewsTotal ? number(channel.viewsTotal) : "—"}</td><td className="numeric-cell">{number(channel.videosTracked)}</td><td><span className="collected-cell"><i className={collectedAt ? "status-dot status-on" : "status-dot"} />{collectedAt ? date(collectedAt) : "No data"}</span></td><td><a className="row-more" href={`https://www.youtube.com/channel/${encodeURIComponent(channel.youtubeChannelId)}`} target="_blank" rel="noreferrer" aria-label={`Open ${channelName} on YouTube`}>↗</a></td></tr>; })}</tbody></table></div><div className="table-footer"><span>Showing <strong>{filteredChannels.length}</strong> of <strong>{channels.length}</strong> channels, sorted by subscribers</span><span className="footer-note"><Icon name="lock" size={13} />Public metrics retained for up to 30 days</span></div></>}</section>}

          {tab === "activity" && <section className="panel activity-panel"><div className="panel-heading"><div><h2>Recent collections</h2><p>Metric refresh jobs started from this workspace.</p></div></div>{jobs.length ? <div className="job-list">{jobs.map((job) => <div className="job-row" key={job.id}><span className={`job-status status-${job.status}`}><i />{job.status}</span><span className="job-description"><strong>YouTube {job.scope === "views" ? "views" : job.scope === "engagement" ? "engagement" : "views + engagement"} collection</strong><small>{job.channelsCompleted ?? 0} of {job.channelsTotal ?? 0} channels · {date(job.createdAt)}</small>{job.errorSummary && <small className="job-error" title={job.errorSummary}>{summarizeCollectionError(job.errorSummary)}</small>}</span><span className="job-id" title={job.id}>{job.id.slice(0, 8)}</span></div>)}</div> : <div className="empty-state"><div className="empty-icon"><Icon name="activity" size={22} /></div><h3>No collection jobs yet</h3><p>Add a channel and run a collector to get its latest YouTube data.</p></div>}</section>}
          {tab === "keywords" && <KeywordSearchPage key={globalVideoSearch} canManage={canManageWorkspace} initialQuery={globalVideoSearch} />}
          {tab === "xPosts" && <XPostsPage canManage={canManageWorkspace} />}
          </>}
          <footer className="app-copyright">© 2026 YT Atlas <span>·</span> Private analytics</footer>
        </div>
      </main>

      {taskToasts.length > 0 && <div className="task-toast-stack" aria-live="polite" aria-relevant="additions">
        {taskToasts.map((toast) => <article className={`task-toast task-toast-${toast.state}`} key={toast.id} role={toast.state === "error" ? "alert" : "status"}>
          <span className="task-toast-mark" aria-hidden="true">{toast.state === "started" ? "↻" : toast.state === "completed" ? "✓" : toast.state === "warning" ? "!" : "×"}</span>
          <div className="task-toast-copy"><strong>{toast.kind === "views" ? "Views" : toast.kind === "engagement" ? "Engagement" : "Video analysis"}</strong><span>{toast.message}</span>{toast.progress && toast.progress.total > 0 && <div className="task-toast-progress" role="progressbar" aria-label="Video analysis progress" aria-valuemin={0} aria-valuemax={toast.progress.total} aria-valuenow={Math.min(toast.progress.completed, toast.progress.total)}><i style={{ width: `${Math.min(100, Math.round((toast.progress.completed / toast.progress.total) * 100))}%` }} /></div>}</div>
          <button type="button" className="task-toast-close" onClick={() => dismissTaskToast(toast.id)} aria-label={`Dismiss ${toast.message}`}>×</button>
        </article>)}
      </div>}

      {showClearDatabase && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !clearDatabaseBusy) setShowClearDatabase(false); }}><section className="modal clear-database-modal" role="dialog" aria-modal="true" aria-labelledby="clear-database-title" aria-describedby="clear-database-description"><div className="modal-header"><div><span className="modal-mark"><Icon name="trash" size={16} /></span><div><h2 id="clear-database-title">Clear database?</h2><p>This action permanently removes workspace data.</p></div></div><button className="icon-button close-button" onClick={() => setShowClearDatabase(false)} aria-label="Close" disabled={clearDatabaseBusy}>×</button></div><div className="clear-database-content"><p id="clear-database-description">This will delete all channels, saved contact details, collected metrics, and collection history. Your admin login and app schema will remain.</p><strong>This cannot be undone.</strong></div><div className="modal-actions clear-database-actions"><button type="button" className="button button-secondary" onClick={() => setShowClearDatabase(false)} disabled={clearDatabaseBusy}>Cancel</button><button type="button" className="button button-danger" onClick={handleClearDatabase} disabled={clearDatabaseBusy}>{clearDatabaseBusy ? "Clearing…" : "Clear database"}</button></div></section></div>}

      {showImport && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !importBusy && !googleSheetBusy) closeImport(); }}><section className="modal import-modal" role="dialog" aria-modal="true" aria-labelledby="excel-import-title" aria-describedby="excel-import-description"><div className="modal-header"><div><span className="modal-mark"><Icon name="grid" size={16} /></span><div><h2 id="excel-import-title">Add channels from Excel or Google Sheets</h2><p id="excel-import-description">Load a Google Sheets tab or import a workbook.</p></div></div><button className="icon-button close-button" onClick={closeImport} aria-label="Close" disabled={importBusy || googleSheetBusy}>×</button></div><div className="import-form">
        <div className="google-sheet-import"><label htmlFor="google-sheet-url">Google Sheets link</label><div className="google-sheet-import-row"><input id="google-sheet-url" type="url" value={googleSheetUrl} onChange={(event) => { setGoogleSheetUrl(event.currentTarget.value); setImportError(""); }} placeholder="https://docs.google.com/spreadsheets/d/…" disabled={googleSheetBusy || importBusy} /><button type="button" className="button button-secondary" onClick={handleGoogleSheetLoad} disabled={!googleSheetUrl.trim() || googleSheetBusy || importBusy}>{googleSheetBusy ? "Loading…" : "Load sheet"}</button></div><small>Give the sheet “Anyone with the link” viewer access. The selected tab is imported, up to 2,000 rows.</small></div>
        <div className="import-divider"><span>or upload a file</span></div>
        <input ref={importInputRef} className="sr-only" type="file" accept=".xlsx,.csv" onChange={handleSpreadsheetPicked} aria-label="Choose Excel workbook or CSV file" />
        <button type="button" className="excel-file-picker" onClick={() => importInputRef.current?.click()} disabled={importBusy || googleSheetBusy}><span className="excel-file-icon">XLS</span><span><strong>{importFileName || "Choose an Excel or CSV file"}</strong><small>Supported: .xlsx or .csv, up to 2,000 rows</small></span><span className="button button-secondary button-small">Browse</span></button>
        <div className="import-rules"><strong>Required columns</strong><span>Channel Name · Channel ID · Category</span><small>State / UT is optional. State headings can use State, State/UT, UT Name, or Union Territory. Regional area, District, and Contact are optional. Contact values are added to the channel card. Existing channel IDs are updated. Categories must be News &amp; Politics, Infotainment, or People &amp; Blog.</small></div>
        {importError && <p className="form-error" role="alert">{importError}</p>}
        {importRows.length > 0 && !importReport && <div className="import-preview"><div className="import-preview-heading"><strong>Import preview · {number(importRows.length)} rows</strong><span>from {importFileName}</span></div><div className="import-preview-counts"><span>{number(importPreview.filter((item) => item.status === "new").length)} new</span><span>{number(importPreview.filter((item) => item.status === "update").length)} updates</span><span>{number(importPreview.filter((item) => item.status === "duplicate").length)} repeated IDs</span><span>{number(importPreview.filter((item) => item.status === "skip").length)} skipped</span></div><div className="table-scroll import-preview-table"><table><thead><tr><th>ROW</th><th>CHANNEL</th><th>CHANNEL ID</th><th>CATEGORY</th><th>STATE</th><th>CONTACT</th><th>RESULT</th></tr></thead><tbody>{importRows.slice(0, 20).map((row, index) => { const preview = importPreview[index]; return <tr key={`${row.youtubeChannelId}-${index}`}><td>{preview.row}</td><td>{row.channelName || "—"}</td><td>{row.youtubeChannelId || "—"}</td><td>{row.category || "—"}</td><td>{displayLocation(row.state) || "—"}</td><td>{row.contact || "—"}</td><td><strong className={`import-preview-status is-${preview.status}`}>{preview.status === "new" ? "New" : preview.status === "update" ? "Update" : preview.status === "duplicate" ? "Repeated ID" : "Skip"}</strong><small>{preview.reason}</small></td></tr>; })}</tbody></table></div>{importRows.length > 20 && <small className="import-preview-more">Showing 20 of {number(importRows.length)} rows. Counts include the full sheet.</small>}</div>}
        {importReport && <div className="import-result" role="status"><strong>Import complete</strong><p>{number(importReport.inserted)} added · {number(importReport.updated)} updated · {number(importReport.duplicates)} repeated IDs · {number(importReport.skipped)} skipped</p>{importReport.rejected.length > 0 && <ul>{importReport.rejected.slice(0, 8).map((item) => <li key={`${item.row}-${item.reason}`}>Row {item.row}: {item.reason}</li>)}</ul>}{importReport.additionalRejected > 0 && <small>And {number(importReport.additionalRejected)} more skipped rows.</small>}</div>}
        <div className="modal-actions"><button type="button" className="button button-secondary" onClick={closeImport} disabled={importBusy || googleSheetBusy}>{importReport ? "Done" : "Cancel"}</button>{!importReport && <button type="button" className="button button-primary" onClick={handleImportChannels} disabled={importBusy || googleSheetBusy || importRows.length === 0}>{importBusy ? "Importing…" : `Import ${number(importRows.length)} channels`}<Icon name="arrow" size={16} /></button>}</div>
      </div></section></div>}

      {showAdd && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowAdd(false); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="add-channel-title" aria-describedby="add-channel-description"><div className="modal-header"><div><span className="modal-mark"><Icon name="play" size={16} /></span><div><h2 id="add-channel-title">Add a YouTube channel</h2><p id="add-channel-description">Enter channel details to include it in your workspace.</p></div></div><button className="icon-button close-button" onClick={() => setShowAdd(false)} aria-label="Close">×</button></div><form className="channel-form" onSubmit={handleAddChannel}><div className="form-grid"><label>Channel name<span className="required">*</span><input name="channelName" required maxLength={200} placeholder="e.g. Channel name" autoFocus /></label><label>YouTube channel ID<span className="required">*</span><input name="youtubeChannelId" required maxLength={120} placeholder="UC…" /></label><label>Category<span className="required">*</span><input name="category" required maxLength={120} placeholder="e.g. Education" /></label><label>State or union territory <span className="optional">(optional)</span><input name="state" list="india-location-options" maxLength={120} placeholder="Start typing a state or UT" /><datalist id="india-location-options">{indiaStateNames.map((name) => <option key={name} value={name} label="State" />)}{indiaUnionTerritoryNames.map((name) => <option key={name} value={name} label="Union territory" />)}</datalist></label><label>Regional area <span className="optional">(optional)</span><input name="region" maxLength={120} placeholder="Region" /></label><label>District <span className="optional">(optional)</span><input name="district" maxLength={120} placeholder="District" /></label></div><div className="form-footnote"><Icon name="lock" size={14} />Metrics are collected from public YouTube data. Share counts need channel-owner authorization.</div><div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setShowAdd(false)}>Cancel</button><button className="button button-primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Add channel"}<Icon name="arrow" size={16} /></button></div></form></section></div>}
    </div>
  );
}
