import { useMemo, useState } from "react";
import { resolveArtSrc } from "../art/editor";
import { landingFormatLabel } from "../landing/formats";
import { projectCover, savedProjects, type CdProject, type ProjectKind } from "./catalog";

interface RecentProjectsProps {
  projects: CdProject[];
  loading?: boolean;
  /** A load failure: shown instead of "no projects", which would be untrue. */
  error?: string;
  onOpen: (project: CdProject) => void;
}

export function RecentProjects({ projects, loading = false, error = "", onOpen }: RecentProjectsProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | ProjectKind>("all");
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return savedProjects(projects).filter((project) =>
      (filter === "all" || project.kind === filter)
      && (!needle || `${project.name} ${project.entry.artist} ${project.entry.album}`.toLowerCase().includes(needle))
    );
  }, [filter, projects, query]);

  return (
    <section className="catalog" id="recent-projects" aria-labelledby="catalog-heading" data-testid="recent-projects">
      <div className="catalog-head">
        <div>
          <span className="catalog-kicker">Your work</span>
          <h2 id="catalog-heading">Projects</h2>
          <p>Open a saved CD to revisit its exact song order, cover, booklet, audio, and burn controls.</p>
        </div>
        <label className="catalog-search">
          <span>Find a project</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Artist or album"
          />
        </label>
      </div>

      <div className="music-project-filters" role="group" aria-label="Filter projects">
        <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>All</button>
        <button className={filter === "artist" ? "active" : ""} onClick={() => setFilter("artist")}>Artist releases</button>
        <button className={filter === "custom" ? "active" : ""} onClick={() => setFilter("custom")}>Custom CDs</button>
      </div>

      {loading && visible.length === 0 ? <p className="catalog-empty">Loading your MXTP projects…</p> : null}
      {error ? (
        <p className="error" role="alert" data-testid="projects-load-error">Some projects could not be loaded: {error}</p>
      ) : null}
      {!loading && !error && visible.length === 0 ? (
        <p className="catalog-empty">Saved projects and completed burns will appear here.</p>
      ) : null}

      <div className="catalog-grid">
        {visible.map((project) => {
          const cover = projectCover(project);
          const coverSrc = resolveArtSrc(cover);
          // Saved research can be partial (older or hand-edited files): guard every field.
          const lyrics = project.research?.lyricsByTrack?.length ?? 0;
          return (
            <button
              key={project.id}
              type="button"
              className="catalog-card"
              onClick={() => onOpen(project)}
              aria-label={`Open ${project.name || project.entry.album || "untitled CD"}`}
              data-testid={`project-card-${project.id}`}
            >
              <span className="catalog-case" aria-hidden="true">
                <span className="catalog-case-spine" />
                <span className="catalog-case-cover">
                  {coverSrc ? <img src={coverSrc} alt="" /> : <i>MXTP</i>}
                </span>
                <span className="catalog-case-glare" />
              </span>
              <span className="catalog-card-copy">
                <strong>{project.name || project.entry.album || "Untitled CD"}</strong>
                <span>{project.entry.artist || kindLabel(project)}</span>
                <small>
                  {project.burnQueue?.length || project.tracks?.length || 0} tracks · {lyrics} lyrics · {project.bookletPages}-page booklet
                </small>
                <small>{landingFormatLabel(project.entry.formatId)} · {formatUpdated(project.updatedAt)}</small>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function kindLabel(project: CdProject): string {
  if (project.id.startsWith("recovered-")) return "Recovered playlist";
  return project.kind === "custom" ? "Custom CD" : "Artist release";
}

function formatUpdated(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Saved project" : `Updated ${date.toLocaleDateString()}`;
}
