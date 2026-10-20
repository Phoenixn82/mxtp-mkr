import { FormEvent, useMemo, useState } from "react";
import { savedProjects, type CdProject } from "../project/catalog";
import { RecentProjects } from "../project/RecentProjects";
import { ThemeToggle } from "../theme/ThemeToggle";
import { CaseModelCanvas } from "./CaseModelCanvas";
import { landingFormats } from "./formats";

export interface LandingEntry {
  artist: string;
  album: string;
  formatId: string;
}

interface LandingScreenProps {
  onSubmit: (entry: LandingEntry) => void;
  projects?: CdProject[];
  projectsLoading?: boolean;
  /** Why saved projects could not be loaded; shown instead of the empty state. */
  projectsError?: string;
  /** "Back to library" when a library is already loaded, otherwise "Import music sources". */
  libraryLabel?: string;
  onOpenProject?: (project: CdProject) => void;
  onOpenLibrary?: () => void;
  /** Libraries still loading: a neutral shell, so the form does not flash and then jump to the library. */
  loading?: boolean;
}

export function LandingScreen({
  onSubmit,
  projects = [],
  projectsLoading = false,
  projectsError = "",
  libraryLabel = "Import music sources",
  onOpenProject = () => undefined,
  onOpenLibrary = () => undefined,
  loading = false
}: LandingScreenProps) {
  const formats = useMemo(() => landingFormats(), []);
  const [artist, setArtist] = useState("");
  const [album, setAlbum] = useState("");
  const [formatId, setFormatId] = useState("jewelcase");
  const savedCount = useMemo(() => savedProjects(projects).length, [projects]);
  const albumCd = Boolean(artist.trim() || album.trim());

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit({ artist: artist.trim(), album: album.trim(), formatId });
  }

  if (loading) {
    // Same root <main> as the landing, so the page keeps one root node while it loads.
    return (
      <main className="landing-screen app-loading" data-testid="app-loading">
        <ThemeToggle className="landing-theme-toggle" />
        <p role="status">Loading your library…</p>
      </main>
    );
  }

  return (
    <main className="landing-screen" data-testid="landing-screen">
      <ThemeToggle className="landing-theme-toggle" />
      <div className="landing-intro">
        <h1>MXTP MKR</h1>
        <p>Make a mixtape CD: pick the songs, design the case, burn the disc.</p>
        {savedCount > 0 ? (
          <a className="landing-projects-link" href="#recent-projects">Your projects ({savedCount})</a>
        ) : null}
      </div>
      <div className="landing-core">
        <CaseModelCanvas modelId={formatId} />
        <form className="landing-form" onSubmit={submit} aria-labelledby="landing-form-heading">
          <h2 id="landing-form-heading">Start a new CD</h2>
          <label className="landing-field">
            Artist
            <input value={artist} onChange={(event) => setArtist(event.target.value)} autoComplete="off" />
          </label>
          <label className="landing-field">
            Album
            <input value={album} onChange={(event) => setAlbum(event.target.value)} autoComplete="off" />
          </label>
          <label className="landing-field landing-format-field">
            Format
            <select value={formatId} onChange={(event) => setFormatId(event.target.value)}>
              {formats.map((format) => (
                <option key={format.id} value={format.id}>
                  {format.label}
                </option>
              ))}
            </select>
          </label>
          <button className="landing-submit" type="submit">
            {albumCd ? "Create album CD" : "Start custom CD"}
          </button>
          <p className="landing-hint">Leave Artist and Album empty to start a custom mix.</p>
          <button className="landing-library-entry" type="button" onClick={onOpenLibrary}>{libraryLabel}</button>
        </form>
      </div>
      <RecentProjects projects={projects} loading={projectsLoading} error={projectsError} onOpen={onOpenProject} />
    </main>
  );
}
