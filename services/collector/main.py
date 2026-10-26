import os
import asyncio
import base64
import secrets
import time
import hmac
import hashlib
import json
import html
import re
import shutil
import sys
import tempfile
import xml.etree.ElementTree as ET
from contextlib import contextmanager
from typing import Any, Literal

import httpx
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3"
API_INTERNAL_URL = os.getenv("API_INTERNAL_URL", "http://localhost:4000/api/v1")
WORKER_TOKEN = os.getenv("WORKER_TOKEN", "")
YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY", "")
MAX_VIDEOS_PER_CHANNEL = max(1, min(int(os.getenv("MAX_VIDEOS_PER_CHANNEL", "100")), 100))
COLLECTION_CHANNEL_CONCURRENCY = max(1, min(int(os.getenv("COLLECTION_CHANNEL_CONCURRENCY", "6")), 8))
YOUTUBE_CHANNEL_BATCH_SIZE = 50
YOUTUBE_REQUEST_SEMAPHORE = asyncio.Semaphore(8)
CLOUDFLARE_ACCOUNT_ID = os.getenv("CLOUDFLARE_ACCOUNT_ID", "")
CLOUDFLARE_API_TOKEN = os.getenv("CLOUDFLARE_API_TOKEN", "")
CLOUDFLARE_WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo"
YOUTUBE_COOKIES_FILE = os.getenv("YOUTUBE_COOKIES_FILE", "")
YOUTUBE_COOKIES_TMP_DIR = os.getenv("YOUTUBE_COOKIES_TMP_DIR", "/dev/shm")
MAX_TRANSCRIPTION_AUDIO_BYTES = 20 * 1024 * 1024
app = FastAPI(title="YouTube Metrics Collector", docs_url=None, redoc_url=None)


class ChannelInput(BaseModel):
    id: str
    youtube_channel_id: str = Field(alias="youtubeChannelId")


class CollectionRequest(BaseModel):
    job_id: str = Field(alias="jobId")
    scope: Literal["all", "views", "engagement"]
    published_after: str | None = Field(default=None, alias="publishedAfter")
    published_before: str | None = Field(default=None, alias="publishedBefore")
    channels: list[ChannelInput]


def _caption_text(raw: bytes, extension: str) -> str:
    text = raw.decode("utf-8", errors="replace")
    if extension == "json3":
        try:
            payload = json.loads(text)
            return " ".join(
                segment.get("utf8", "")
                for event in payload.get("events", [])
                for segment in event.get("segs", [])
                if isinstance(segment, dict)
            ).strip()
        except (ValueError, AttributeError):
            return ""
    lines = []
    for line in text.splitlines():
        value = line.strip()
        if not value or value.upper() == "WEBVTT" or value.startswith(("NOTE", "STYLE", "Kind:", "Language:")):
            continue
        if "-->" in value or re.fullmatch(r"\d+", value):
            continue
        value = re.sub(r"<[^>]*>", "", value)
        value = html.unescape(value).strip()
        if value and (not lines or lines[-1] != value):
            lines.append(value)
    return " ".join(lines)


def _safe_diagnostic(value: str, limit: int = 240) -> str:
    # yt-dlp errors can contain signed media URLs. Keep useful error text, but
    # never print those URLs (or their query-string tokens) into container logs.
    value = re.sub(r"https?://\S+", "<url>", value)
    return re.sub(r"\s+", " ", value).strip()[:limit]


@contextmanager
def _yt_dlp_cookiefile():
    """Copy the read-only host cookie file into ephemeral RAM for yt-dlp."""
    if not YOUTUBE_COOKIES_FILE:
        yield None
        return

    os.makedirs(YOUTUBE_COOKIES_TMP_DIR, mode=0o700, exist_ok=True)
    fd, temporary_path = tempfile.mkstemp(prefix="youtube-cookies-", suffix=".txt", dir=YOUTUBE_COOKIES_TMP_DIR)
    os.close(fd)
    try:
        shutil.copyfile(YOUTUBE_COOKIES_FILE, temporary_path)
        os.chmod(temporary_path, 0o600)
        yield temporary_path
    finally:
        try:
            os.unlink(temporary_path)
        except FileNotFoundError:
            pass


