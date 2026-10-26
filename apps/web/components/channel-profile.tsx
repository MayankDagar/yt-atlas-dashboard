"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { displayChannelName } from "../lib/channel-name";
import { displayLocation } from "../lib/location";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "/api/v1";

type ChannelProfileData = {
  id: string;
  youtubeChannelId: string;
  channelName: string;
  youtubeTitle: string | null;
  category: string;
  state: string;
  region: string | null;
  district: string | null;
  description: string | null;
  channelPublishedAt: string | null;
  subscriberCount: string | null;
  subscribersHidden: boolean;
  youtubeVideoCount: string | null;
  profileObservedAt: string | null;
  contactDetails: ContactDetails;
  contactDetailsSource: "manual" | null;
  contactDetailsObservedAt: string | null;
  viewsTotal: string | null;
  viewsObservedAt: string | null;
  videosTracked: string | null;
};

type ProfileVideo = {
  youtubeVideoId: string;
  videoTitle: string;
  keywords: string[];
  publishedAt: string | null;
  isShort: boolean;
  viewsCount: string | null;
  likesCount: string | null;
  commentsCount: string | null;
  sharesCount: string | null;
  observedAt: string;
};

type ProfileResponse = { channel: ChannelProfileData; videos: ProfileVideo[] };
type TrendPoint = { period: string; viewsTotal: string | null; viewsGained: string | null; medianLikes: string | null; medianComments: string | null };
type TrendInterval = "daily" | "monthly";
type TrendMetric = "viewsTotal" | "medianLikes" | "medianComments";
type ContactDetails = { emails: string[]; phones: string[]; socialLinks: Array<{ platform: string; url: string }>; websites: Array<{ name: string; url: string }> };
type ContactDraft = { emails: string; phones: string; socialLinks: string; websites: string };

const emptyContactDetails: ContactDetails = { emails: [], phones: [], socialLinks: [], websites: [] };

function splitLines(value: string): string[] { return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean); }

function makeContactDraft(details: ContactDetails): ContactDraft {
  return {
    emails: details.emails.join("\n"),
    phones: details.phones.join("\n"),
    socialLinks: details.socialLinks.map((item) => `${item.platform} | ${item.url}`).join("\n"),
    websites: details.websites.map((item) => `${item.name} | ${item.url}`).join("\n"),
  };
}

function TrendChart({ title, points, valueKey, color, summaryLabel, summaryValue, interval }: { title: string; points: TrendPoint[]; valueKey: TrendMetric; color: string; summaryLabel: string; summaryValue?: number; interval: TrendInterval }) {
  const chartWidth = 900;
  const chartHeight = 310;
  const left = 76;
  const right = 876;
  const top = 40;
  const bottom = 254;
  const values = points.map((point, index) => ({
    index,
    period: point.period,
    value: point[valueKey] === null ? null : Number(point[valueKey]),
  })).filter((point): point is { index: number; period: string; value: number } => point.value !== null && Number.isFinite(point.value));
  const maxValue = Math.max(...values.map((point) => point.value), 0);
  const axisMax = maxValue > 0 ? maxValue : 1;
  const x = (index: number) => points.length <= 1 ? (left + right) / 2 : left + index / (points.length - 1) * (right - left);
  const y = (value: number) => bottom - value / axisMax * (bottom - top);
  const line = values.map((point) => `${x(point.index)},${y(point.value)}`).join(" ");
  const axisTicks = [0, 1, 2, 3].map((step) => ({
    value: axisMax * (3 - step) / 3,
    y: top + (bottom - top) * step / 3,
  }));

  return <div className="profile-trend-chart">
    {values.length ? <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label={`${title} by ${interval === "daily" ? "day" : "month"}`}>
      {axisTicks.map((tick) => <g key={tick.y}><line className="profile-trend-gridline" x1={left} y1={tick.y} x2={right} y2={tick.y} /><text className="profile-trend-y-label" x={left - 10} y={tick.y + 4} textAnchor="end">{formatCompact(tick.value)}</text></g>)}
      <line className="profile-trend-axis" x1={left} y1={top} x2={left} y2={bottom} />
      <line className="profile-trend-axis" x1={left} y1={bottom} x2={right} y2={bottom} />
      {line && <polyline points={line} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />}
      {values.map((point, valueIndex) => {
        const labelEvery = Math.max(1, Math.ceil(values.length / 6));
        const showPeriod = interval === "monthly" || values.length <= 8 || valueIndex === 0 || valueIndex === values.length - 1 || valueIndex % labelEvery === 0;
        return <g key={point.period}><circle cx={x(point.index)} cy={y(point.value)} r="5" fill={color}><title>{formatTrendPeriod(point.period, interval)}: {formatCompact(point.value)}</title></circle><text className="profile-trend-point-label" x={x(point.index)} y={Math.max(18, y(point.value) - 11)} textAnchor="middle">{formatCompact(point.value)}</text>{showPeriod && <text x={x(point.index)} y="278" textAnchor="middle">{formatTrendPeriod(point.period, interval)}</text>}</g>;
      })}
    </svg> : <div className="profile-trend-empty">Collect metrics to build this chart.</div>}
    {values.length > 0 && <p className="profile-trend-current">{summaryLabel}: <strong>{formatCompact(summaryValue ?? values[values.length - 1].value)}</strong></p>}
  </div>;
}

