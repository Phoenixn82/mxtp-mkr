#!/usr/bin/env python3
"""Download a YouTube playlist with the same CLI contract as Get-PlaylistMp3.ps1."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.parse
from collections import Counter
from pathlib import Path


AUDIO_EXTENSIONS = {".mp3", ".m4a", ".opus", ".webm", ".flac", ".wav", ".ogg", ".aac"}
SOURCE_MARKER = ".mxtp-source.json"


def write_step(message: str) -> None:
    print(f"==> {message}")


def write_warn(message: str) -> None:
    print(f"!!  {message}")


def write_bad(message: str) -> None:
    print(f"XX  {message}")


def safe_name(value: str) -> str:
    name = "".join("_" if ord(char) < 32 or char in '<>:"/\\|?*' else char for char in value)
    name = name.strip().rstrip(".")
    if not name:
        name = "YouTube Downloads"
    return name[:120].rstrip()


def lookup_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def resolve_tool(override_var: str, executable: str) -> str | None:
    override = os.environ.get(override_var, "").strip()
    if override:
        candidate = Path(override).expanduser()
        return str(candidate) if candidate.is_file() and os.access(candidate, os.X_OK) else None
    return shutil.which(executable)


def source_identity(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    query = urllib.parse.parse_qs(parsed.query)
    if host in {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"}:
        if query.get("list", [""])[0]:
            return f"youtube-playlist:{query['list'][0]}"
        if query.get("v", [""])[0]:
            return f"youtube-video:{query['v'][0]}"
    if host == "youtu.be" and parsed.path.strip("/"):
        return f"youtube-video:{parsed.path.strip('/').split('/')[0]}"
    return urllib.parse.urlunparse(
        (
            parsed.scheme.lower(),
            parsed.netloc.lower(),
            parsed.path,
            "",
            urllib.parse.urlencode(sorted(urllib.parse.parse_qsl(parsed.query))),
            "",
        )
    )


def source_metadata(folder: Path) -> dict[str, str] | None:
    try:
        value = json.loads((folder / SOURCE_MARKER).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict):
        return None
    return {key: str(value[key]) for key in ("source", "title") if value.get(key)}


def playlist_destination(out_root: Path, title: str, url: str) -> Path:
    identity = source_identity(url)
    base = out_root / safe_name(title)
    existing = source_metadata(base)
    base_is_empty = base.is_dir() and next(base.iterdir(), None) is None
    if not base.exists() or base_is_empty or (existing and existing.get("source") == identity):
        destination = base
    else:
        digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()
        destination = out_root / f"{safe_name(title)} [{digest}]"
        collision = source_metadata(destination)
        if destination.exists() and (collision is None or collision.get("source") != identity):
            raise RuntimeError(f"playlist cache destination is already owned by another source: {destination}")

    destination.mkdir(parents=True, exist_ok=True)
    marker = {"source": identity, "title": title}
    (destination / SOURCE_MARKER).write_text(
        json.dumps(marker, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return destination


def run_quietly(arguments: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(arguments, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)


def first_output_line(result: subprocess.CompletedProcess[str]) -> str | None:
    return next((line for line in result.stdout.splitlines() if line.strip()), None)


def resolve_album(yt_dlp: str, artist: str, album: str) -> tuple[str, str, str, int] | None:
    write_step("Finding the official album playlist")
    query = urllib.parse.quote(f"{artist} {album}")
    search_url = f"https://www.youtube.com/results?search_query={query}&sp=EgIQAw%3D%3D"
    search = run_quietly(
        [
            yt_dlp,
            "--flat-playlist",
            "--no-warnings",
            "--ignore-errors",
            "--playlist-end",
            "12",
            "--dump-json",
            "--",
            search_url,
        ]
    )
    album_key = lookup_key(album)
    artist_key = lookup_key(artist)
    candidates: list[dict[str, object]] = []
    for line in search.stdout.splitlines():
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict) and candidate.get("url") and album_key in lookup_key(
            str(candidate.get("title", ""))
        ):
            candidates.append(candidate)
        if len(candidates) == 6:
            break

    best: tuple[str, str, str, int] | None = None
    best_score = -1
    for candidate in candidates:
        candidate_url = str(candidate["url"])
        probe = run_quietly(
            [
                yt_dlp,
                "--flat-playlist",
                "--no-warnings",
                "--ignore-errors",
                "--playlist-items",
                "1",
                "--print",
                "%(playlist_title)s|%(playlist_count)s|%(channel)s",
                "--",
                candidate_url,
            ]
        )
        line = first_output_line(probe)
        if probe.returncode != 0 or line is None:
            continue
        parts = line.split("|", 2)
        if len(parts) != 3:
            continue
        title, count_text, channel = parts
        title_key = lookup_key(title)
        channel_key = lookup_key(channel)
        score = 80 if title_key == album_key else 40 if album_key in title_key else 0
        if channel_key == artist_key:
            score += 120
        elif channel_key in artist_key or artist_key in channel_key:
            score += 90
        try:
            track_count = int(count_text)
        except ValueError:
            track_count = 0
        if track_count > 1:
            score += min(track_count, 30)
        if score > best_score:
            best_score = score
            best = (candidate_url, title, channel, track_count)

    if best is None or best_score < 80:
        return None
    return best


def playlist_details(yt_dlp: str, url: str) -> tuple[str, str | None, bool] | None:
    probe = run_quietly(
        [
            yt_dlp,
            "--flat-playlist",
            "--no-warnings",
            "--ignore-errors",
            "--playlist-items",
            "1",
            "--print",
            "%(playlist_title)s|%(playlist_count)s",
            "--",
            url,
        ]
    )
    line = first_output_line(probe)
    if probe.returncode != 0 or line is None:
        return None
    title, separator, count = line.partition("|")
    if title and title != "NA":
        return title, count if separator else None, True

    title_probe = run_quietly(
        [yt_dlp, "--no-warnings", "--print", "%(title)s", "--playlist-items", "1", "--", url]
    )
    title = first_output_line(title_probe)
    if title_probe.returncode != 0 or title is None:
        return None
    return title, None, False


def download_cover(yt_dlp: str, ffmpeg: str | None, destination: Path, url: str) -> None:
    write_step("Downloading playlist cover")
    subprocess.run(
        [
            yt_dlp,
            "--playlist-items",
            "1",
            "--skip-download",
            "--write-thumbnail",
            "--force-overwrites",
            "--no-warnings",
            "--paths",
            f"home:{destination}",
            "-o",
            "cover.%(ext)s",
            "--",
            url,
        ],
        stdout=subprocess.DEVNULL,
    )
    covers = sorted(
        (
            path
            for path in destination.glob("cover.*")
            if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
        ),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    cover = covers[0] if covers else None
    if cover and ffmpeg:
        square = destination / "cover-square.jpg"
        conversion = subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(cover),
                "-vf",
                "crop='min(iw,ih)':'min(iw,ih)'",
                "-q:v",
                "2",
                str(square),
            ]
        )
        if conversion.returncode == 0 and square.is_file():
            square.replace(destination / "cover.jpg")
            cover = destination / "cover.jpg"
    if cover:
        print(f"    Cover    : {cover}")
    else:
        write_warn("No playlist artwork was available; audio download will continue.")
    print()


def download_audio(
    yt_dlp: str,
    ffmpeg: str | None,
    destination: Path,
    url: str,
    output_format: str,
    quality: str,
    playlist_items: str | None,
    is_playlist: bool,
) -> int:
    template = "%(playlist_index)03d - %(title)s.%(ext)s" if is_playlist else "%(title)s.%(ext)s"
    arguments = ["--extract-audio", "--audio-format", output_format]
    if output_format == "best":
        arguments.extend(["-f", "bestaudio/best"])
    elif output_format == "m4a":
        arguments.extend(["-f", "bestaudio[ext=m4a]/bestaudio/best"])
    elif output_format == "opus":
        arguments.extend(["-f", "bestaudio[acodec=opus]/bestaudio/best"])
    elif output_format == "mp3":
        arguments.extend(["--audio-quality", quality])
    if output_format in {"flac", "wav"}:
        write_warn(f"{output_format} wraps a lossy YouTube stream in a lossless container.")
        write_warn("Files get much bigger. The audio does not get better. 'best' is the real answer.")

    arguments.extend(
        [
            "--yes-playlist",
            "--ignore-errors",
            "--no-abort-on-error",
            "--retries",
            "10",
            "--fragment-retries",
            "10",
            "--concurrent-fragments",
            "4",
            "--windows-filenames",
            "--trim-filenames",
            "180",
            "--download-archive",
            str(destination / f".downloaded-{output_format}.txt"),
            "--paths",
            f"home:{destination}",
            "-o",
            template,
            "--progress",
            "--newline",
        ]
    )
    # Keep audio post-processing dependency-free. yt-dlp's metadata and artwork
    # embedding requires the optional Python ``mutagen`` package, which is not
    # part of the native Linux runtime. MXTP MKR already owns this information:
    # it stores project metadata itself and downloads cover.jpg separately.
    # Avoiding those embedding flags also lets a retry accept audio that was
    # downloaded before a previous optional postprocessor failed.
    if is_playlist:
        arguments.extend(["--parse-metadata", "%(playlist_title)s:%(meta_album)s"])
        arguments.extend(["--parse-metadata", "%(playlist_index)s:%(meta_track)s"])
        if playlist_items and playlist_items.strip():
            arguments.extend(["--playlist-items", playlist_items.strip()])
    if ffmpeg:
        arguments.extend(["--ffmpeg-location", ffmpeg])
    arguments.extend(["--", url])

    write_step("Downloading")
    result = subprocess.run([yt_dlp, *arguments])
    audio = [path for path in destination.iterdir() if path.is_file() and path.suffix.lower() in AUDIO_EXTENSIONS]
    wanted = requested_items(playlist_items) if is_playlist else None
    present = {index for index in (playlist_index(path) for path in audio) if index is not None}
    usable = [path for path in audio if wanted is None or playlist_index(path) in wanted]
    print()
    if not usable:
        write_bad(f"Nothing downloaded (yt-dlp exit {result.returncode}).")
        return result.returncode or 1
    kinds = ", ".join(f"{count} x {suffix}" for suffix, count in sorted(Counter(path.suffix for path in usable).items()))
    print(f"  Done. {kinds} in:")
    print(f"  {destination}")
    # yt-dlp exits 1 when any entry failed (region-blocked, removed, age-gated)
    # even with --ignore-errors. What did download is still good: report the
    # gap and succeed so the app imports it.
    skipped = len(wanted - present) if wanted is not None else 0
    if result.returncode != 0 and skipped == 0:
        skipped = 1
    if skipped:
        print(f"Skipped: {skipped} entries")
    return 0


def playlist_index(path: Path) -> int | None:
    prefix, separator, _ = path.stem.partition(" - ")
    if separator and len(prefix) == 3 and prefix.isdigit():
        return int(prefix)
    return None


def requested_items(spec: str | None) -> set[int] | None:
    if not spec or not spec.strip():
        return None
    wanted: set[int] = set()
    for part in spec.strip().split(","):
        start, _, end = part.partition("-")
        wanted.update(range(int(start), int(end or start) + 1))
    return wanted


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download a YouTube playlist with yt-dlp.")
    parser.add_argument("url_position", nargs="?")
    parser.add_argument("-Url", dest="url")
    parser.add_argument("-Artist", default="")
    parser.add_argument("-Album", default="")
    parser.add_argument("-ResolveOnly", action="store_true")
    parser.add_argument("-OutRoot", default=str(Path.home() / "Music" / "YouTube"))
    parser.add_argument("-Format", choices=["best", "m4a", "mp3", "flac", "wav", "opus"], default="best")
    parser.add_argument("-Quality", choices=["0", "128", "192", "256", "320"], default="0")
    parser.add_argument("-PlaylistItems")
    parser.add_argument("-Update", action="store_true")
    parser.add_argument("-NoPause", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    yt_dlp = resolve_tool("MXTP_YTDLP_PATH", "yt-dlp")
    if not yt_dlp:
        write_bad("yt-dlp not found on PATH. Install it with your system package manager.")
        return 1
    ffmpeg = resolve_tool("MXTP_FFMPEG_PATH", "ffmpeg")

    if args.Update:
        write_step("Updating yt-dlp")
        subprocess.run([sys.executable, "-m", "pip", "install", "-U", "yt-dlp"])

    url = (args.url or args.url_position or "").strip().strip('"')
    if not url and args.Artist.strip() and args.Album.strip():
        album_match = resolve_album(yt_dlp, args.Artist.strip(), args.Album.strip())
        if album_match is None:
            write_bad(
                f"Could not find a trustworthy YouTube album playlist for {args.Artist} - {args.Album}."
            )
            return 2
        url, title, artist, track_count = album_match
        print(f"    Resolved : {url}")
        print(f"    Album    : {title}")
        print(f"    Artist   : {artist}")
        print(f"    Tracks   : {track_count}")
        if args.ResolveOnly:
            return 0

    if not url:
        write_bad("No URL given.")
        return 1

    print()
    print("  YouTube Playlist -> MP3")
    version = run_quietly([yt_dlp, "--version"])
    print(
        f"  yt-dlp {(first_output_line(version) or 'unknown')}  |  "
        f"ffmpeg {'ok' if ffmpeg else 'MISSING'}  |  format: {args.Format}"
    )
    print()

    write_step("Reading playlist")
    details = playlist_details(yt_dlp, url)
    if details is None:
        write_bad("Could not read that URL. Check the link.")
        return 1
    title, count, is_playlist = details
    try:
        destination = playlist_destination(Path(args.OutRoot).expanduser(), title, url)
    except (OSError, RuntimeError) as error:
        write_bad(f"Could not create an isolated playlist cache: {error}")
        return 1
    if is_playlist:
        print(f"    Playlist : {title} ({count or '?'} items)")
    else:
        print(f"    Video    : {title}")
    print(f"    Folder   : {destination}")
    print()

    download_cover(yt_dlp, ffmpeg, destination, url)
    return download_audio(
        yt_dlp,
        ffmpeg,
        destination,
        url,
        args.Format,
        args.Quality,
        args.PlaylistItems,
        is_playlist,
    )


if __name__ == "__main__":
    raise SystemExit(main())