def _youtube_captions(video_id: str) -> str | None:
    from yt_dlp import YoutubeDL

    options = {"quiet": True, "no_warnings": True, "no_color": True, "no_cache": True, "skip_download": True}
    try:
        with _yt_dlp_cookiefile() as cookiefile:
            if cookiefile:
                options["cookiefile"] = cookiefile
                # yt-dlp's default logged-in tv_downgraded client can currently
                # return "The page needs to be reloaded". Prefer supported web
                # clients when using cookies.
                options["extractor_args"] = {"youtube": {"player_client": ["default", "web_embedded"]}}
            with YoutubeDL(options) as ydl:
                info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
                if not info:
                    return None
                tracks: list[tuple[int, str, dict[str, Any]]] = []
                for group, rank in ((info.get("subtitles", {}), 0), (info.get("automatic_captions", {}), 1)):
                    for language, formats in group.items():
                        for track in formats:
                            if track.get("ext") not in {"vtt", "json3"} or not track.get("url"):
                                continue
                            language_rank = 0 if language.lower().startswith("en") else 1
                            format_rank = 0 if track.get("ext") == "vtt" else 1
                            tracks.append((rank * 10 + language_rank * 2 + format_rank, language, track))
                for _, _language, track in sorted(tracks, key=lambda item: item[0]):
                    try:
                        with ydl.urlopen(track["url"]) as response:
                            raw = response.read(5 * 1024 * 1024 + 1)
                        if len(raw) > 5 * 1024 * 1024:
                            continue
                        transcript = _caption_text(raw, track.get("ext", "vtt"))
                        if transcript:
                            return transcript[:120_000]
                    except Exception:
                        continue
    except Exception as error:
        # A caption lookup problem should still try the Whisper audio fallback.
        print(f"YouTube caption lookup failed ({type(error).__name__}): {_safe_diagnostic(str(error)) or 'no details'}; trying audio fallback")
    return None


async def _extract_audio(video_id: str) -> bytes:
    with _yt_dlp_cookiefile() as cookiefile:
        command = [
            sys.executable, "-m", "yt_dlp", "--ignore-config", "--no-cache-dir", "--no-part",
            "--quiet", "--no-warnings", "--no-progress", "-f", "bestaudio", "-o", "-",
        ]
        if cookiefile:
            command.extend([
                "--cookies", cookiefile,
                "--extractor-args", "youtube:player_client=default,web_embedded",
            ])
        command.append(f"https://www.youtube.com/watch?v={video_id}")
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        assert process.stdout is not None and process.stderr is not None
        stderr_tail = bytearray()

        async def drain_stderr() -> None:
            while chunk := await process.stderr.read(4096):
                # Drain all stderr to avoid blocking yt-dlp, but retain only a small tail.
                stderr_tail.extend(chunk)
                if len(stderr_tail) > 4096:
                    del stderr_tail[:-4096]

        stderr_task = asyncio.create_task(drain_stderr())
        chunks: list[bytes] = []
        size = 0
        deadline = time.monotonic() + 8 * 60
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise HTTPException(status_code=504, detail="yt-dlp audio extraction timed out.")
                chunk = await asyncio.wait_for(process.stdout.read(64 * 1024), timeout=remaining)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_TRANSCRIPTION_AUDIO_BYTES:
                    raise HTTPException(status_code=413, detail="This video’s audio is larger than the 20 MB in-memory limit. No audio file was saved.")
                chunks.append(chunk)
            exit_code = await asyncio.wait_for(process.wait(), timeout=max(1, deadline - time.monotonic()))
            await stderr_task
            if exit_code != 0 or not size:
                reason = _safe_diagnostic(stderr_tail.decode("utf-8", errors="replace"))
                detail = f"yt-dlp could not extract audio (exit {exit_code})."
                if reason:
                    detail += f" {reason}"
                raise HTTPException(status_code=422, detail=detail)
            return b"".join(chunks)
        except asyncio.TimeoutError as error:
            process.kill()
            await process.wait()
            await stderr_task
            raise HTTPException(status_code=504, detail="yt-dlp audio extraction timed out.") from error
        except Exception:
            if process.returncode is None:
                process.kill()
                await process.wait()
            await stderr_task
            raise


