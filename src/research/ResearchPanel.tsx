import { useEffect, useRef, useState } from "react";
import {
  COVER_DIRECTIONS,
  DEFAULT_COVER_DIRECTION,
  artDirectFromReferences,
  composeTracklist,
  coverAdapterLabel,
  coverEditAvailable,
  coverDirectionFor,
  coverPromptFromArtDirection,
  coverPromptForAlbum,
  coverStyleReferences,
  editCoverFromOriginal,
  fetchCoverTheme,
  fetchEraCovers,
  fetchLyrics,
  fetchRealCoverFile,
  generateCover,
  lookupAlbum,
  styleDnaFromAlbum,
  visionAlbumLabelForDirection,
  type AlbumInfo,
  type CoverDirectionId,
  type CoverTheme,
  type GeneratedCover,
  type TrackLyrics
} from "./research";

interface ResearchPanelProps {
  onApply: (
    album: AlbumInfo,
    cover: GeneratedCover | undefined,
    lyricsByTrack: TrackLyrics[],
    theme?: CoverTheme
  ) => void;
  onCover?: (cover: GeneratedCover) => void;
  initialArtist?: string;
  initialAlbum?: string;
  autoLookupKey?: string;
}

const EDIT_SUGGESTIONS = [
  { label: "Cartoonish", instruction: "Make it more cartoonish, while keeping the composition and colors." },
  { label: "Hand-drawn", instruction: "Make it more hand-drawn, while preserving the subject and layout." },
  { label: "Print texture", instruction: "Add more tactile print texture without changing the subject." }
];

const NO_REAL_COVER = "No real cover on Cover Art Archive for this release.";
const COVER_EDIT_UNAVAILABLE = "Cover edits need Cloudflare Workers AI credentials.";

type CoverNote = { kind: "none" } | { kind: "failed"; error: string } | null;

