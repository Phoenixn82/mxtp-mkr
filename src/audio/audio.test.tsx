import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { AudioPanel } from "./AudioPanel";
import { CDDA_LIMIT_SEC, capacityCheck, fixtureTracks, formatDuration, moveTrack, type Track } from "./audio";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));

describe("audio", () => {
  afterEach(() => {
    window.__MXTP_INVOKE__ = undefined;
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it("checks CD-DA capacity", () => {
    expect(capacityCheck(fixtureTracks).ok).toBe(true);
    expect(capacityCheck([{ id: "long", title: "Long", durationSec: 5000 }]).ok).toBe(false);
  });

  it("reports empty and exact CD-DA capacity boundaries", () => {
    expect(capacityCheck([])).toMatchObject({ totalSec: 0, limitSec: CDDA_LIMIT_SEC, ok: true });
    expect(capacityCheck([{ id: "exact", title: "Exact", durationSec: CDDA_LIMIT_SEC }]).ok).toBe(true);
    expect(capacityCheck([{ id: "over", title: "Over", durationSec: CDDA_LIMIT_SEC + 0.01 }]).ok).toBe(false);
  });

  it.each([
    [0, "0:00"],
    [5.4, "0:05"],
    [59.6, "1:00"],
    [60, "1:00"],
    [65.6, "1:06"],
    [-2, "0:00"],
    [Number.NaN, "0:00"]
  ])("formats %s seconds without invalid second fields", (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });

  it("reorders tracks", () => {
    const reordered = moveTrack(fixtureTracks, 2, 0);
    expect(reordered.map((track) => track.id)).toEqual([
      "digital-love",
      "one-more-time",
      "aerodynamic"
    ]);
    expect(fixtureTracks.map((track) => track.id)).toEqual(["one-more-time", "aerodynamic", "digital-love"]);
  });

  it.each([
    [-1, 0],
    [0, -1],
    [fixtureTracks.length, 0],
    [0, fixtureTracks.length],
    [0.5, 1]
  ])("leaves tracks intact for invalid move %s -> %s", (from, to) => {
    expect(moveTrack(fixtureTracks, from, to)).toBe(fixtureTracks);
  });

  it("does not copy the array for a no-op reorder", () => {
    expect(moveTrack(fixtureTracks, 1, 1)).toBe(fixtureTracks);
  });

  it("counts a track with no recorded duration as 0", () => {
    const tracks = [fixtureTracks[0], { id: "x", title: "X" } as unknown as Track];
    expect(capacityCheck(tracks)).toMatchObject({ totalSec: 320, ok: true, label: "5:20 / 79:57" });
  });

  it("labels capacity against the real 79:57 limit", () => {
    expect(capacityCheck(fixtureTracks).label).toBe("13:53 / 79:57");
  });

  it("imports, reorders by keyboard, and pre-listens in the UI", async () => {
    stubObjectUrls();
    const user = userEvent.setup();
    const published: Track[][] = [];
    function Harness() {
      const [tracks, setTracks] = useState<Track[]>([]);
      return (
        <AudioPanel
          projectId="component-test"
          tracks={tracks}
          onTracksChange={(next) => {
            published.push(next);
            setTracks(next);
          }}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByText("No audio yet. Add WAV, FLAC or MP3 files, or use Find album audio below.")).toHaveClass("audio-empty");
    const files = [
      new File(["a"], "one-more-time.wav", { type: "audio/wav" }),
      new File(["b"], "aerodynamic.wav", { type: "audio/wav" })
    ];
    await user.upload(screen.getByTestId("audio-input"), files);
    expect(screen.queryByText(/No audio yet/)).not.toBeInTheDocument();
    // A browser File has no native path: the track must not pretend to have one.
    expect(published[0].map((track) => track.path)).toEqual([undefined, undefined]);
    expect(screen.queryByRole("button", { name: /up$/ })).not.toBeInTheDocument();
    const handle = screen.getByRole("button", { name: "Reorder aerodynamic" });
    expect(handle).toHaveClass("audio-reorder-handle");
    handle.focus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByLabelText("Edit title for track 1")).toHaveValue("aerodynamic");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reorder aerodynamic" }));
    await user.keyboard("{ArrowDown}");
    expect(screen.getByLabelText("Edit title for track 2")).toHaveValue("aerodynamic");
    await user.keyboard("{ArrowUp}");
    expect(screen.queryByTestId("prelisten")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Play aerodynamic" }));
    expect(screen.getByTestId("capacity-meter")).toHaveTextContent("/ 79:57");
    const player = screen.getByTestId("audio-player");
    expect(player).toHaveAttribute("controls");
    // Only the element's playing event turns the line on.
    expect(screen.queryByTestId("prelisten")).not.toBeInTheDocument();
    fireEvent.playing(player);
    expect(screen.getByTestId("prelisten")).toHaveTextContent("Now playing: aerodynamic");
    fireEvent.pause(player);
    expect(screen.queryByTestId("prelisten")).not.toBeInTheDocument();
  });

  it("never renders the pre-listen player with an empty src", async () => {
    stubObjectUrls();
    vi.mocked(readFile).mockReturnValue(new Promise(() => undefined));
    const user = userEvent.setup();
    render(<AudioPanel projectId="p" tracks={[{ id: "/a/one.wav", title: "One", durationSec: 5, path: "/a/one.wav" }]} onTracksChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Play One" }));
    expect(screen.getByTestId("audio-player")).not.toHaveAttribute("src");
  });

  it("Play after pause on the same track restarts it", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const user = userEvent.setup();
    const track: Track = { id: "a", title: "A", durationSec: 5, url: "blob:a" };
    render(<AudioPanel projectId="p" tracks={[track]} onTracksChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Play A" }));
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    const player = screen.getByTestId("audio-player");
    fireEvent.playing(player);
    expect(screen.getByTestId("prelisten")).toHaveTextContent("Now playing: A");
    fireEvent.pause(player);
    expect(screen.queryByTestId("prelisten")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Play A" }));
    expect(play).toHaveBeenCalledTimes(2);
    // Still paused until the element really plays.
    expect(screen.queryByTestId("prelisten")).not.toBeInTheDocument();
    fireEvent.playing(player);
    expect(screen.getByTestId("prelisten")).toHaveTextContent("Now playing: A");
  });

  it("ArrowUp on the first handle does not steal focus from a title input later", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [tracks, setTracks] = useState<Track[]>(fixtureTracks);
      return <AudioPanel projectId="p" tracks={tracks} onTracksChange={setTracks} />;
    }
    render(<Harness />);
    screen.getByRole("button", { name: "Reorder One More Time" }).focus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByLabelText("Edit title for track 1")).toHaveValue("One More Time");
    const title = screen.getByLabelText("Edit title for track 2");
    await user.click(title);
    await user.keyboard("XY");
    expect(screen.getByLabelText("Edit title for track 2")).toHaveValue("AerodynamicXY");
    expect(document.activeElement).toBe(screen.getByLabelText("Edit title for track 2"));
  });

  it("reorders by dragging a handle onto another row", () => {
    const onTracksChange = vi.fn();
    render(<AudioPanel projectId="p" tracks={fixtureTracks} onTracksChange={onTracksChange} />);
    const handle = screen.getByRole("button", { name: "Reorder Digital Love" });
    const target = screen.getByLabelText("Edit title for track 1").closest("li")!;
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => "digital-love"), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(handle, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    expect(onTracksChange).toHaveBeenLastCalledWith([fixtureTracks[2], fixtureTracks[0], fixtureTracks[1]]);
  });

  it("shows durations as m:ss", () => {
    render(<AudioPanel projectId="p" tracks={fixtureTracks} onTracksChange={vi.fn()} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("span")?.textContent)).toEqual(["5:20", "3:32", "5:01"]);
  });

  it("copies native imports into the active project's isolated audio folder with probed durations", async () => {
    vi.mocked(open).mockResolvedValue(["/music/first.wav"]);
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    window.__MXTP_INVOKE__ = async (command, args) => {
      calls.push({ command, args });
      if (command === "probe_audio") return { durationSec: 187.4, sampleRate: 48000, channels: 2, codec: "pcm_s16le" } as never;
      if (command === "copy_audio_file") return "/cache/project-42/first.wav" as never;
      throw new Error(`unexpected command ${command}`);
    };
    const onTracksChange = vi.fn();
    const user = userEvent.setup();
    render(<AudioPanel projectId="project-42" tracks={[]} onTracksChange={onTracksChange} />);

    await user.click(screen.getByRole("button", { name: "Add audio files…" }));

    await waitFor(() => expect(onTracksChange).toHaveBeenCalled());
    expect(calls).toContainEqual({
      command: "copy_audio_file",
      args: { sourcePath: "/music/first.wav", projectId: "project-42" }
    });
    expect(calls).toContainEqual({ command: "probe_audio", args: { path: "/music/first.wav" } });
    expect(onTracksChange).toHaveBeenCalledWith([
      {
        id: "/cache/project-42/first.wav",
        title: "first",
        durationSec: 187.4,
        sampleRate: 48000,
        channels: 2,
        path: "/cache/project-42/first.wav"
      }
    ]);
  });

  it("adds imports after the existing tracks and skips files already in the list", async () => {
    vi.mocked(open).mockResolvedValue(["/music/beta.wav", "/music/again.wav"]);
    window.__MXTP_INVOKE__ = async (command, args) => {
      if (command === "probe_audio") return { durationSec: 61, sampleRate: 44100, channels: 2, codec: "pcm_s16le" } as never;
      if (command === "copy_audio_file") {
        return (String(args?.sourcePath).endsWith("again.wav") ? "aerodynamic" : "/cache/p/beta.wav") as never;
      }
      throw new Error(`unexpected command ${command}`);
    };
    const onTracksChange = vi.fn();
    const user = userEvent.setup();
    render(<AudioPanel projectId="p" tracks={fixtureTracks} onTracksChange={onTracksChange} />);

    await user.click(screen.getByRole("button", { name: "Add audio files…" }));

    await waitFor(() => expect(onTracksChange).toHaveBeenCalledTimes(1));
    const next = onTracksChange.mock.calls[0][0] as Track[];
    expect(next).toHaveLength(4);
    expect(next.map((track) => track.id)).toEqual(["one-more-time", "aerodynamic", "digital-love", "/cache/p/beta.wav"]);
    expect(next[3]).toMatchObject({ title: "beta", durationSec: 61 });
  });

  it("adds the files that copied and names the ones that failed", async () => {
    vi.mocked(open).mockResolvedValue(["/music/good.wav", "/music/locked.wav"]);
    window.__MXTP_INVOKE__ = async (command, args) => {
      if (command === "probe_audio") return { durationSec: 30, sampleRate: 44100, channels: 2, codec: "pcm_s16le" } as never;
      if (command === "copy_audio_file") {
        if (String(args?.sourcePath).endsWith("locked.wav")) throw "permission denied";
        return "/cache/p/good.wav" as never;
      }
      throw new Error(`unexpected command ${command}`);
    };
    const onTracksChange = vi.fn();
    const user = userEvent.setup();
    render(<AudioPanel projectId="p" tracks={[]} onTracksChange={onTracksChange} />);

    await user.click(screen.getByRole("button", { name: "Add audio files…" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't add locked.wav: permission denied");
    expect(onTracksChange).toHaveBeenCalledTimes(1);
    expect(onTracksChange.mock.calls[0][0]).toEqual([expect.objectContaining({ id: "/cache/p/good.wav", title: "good" })]);
  });

  it("drops a file that is not readable audio before copying it", async () => {
    vi.mocked(open).mockResolvedValue(["/music/notes.wav"]);
    const commands: string[] = [];
    window.__MXTP_INVOKE__ = async (command) => {
      commands.push(command);
      if (command === "probe_audio") throw "ffprobe found no audio stream";
      throw new Error(`unexpected command ${command}`);
    };
    const onTracksChange = vi.fn();
    const user = userEvent.setup();
    render(<AudioPanel projectId="p" tracks={[]} onTracksChange={onTracksChange} />);

    await user.click(screen.getByRole("button", { name: "Add audio files…" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("notes.wav is not a supported audio file");
    expect(commands).toEqual(["probe_audio"]);
    expect(onTracksChange).not.toHaveBeenCalled();
  });

  it("reports a file chooser failure instead of failing silently", async () => {
    vi.mocked(open).mockRejectedValue(new Error("portal unavailable"));
    const user = userEvent.setup();
    render(<AudioPanel projectId="p" tracks={[]} onTracksChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Add audio files…" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't open the file chooser: portal unavailable");
  });
});

function stubObjectUrls() {
  let n = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:audio-test-${(n += 1)}`);
}