async def _cloudflare_transcript(audio: bytes) -> str:
    if not CLOUDFLARE_ACCOUNT_ID or not CLOUDFLARE_API_TOKEN:
        raise HTTPException(status_code=503, detail="Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to enable Whisper fallback.")
    if not re.fullmatch(r"[A-Fa-f0-9]{32}", CLOUDFLARE_ACCOUNT_ID):
        raise HTTPException(status_code=503, detail="CLOUDFLARE_ACCOUNT_ID must be the 32-character account ID from Cloudflare.")
    endpoint = f"https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/run/{CLOUDFLARE_WHISPER_MODEL}"
    payload = {"audio": base64.b64encode(audio).decode("ascii"), "task": "transcribe"}
    response = None
    for attempt in range(2):
        try:
            async with httpx.AsyncClient(timeout=240) as client:
                response = await client.post(endpoint, headers={"Authorization": f"Bearer {CLOUDFLARE_API_TOKEN}"}, json=payload)
        except httpx.TransportError:
            if attempt == 0:
                await asyncio.sleep(2)
                continue
            raise HTTPException(status_code=502, detail="Cloudflare Whisper request failed due to a network error after retrying.")
        if response.status_code not in {500, 502, 503, 504} or attempt == 1:
            break
        await asyncio.sleep(2)
    assert response is not None
    if response.is_error:
        provider_detail = ""
        try:
            errors = response.json().get("errors", [])
            if errors and isinstance(errors[0], dict):
                provider_detail = str(errors[0].get("message", ""))[:240]
        except (ValueError, AttributeError, IndexError):
            pass
        detail = f"Cloudflare Whisper returned HTTP {response.status_code}"
        if provider_detail:
            detail += f": {provider_detail}"
        raise HTTPException(status_code=502, detail=detail + ".")
    try:
        result = response.json().get("result", {})
    except (ValueError, AttributeError):
        result = {}
    transcript = result.get("text") if isinstance(result, dict) else None
    if not isinstance(transcript, str) or not transcript.strip():
        raise HTTPException(status_code=502, detail="Cloudflare Whisper returned no transcript.")
    return transcript[:120_000]


def authorized(provided: str | None) -> bool:
    return bool(provided and WORKER_TOKEN and secrets.compare_digest(provided, WORKER_TOKEN))