function parseNamedLinks(value: string, defaultName: string): Array<{ name: string; url: string }> {
  return splitLines(value).map((line) => {
    const separator = line.indexOf("|");
    return { name: separator < 0 ? defaultName : line.slice(0, separator).trim() || defaultName, url: separator < 0 ? line : line.slice(separator + 1).trim() };
  });
}

function formatNumber(value: string | number | null | undefined): string { return value == null || value === "" ? "—" : new Intl.NumberFormat().format(Number(value)); }

function formatCompact(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const numericValue = Number(value);
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    minimumFractionDigits: Math.abs(numericValue) >= 1_000 ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(numericValue);
}

function formatDate(value: string | null, options: Intl.DateTimeFormatOptions = { dateStyle: "medium" }): string {
  const parsed = value && new Date(value);
  return parsed && !Number.isNaN(parsed.getTime()) ? new Intl.DateTimeFormat(undefined, options).format(parsed) : "Not available";
}

function formatTrendPeriod(value: string, interval: TrendInterval): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, interval === "daily" ? day : 1));
  return new Intl.DateTimeFormat(undefined, interval === "daily"
    ? { month: "short", day: "numeric", timeZone: "UTC" }
    : { month: "short", year: "2-digit", timeZone: "UTC" }).format(date);
}

function readError(body: unknown): string { return typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : "Could not load this channel profile."; }

