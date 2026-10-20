import { readFile } from "@tauri-apps/plugin-fs";
import { useEffect, useState } from "react";
import type { Track } from "./audio";

interface LoadedPlaybackSource {
  src: string;
  release: () => void;
}

interface PlaybackSourceState {
  src: string;
  error: string;
  loading: boolean;
}

const EMPTY_SOURCE: PlaybackSourceState = { src: "", error: "", loading: false };

export async function loadPlaybackSource(track: Track): Promise<LoadedPlaybackSource> {
  if (track.url && /^(?:blob:|data:|https?:)/i.test(track.url)) {
    return { src: track.url, release: () => undefined };
  }

  const path = track.path ?? track.id;
  if (!path) throw new Error("This track has no local audio path.");
  if (typeof URL.createObjectURL !== "function") {
    throw new Error("This runtime cannot create a local audio URL.");
  }

  const bytes = await readFile(path);
  const blob = new Blob([new Uint8Array(bytes)], { type: audioMimeType(path) });
  const src = URL.createObjectURL(blob);
  let released = false;
  return {
    src,
    release: () => {
      if (released) return;
      released = true;
      URL.revokeObjectURL(src);
    }
  };
}

export function usePlaybackSource(track?: Track): PlaybackSourceState {
  const key = track ? `${track.id}\0${track.path ?? ""}\0${track.url ?? ""}` : "";
  const [loaded, setLoaded] = useState<PlaybackSourceState & { key: string }>({ ...EMPTY_SOURCE, key: "" });

  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | undefined;
    if (!track) {
      setLoaded({ ...EMPTY_SOURCE, key: "" });
      return;
    }

    setLoaded({ src: "", error: "", loading: true, key });
    void loadPlaybackSource(track).then((source) => {
      release = source.release;
      if (cancelled) {
        source.release();
        return;
      }
      setLoaded({ src: source.src, error: "", loading: false, key });
    }).catch((error) => {
      if (cancelled) return;
      setLoaded({
        src: "",
        error: error instanceof Error ? error.message : String(error),
        loading: false,
        key
      });
    });

    return () => {
      cancelled = true;
      release?.();
    };
  }, [key]);

  return loaded.key === key ? loaded : { ...EMPTY_SOURCE, loading: Boolean(track) };
}

function audioMimeType(path: string): string {
  const extension = path.toLocaleLowerCase().match(/\.([a-z0-9]+)(?:[?#].*)?$/)?.[1];
  return {
    aac: "audio/aac",
    flac: "audio/flac",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    opus: "audio/ogg; codecs=opus",
    wav: "audio/wav",
    webm: "audio/webm"
  }[extension ?? ""] ?? "application/octet-stream";
}