@app.post("/transcribe")
async def transcribe_video(payload: dict[str, Any], x_worker_token: str | None = Header(default=None)) -> dict[str, str]:
    if not authorized(x_worker_token):
        raise HTTPException(status_code=401, detail="Unauthorized")
    video_id = payload.get("videoId")
    if not isinstance(video_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        raise HTTPException(status_code=400, detail="A valid YouTube video ID is required.")
    try:
        transcript = await asyncio.to_thread(_youtube_captions, video_id)
        if transcript:
            return {"transcript": transcript, "source": "youtube_captions"}
        if not CLOUDFLARE_ACCOUNT_ID or not CLOUDFLARE_API_TOKEN:
            raise HTTPException(status_code=503, detail="Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to enable Whisper fallback.")
        audio = await _extract_audio(video_id)
        transcript = await _cloudflare_transcript(audio)
        del audio
        return {"transcript": transcript, "source": "cloudflare_whisper"}
    except HTTPException:
        raise
    except Exception as error:
        reason = _safe_diagnostic(str(error), 300)
        print(f"Transcription failed ({type(error).__name__}): {reason or 'no additional error details'}")
        raise HTTPException(
            status_code=502,
            detail=f"Caption lookup or transcription failed ({type(error).__name__}). Check worker logs for details.",
        ) from error


async def youtube_get(client: httpx.AsyncClient, endpoint: str, params: dict[str, Any]) -> dict[str, Any]:
    response: httpx.Response | None = None
    for attempt in range(3):
        async with YOUTUBE_REQUEST_SEMAPHORE:
            response = await client.get(
                f"{YOUTUBE_API_BASE}/{endpoint}",
                params={**params, "key": YOUTUBE_API_KEY},
            )
        if response.status_code not in (429, 500, 502, 503, 504) or attempt == 2:
            break
        try:
            retry_after = float(response.headers.get("Retry-After", ""))
        except ValueError:
            retry_after = 0
        await asyncio.sleep(min(retry_after if retry_after > 0 else 0.5 * (2 ** attempt), 8))
    assert response is not None
    if response.is_error:
        detail = ""
        try:
            detail = response.json().get("error", {}).get("message", "")
        except (ValueError, AttributeError):
            pass
        suffix = f": {detail}" if detail else ""
        raise RuntimeError(f"YouTube API returned HTTP {response.status_code}{suffix}")
    return response.json()


async def get_channels(
    client: httpx.AsyncClient,
    channels: list[ChannelInput],
    parts: str,
) -> list[dict[str, Any]]:
    if not channels:
        return []
    channel_data = await youtube_get(
        client,
        "channels",
        {"part": parts, "id": ",".join(channel.youtube_channel_id for channel in channels)},
    )
    return channel_data.get("items", [])


def views_metric(channel: ChannelInput, youtube_channel: dict[str, Any]) -> dict[str, Any]:
    statistics = youtube_channel.get("statistics", {})
    return {
        "channelId": channel.id,
        "viewsTotal": int(statistics.get("viewCount", 0)),
    }


def channel_profile(channel: ChannelInput, youtube_channel: dict[str, Any]) -> dict[str, Any]:
    snippet = youtube_channel.get("snippet", {})
    statistics = youtube_channel.get("statistics", {})
    description = snippet.get("description", "")
    return {
        "channelId": channel.id,
        "title": snippet.get("title", ""),
        "description": snippet.get("description", ""),
        "publishedAt": snippet.get("publishedAt"),
        "subscriberCount": int(statistics["subscriberCount"]) if "subscriberCount" in statistics else None,
        "subscribersHidden": bool(statistics.get("hiddenSubscriberCount", False)),
        "videoCount": int(statistics["videoCount"]) if "videoCount" in statistics else None,
    }


def _recent_upload_ids_from_youtube(channel_id: str, tab: str = "videos") -> list[str]:
    """Read a public Videos or Shorts tab without spending YouTube Data API quota."""
    from yt_dlp import YoutubeDL

    options = {
        "quiet": True,
        "no_warnings": True,
        "no_color": True,
        "no_cache": True,
        "skip_download": True,
        "extract_flat": "in_playlist",
        "playlistend": MAX_VIDEOS_PER_CHANNEL,
        "ignoreerrors": True,
    }
    with YoutubeDL(options) as ydl:
        result = ydl.extract_info(f"https://www.youtube.com/channel/{channel_id}/{tab}", download=False)
    return list(dict.fromkeys(
        entry["id"] for entry in (result or {}).get("entries", [])
        if isinstance(entry, dict) and entry.get("id")
    ))[:MAX_VIDEOS_PER_CHANNEL]


async def engagement_metric(
    client: httpx.AsyncClient,
    channel: ChannelInput,
    youtube_channel: dict[str, Any],
    published_after: str | None = None,
    published_before: str | None = None,
) -> list[dict[str, Any]]:
    uploads_playlist = youtube_channel.get("contentDetails", {}).get("relatedPlaylists", {}).get("uploads")
    if not uploads_playlist:
        raise RuntimeError("YouTube did not return an uploads playlist for this channel.")

    is_date_range = bool(published_after and published_before)
    video_ids: list[str] = []
    public_video_ids: list[str] = []
    short_video_ids: list[str] = []
    try:
        short_video_ids = await asyncio.to_thread(
            _recent_upload_ids_from_youtube,
            channel.youtube_channel_id,
            "shorts",
        )
    except Exception as exc:
        print(f"Could not read recent Shorts for {channel.id}: {type(exc).__name__}")
    if not is_date_range:
        try:
            public_video_ids = await asyncio.to_thread(
                _recent_upload_ids_from_youtube,
                channel.youtube_channel_id,
            )
        except Exception as exc:
            print(f"Could not read recent videos for {channel.id}: {type(exc).__name__}")
    video_ids = public_video_ids.copy()

    page_token: str | None = None
    should_stop = False
    while (is_date_range or not public_video_ids) and len(video_ids) < MAX_VIDEOS_PER_CHANNEL and not should_stop:
        params: dict[str, Any] = {
            "part": "snippet,contentDetails" if is_date_range else "contentDetails",
            "playlistId": uploads_playlist,
            "maxResults": 50,
        }
        if page_token:
            params["pageToken"] = page_token
        playlist_page = await youtube_get(client, "playlistItems", params)
        for item in playlist_page.get("items", []):
            video_id = item.get("contentDetails", {}).get("videoId")
            # For playlist items, snippet.publishedAt is when the item was
            # added to the playlist. Use videoPublishedAt for the actual
            # upload date so the selected range describes video publication.
            published_at = item.get("contentDetails", {}).get("videoPublishedAt") or item.get("snippet", {}).get("publishedAt")
            if not video_id:
                continue
            if is_date_range:
                if not published_at:
                    continue
                if published_at < published_after:
                    should_stop = True
                    break
                if published_at >= published_before:
                    continue
            video_ids.append(video_id)
            if len(video_ids) >= MAX_VIDEOS_PER_CHANNEL:
                break
        video_ids = video_ids[:MAX_VIDEOS_PER_CHANNEL]
        page_token = playlist_page.get("nextPageToken")
        if should_stop or not page_token or len(video_ids) >= MAX_VIDEOS_PER_CHANNEL:
            break

    # YouTube's uploads playlist and public RSS feed can lag behind the Videos
    # tab. Discover the latest uploads from that tab first; yt-dlp only reads
    # public metadata here, while videos.list below still supplies engagement.
    if not is_date_range:
        try:
            response = await client.get(
                "https://www.youtube.com/feeds/videos.xml",
                params={"channel_id": channel.youtube_channel_id},
                headers={"Cache-Control": "no-cache"},
            )
            response.raise_for_status()
            feed = ET.fromstring(response.content)
            feed_video_ids = [
                item.text.strip()
                for item in feed.findall(".//{http://www.youtube.com/xml/schemas/2015}videoId")
                if item.text and item.text.strip()
            ]
            video_ids = list(dict.fromkeys([
                *public_video_ids, *feed_video_ids, *video_ids, *short_video_ids,
            ]))[:MAX_VIDEOS_PER_CHANNEL * 2]
        except (httpx.HTTPError, ET.ParseError) as exc:
            # Keep the Videos tab IDs if the public feed is unavailable.
            print(f"Could not read recent-upload feed for {channel.id}: {type(exc).__name__}")

    if is_date_range:
        video_ids = list(dict.fromkeys([*video_ids, *short_video_ids]))[:MAX_VIDEOS_PER_CHANNEL * 2]

    if not is_date_range and not video_ids and int(youtube_channel.get("statistics", {}).get("videoCount", 0)) > 0:
        raise RuntimeError("YouTube returned no upload IDs for a channel that has videos.")

    engagement: list[dict[str, Any]] = []
    for start in range(0, len(video_ids), 50):
        videos_page = await youtube_get(
            client,
            "videos",
            {"part": "snippet,statistics", "id": ",".join(video_ids[start : start + 50])},
        )
        for video in videos_page.get("items", []):
            snippet = video.get("snippet", {})
            video_statistics = video.get("statistics", {})
            published_at = snippet.get("publishedAt")
            if is_date_range and (not published_at or published_at < published_after or published_at >= published_before):
                continue
            engagement.append({
                "channelId": channel.id,
                "videoId": video.get("id", ""),
                "title": snippet.get("title", "Untitled video"),
                "description": snippet.get("description", ""),
                "publishedAt": published_at,
                "isShort": video.get("id") in short_video_ids,
                "views": int(video_statistics["viewCount"]) if "viewCount" in video_statistics else None,
                "likes": int(video_statistics["likeCount"]) if "likeCount" in video_statistics else None,
                "comments": int(video_statistics["commentCount"]) if "commentCount" in video_statistics else None,
                "shares": None,
            })
    if video_ids and not engagement:
        raise RuntimeError("YouTube returned upload IDs but no video details for them.")
    return engagement


async def collect_job(job: CollectionRequest) -> None:
    views: list[dict[str, Any]] = []
    channel_profiles: list[dict[str, Any]] = []
    video_engagement: list[dict[str, Any]] = []
    completed_kinds: list[dict[str, str]] = []
    errors: list[dict[str, str]] = []
    timeout = httpx.Timeout(30.0, connect=10.0)

    async with httpx.AsyncClient(timeout=timeout) as client:
        parts = "snippet,statistics" if job.scope == "views" else "snippet,statistics,contentDetails"
        youtube_channels: dict[str, dict[str, Any]] = {}
        failed_channel_ids: set[str] = set()
        for start in range(0, len(job.channels), YOUTUBE_CHANNEL_BATCH_SIZE):
            batch = job.channels[start : start + YOUTUBE_CHANNEL_BATCH_SIZE]
            try:
                for youtube_channel in await get_channels(client, batch, parts):
                    youtube_id = youtube_channel.get("id")
                    if youtube_id:
                        youtube_channels[youtube_id] = youtube_channel
            except Exception as exc:  # Keep collecting other channels if one fails.
                for channel in batch:
                    failed_channel_ids.add(channel.id)
                    errors.append({"channelId": channel.id, "scraper": job.scope, "message": str(exc)[:500]})

        semaphore = asyncio.Semaphore(COLLECTION_CHANNEL_CONCURRENCY)

        async def collect_channel(channel: ChannelInput) -> None:
            async with semaphore:
                youtube_channel = youtube_channels.get(channel.youtube_channel_id)
                if not youtube_channel:
                    if channel.id not in failed_channel_ids:
                        errors.append({
                            "channelId": channel.id,
                            "scraper": job.scope,
                            "message": "YouTube did not return a channel for this ID.",
                        })
                    return

                channel_profiles.append(channel_profile(channel, youtube_channel))

                if job.scope in ("all", "views"):
                    try:
                        views.append(views_metric(channel, youtube_channel))
                        completed_kinds.append({"channelId": channel.id, "kind": "views"})
                    except Exception as exc:
                        errors.append({"channelId": channel.id, "scraper": "views", "message": str(exc)[:500]})
                if job.scope in ("all", "engagement"):
                    try:
                        video_engagement.extend(await engagement_metric(
                            client,
                            channel,
                            youtube_channel,
                            job.published_after,
                            job.published_before,
                        ))
                        completed_kinds.append({"channelId": channel.id, "kind": "engagement"})
                    except Exception as exc:
                        errors.append({"channelId": channel.id, "scraper": "engagement", "message": str(exc)[:500]})

        await asyncio.gather(*(collect_channel(channel) for channel in job.channels))

        callback_batch_size = 3
        for start in range(0, len(job.channels), callback_batch_size):
            channel_ids = [channel.id for channel in job.channels[start : start + callback_batch_size]]
            channel_id_set = set(channel_ids)
            result_payload = {
                "channelIds": channel_ids,
                "final": start + callback_batch_size >= len(job.channels),
                "views": [item for item in views if item["channelId"] in channel_id_set],
                "channelProfiles": [item for item in channel_profiles if item["channelId"] in channel_id_set],
                "videoEngagement": [item for item in video_engagement if item["channelId"] in channel_id_set],
                "completedKinds": [item for item in completed_kinds if item["channelId"] in channel_id_set],
                "errors": [item for item in errors if item["channelId"] in channel_id_set],
            }
            try:
                body = json.dumps(result_payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
                timestamp = str(int(time.time()))
                signature = hmac.new(
                    WORKER_TOKEN.encode("utf-8"),
                    timestamp.encode("ascii") + b"." + body,
                    hashlib.sha256,
                ).hexdigest()
                response = await client.post(
                    f"{API_INTERNAL_URL}/internal/collection-jobs/{job.job_id}/results",
                    content=body,
                    headers={
                        "content-type": "application/json",
                        "x-worker-timestamp": timestamp,
                        "x-worker-signature": signature,
                    },
                )
                response.raise_for_status()
            except httpx.HTTPError as exc:
                # Continue sending later batches so the API can finish this job as partial.
                print(f"Could not return a collection result batch to the API: {type(exc).__name__}")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/jobs", status_code=202)
async def start_job(
    request: CollectionRequest,
    background_tasks: BackgroundTasks,
    x_worker_token: str | None = Header(default=None),
) -> dict[str, str]:
    if not authorized(x_worker_token):
        raise HTTPException(status_code=401, detail="Worker authentication failed.")
    if not YOUTUBE_API_KEY:
        raise HTTPException(status_code=503, detail="YouTube API key is not configured.")
    if not request.channels:
        raise HTTPException(status_code=400, detail="A collection job needs at least one channel.")
    background_tasks.add_task(collect_job, request)
    return {"jobId": request.job_id, "status": "running"}