export function ResearchPanel({ onApply, onCover, initialArtist = "Daft Punk", initialAlbum = "Discovery", autoLookupKey }: ResearchPanelProps) {
  const [artist, setArtist] = useState(initialArtist);
  const [album, setAlbum] = useState(initialAlbum);
  const [result, setResult] = useState<AlbumInfo | null>(null);
  const [cover, setCover] = useState<GeneratedCover | null>(null);
  const [originalCover, setOriginalCover] = useState<GeneratedCover | null>(null);
  const [theme, setTheme] = useState<CoverTheme | null>(null);
  const [lyricsCoverage, setLyricsCoverage] = useState("");
  const [lyricsNote, setLyricsNote] = useState<{ text: string; details: string } | null>(null);
  const [coverNote, setCoverNote] = useState<CoverNote>(null);
  const [error, setError] = useState("");
  const [errorDetails, setErrorDetails] = useState("");
  const [stage, setStage] = useState("");
  const [conceptOpen, setConceptOpen] = useState(false);
  const [editError, setEditError] = useState("");
  const [editInstruction, setEditInstruction] = useState("");
  const [editHistory, setEditHistory] = useState<string[]>([]);
  // null = unknown (probe failed or still running): never block the editor on a failed probe.
  const [canEditCover, setCanEditCover] = useState<boolean | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [coverBusy, setCoverBusy] = useState<"" | "real" | "grounded" | "edit">("");
  const [coverDirection, setCoverDirection] = useState<CoverDirectionId>(DEFAULT_COVER_DIRECTION);
  const autoLookupStarted = useRef<string | null>(null);
  const lookupVersion = useRef(0);
  const latestCoverRef = useRef<GeneratedCover | undefined>(undefined);

  useEffect(() => {
    let live = true;
    coverEditAvailable()
      .then((available) => {
        if (live) setCanEditCover(Boolean(available));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!autoLookupKey || autoLookupStarted.current === autoLookupKey || !initialArtist.trim() || !initialAlbum.trim()) {
      return;
    }
    autoLookupStarted.current = autoLookupKey;
    void runAlbumLookup(initialArtist, initialAlbum);
  }, [autoLookupKey, initialAlbum, initialArtist]);

  async function runAlbumLookup(artistValue = artist, albumValue = album) {
    const lookupId = ++lookupVersion.current;
    const isCurrent = () => lookupId === lookupVersion.current;
    setLookupBusy(true);
    setStage("Finding the release…");
    latestCoverRef.current = undefined;
    // A new lookup replaces whatever was shown: never leave another album's result on screen.
    setResult(null);
    setCover(null);
    setOriginalCover(null);
    setTheme(null);
    setLyricsCoverage("");
    setLyricsNote(null);
    setCoverNote(null);
    setError("");
    setErrorDetails("");
    setEditError("");
    setEditInstruction("");
    setEditHistory([]);
    let info: AlbumInfo;
    try {
      info = await lookupAlbum(artistValue, albumValue);
    } catch (cause) {
      if (isCurrent()) {
        const raw = errorText(cause);
        if (isNetworkFailure(raw)) {
          setError("Couldn't reach MusicBrainz. Check your internet connection, then click Look up album again.");
          setErrorDetails(raw);
        } else {
          setError(`Album research failed: ${raw}`);
        }
        setStage("");
        setLookupBusy(false);
      }
      return;
    }
    if (!isCurrent()) {
      return;
    }
    setResult(info);
    // Cover, theme, and lyrics are optional enrichments: their failure must
    // never block applying the album (tracklist) into the project.
    // Start theme analysis without making it a gate for the original-cover edit flow. A slow
    // palette request should never keep the actual source image out of the user's hands.
    const themeTask: Promise<CoverTheme | undefined> = info.coverArtUrls.length > 0
      ? fetchCoverTheme(info.coverArtUrls)
          .then((nextTheme) => {
            if (isCurrent()) {
              setTheme(nextTheme);
            }
            return nextTheme;
          })
          .catch(() => undefined)
      : Promise.resolve(undefined);
    // Only REAL artwork is ever applied by a lookup. When there is none, the front stays
    // untouched and generating a concept stays an explicit choice.
    let coverResult: GeneratedCover | undefined;
    if (info.coverArtUrls.length > 0) {
      setStage("Downloading the real cover…");
      try {
        const real = await fetchRealCoverFile(info.coverArtUrls);
        if (!isCurrent()) {
          return;
        }
        coverResult = realCoverAsGeneratedCover(real);
        latestCoverRef.current = coverResult;
        setOriginalCover(coverResult);
        setCover(coverResult);
      } catch (cause) {
        if (!isCurrent()) {
          return;
        }
        setCoverNote({ kind: "failed", error: errorText(cause) });
        setConceptOpen(true);
      }
    } else {
      setCoverNote({ kind: "none" });
      setConceptOpen(true);
    }
    const themeResult = await themeTask;
    if (!isCurrent()) {
      return;
    }
    const lyricsByTrack: TrackLyrics[] = [];
    let lyricFailure = "";
    let lyricFailureCount = 0;
    for (const [index, title] of info.tracks.entries()) {
      // Circuit-break: if the first tracks all fail, the lyrics source is down —
      // don't burn a slow network timeout on every remaining track.
      if (lyricsByTrack.length === 0 && lyricFailureCount >= 3) {
        break;
      }
      setStage(`Lyrics ${index + 1} of ${info.tracks.length}…`);
      try {
        const lyricText = await fetchLyrics(info.artist, title);
        if (!isCurrent()) {
          return;
        }
        if (lyricText.trim()) {
          lyricsByTrack.push({ title, lyrics: lyricText });
        }
      } catch (cause) {
        if (!isCurrent()) {
          return;
        }
        lyricFailureCount += 1;
        if (!lyricFailure) {
          lyricFailure = errorText(cause);
        }
      }
    }
    if (!isCurrent()) {
      return;
    }
    setLyricsCoverage(`${lyricsByTrack.length}/${info.tracks.length} tracks`);
    const missing = info.tracks.length - lyricsByTrack.length;
    if (missing > 0) {
      setLyricsNote({ text: `Lyrics not found for ${missing} ${missing === 1 ? "track" : "tracks"}.`, details: lyricFailure });
    }
    // Every current lookup applies: re-running the same album replaces the project's research
    // (applyResearch is idempotent), and lookupVersion already drops stale runs.
    onApply(info, latestCoverRef.current ?? coverResult, lyricsByTrack, themeResult);
    setStage("");
    setLookupBusy(false);
  }

  function runResearch() {
    return runAlbumLookup(artist, album);
  }

  // Click-to-apply the REAL album cover full-res to the front slot (also the Retry after a failed download).
  async function useRealCover() {
    if (!result || coverBusy) {
      return;
    }
    setError("");
    setErrorDetails("");
    setEditError("");
    if (originalCover) {
      latestCoverRef.current = originalCover;
      setCover(originalCover);
      onCover?.(originalCover);
      return;
    }
    setCoverBusy("real");
    try {
      const real = await fetchRealCoverFile(result.coverArtUrls);
      const nextCover = realCoverAsGeneratedCover(real);
      latestCoverRef.current = nextCover;
      setOriginalCover(nextCover);
      setCover(nextCover);
      setCoverNote(null);
      onCover?.(nextCover);
    } catch (cause) {
      setCoverNote({ kind: "failed", error: errorText(cause) });
    } finally {
      setCoverBusy("");
    }
  }

  async function editOriginalCover() {
    const instruction = editInstruction.trim();
    if (!originalCover || !instruction || coverBusy || canEditCover === false) {
      return;
    }
    setEditError("");
    setCoverBusy("edit");
    try {
      const nextCover = await editCoverFromOriginal(originalCover.imagePath, instruction);
      latestCoverRef.current = nextCover;
      setCover(nextCover);
      onCover?.(nextCover);
      setEditHistory((history) => [instruction, ...history].slice(0, 3));
      setEditInstruction("");
    } catch (cause) {
      setEditError(`Could not apply that edit. Your current cover is unchanged. ${errorText(cause)}`);
    } finally {
      setCoverBusy("");
    }
  }

  // Generate a CUSTOM cover grounded in the real cover + contemporaneous era art via the vision
  // art-director; fall back to the theme/style text prompt if the vision router is unavailable.
  async function generateGroundedCover() {
    if (!result || coverBusy) {
      return;
    }
    setError("");
    setErrorDetails("");
    setCoverBusy("grounded");
    try {
      const eraRefs = await fetchEraCovers(result.artist, result.year, 5).catch(() => [] as string[]);
      let prompt: string;
      try {
        const visionDirection = await artDirectFromReferences(
          visionAlbumLabelForDirection(result, coverDirection),
          result.coverArtUrls.slice(0, 1),
          eraRefs.slice(0, 2)
        );
        prompt = coverPromptFromArtDirection(
          result,
          visionDirection,
          styleDnaFromAlbum(result),
          theme ?? undefined,
          coverDirection
        );
      } catch {
        prompt = coverPromptForAlbum(
          result,
          styleDnaFromAlbum(result),
          theme ?? undefined,
          coverDirection
        );
      }
      const styleRefs = coverStyleReferences(result, eraRefs);
      const nextCover = await generateCover(prompt, styleRefs);
      latestCoverRef.current = nextCover;
      setCover(nextCover);
      onCover?.(nextCover);
    } catch (cause) {
      setError(`Grounded cover failed: ${errorText(cause)}`);
    } finally {
      setCoverBusy("");
    }
  }

  function errorText(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
  }

  function fileName(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
  }

  const editsDisabled = Boolean(coverBusy) || canEditCover === false;
  const showingOriginal = Boolean(originalCover && cover && cover.imagePath === originalCover.imagePath);

  return (
    <section className="panel" aria-labelledby="research-heading" aria-busy={lookupBusy}>
      <div className="panel-head">
        <h2 id="research-heading">Album</h2>
        <button type="button" onClick={() => void runResearch()} disabled={lookupBusy || Boolean(coverBusy)} data-testid="run-research">
          {lookupBusy ? "Looking up…" : "Look up album"}
        </button>
      </div>
      <label>
        Artist
        <input value={artist} onChange={(event) => setArtist(event.target.value)} data-testid="artist-input" />
      </label>
      <label>
        Album
        <input value={album} onChange={(event) => setAlbum(event.target.value)} data-testid="album-input" />
      </label>
      <p className="research-stage" role="status" aria-live="polite" data-testid="research-stage">
        {stage}
      </p>
      {error ? (
        <div className="research-error-block">
          <p className="error" role="alert" data-testid="research-error">
            {error}
          </p>
          {errorDetails ? (
            <details className="error-details" data-testid="research-error-details">
              <summary>Technical details</summary>
              <p>{errorDetails}</p>
            </details>
          ) : null}
        </div>
      ) : null}
      {result ? (
        <div className="research-result" data-testid="research-result">
          <strong>
            {result.artist} - {result.album} ({result.year})
          </strong>
          {theme ? (
            <div className="album-theme" data-testid="album-theme">
              <img src={theme.previewUrl} alt="Original album artwork" data-testid="theme-source-art" />
              <div className="theme-facts">
                <div className="theme-label">Theme - learned from the album artwork</div>
                <div className="theme-swatches" data-testid="theme-swatches">
                  {theme.palette.map((hex) => (
                    <i key={hex} style={{ background: hex }} title={hex} />
                  ))}
                </div>
                <div className="theme-tokens" data-testid="theme-tokens">
                  {styleDnaFromAlbum(result).profile} · {styleDnaFromAlbum(result).era} ·{" "}
                  {theme.luminance < 0.35 ? "dark" : theme.luminance > 0.65 ? "light" : "mid-tone"} artwork
                </div>
              </div>
            </div>
          ) : null}
          {originalCover ? (
            <div className="cover-editor" aria-busy={coverBusy === "edit"} data-testid="cover-editor">
              <div className="cover-editor-head">
                <img src={originalCover.previewUrl} alt="Original cover loaded for editing" />
                <div>
                  <span className="cover-editor-badge">Original loaded</span>
                  <strong>Cover chat</strong>
                  <p>Describe one change. Every edit starts from the actual original cover.</p>
                </div>
              </div>
              {canEditCover === false ? (
                <p className="panel-message" id="cover-edit-unavailable" data-testid="cover-edit-unavailable">
                  {COVER_EDIT_UNAVAILABLE}
                </p>
              ) : null}
              <label className="cover-editor-input">
                Describe an edit
                <textarea
                  value={editInstruction}
                  onChange={(event) => setEditInstruction(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                      event.preventDefault();
                      void editOriginalCover();
                    }
                  }}
                  disabled={editsDisabled}
                  aria-describedby={canEditCover === false ? "cover-edit-unavailable" : undefined}
                  placeholder="Make it more cartoonish, but keep the figure, composition, colors, and title placement."
                  data-testid="cover-edit-instruction"
                />
              </label>
              <div className="cover-editor-suggestions" aria-label="Edit suggestions">
                {EDIT_SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion.label}
                    type="button"
                    onClick={() => setEditInstruction(suggestion.instruction)}
                    disabled={editsDisabled}
                    title={suggestion.instruction}
                  >
                    {suggestion.label}
                  </button>
                ))}
              </div>
              <div className="cover-editor-actions">
                <button
                  type="button"
                  onClick={() => void editOriginalCover()}
                  disabled={editsDisabled || !editInstruction.trim()}
                  aria-describedby={canEditCover === false ? "cover-edit-unavailable" : undefined}
                  data-testid="apply-original-edit"
                >
                  {coverBusy === "edit" ? "Editing..." : "Apply to original"}
                </button>
                <button
                  type="button"
                  onClick={() => void useRealCover()}
                  disabled={Boolean(coverBusy) || showingOriginal}
                  data-testid="reset-original-cover"
                >
                  Undo edits
                </button>
              </div>
              <p className="cover-editor-status" role="status" aria-live="polite">
                {coverBusy === "edit"
                  ? "Editing the original cover. This can take a moment."
                  : canEditCover === false
                    ? ""
                    : "Tip: Ctrl/Cmd + Enter applies your edit."}
              </p>
              {editHistory.length > 0 ? (
                <ol className="cover-editor-history" data-testid="cover-edit-history">
                  {editHistory.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ol>
              ) : null}
              {editError ? (
                <p className="cover-editor-error" role="alert" data-testid="cover-edit-error">
                  {editError}
                </p>
              ) : null}
            </div>
          ) : null}
          <pre>{composeTracklist(result)}</pre>
          {lyricsCoverage ? (
            <div className="lyrics-coverage" data-testid="lyrics-coverage">
              Lyrics: {lyricsCoverage}
              {lyricsNote ? (
                <span className="lyrics-note" data-testid="lyrics-note">
                  {" "}
                  · {lyricsNote.text}
                </span>
              ) : null}
            </div>
          ) : null}
          {lyricsNote?.details ? (
            <details className="error-details" data-testid="lyrics-error-details">
              <summary>Technical details</summary>
              <p>{lyricsNote.details}</p>
            </details>
          ) : null}
          <div className="cover-actions" data-testid="cover-actions">
            {coverNote ? (
              <p
                className={coverNote.kind === "failed" ? "error" : "panel-message"}
                role={coverNote.kind === "failed" ? "alert" : "status"}
                id="real-cover-note"
                data-testid="real-cover-note"
              >
                {coverNote.kind === "failed" ? `Real cover download failed: ${coverNote.error}` : NO_REAL_COVER}
              </p>
            ) : null}
            {!originalCover ? (
              <button
                type="button"
                onClick={() => void useRealCover()}
                disabled={lookupBusy || Boolean(coverBusy) || result.coverArtUrls.length === 0}
                aria-describedby={coverNote ? "real-cover-note" : undefined}
                data-testid="use-real-cover"
              >
                {coverBusy === "real" ? "Fetching..." : coverNote?.kind === "failed" ? "Retry" : "Use real album cover"}
              </button>
            ) : null}
            <details
              className="cover-concept-actions"
              open={conceptOpen}
              onToggle={(event) => setConceptOpen(event.currentTarget.open)}
            >
              <summary>Create a separate concept</summary>
              <label>
                Cover direction
                <select
                  aria-label="Cover direction"
                  value={coverDirection}
                  onChange={(event) => setCoverDirection(event.target.value as CoverDirectionId)}
                  disabled={lookupBusy || Boolean(coverBusy)}
                  data-testid="cover-direction"
                >
                  {COVER_DIRECTIONS.map((direction) => (
                    <option key={direction.id} value={direction.id}>
                      {direction.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="cover-direction-note" data-testid="cover-direction-description">
                {coverDirectionFor(coverDirection).description}
              </div>
              <button
                type="button"
                onClick={() => void generateGroundedCover()}
                disabled={lookupBusy || Boolean(coverBusy)}
                data-testid="generate-grounded-cover"
                title="Generate a separate new cover concept from the album's visual direction"
              >
                {coverBusy === "grounded" ? "Generating..." : "Generate separate concept"}
              </button>
            </details>
          </div>
          {cover ? (
            <figure className="cover-preview">
              {cover.previewUrl ? (
                <img
                  src={cover.previewUrl}
                  alt={cover.adapter === "real" ? "Album cover" : "Generated concept"}
                  data-testid="cover-thumb"
                />
              ) : null}
              {/* One caption; its chips keep the stacked layout the separate captions had. */}
              <figcaption style={{ display: "grid", gap: "0.4rem", justifyItems: "start" }}>
                {cover.adapter === "mock" ? (
                  <span className="cover-placeholder-note" data-testid="cover-placeholder-note">
                    Placeholder only. This image came from the mock adapter, not an AI image model.
                  </span>
                ) : null}
                <span className="cover-chip" data-testid="cover-provider">
                  {coverAdapterLabel(cover.adapter)}
                </span>
                <span className="cover-chip" title={cover.imagePath}>
                  {fileName(cover.imagePath)}
                </span>
              </figcaption>
            </figure>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Transport-level failures (offline, DNS, timeouts, 5xx after retries): show a plain sentence. */
function isNetworkFailure(message: string): boolean {
  return /request failed after|error sending request|unreachable|timed out|connection|dns|HTTP 5\d\d|network/i.test(message);
}

function realCoverAsGeneratedCover(real: {
  imagePath: string;
  previewUrl: string;
  palette: string[];
}): GeneratedCover {
  return {
    imagePath: real.imagePath,
    previewUrl: real.previewUrl,
    palette: real.palette,
    prompt: "real album cover",
    adapter: "real"
  };
}
