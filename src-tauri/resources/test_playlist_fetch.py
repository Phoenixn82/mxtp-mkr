from __future__ import annotations

import importlib.util
import io
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("playlist_fetch.py")
SPEC = importlib.util.spec_from_file_location("playlist_fetch", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
playlist_fetch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(playlist_fetch)


class DownloadAudioTests(unittest.TestCase):
    def test_download_does_not_require_optional_mutagen_postprocessors(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            (destination / "001 - Existing track.opus").touch()

            completed = subprocess.CompletedProcess(["yt-dlp"], 0)
            with patch.object(playlist_fetch.subprocess, "run", return_value=completed) as run:
                result = playlist_fetch.download_audio(
                    "yt-dlp",
                    "ffmpeg",
                    destination,
                    "https://www.youtube.com/playlist?list=test",
                    "best",
                    "0",
                    None,
                    True,
                )

            command = run.call_args.args[0]
            self.assertEqual(result, 0)
            self.assertNotIn("--embed-metadata", command)
            self.assertNotIn("--embed-thumbnail", command)
            self.assertNotIn("--convert-thumbnails", command)
            self.assertIn("--download-archive", command)


    def test_partial_download_succeeds_and_reports_the_skipped_entry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)

            def fake_yt_dlp(*_args, **_kwargs):
                (destination / "001 - First.opus").touch()
                return subprocess.CompletedProcess(["yt-dlp"], 1)

            output = io.StringIO()
            with patch.object(playlist_fetch.subprocess, "run", side_effect=fake_yt_dlp), redirect_stdout(output):
                result = playlist_fetch.download_audio(
                    "yt-dlp", "ffmpeg", destination, "https://www.youtube.com/playlist?list=test",
                    "best", "0", "1,2", True,
                )

            self.assertEqual(result, 0)
            self.assertIn("Skipped: 1 entries", output.getvalue())

    def test_download_with_no_requested_audio_still_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            (destination / "005 - Stale.opus").touch()
            completed = subprocess.CompletedProcess(["yt-dlp"], 1)
            with patch.object(playlist_fetch.subprocess, "run", return_value=completed), redirect_stdout(io.StringIO()) as output:
                result = playlist_fetch.download_audio(
                    "yt-dlp", "ffmpeg", destination, "https://www.youtube.com/playlist?list=test",
                    "best", "0", "1,2", True,
                )
            self.assertEqual(result, 1)
            self.assertNotIn("-Update", output.getvalue())


class PlaylistDestinationTests(unittest.TestCase):
    def test_same_title_different_sources_never_share_download_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = playlist_fetch.playlist_destination(
                root, "Greatest Hits", "https://youtube.com/playlist?list=FIRST"
            )
            (first / ".downloaded-best.txt").write_text("first-track\n", encoding="utf-8")
            second = playlist_fetch.playlist_destination(
                root, "Greatest Hits", "https://youtube.com/playlist?list=SECOND"
            )

            self.assertNotEqual(first, second)
            self.assertFalse((second / ".downloaded-best.txt").exists())
            self.assertEqual(
                playlist_fetch.source_metadata(first)["source"], "youtube-playlist:FIRST"
            )
            self.assertEqual(
                playlist_fetch.source_metadata(second)["source"], "youtube-playlist:SECOND"
            )

    def test_same_source_reuses_cache_despite_tracking_query_changes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = playlist_fetch.playlist_destination(
                root, "Album", "https://www.youtube.com/playlist?list=SAME&si=one"
            )
            second = playlist_fetch.playlist_destination(
                root, "Album", "https://music.youtube.com/playlist?si=two&list=SAME"
            )
            self.assertEqual(first, second)

    def test_unidentified_legacy_cache_is_never_claimed_by_an_unknown_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legacy = root / "Album"
            legacy.mkdir()
            (legacy / ".downloaded-best.txt").write_text("unknown-track\n", encoding="utf-8")

            destination = playlist_fetch.playlist_destination(
                root, "Album", "https://youtube.com/playlist?list=KNOWN"
            )

            self.assertNotEqual(destination, legacy)
            self.assertEqual(
                (legacy / ".downloaded-best.txt").read_text(encoding="utf-8"), "unknown-track\n"
            )

    def test_explicit_tool_path_is_used_even_with_a_nonstandard_filename(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tool = Path(directory) / "bundled-downloader"
            tool.touch()
            tool.chmod(0o755)
            with patch.dict(playlist_fetch.os.environ, {"MXTP_YTDLP_PATH": str(tool)}):
                self.assertEqual(
                    playlist_fetch.resolve_tool("MXTP_YTDLP_PATH", "yt-dlp"), str(tool)
                )


if __name__ == "__main__":
    unittest.main()
