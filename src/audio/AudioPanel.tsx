import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { capacityCheck, formatDuration, moveTrack, type Track } from "./audio";
import { usePlaybackSource } from "./playbackSource";
import { invokeCommand } from "../tauriClient";

interface AudioPanelProps {
  projectId: string;
  tracks: Track[];
  onTracksChange: (tracks: Track[]) => void;
}

/** probe_audio's answer (src-tauri/src/audio_prep.rs AudioMeta, camelCase). */
interface AudioMeta {
  durationSec: number;
  sampleRate: number;
  channels: number;
}

export function AudioPanel({ projectId, tracks, onTracksChange }: AudioPanelProps) {
  const [listening, setListening] = useState<Track | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playbackError, setPlaybackError] = useState("");
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [draggedId, setDraggedId] = useState<string>();
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const audioRef = useRef<HTMLAudioElement>(null);
  const handleRefs = useRef(new Map<string, HTMLButtonElement>());
  const refocusId = useRef<string>();
  const playback = usePlaybackSource(listening ?? undefined);
  const capacity = useMemo(() => capacityCheck(tracks), [tracks]);
  const capacityPct = Math.min(100, (capacity.totalSec / capacity.limitSec) * 100);

  useEffect(() => {
    if (!listening || !playback.src) return;
    startPlayback(listening);
  }, [listening, playback.src]);

  /** "Now playing" turns on from the element's playing event, never optimistically. */
  function startPlayback(track: Track) {
    const result = audioRef.current?.play();
    if (result && "catch" in result) {
      void result.catch(() => {
        setPlaying(false);
        setPlaybackError(`Could not play ${track.title}.`);
      });
    }
  }

  useEffect(() => {
    if (listening && playback.error) {
      setPlaying(false);
      setPlaybackError(`Could not load ${listening.title}: ${playback.error}`);
    }
  }, [listening, playback.error]);

  // A keyboard reorder can move the focused row's DOM node; put focus back on its handle.
  useEffect(() => {
    const id = refocusId.current;
    if (!id) return;
    refocusId.current = undefined;
    handleRefs.current.get(id)?.focus();
  }, [tracks]);

  function setAndPublish(next: Track[]) {
    tracksRef.current = next;
    onTracksChange(next);
  }

  /** Append imports after the current tracks, skipping any already in the list (by id or path). */
  function addTracks(imported: Track[]) {
    const current = tracksRef.current;
    const seen = new Set(current.flatMap((track) => (track.path ? [track.id, track.path] : [track.id])));
    const fresh = imported.filter((track) => {
      if (seen.has(track.id) || (track.path && seen.has(track.path))) return false;
      seen.add(track.id);
      if (track.path) seen.add(track.path);
      return true;
    });
    if (fresh.length > 0) setAndPublish([...current, ...fresh]);
  }

  async function importNativeFiles() {
    setImportErrors([]);
    let selected: string | string[] | null;
    try {
      selected = await open({
        multiple: true,
        filters: [{ name: "Audio", extensions: ["wav", "flac", "mp3"] }]
      });
    } catch (error) {
      setImportErrors([`Couldn't open the file chooser: ${errorText(error)}`]);
      return;
    }
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    await importNativePaths(paths);
  }

  async function importNativePaths(paths: string[]) {
    if (paths.length === 0) {
      return;
    }
    setImportErrors([]);
    const results = await Promise.allSettled(paths.map((sourcePath) => importNativeFile(sourcePath)));
    addTracks(results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])));
    setImportErrors(results.flatMap((result) => (result.status === "rejected" ? [errorText(result.reason)] : [])));
  }

  // Probe before copying, so an unsupported file never lands in the project's audio folder.
  async function importNativeFile(sourcePath: string): Promise<Track> {
    const name = fileName(sourcePath);
    let meta: AudioMeta;
    try {
      meta = await invokeCommand<AudioMeta>("probe_audio", { path: sourcePath });
    } catch {
      throw new Error(`${name} is not a supported audio file`);
    }
    let destPath: string;
    try {
      destPath = await invokeCommand<string>("copy_audio_file", { sourcePath, projectId });
    } catch (error) {
      throw new Error(`Couldn't add ${name}: ${errorText(error)}`);
    }
    return {
      id: destPath,
      title: stripExtension(name),
      durationSec: meta.durationSec,
      sampleRate: meta.sampleRate,
      channels: meta.channels,
      path: destPath
    };
  }

  async function importFiles(files: FileList | null) {
    if (!files) {
      return;
    }
    const fileList = Array.from(files);
    const nativePaths = fileList
      .map((file) => (file as File & { path?: string }).path)
      .filter((path): path is string => Boolean(path));
    if (nativePaths.length === fileList.length) {
      await importNativePaths(nativePaths);
      return;
    }
    setImportErrors([]);
    // No native path: the track plays from its blob URL but has no path, so burn and GO
    // refuse it with a clear message instead of guessing a same-named file elsewhere.
    const imported: Track[] = fileList.map((file) => ({
      id: `${file.name}-${file.size}`,
      title: stripExtension(file.name),
      durationSec: 0,
      url: typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : ""
    }));
    addTracks(imported);
    imported.forEach((track) => {
      const audio = document.createElement("audio");
      audio.preload = "metadata";
      audio.onloadedmetadata = () => {
        if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
          return;
        }
        setAndPublish(tracksRef.current.map((item) => (item.id === track.id ? { ...item, durationSec: audio.duration } : item)));
      };
      audio.src = track.url ?? "";
    });
  }

  function play(track: Track) {
    setPlaybackError("");
    // Same track again (after pause or end): the source effect will not re-run, so restart it here.
    if (listening?.id === track.id && audioRef.current && playback.src) {
      startPlayback(listening);
      return;
    }
    setPlaying(false);
    setListening(track);
  }

  function renameTrack(track: Track, title: string) {
    setAndPublish(tracksRef.current.map((item) => (item.id === track.id ? { ...item, title } : item)));
    setListening((current) => (current?.id === track.id ? { ...current, title } : current));
  }

  function moveById(id: string, to: number) {
    const current = tracksRef.current;
    const next = moveTrack(current, current.findIndex((track) => track.id === id), to);
    if (next !== current) setAndPublish(next);
  }

  function nudge(id: string, offset: -1 | 1) {
    const current = tracksRef.current;
    const from = current.findIndex((track) => track.id === id);
    const next = moveTrack(current, from, from + offset);
    // At a boundary nothing moves; a stale refocus would steal focus on the next unrelated change.
    if (next === current) return;
    refocusId.current = id;
    setAndPublish(next);
  }

  return (
    <section className="panel" aria-labelledby="audio-heading">
      <div className="panel-head">
        <h2 id="audio-heading">Audio</h2>
        <button type="button" onClick={() => void importNativeFiles()}>
          Add audio files…
        </button>
        <label>
          <span style={{ display: "none" }}>Import audio files</span>
          <input
            type="file"
            accept="audio/*,.wav,.flac,.mp3"
            multiple
            onChange={(event) => void importFiles(event.target.files)}
            data-testid="audio-input"
            style={{ display: "none" }}
          />
        </label>
      </div>
      <div className={capacity.ok ? "meter ok" : "meter bad"} data-testid="capacity-meter">
        {capacity.label}
        <div className="capacity-track">
          <div
            className={capacity.ok ? "capacity-fill" : "capacity-fill bad"}
            style={{ width: `${capacityPct}%` }}
          />
        </div>
      </div>
      {importErrors.length > 0 ? (
        <p className="error" role="alert" data-testid="audio-import-error">
          {importErrors.map((line, index) => (
            <span key={index} style={{ display: "block" }}>
              {line}
            </span>
          ))}
        </p>
      ) : null}
      {tracks.length === 0 ? (
        <p className="audio-empty">No audio yet. Add WAV, FLAC or MP3 files, or use Find album audio below.</p>
      ) : null}
      <ol className="track-list" data-testid="track-list">
        {tracks.map((track, index) => {
          const name = track.title || `track ${index + 1}`;
          return (
            <li
              key={track.id}
              data-dragging={draggedId === track.id ? "true" : "false"}
              onDragOver={(event) => {
                if (!draggedId) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                event.preventDefault();
                const sourceId = draggedId ?? event.dataTransfer.getData("text/plain");
                setDraggedId(undefined);
                if (sourceId) moveById(sourceId, tracksRef.current.findIndex((item) => item.id === track.id));
              }}
            >
              <input
                className="track-title-input"
                value={track.title}
                onChange={(event) => renameTrack(track, event.target.value)}
                aria-label={`Edit title for track ${index + 1}`}
              />
              <span>{formatDuration(track.durationSec)}</span>
              <button
                type="button"
                className="audio-reorder-handle"
                draggable
                ref={(node) => {
                  if (node) handleRefs.current.set(track.id, node);
                  else handleRefs.current.delete(track.id);
                }}
                aria-label={`Reorder ${name}`}
                title="Drag to reorder. Or focus here and use the up/down arrow keys."
                onDragStart={(event) => {
                  setDraggedId(track.id);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", track.id);
                }}
                onDragEnd={() => setDraggedId(undefined)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                  event.preventDefault();
                  nudge(track.id, event.key === "ArrowUp" ? -1 : 1);
                }}
              >
                ⋮⋮
              </button>
              <button type="button" onClick={() => play(track)} aria-label={`Play ${name}`}>
                Play
              </button>
            </li>
          );
        })}
      </ol>
      {listening && playing ? (
        <div className="listening" data-testid="prelisten">
          Now playing: {listening.title}
        </div>
      ) : null}
      {listening ? (
        <audio
          ref={audioRef}
          src={playback.src || undefined}
          controls
          data-testid="audio-player"
          onPlaying={() => {
            setPlaying(true);
            setPlaybackError("");
          }}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onError={() => {
            setPlaying(false);
            setPlaybackError(`Could not play ${listening.title}.`);
          }}
        />
      ) : null}
      {playbackError ? <p className="error" role="alert">{playbackError}</p> : null}
    </section>
  );
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function stripExtension(name: string): string {
  const stripped = name.replace(/\.[^.]+$/, "");
  return stripped || name;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