export default function ChannelProfile({ channelId, onBack, onDeleted, onKeywordClick, refreshKey, canManage = true }: { channelId: string; onBack: () => void; onDeleted: () => void; onKeywordClick: (keyword: string) => void; refreshKey: number; canManage?: boolean }) {
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [error, setError] = useState("");
  const [contactDraft, setContactDraft] = useState<ContactDraft>(() => makeContactDraft(emptyContactDetails));
  const [contactSaving, setContactSaving] = useState(false);
  const [contactError, setContactError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [trendSeries, setTrendSeries] = useState<Record<TrendInterval, TrendPoint[]>>({ daily: [], monthly: [] });
  const [trendMetric, setTrendMetric] = useState<TrendMetric>("viewsTotal");
  const [trendInterval, setTrendInterval] = useState<TrendInterval>("daily");
  const [videoFilter, setVideoFilter] = useState<"all" | "videos" | "shorts">("all");
  const videosPanelRef = useRef<HTMLElement | null>(null);
  const sideStackRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const videosPanel = videosPanelRef.current;
    const sideStack = sideStackRef.current;
    if (!videosPanel || !sideStack) return;

    const syncHeight = () => {
      videosPanel.style.height = window.matchMedia("(min-width: 901px)").matches
        ? `${sideStack.getBoundingClientRect().height}px`
        : "";
    };
    const observer = new ResizeObserver(syncHeight);
    observer.observe(sideStack);
    window.addEventListener("resize", syncHeight);
    syncHeight();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncHeight);
      videosPanel.style.height = "";
    };
  }, [channelId, profile !== null]);

  useEffect(() => {
    const controller = new AbortController();
    setProfile(null);
    setError("");
    fetch(`${API_BASE}/channels/${encodeURIComponent(channelId)}/profile`, {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(readError(body));
        return body as ProfileResponse;
      })
      .then((data) => {
        const details = { ...emptyContactDetails, ...(data.channel.contactDetails || {}) };
        data.channel.contactDetails = details;
        setProfile(data);
        setContactDraft(makeContactDraft(details));
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load this channel profile.");
      });
    return () => controller.abort();
  }, [channelId, refreshKey]);

  useEffect(() => {
    const controller = new AbortController();
    setTrendSeries({ daily: [], monthly: [] });
    const read = async <T,>(path: string, key: string): Promise<T[]> => {
      const response = await fetch(`${API_BASE}${path}`, { credentials: "include", cache: "no-store", signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(readError(body));
      return (body as Record<string, T[]>)[key] || [];
    };
    for (const interval of ["daily", "monthly"] as const) {
      void read<TrendPoint>(`/channels/${encodeURIComponent(channelId)}/trends?interval=${interval}`, "trends")
        .then((points) => setTrendSeries((current) => ({ ...current, [interval]: points })))
        .catch(() => undefined);
    }
    return () => controller.abort();
  }, [channelId, refreshKey]);

  async function saveContacts(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setContactSaving(true);
    setContactError("");
    const details: ContactDetails = {
      emails: splitLines(contactDraft.emails),
      phones: splitLines(contactDraft.phones),
      socialLinks: parseNamedLinks(contactDraft.socialLinks, "Social link").map(({ name, url }) => ({ platform: name, url })),
      websites: parseNamedLinks(contactDraft.websites, "Website"),
    };
    try {
      const response = await fetch(`${API_BASE}/channels/${encodeURIComponent(channelId)}/contact-details`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(details),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Could not save contact details.");
      const savedDetails = body.contactDetails as ContactDetails;
      setProfile((current) => current ? { ...current, channel: { ...current.channel, contactDetails: savedDetails, contactDetailsSource: "manual", contactDetailsObservedAt: new Date().toISOString() } } : current);
      setContactDraft(makeContactDraft(savedDetails));
    } catch (cause) {
      setContactError(cause instanceof Error ? cause.message : "Could not save contact details.");
    } finally {
      setContactSaving(false);
    }
  }

  async function deleteSavedContact(group: "emails" | "phones" | "socialLinks" | "websites", index: number) {
    if (!profile) return;
    const current = profile.channel.contactDetails;
    const details: ContactDetails = {
      emails: group === "emails" ? current.emails.filter((_, itemIndex) => itemIndex !== index) : current.emails,
      phones: group === "phones" ? current.phones.filter((_, itemIndex) => itemIndex !== index) : current.phones,
      socialLinks: group === "socialLinks" ? current.socialLinks.filter((_, itemIndex) => itemIndex !== index) : current.socialLinks,
      websites: group === "websites" ? current.websites.filter((_, itemIndex) => itemIndex !== index) : current.websites,
    };
    setContactSaving(true);
    setContactError("");
    try {
      const response = await fetch(`${API_BASE}/channels/${encodeURIComponent(channelId)}/contact-details`, {
        method: "PATCH", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(details),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Could not delete this contact detail.");
      const savedDetails = body.contactDetails as ContactDetails;
      setProfile((value) => value ? { ...value, channel: { ...value.channel, contactDetails: savedDetails, contactDetailsSource: "manual", contactDetailsObservedAt: new Date().toISOString() } } : value);
      setContactDraft(makeContactDraft(savedDetails));
    } catch (cause) {
      setContactError(cause instanceof Error ? cause.message : "Could not delete this contact detail.");
    } finally {
      setContactSaving(false);
    }
  }

  async function deleteChannel() {
    if (!window.confirm(`Permanently delete ${displayChannelName(channel.channelName)} and its stored metrics and contact details? This cannot be undone.`)) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const response = await fetch(`${API_BASE}/channels/${encodeURIComponent(channelId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Could not delete this channel.");
      onDeleted();
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : "Could not delete this channel.");
    } finally {
      setDeleting(false);
    }
  }

  const videos = profile?.videos ?? [];
  const visibleVideos = videos.filter((video) => videoFilter === "all" || video.isShort === (videoFilter === "shorts"));
  const trendPoints = trendSeries[trendInterval];
  const engagement = useMemo(() => {
    const views = videos.filter((video) => video.viewsCount !== null);
    const likes = videos.filter((video) => video.likesCount !== null);
    const comments = videos.filter((video) => video.commentsCount !== null);
    const paired = videos.filter((video) => video.viewsCount !== null && video.likesCount !== null);
    const sum = (items: ProfileVideo[], field: "viewsCount" | "likesCount" | "commentsCount") =>
      items.reduce((total, video) => total + Number(video[field]), 0);
    const pairedViews = sum(paired, "viewsCount");
    return {
      views: sum(views, "viewsCount"), likes: sum(likes, "likesCount"), comments: sum(comments, "commentsCount"),
      viewsVideoCount: views.length, likesVideoCount: likes.length, commentsVideoCount: comments.length,
      likesPer100Views: pairedViews > 0 ? sum(paired, "likesCount") / pairedViews * 100 : null,
    };
  }, [videos]);

  const recentViewCounts = videos.map((video) => video.viewsCount === null ? null : Number(video.viewsCount))
    .filter((value): value is number => value !== null).sort((left, right) => left - right);
  const medianRecentViews = recentViewCounts.length
    ? recentViewCounts.length % 2
      ? recentViewCounts[Math.floor(recentViewCounts.length / 2)]
      : Math.round((recentViewCounts[recentViewCounts.length / 2 - 1] + recentViewCounts[recentViewCounts.length / 2]) / 2)
    : null;
  const workspaceName = profile?.channel.channelName ? displayChannelName(profile.channel.channelName) : "";
  const title = profile?.channel.youtubeTitle || workspaceName || "Channel profile";
  const location = profile ? [profile.channel.state, profile.channel.region, profile.channel.district].map(displayLocation).filter(Boolean).join(" · ") : "";

  if (!profile && !error) {
    return <div className="profile-loading"><span className="loader-mark">▶</span><p>Loading channel profile…</p><button className="button button-secondary" onClick={onBack}>Back to channels</button></div>;
  }

  if (error || !profile) {
    return <section className="panel profile-error"><button className="text-back" onClick={onBack}>← Back to channels</button><h1>Couldn’t open this channel</h1><p>{error || "Channel profile is unavailable."}</p></section>;
  }

  const channel = profile.channel;
  const stats = [
    { label: "Subscribers", value: channel.subscribersHidden ? "Hidden" : formatCompact(channel.subscriberCount) },
    { label: "Total channel views", value: formatCompact(channel.viewsTotal) },
    { label: "Total videos", value: formatNumber(channel.youtubeVideoCount) },
    { label: "Recent videos collected", value: formatCompact(channel.videosTracked) },
    { label: "Median views per recent video", value: medianRecentViews === null ? "—" : formatCompact(medianRecentViews) },
  ];

  return (
    <div className="channel-profile-page">
      <section className="profile-hero">
        {canManage && <div className="profile-hero-actions"><button className="button button-danger" type="button" onClick={deleteChannel} disabled={deleting}>{deleting ? "Deleting…" : "Delete channel"}</button>{deleteError && <p className="profile-delete-error" role="alert">{deleteError}</p>}</div>}
        <div className="profile-identity">
          <span className="profile-avatar" aria-hidden="true">{title.slice(0, 2).toUpperCase()}</span>
          <div className="profile-title-wrap">
            <p className="eyebrow">YOUTUBE CHANNEL</p>
            <h1><a className="profile-channel-youtube-link" href={`https://www.youtube.com/channel/${encodeURIComponent(channel.youtubeChannelId)}`} target="_blank" rel="noreferrer" aria-label={`Open ${title} on YouTube`}>{title}</a></h1>
            {channel.youtubeTitle && channel.youtubeTitle !== channel.channelName && <p className="profile-alias">Workspace name: {displayChannelName(channel.channelName)}</p>}
            <p className="profile-subline">{channel.youtubeChannelId}{location ? ` · ${location}` : ""}{channel.channelPublishedAt ? ` · On YouTube since ${new Date(channel.channelPublishedAt).getFullYear()}` : ""}</p>
            <div className="profile-tags"><span>{channel.category}</span>{channel.state && <span>{displayLocation(channel.state)}</span>}{channel.region && <span>{displayLocation(channel.region)}</span>}{channel.district && <span>{displayLocation(channel.district)}</span>}</div>
          </div>
        </div>
        <div className="profile-stat-grid" aria-label="Channel statistics">
          {stats.map((stat) => <article className="profile-stat-card" key={stat.label}><span>{stat.label}</span><strong>{stat.value}</strong></article>)}
        </div>
      </section>

      <section className="profile-main-grid">
        <article ref={videosPanelRef} className="panel profile-videos-panel">
          <div className="profile-panel-heading"><div><h2>Recent videos</h2><p>Views and engagement for the latest collected uploads.</p></div><span className="video-count-label">{visibleVideos.length} shown</span></div>
          <div className="profile-metric-tabs profile-video-tabs" role="group" aria-label="Filter recent videos">
            {(["all", "videos", "shorts"] as const).map((filter) => <button key={filter} type="button" className={videoFilter === filter ? "selected" : ""} aria-pressed={videoFilter === filter} onClick={() => setVideoFilter(filter)}>{filter === "all" ? "All" : filter === "videos" ? "Videos" : "Shorts"}</button>)}
          </div>
          {visibleVideos.length ? <>
            <div className="profile-video-list" role="table" aria-label="Recent videos and engagement metrics">
              <div className="profile-video-list-head" role="rowgroup"><div role="row"><span role="columnheader">VIDEO</span><span role="columnheader">VIEWS</span><span role="columnheader">LIKES</span><span role="columnheader">COMMENTS</span></div></div>
              <div className="profile-video-list-scroll" role="rowgroup">
                {visibleVideos.map((video, index) => <div className="profile-video-row" role="row" key={video.youtubeVideoId}>
                  <div className="profile-video-title">
                    <a className="profile-video-title-link" href={`https://www.youtube.com/watch?v=${encodeURIComponent(video.youtubeVideoId)}`} target="_blank" rel="noreferrer" title={video.videoTitle || "Untitled video"}>
                      <small>{video.publishedAt ? formatDate(video.publishedAt, { month: "short", day: "numeric", year: "numeric" }) : `Video ${index + 1}`}</small>
                      <strong>{video.videoTitle || "Untitled video"}</strong>
                    </a>
                    {video.keywords?.length > 0 && <span className="profile-video-keywords" aria-label={`Keywords: ${video.keywords.join(", ")}`}>
                      {video.keywords.map((keyword) => <button type="button" key={keyword} title={`Search videos matching “${keyword}”`} onClick={() => onKeywordClick(keyword)}>{keyword}</button>)}
                    </span>}
                  </div>
                  <span role="cell">{formatCompact(video.viewsCount)}</span><span role="cell">{formatCompact(video.likesCount)}</span><span role="cell">{formatCompact(video.commentsCount)}</span>
                </div>)}
              </div>
            </div>
          </> : <div className="profile-empty-videos"><span>▶</span><strong>{videoFilter === "shorts" ? "No Shorts collected yet" : videoFilter === "videos" ? "No regular videos collected yet" : "No video metrics collected yet"}</strong><p>Choose <b>Collect engagement</b> to load public views, likes, and comments for this channel’s recent uploads.</p></div>}
        </article>

        <div ref={sideStackRef} className="profile-side-stack">
          <article className="panel profile-engagement-panel">
            <div className="profile-panel-heading"><div><h2>Engagement</h2><p>Counts show how many videos have each metric.</p></div><span className="profile-insight-icon">♡</span></div>
            <div className="profile-engagement-score"><strong>{engagement.likesPer100Views === null ? "—" : engagement.likesPer100Views.toFixed(2)}</strong><span>likes per 100 views</span></div>
            <div className="profile-engagement-track"><i style={{ width: `${Math.min(100, (engagement.likesPer100Views ?? 0) / 6 * 100)}%` }} /></div>
            <div className="profile-engagement-scale"><span>0</span><span>1</span><span>2</span><span>4</span><span>6+</span></div>
            <div className="profile-engagement-totals">
              <div><span>Views <small>· {engagement.viewsVideoCount} videos</small></span><strong>{formatCompact(engagement.views)}</strong></div>
              <div><span>Likes <small>· {engagement.likesVideoCount} videos</small></span><strong>{formatCompact(engagement.likes)}</strong></div>
              <div><span>Comments <small>· {engagement.commentsVideoCount} videos</small></span><strong>{formatCompact(engagement.comments)}</strong></div>
            </div>
          </article>

          <article className="panel profile-contact-panel">
            <div className="profile-panel-heading"><div><h2>Contact details</h2><p>{channel.contactDetailsSource === "manual" ? `Manually provided${channel.contactDetailsObservedAt ? ` · ${formatDate(channel.contactDetailsObservedAt)}` : ""}` : "Add details shared with your workspace"}</p></div></div>
            <div className="profile-contact-content">
              {(channel.contactDetails.emails.length > 0 || channel.contactDetails.phones.length > 0 || channel.contactDetails.socialLinks.length > 0 || channel.contactDetails.websites.length > 0) && <div className="profile-contact-list">
                {channel.contactDetails.emails.map((email, index) => <div className="profile-contact-entry" key={`email-${email}`}><a className="profile-contact-row" href={`mailto:${email}`}><span className="profile-contact-symbol">@</span><span><small>Email</small><strong>{email}</strong></span></a>{canManage && <button type="button" className="profile-contact-delete" onClick={() => void deleteSavedContact("emails", index)} disabled={contactSaving} aria-label={`Delete email ${email}`}>Delete</button>}</div>)}
                {channel.contactDetails.phones.map((phone, index) => <div className="profile-contact-entry" key={`phone-${phone}`}><a className="profile-contact-row" href={`tel:${phone.replace(/[^+\d]/g, "")}`}><span className="profile-contact-symbol">⌕</span><span><small>Phone</small><strong>{phone}</strong></span></a>{canManage && <button type="button" className="profile-contact-delete" onClick={() => void deleteSavedContact("phones", index)} disabled={contactSaving} aria-label={`Delete phone ${phone}`}>Delete</button>}</div>)}
                {channel.contactDetails.socialLinks.map((social, index) => <div className="profile-contact-entry" key={`social-${social.url}`}><a className="profile-contact-row" href={social.url} target="_blank" rel="noreferrer"><span className="profile-contact-symbol">↗</span><span><small>{social.platform}</small><strong>{social.url.replace(/^https?:\/\//i, "")}</strong></span></a>{canManage && <button type="button" className="profile-contact-delete" onClick={() => void deleteSavedContact("socialLinks", index)} disabled={contactSaving} aria-label={`Delete ${social.platform} link`}>Delete</button>}</div>)}
                {channel.contactDetails.websites.map((website, index) => <div className="profile-contact-entry" key={`website-${website.url}`}><a className="profile-contact-row" href={website.url} target="_blank" rel="noreferrer"><span className="profile-contact-symbol">↗</span><span><small>{website.name}</small><strong>{website.url.replace(/^https?:\/\//i, "")}</strong></span></a>{canManage && <button type="button" className="profile-contact-delete" onClick={() => void deleteSavedContact("websites", index)} disabled={contactSaving} aria-label={`Delete ${website.name}`}>Delete</button>}</div>)}
              </div>}
              {canManage && <form className="profile-contact-form" onSubmit={saveContacts}>
                <label>Email addresses<textarea rows={2} value={contactDraft.emails} onChange={(event) => setContactDraft((current) => ({ ...current, emails: event.target.value }))} placeholder="info@example.com" /></label>
                <label>Phone numbers<textarea rows={2} value={contactDraft.phones} onChange={(event) => setContactDraft((current) => ({ ...current, phones: event.target.value }))} placeholder="One number per line" /></label>
                <label>Social profiles<textarea rows={3} value={contactDraft.socialLinks} onChange={(event) => setContactDraft((current) => ({ ...current, socialLinks: event.target.value }))} placeholder={'Facebook | https://facebook.com/example\nX | https://x.com/example'} /></label>
                <label>Website and app links<textarea rows={3} value={contactDraft.websites} onChange={(event) => setContactDraft((current) => ({ ...current, websites: event.target.value }))} placeholder={'Website | https://example.com\niOS app | https://apps.apple.com/...'} /></label>
                <small className="profile-contact-form-note">One item per line. For links, enter a label, a vertical bar, and the URL.</small>
                {contactError && <p className="profile-contact-error" role="alert">{contactError}</p>}
                <div className="profile-contact-form-actions"><button type="button" className="button button-secondary" onClick={() => setContactDraft(makeContactDraft(channel.contactDetails))}>Reset</button><button type="submit" className="button button-primary" disabled={contactSaving}>{contactSaving ? "Saving…" : "Save details"}</button></div>
              </form>}
            </div>
          </article>
        </div>
      </section>

      <section className="panel profile-trends-panel">
        <div className="profile-panel-heading profile-trends-heading"><div><h2>{trendInterval === "daily" ? "Daily" : "Monthly"} metric trends</h2><p>View points show the total recorded at collection time; the summary shows views gained in the last 30 days. Engagement shows {trendInterval === "daily" ? "daily" : "monthly"} medians.</p></div><label className="trend-interval-control"><span>Show</span><select className="filter-select" value={trendInterval} onChange={(event) => setTrendInterval(event.target.value as TrendInterval)} aria-label="Trend interval"><option value="daily">Daily</option><option value="monthly">Monthly</option></select></label></div>
        <div className="profile-trend-tabs" role="group" aria-label="Choose trend metric">
          {([{ key: "viewsTotal", label: "Channel views", color: "#267dd9" }, { key: "medianLikes", label: "Median likes", color: "#d92626" }, { key: "medianComments", label: "Median comments", color: "#26d9ca" }] as const).map(({ key, label }) => <button key={key} type="button" aria-pressed={trendMetric === key} className={trendMetric === key ? "active" : ""} onClick={() => setTrendMetric(key)}>{label}</button>)}
        </div>
        <TrendChart title={trendMetric === "viewsTotal" ? "Channel views" : trendMetric === "medianLikes" ? "Median likes per video" : "Median comments per video"} points={trendPoints} valueKey={trendMetric} color={trendMetric === "viewsTotal" ? "#267dd9" : trendMetric === "medianLikes" ? "#d92626" : "#26d9ca"} summaryLabel={trendMetric === "viewsTotal" ? "Views gained (last 30 days)" : "Latest"} summaryValue={trendMetric === "viewsTotal" ? trendPoints.reduce((total, point) => total + (Number(point.viewsGained) || 0), 0) : undefined} interval={trendInterval} />
      </section>

      <section className="profile-detail-grid">
        <article className="panel profile-description-panel"><div className="profile-panel-heading"><div><h2>Channel description</h2><p>About this channel on YouTube</p></div></div><div className="profile-description">{channel.description?.trim() || <span className="profile-muted">No description has been collected yet. Run a metrics collection to load the public channel description.</span>}</div></article>
        <article className="panel profile-info-panel"><div className="profile-panel-heading"><div><h2>Channel details</h2><p>Workspace and YouTube information</p></div></div><dl><div><dt>Category</dt><dd>{channel.category || "—"}</dd></div><div><dt>State</dt><dd>{displayLocation(channel.state) || "—"}</dd></div><div><dt>Regional area</dt><dd>{displayLocation(channel.region) || "—"}</dd></div><div><dt>District</dt><dd>{displayLocation(channel.district) || "—"}</dd></div><div><dt>On YouTube since</dt><dd>{formatDate(channel.channelPublishedAt, { year: "numeric" })}</dd></div><div><dt>Profile collected</dt><dd>{formatDate(channel.profileObservedAt, { dateStyle: "medium", timeStyle: "short" })}</dd></div><div><dt>Views collected</dt><dd>{formatDate(channel.viewsObservedAt, { dateStyle: "medium", timeStyle: "short" })}</dd></div></dl></article>
      </section>
    </div>
  );
}
