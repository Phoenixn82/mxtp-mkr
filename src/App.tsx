import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from "react";
import { AudioPanel } from "./audio/AudioPanel";
import { capacityCheck, formatDuration, type CapacityResult, type Track } from "./audio/audio";
import {
  burnItemForTrack,
  burnReal,
  canUsePlaylistCover,
  confirmRealBurn,
  composeResearchArt,
  detectBurners,
  downloadPlaylistBest,
  findYouTubeAlbumPlaylist,
  libraryProjectFor,
  mergeSlotArt,
  missingPathErrors,
  playableTracks,
  playlistFront,
  replaceResearchBookletArt,
  replaceResearchArt,
  researchArtKeepingChosenFront,
  runGo,
  validateProject,
  writeTracksToQueue,
  type DriveInfo,
  type PlaylistImport
} from "./app/orchestration";
import { SlotEditor } from "./art/SlotEditor";
import { resolveArtSrc, type SlotArt } from "./art/editor";
import { BookletManager } from "./booklet/BookletManager";
import { BookletModelPreview } from "./booklet/BookletModelPreview";
import { BookletPreview } from "./booklet/BookletPreview";
import {
  composeBookletPages,
  PRINTABLE_BOOKLET_PAGE_COUNTS,
  type ComposedBooklet
} from "./booklet/bookletExport";
import type { BookletDesignInput } from "./booklet/design";
import { bookletComponentId, exportBooklet, type ExportBookletResult } from "./booklet/exportBooklet";
import { insertSpecs } from "./geometry";
import { LandingScreen, type LandingEntry } from "./landing/LandingScreen";
import { landingFormatLabel } from "./landing/formats";
import { AppleMusicLibrary } from "./library/AppleMusicLibrary";
import { loadAppleMusicLibrary, normalizeTrackTitle, type AppleMusicAlbum, type AppleMusicLibraryData, type MusicSource } from "./library/appleMusic";
import {
  combineMusicLibraries,
  loadImportedMusicSources,
  parseMusicExport,
  saveImportedMusicSources,
  type ImportedMusicSource,
  type ImportTextFile
} from "./library/multiLibrary";
import { Preview3D } from "./preview3d/Preview3D";
import {
  createCdProject,
  deleteCdProject,
  listCachedPlaylists,
  mergeCachedPlaylists,
  normalizeCdProject,
  saveCdProject,
  sortCdProjects,
  upsertCdProject,
  type CdBurnItem,
  type CdProject,
  type SavedResearch
} from "./project/catalog";
import { DeleteProjectDialog } from "./project/DeleteProjectDialog";
import { ResearchPanel } from "./research/ResearchPanel";
import {
  fetchLyrics,
  styleDnaFromAlbum,
  type AlbumInfo,
  type CoverTheme,
  type GeneratedCover,
  type TrackLyrics
} from "./research/research";
import { invokeCommand } from "./tauriClient";
import { ThemeToggle } from "./theme/ThemeToggle";

const PREVIEW_PIECES = [
  { id: "front", label: "Front" },
  { id: "tray", label: "Tray" },
  { id: "disc", label: "Disc" }
];

const CHECKLIST_PIECES = [
  { id: "front", label: "Front cover" },
  { id: "tray", label: "Tray card" },
  { id: "disc", label: "Disc face" }
];

const BUSY_REASON = "Finish the current burn or download first.";

type Busy = "exporting" | "burning" | "downloading" | "searching";
type MessageArea = "audio" | "burn";

export function App() {
  const [projects, setProjects] = useState<CdProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsLoadError, setProjectsLoadError] = useState("");
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [appleLibrary, setAppleLibrary] = useState<AppleMusicLibraryData | null>(null);
  const [appleLoading, setAppleLoading] = useState(true);
  const [appleLoadError, setAppleLoadError] = useState("");
  const [importedSources, setImportedSources] = useState<ImportedMusicSource[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [importedSourcesError, setImportedSourcesError] = useState("");
  const [enabledSources, setEnabledSources] = useState<Set<MusicSource>>(new Set(["apple", "spotify", "soundcloud", "youtubeMusic"]));
  const [manualCreate, setManualCreate] = useState(false);
  const [libraryOnboarding, setLibraryOnboarding] = useState(false);
  const [initialProjectId, setInitialProjectId] = useState<string | undefined>();
  const [exitProjectSignal, setExitProjectSignal] = useState(0);
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CdProject | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  const [deleteProjectError, setDeleteProjectError] = useState("");
  const [projectSaveError, setProjectSaveError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      loadProjectsKeepingGoodOnes().catch((error: unknown) => ({ saved: [] as CdProject[], error: errorText(error) })),
      listCachedPlaylists().catch(() => [])
    ]).then(([{ saved, error }, cached]) => {
      if (cancelled) return;
      // Keep the failure visible: an empty list here would read as "you have no projects".
      setProjectsLoadError(error);
      const merged = mergeCachedPlaylists(saved, cached);
      setProjects((current) => sortCdProjects([...merged, ...current.filter((item) => !merged.some((savedItem) => savedItem.id === item.id))]));
      setProjectsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadImportedMusicSources()
      .then((sources) => { if (!cancelled) setImportedSources(sources); })
      .catch((error: unknown) => { if (!cancelled) setImportedSourcesError(errorText(error)); })
      .finally(() => { if (!cancelled) setSourcesLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadAppleMusicLibrary()
      .then((library) => { if (!cancelled) setAppleLibrary(library); })
      .catch((error: unknown) => {
        // No Apple Music library on this machine is normal; a library that is
        // there but cannot be read is not.
        if (!cancelled && !isLibraryNotFound(error)) setAppleLoadError(`Apple Music library could not be read: ${errorText(error)}`);
      })
      .finally(() => { if (!cancelled) setAppleLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const combinedLibrary = useMemo(
    () => combineMusicLibraries(appleLibrary, importedSources, enabledSources),
    [appleLibrary, importedSources, enabledSources]
  );

  const refreshAppleMusic = useCallback(async (path?: string) => {
    const library = await loadAppleMusicLibrary(path);
    setAppleLibrary(library);
    setAppleLoadError("");
    setEnabledSources((current) => new Set([...current, "apple"]));
    return library;
  }, []);

  const importMusicSource = useCallback(async (source: ImportedMusicSource["source"], files: ImportTextFile[]) => {
    if (importedSourcesError) {
      // The saved sources could not be read; writing now would replace them.
      throw new Error(`Your imported music sources could not be loaded, so importing is blocked to avoid overwriting them: ${importedSourcesError}`);
    }
    const imported = parseMusicExport(source, files);
    const next = [...importedSources.filter((item) => item.source !== source), imported];
    await saveImportedMusicSources(next);
    setImportedSources(next);
    setEnabledSources((current) => new Set([...current, source]));
    return imported;
  }, [importedSources, importedSourcesError]);

  const updateProject = useCallback((project: CdProject) => {
    setProjects((current) => upsertCdProject(current, project));
    if (project.saved) {
      void saveCdProject(project)
        .then(() => setProjectSaveError(""))
        .catch((error) => setProjectSaveError(`Could not save this project: ${errorText(error)}`));
    }
  }, []);

  const explicitlySaveProject = useCallback(async (project: CdProject): Promise<boolean> => {
    const saved = normalizeCdProject({ ...project, saved: true, updatedAt: new Date().toISOString() });
    setProjectSaveError("");
    try {
      await saveCdProject(saved);
      setProjects((current) => upsertCdProject(current, saved));
      return true;
    } catch (error) {
      setProjectSaveError(`Could not save this project: ${errorText(error)}`);
      return false;
    }
  }, []);

  const requestProjectDelete = useCallback((project: CdProject) => {
    setDeleteProjectError("");
    setDeleteTarget(project);
  }, []);

  const cancelProjectDelete = useCallback(() => {
    setDeleteProjectError("");
    setDeleteTarget(null);
  }, []);

  async function confirmProjectDelete() {
    if (!deleteTarget) return;
    setDeletingProject(true);
    setDeleteProjectError("");
    try {
      await deleteCdProject(deleteTarget.id);
      setProjects((current) => current.filter((project) => project.id !== deleteTarget.id));
      setActiveProjectId((current) => current === deleteTarget.id ? null : current);
      setInitialProjectId((current) => current === deleteTarget.id ? undefined : current);
      setDeleteTarget(null);
    } catch (error) {
      setDeleteProjectError(`Could not delete this project: ${errorText(error)}`);
    } finally {
      setDeletingProject(false);
    }
  }

  function createProject(entry: LandingEntry) {
    const project = createCdProject(entry);
    updateProject(project);
    setManualCreate(false);
    setInitialProjectId(undefined);
    setJustCreatedId(project.id);
    setActiveProjectId(project.id);
  }

  function savePreparedAlbum(album: AppleMusicAlbum, playlist: PlaylistImport) {
    updateProject(libraryProjectFor(projects, album, playlist));
  }

  function openAlbumStudio(album: AppleMusicAlbum) {
    const project = libraryProjectFor(projects, album);
    updateProject(project);
    setActiveProjectId(project.id);
  }

  function openProjectStudio(project: CdProject) {
    setProjects((current) => upsertCdProject(current, project));
    setActiveProjectId(project.id);
  }

  function leaveStudio() {
    setActiveProjectId(null);
    setManualCreate(false);
    setJustCreatedId(null);
  }

  function discardDraft(projectId: string) {
    setProjects((current) => current.filter((project) => project.id !== projectId || project.saved));
    leaveStudio();
  }

  const activeProject = projects.find((project) => project.id === activeProjectId);
  const libraryMode = Boolean(appleLibrary || importedSources.length > 0 || libraryOnboarding) && !manualCreate;
  const appError = [
    projectSaveError,
    projectsLoadError ? `Some projects could not be loaded: ${projectsLoadError}` : "",
    importedSourcesError ? `Imported music sources could not be loaded: ${importedSourcesError}. Importing is blocked so they are not overwritten.` : "",
    appleLoadError
  ].filter(Boolean).join(" ");
  const deleteDialog = (
    <DeleteProjectDialog
      projectName={deleteTarget?.name || deleteTarget?.entry.album || "this project"}
      open={Boolean(deleteTarget)}
      busy={deletingProject}
      error={deleteProjectError}
      onCancel={cancelProjectDelete}
      onConfirm={() => void confirmProjectDelete()}
    />
  );

  if (!activeProject && !libraryMode) {
    return (
      <>
        <LandingScreen
          loading={appleLoading || sourcesLoading}
          onSubmit={createProject}
          projects={projects}
          projectsLoading={projectsLoading}
          projectsError={projectsLoadError}
          libraryLabel={appleLibrary || importedSources.length > 0 ? "Back to library" : "Import music sources"}
          onOpenProject={(project) => {
            // Recent CDs open the album layout + tracklist in the library first;
            // the studio is one click away from there.
            setManualCreate(false);
            setLibraryOnboarding(true);
            setInitialProjectId(project.id);
          }}
          onOpenLibrary={() => {
            setManualCreate(false);
            setLibraryOnboarding(true);
          }}
        />
        {deleteDialog}
      </>
    );
  }

  // The studio renders first and the library stays mounted (hidden) behind it,
  // so the burn list, project mode, view and curator survive a studio visit.
  return (
    <>
      {activeProject ? (
        <DetailView
          key={activeProject.id}
          project={activeProject}
          autoFindAudio={activeProject.id === justCreatedId}
          saveError={projectSaveError}
          onChange={updateProject}
          onSave={explicitlySaveProject}
          onBack={leaveStudio}
          onExitProject={() => {
            setExitProjectSignal((current) => current + 1);
            leaveStudio();
          }}
          onDiscard={() => discardDraft(activeProject.id)}
          onRequestDelete={() => requestProjectDelete(activeProject)}
        />
      ) : null}
      {libraryMode ? (
        <div hidden={Boolean(activeProject)}>
          <AppleMusicLibrary
            library={combinedLibrary}
            enabledSources={enabledSources}
            onToggleSource={(source) => setEnabledSources((current) => {
              const next = new Set(current);
              if (next.has(source)) next.delete(source); else next.add(source);
              return next;
            })}
            onRefreshApple={(path?: string) => refreshAppleMusic(path)}
            onImportSource={importMusicSource}
            projects={projects}
            projectsLoading={projectsLoading}
            onCreateCustom={() => {
              setManualCreate(true);
              setInitialProjectId(undefined);
            }}
            onOpenStudio={openAlbumStudio}
            onOpenProjectStudio={openProjectStudio}
            onPreparedAlbum={savePreparedAlbum}
            onUpdateProject={updateProject}
            onSaveProject={explicitlySaveProject}
            onDeleteProject={requestProjectDelete}
            initialProjectId={initialProjectId}
            appError={appError || undefined}
            exitProjectSignal={exitProjectSignal}
          />
        </div>
      ) : null}
      {deleteDialog}
    </>
  );
}

/** useState whose setter also marks the studio as edited. */
function useEditedState<T>(initial: T | (() => T), edited: MutableRefObject<boolean>): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState(initial);
  const set = useCallback((next: SetStateAction<T>) => {
    edited.current = true;
    setValue(next);
  }, [edited]);
  return [value, set];
}

function DetailView({ project, autoFindAudio, saveError, onChange, onSave, onBack, onExitProject, onDiscard, onRequestDelete }: {
  project: CdProject;
  autoFindAudio: boolean;
  saveError: string;
  onChange: (project: CdProject) => void;
  onSave: (project: CdProject) => boolean | void | Promise<boolean | void>;
  onBack: () => void;
  onExitProject: () => void;
  onDiscard: () => void;
  onRequestDelete: () => void;
}) {
  const entry = project.entry;
  // Only the person's (or a download's) changes are saved; merely opening a
  // project never rewrites it.
  const edited = useRef(false);
  // The burn list is the one ordered track list; the studio plays, prints and
  // burns its downloaded items in that order.
  const [queue, setQueue] = useEditedState<CdBurnItem[]>(
    () => project.burnQueue.length > 0 ? project.burnQueue : project.tracks.map((track) => burnItemForTrack(track, entry)),
    edited
  );
  const tracks = useMemo(() => playableTracks(queue), [queue]);
  // Long downloads read the list as it is when they finish, not as it was when they started.
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const [art, setArt] = useEditedState<SlotArt[]>(project.art, edited);
  const [researchApplied, setResearchApplied] = useEditedState<string[]>(project.researchApplied, edited);
  const [research, setResearch] = useEditedState<SavedResearch | null>(project.research, edited);
  const [bookletPages, setBookletPages] = useEditedState(project.bookletPages, edited);
  const [exports, setExports] = useEditedState<string[]>(project.exports, edited);
  const [burnProgress, setBurnProgress] = useEditedState(project.burnProgress, edited);
  const [playlistUrl, setPlaylistUrl] = useEditedState(project.playlistUrl, edited);
  const [lastBurnedAt, setLastBurnedAt] = useEditedState(project.lastBurnedAt, edited);
  const [testBurn, setTestBurn] = useState<number | null>(project.lastBurnedAt || !project.burnProgress ? null : project.burnProgress);
  const [goError, setGoError] = useState<{ message: string; details?: string } | null>(null);
  const specs = useMemo(() => insertSpecs(), []);
  const composedSummary = useMemo(() => summarizeComposedArt(art), [art]);
  const [burners, setBurners] = useState<DriveInfo[]>([]);
  const [selectedDrive, setSelectedDrive] = useState("");
  const [message, setMessageState] = useState<{ text: string; area: MessageArea }>({ text: "", area: "audio" });
  const [lyricsStatus, setLyricsStatus] = useState("");
  const [busy, setBusyState] = useState<Busy | null>(null);
  const [autoSearching, setAutoSearching] = useState(false);
  const busyRef = useRef<Busy | null>(null);
  const [stage, setStage] = useState("");
  const [matched, setMatched] = useState<{ url: string; positions: number[] } | null>(null);
  const [playlistOpen, setPlaylistOpen] = useState(Boolean(project.playlistUrl));
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const youtubeLookupStarted = useRef(false);
  const researchEnrichmentStarted = useRef(false);
  const playlistCoverPath = useRef(
    project.art.find((item) => item.imageSource === "playlist" && item.slotId === "front")?.imageRef
  );
  // Display and CD-Text only: an artist-less mix keeps entry.artist empty on disk.
  const projectArtist = useMemo(
    () => entry.artist.trim() || inferArtistFromTracks(tracks),
    [entry.artist, tracks]
  );

  function setMessage(text: string, area: MessageArea) {
    setMessageState({ text, area });
  }

  function startBusy(kind: Busy, firstStage = "") {
    busyRef.current = kind;
    setBusyState(kind);
    setStage(firstStage);
  }

  function endBusy() {
    busyRef.current = null;
    setBusyState(null);
    setStage("");
  }

  useEffect(() => {
    // The landing or library may have been scrolled; the studio starts at the top.
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    detectBurners()
      .then((found) => {
        setBurners(found);
        if (found[0]) setSelectedDrive(found[0].id);
      })
      .catch((error) => {
        setBurners([]);
        setMessage(`Burner detection failed: ${errorText(error)}`, "burn");
      });
  }, []);

  useEffect(() => {
    // Only right after Create: reopening a saved project never searches YouTube unasked.
    if (
      !autoFindAudio ||
      youtubeLookupStarted.current ||
      project.sourcePath ||
      playlistUrl ||
      tracks.length > 0 ||
      !entry.artist.trim() ||
      !entry.album.trim()
    ) {
      return;
    }
    youtubeLookupStarted.current = true;
    setAutoSearching(true);
    setMessage(`Looking for ${entry.album} by ${entry.artist} on YouTube…`, "audio");
    void findYouTubeAlbumPlaylist(entry.artist, entry.album)
      .then((match) => {
        setPlaylistUrl(match.url);
        setMatched({ url: match.url, positions: match.safeTrackPositions ?? [] });
        setMessage(`Found ${channelName(match.artist)}: ${match.title} (${match.trackCount} tracks). Click Find album audio to download it.`, "audio");
      })
      .catch((error) => setMessage(`Automatic YouTube match failed: ${errorText(error)}`, "audio"))
      .finally(() => setAutoSearching(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFindAudio, entry.album, entry.artist, playlistUrl, project.sourcePath, tracks.length]);

  useEffect(() => {
    if (
      researchEnrichmentStarted.current ||
      (research && (research.lyricsByTrack?.length ?? 0) > 0) ||
      tracks.length === 0 ||
      !projectArtist ||
      !entry.album.trim()
    ) {
      return;
    }
    researchEnrichmentStarted.current = true;
    void enrichTrackResearch(tracks, entry.album, playlistCoverPath.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.album, projectArtist, research, tracks]);

  function snapshotProject(): CdProject {
    return {
      ...project,
      burnQueue: queue,
      tracks: retainTracks(project.tracks, tracks),
      art,
      researchApplied,
      research,
      bookletPages,
      exports,
      burnProgress,
      playlistUrl,
      lastBurnedAt
    };
  }

  /** Publish edits, if any; updatedAt moves only when something really changed. */
  function flush() {
    if (!edited.current) return;
    const next = snapshotProject();
    if (sameProject(next, project)) return;
    onChange({ ...next, updatedAt: new Date().toISOString() });
  }
  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(() => {
    if (!edited.current) return;
    const timeout = window.setTimeout(() => flushRef.current(), 350);
    return () => window.clearTimeout(timeout);
  }, [art, bookletPages, burnProgress, exports, lastBurnedAt, playlistUrl, queue, research, researchApplied]);

  const hasDraftContent = tracks.length > 0 || art.some((item) => item.imageRef || item.previewRef || item.textContent) || Boolean(research);

  function requestLeave() {
    if (busyRef.current) return;
    if (!project.saved && hasDraftContent) {
      setLeaveDialogOpen(true);
      return;
    }
    flush();
    onBack();
  }

  async function saveAndLeave() {
    setLeaveDialogOpen(false);
    if ((await onSave(snapshotProject())) !== false) onBack();
  }

  function exitProject() {
    if (busyRef.current) return;
    flush();
    onExitProject();
  }

  useEffect(() => {
    if (!leaveDialogOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLeaveDialogOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [leaveDialogOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", handlePointer);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  function changeTracks(next: Track[]) {
    setQueue((current) => writeTracksToQueue(current, next, entry));
  }

  async function go() {
    if (busyRef.current) return;
    setGoError(null);
    const capacity = capacityCheck(tracks);
    if (!capacity.ok) {
      setGoError({ message: overCapacityMessage(capacity) });
      return;
    }
    const invalid = validateProject({ projectId: project.id, tracks, art });
    if (invalid.length > 0) {
      setGoError({ message: invalid.join(" ") });
      return;
    }
    startBusy("exporting", "Preparing audio…");
    try {
      const result = await runGo({ projectId: project.id, tracks, art }, setStage);
      setBurnProgress(result.burnProgress);
      setTestBurn(result.burnProgress);
      if (result.ok) {
        setExports(result.exports);
      } else {
        const written = result.exports.length > 0 ? `\nWritten anyway:\n${result.exports.join("\n")}` : "";
        setGoError({
          message: `Export stopped. ${result.errors.map(shortError).join(" ")}`,
          details: `${result.errors.join("\n")}${written}`
        });
      }
    } finally {
      endBusy();
    }
  }

  async function detectDrives() {
    try {
      const found = await detectBurners();
      setBurners(found);
      if (found[0] && !found.some((drive) => drive.id === selectedDrive)) {
        setSelectedDrive(found[0].id);
      }
      setMessage(found[0] ? `Found ${found[0].name}` : "No CD writer found. Plug one in with a blank CD-R, then click Detect drives.", "burn");
    } catch (error) {
      setBurners([]);
      setMessage(`Burner detection failed: ${errorText(error)}`, "burn");
    }
  }

  async function burnDisc() {
    if (busyRef.current) return;
    const capacity = capacityCheck(tracks);
    if (!capacity.ok) {
      setMessage(overCapacityMessage(capacity), "burn");
      return;
    }
    const missing = missingPathErrors(tracks);
    if (missing.length > 0) {
      setMessage(missing.join(" "), "burn");
      return;
    }
    const drive = selectedDrive || burners[0]?.id || "";
    const driveName = burners.find((candidate) => candidate.id === drive)?.name || "";
    const burnTracks = tracksWithMetadata(tracks, projectArtist, entry.album);
    const discTitle = project.name || entry.album;
    if (!(await confirmRealBurn(driveName, burnTracks.length, discTitle))) {
      setMessage("Burn canceled.", "burn");
      return;
    }
    startBusy("burning", "Converting audio…");
    setMessage("Burning. This usually takes 7 to 20 minutes. Do not remove the disc.", "burn");
    try {
      const result = await burnReal(burnTracks, drive, false, discTitle, setStage);
      setMessage(result.ok ? result.message : `Burn failed: ${result.errors.join("; ")}`, "burn");
      if (result.ok) {
        setBurnProgress(result.finalPercent);
        const burnedAt = new Date().toISOString();
        setLastBurnedAt(burnedAt);
        void onSave({ ...snapshotProject(), saved: true, burnProgress: result.finalPercent, lastBurnedAt: burnedAt });
      }
    } finally {
      endBusy();
    }
  }

  /** Download a playlist into the burn list. Burning stays a separate step. */
  async function importPlaylist(url: string, positions?: number[]) {
    if (!url) {
      setMessage("Paste a YouTube playlist link first.", "audio");
      return;
    }
    if (busyRef.current) return;
    startBusy("downloading", "Downloading audio…");
    setMessage("Downloading the best audio for every track. A full album can take 7 to 20 minutes.", "audio");
    try {
      const playlist = await downloadPlaylistBest(url, positions);
      const playlistTracks = tracksWithMetadata(
        playlist.tracks,
        projectArtist,
        entry.album.trim() || playlist.title
      );
      // Add what is new; audio already in the list keeps its place.
      const live = playableTracks(queueRef.current);
      const have = new Set(live.map((track) => normalizeTrackTitle(track.title)));
      const nextTracks = [...live, ...playlistTracks.filter((track) => !have.has(normalizeTrackTitle(track.title)))];
      changeTracks(nextTracks);
      const coverPath = playlist.coverPath;
      if (coverPath) {
        setArt((current) => {
          if (!canUsePlaylistCover(current)) return current;
          playlistCoverPath.current = coverPath;
          return mergeSlotArt(current, [playlistFront(coverPath)]);
        });
      }
      const count = playlist.tracks.length;
      const capacity = capacityCheck(nextTracks);
      setMessage(
        capacity.ok
          ? `${count} ${count === 1 ? "track is" : "tracks are"} audio ready forever. Click Burn CD when ready.`
          : `Downloaded ${count} tracks from ${playlist.title}, but ${capacity.label} will not fit on an 80-minute CD. Remove tracks before burning.`,
        "audio"
      );
    } catch (error) {
      setMessage(`Playlist download failed: ${errorText(error)}`, "audio");
    } finally {
      endBusy();
    }
  }

  async function enrichTrackResearch(tracksToEnrich: Track[], albumTitle: string, coverPath?: string) {
    setLyricsStatus(`Finding lyrics for ${albumTitle}…`);
    const lyricsByTrack: TrackLyrics[] = [];
    let consecutiveFailures = 0;
    for (const track of tracksToEnrich) {
      if (lyricsByTrack.length === 0 && consecutiveFailures >= 3) break;
      try {
        const lyrics = await fetchLyrics(projectArtist, lyricLookupTitle(projectArtist, track.title));
        if (lyrics.trim()) {
          lyricsByTrack.push({ title: track.title, lyrics });
          consecutiveFailures = 0;
        }
      } catch {
        consecutiveFailures += 1;
      }
    }
    const album: AlbumInfo = {
      artist: research?.album.artist.trim() || projectArtist,
      album: research?.album.album || albumTitle,
      year: research?.album.year ?? 0,
      label: research?.album.label || "YouTube release",
      tracks: tracksToEnrich.map((track) => track.title),
      coverArtUrls: research?.album.coverArtUrls ?? [],
      tags: research?.album.tags ?? []
    };
    const cover: GeneratedCover | undefined = research?.cover ?? (coverPath
      ? {
          imagePath: coverPath,
          prompt: "YouTube release artwork",
          palette: [],
          adapter: "youtube"
        }
      : undefined);
    applyResearch(album, cover, lyricsByTrack, research?.theme);
    setLyricsStatus(
      lyricsByTrack.length > 0
        ? `Saved lyrics for ${lyricsByTrack.length} of ${tracksToEnrich.length} tracks.`
        : `No lyrics were found for ${albumTitle}.`
    );
  }

  async function downloadPlaylist() {
    const url = playlistUrl.trim();
    await importPlaylist(url, matched?.url === url ? matched.positions : undefined);
  }

  async function findAlbumAudio() {
    if (busyRef.current) return;
    // A verified match is already in hand (found right after Create): download it.
    if (matched && matched.url === playlistUrl.trim()) {
      await importPlaylist(matched.url, matched.positions);
      return;
    }
    startBusy("searching", "Searching YouTube…");
    setMessage(`Finding ${entry.album} by ${projectArtist} on YouTube…`, "audio");
    let match: { url: string; positions: number[] } | undefined;
    try {
      const found = await findYouTubeAlbumPlaylist(projectArtist, entry.album);
      match = { url: found.url, positions: found.safeTrackPositions ?? [] };
      setPlaylistUrl(found.url);
      setMatched(match);
      setMessage(`Matched ${channelName(found.artist)}: ${found.title}. Downloading the best audio…`, "audio");
    } catch (error) {
      setMessage(`YouTube album search failed: ${errorText(error)}`, "audio");
      return;
    } finally {
      endBusy();
    }
    if (match) await importPlaylist(match.url, match.positions);
  }

  function applyResearch(
    album: AlbumInfo,
    cover: GeneratedCover | undefined,
    lyricsByTrack: TrackLyrics[],
    theme?: CoverTheme
  ) {
    setResearchApplied((current) =>
      Array.from(new Set([...current.filter((item) => !/^\s*-/.test(item)), `${album.artist} - ${album.album}`]))
    );
    setResearch({ album, cover, lyricsByTrack, theme });
    // A front the person chose (library art, a picked file, a playlist cover)
    // survives a Lookup; "Use real album cover" replaces it on purpose.
    setArt((current) =>
      replaceResearchArt(current, researchArtKeepingChosenFront(current, composeResearchArt(album, cover, lyricsByTrack, bookletPages)))
    );
  }

  // Swap ONLY the front cover (used by the "real cover" / "grounded cover" buttons after research
  // has already applied — the album-dedup guard blocks a second full applyResearch).
  function replaceCover(cover: GeneratedCover) {
    playlistCoverPath.current = undefined;
    setResearch((current) => (current ? { ...current, cover } : current));
    setArt((current) =>
      mergeSlotArt(current, [
        {
          slotId: "front",
          imageRef: cover.imagePath,
          previewRef: cover.previewUrl,
          imageSource: "research",
          transform: { x: 0, y: 0, scale: 1, rotation: 0 }
        }
      ])
    );
  }

  function changeBookletPages(pages: number) {
    // Only printable saddle counts: anything else (e.g. a fold count) has no print template.
    if (!(PRINTABLE_BOOKLET_PAGE_COUNTS as readonly number[]).includes(pages)) return;
    setBookletPages(pages);
    if (!research) return;
    const bookletArt = composeResearchArt(research.album, research.cover, research.lyricsByTrack, pages).filter((item) =>
      item.slotId.startsWith("saddle-")
    );
    setArt((current) => replaceResearchBookletArt(current, bookletArt));
  }

  const bookletTracks = useMemo(
    () =>
      tracks.length > 0
        ? tracks.map((track) => ({ title: track.title }))
        : (research?.album.tracks ?? []).map((title) => ({ title })),
    [tracks, research]
  );
  const lyricsCount = research?.lyricsByTrack?.length ?? 0;
  const bookletCredits = research
    ? `${research.album.artist} — ${research.album.album} (${research.album.year}) ${research.album.label}`
    : undefined;
  const bookletDesign = useMemo<BookletDesignInput>(() => {
    const album = research?.album;
    const dna = album ? styleDnaFromAlbum(album) : undefined;
    const generatedPalette = research?.cover?.palette?.filter(Boolean) ?? [];
    return {
      artist: album?.artist ?? projectArtist,
      album: album?.album ?? entry.album,
      year: album?.year,
      tags: album?.tags,
      profile: dna?.profile,
      palette: generatedPalette.length > 0 ? generatedPalette : research?.theme?.palette ?? dna?.palette,
      luminance: research?.theme?.luminance
    };
  }, [entry.album, projectArtist, research]);
  const frontArt = art.find((item) => item.slotId === "front" && (item.imageRef || item.previewRef));
  const bookletCoverPreview = resolveArtSrc(frontArt);

  // Live booklet layout preview: the exact reader pages the PDF will render.
  const bookletLayout = useMemo<{ composed?: ComposedBooklet; error?: string; recommendedPages?: number }>(() => {
    const componentId = bookletComponentId(bookletPages);
    if (!componentId) {
      return { error: `No print template for ${bookletPages} pages.` };
    }
    try {
      return {
        composed: composeBookletPages({
          componentId,
          tracks: bookletTracks,
          lyricsByTrack: research && lyricsCount > 0 ? research.lyricsByTrack : undefined,
          credits: bookletCredits,
          design: bookletDesign
        })
      };
    } catch (error) {
      const messageText = errorText(error);
      return { error: messageText, recommendedPages: recommendedPagesFromError(messageText) };
    }
  }, [bookletPages, bookletTracks, research, lyricsCount, bookletCredits, bookletDesign]);

  function exportBookletPdf(): Promise<ExportBookletResult> {
    if (bookletLayout.error) return Promise.resolve({ ok: false, error: bookletLayout.error });
    return exportBooklet({
      pages: bookletPages,
      coverImageRef: frontArt?.imageRef,
      // Fall back to the REAL album artwork (the learned theme) so the booklet
      // cover + page wash always carry the album's aesthetic.
      coverPreviewRef: bookletCoverPreview ?? research?.theme?.previewUrl,
      tracks: bookletTracks,
      lyricsByTrack: research && lyricsCount > 0 ? research.lyricsByTrack : undefined,
      credits: bookletCredits,
      design: bookletDesign
    });
  }

  const canSearch = Boolean(projectArtist && entry.album.trim());
  const burnDisabledReason = busy
    ? BUSY_REASON
    : tracks.length === 0
      ? "Add audio first (step 2, Audio)."
      : "";
  const burnMessage = (area: MessageArea) =>
    message.text && message.area === area ? (
      <p className="burn-note" data-testid="burn-message" role="status" aria-live="polite">{message.text}</p>
    ) : null;
  const printFiles = exports.map(fileName);
  const exportTime = exportTimeFromPath(exports[0]);

  return (
    <main data-testid="detail-view">
      <header className="app-header studio-header">
        <div className="studio-heading">
          <button
            type="button"
            className="studio-back"
            onClick={requestLeave}
            disabled={Boolean(busy)}
            title={busy ? BUSY_REASON : undefined}
            data-testid="catalog-button"
          >
            ← Library
          </button>
          <h1 className="studio-title">{project.name || "Untitled CD"}</h1>
          <p className="entry-summary" data-testid="detail-entry-summary">
            {[projectArtist, entry.album, landingFormatLabel(entry.formatId)].filter(Boolean).join(" · ")}
          </p>
          <span className="studio-project-chip">{project.saved ? "Editing project" : "Unsaved draft"}</span>
          {saveError ? <p className="error" role="alert" data-testid="project-save-error">{saveError}</p> : null}
        </div>
        <div className="app-header-actions">
          <ThemeToggle className="studio-theme-toggle" />
          {project.saved ? (
            <span className="studio-saved-status" data-testid="save-project-button">Saved automatically</span>
          ) : (
            <button type="button" onClick={() => void onSave(snapshotProject())} data-testid="save-project-button">
              Save as project
            </button>
          )}
          {project.saved ? (
            <button type="button" onClick={exitProject} disabled={Boolean(busy)} title={busy ? BUSY_REASON : undefined}>
              Exit project
            </button>
          ) : null}
          {project.saved ? (
            <div className="studio-more" ref={menuRef}>
              <button
                ref={menuButtonRef}
                type="button"
                aria-label="Project actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                ⋯
              </button>
              {menuOpen ? (
                <div className="studio-more-menu" role="menu" aria-label="Project actions">
                  <button
                    type="button"
                    role="menuitem"
                    className="studio-delete-project"
                    disabled={Boolean(busy)}
                    title={busy ? BUSY_REASON : undefined}
                    onClick={() => {
                      setMenuOpen(false);
                      onRequestDelete();
                    }}
                    data-testid="delete-project-button"
                  >
                    Delete project…
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>
      <div className="studio-busy" role="status" data-testid="studio-busy">
        {busy ? (
          <>
            <span>{stage || "Working…"}</span> <span>{BUSY_REASON}</span>
          </>
        ) : null}
      </div>

      <div className="workspace">
        <div className="stage">
          <Preview3D art={art} formatId={entry.formatId} />
          <div className="assigned-strip" data-testid="assigned-strip">
            {PREVIEW_PIECES.map((piece) => (
              <span
                key={piece.id}
                className="assigned-chip"
                data-filled={art.some((item) => item.slotId === piece.id && Boolean(item.imageRef)) ? "true" : "false"}
              >
                <i />
                {piece.label}
              </span>
            ))}
          </div>
        </div>
        <div className="rail">
          <ResearchPanel
            onApply={applyResearch}
            onCover={replaceCover}
            initialArtist={projectArtist}
            initialAlbum={entry.album}
            autoLookupKey={!research && !project.sourcePath ? `${projectArtist} :: ${entry.album}` : undefined}
          />
          {lyricsStatus ? <p className="burn-note lyrics-status" role="status" data-testid="lyrics-status">{lyricsStatus}</p> : null}
          <AudioPanel projectId={project.id} tracks={tracks} onTracksChange={changeTracks} />
          <div className="audio-source-actions" role="group" aria-label="Get album audio">
            <button
              type="button"
              onClick={() => void findAlbumAudio()}
              disabled={Boolean(busy) || autoSearching || !canSearch}
              aria-describedby={!canSearch ? "find-audio-reason" : undefined}
              data-testid="find-album-burn-button"
            >
              {busy === "searching" || autoSearching ? "Finding album…" : "Find album audio"}
            </button>
            {!canSearch ? <span className="burn-note" id="find-audio-reason">Add artist and album to search</span> : null}
            <details open={playlistOpen} onToggle={(event) => setPlaylistOpen(event.currentTarget.open)}>
              <summary>Use a YouTube playlist link instead</summary>
              <label>
                <span>YouTube playlist link</span>
                <input
                  type="url"
                  value={playlistUrl}
                  onChange={(event) => setPlaylistUrl(event.target.value)}
                  placeholder="https://www.youtube.com/playlist?list=…"
                  data-testid="playlist-url"
                />
              </label>
              <button
                type="button"
                onClick={() => void downloadPlaylist()}
                disabled={Boolean(busy) || autoSearching || playlistUrl.trim().length === 0}
                aria-describedby={playlistUrl.trim().length === 0 ? "playlist-reason" : undefined}
                data-testid="playlist-burn-button"
              >
                {busy === "downloading" ? "Downloading…" : "Download playlist"}
              </button>
              {playlistUrl.trim().length === 0 ? <span className="burn-note" id="playlist-reason">Paste a YouTube playlist link</span> : null}
            </details>
            {burnMessage("audio")}
          </div>
          <SlotEditor
            art={art}
            onArtChange={(updates) => setArt((current) => mergeSlotArt(current, updates))}
            initialSelected={entry.formatId}
            researchedCover={
              research?.cover ? { imageRef: research.cover.imagePath, previewRef: research.cover.previewUrl } : undefined
            }
          />
          <BookletManager
            pages={bookletPages}
            onPagesChange={changeBookletPages}
            onExport={exportBookletPdf}
            validationError={bookletLayout.error}
            recommendedPages={bookletLayout.recommendedPages}
            preview={
              bookletLayout.composed ? (
                <>
                  <BookletModelPreview
                    composed={bookletLayout.composed}
                    coverPreviewUrl={bookletCoverPreview ?? research?.theme?.previewUrl}
                  />
                  <BookletPreview
                    composed={bookletLayout.composed}
                    coverPreviewUrl={bookletCoverPreview ?? research?.theme?.previewUrl}
                    palette={research?.cover?.palette ?? research?.theme?.palette}
                  />
                </>
              ) : undefined
            }
          />
          <section className="panel print-burn" aria-labelledby="print-burn-heading" data-testid="print-burn">
            <div className="panel-head">
              <div>
                <h2 id="print-burn-heading">Print + burn</h2>
                <p>Export the print files, then burn the disc.</p>
              </div>
            </div>
            <ul className="print-checklist">
              {CHECKLIST_PIECES.map((piece) => {
                const item = art.find((candidate) => candidate.slotId === piece.id && (candidate.imageRef || candidate.textContent));
                const done = Boolean(item);
                return (
                  <li key={piece.id} data-done={done ? "true" : "false"}>
                    {piece.label}: {done ? `✓ ${item?.imageRef ? fileName(item.imageRef) : "text"}` : "needs art"}
                  </li>
                );
              })}
              <li data-done={lyricsCount > 0 ? "true" : "false"}>
                Booklet: {bookletPages} pages · lyrics for {lyricsCount} tracks · export it in Booklet
              </li>
              <li data-done={printFiles.length > 0 ? "true" : "false"} title={exports.join("\n") || undefined}>
                Print files: {printFiles.length > 0 ? `${printFiles.join(", ")}${exportTime ? ` · ${exportTime}` : ""}` : "none yet"}
              </li>
            </ul>
            <button
              type="button"
              className="primary"
              onClick={() => void go()}
              disabled={Boolean(busy)}
              title={busy && busy !== "exporting" ? BUSY_REASON : undefined}
              data-testid="go-button"
            >
              {busy === "exporting" ? "Exporting…" : "Export print files + test burn"}
            </button>
            <p className="burn-note" data-testid="burn-progress">
              Test burn: {testBurn === null ? "not run yet" : `${testBurn}%`}
            </p>
            {goError ? (
              <div className="go-error-block">
                <p className="error" role="alert" data-testid="go-error">{goError.message}</p>
                {goError.details ? (
                  <details className="error-details">
                    <summary>Technical details</summary>
                    <pre>{goError.details}</pre>
                  </details>
                ) : null}
              </div>
            ) : null}
            {lastBurnedAt ? <p className="burn-note" data-testid="last-burned">Last burned {formatDay(lastBurnedAt)}</p> : null}
            <div className="burn-drive">
              <button type="button" onClick={() => void detectDrives()} data-testid="detect-burners">
                Detect drives
              </button>
              {burners.length === 0 ? (
                <span className="burn-note" id="burner-status" data-testid="burner-status">
                  No CD writer found. Plug one in with a blank CD-R, then click Detect drives.
                </span>
              ) : (
                <label>
                  <span>CD writer</span>
                  <select
                    value={selectedDrive}
                    onChange={(event) => setSelectedDrive(event.target.value)}
                    data-testid="burner-select"
                  >
                    {burners.map((drive) => (
                      <option key={drive.id} value={drive.id}>
                        {drive.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <button
              type="button"
              className="primary"
              onClick={() => void burnDisc()}
              disabled={Boolean(busy) || tracks.length === 0 || burners.length === 0}
              aria-describedby={burners.length === 0 ? "burner-status" : burnDisabledReason ? "burn-reason" : undefined}
              data-testid="burn-cd-button"
            >
              {busy === "burning" ? "Burning…" : lastBurnedAt ? "Burn CD again" : "Burn CD"}
            </button>
            {burnDisabledReason ? <span className="burn-note" id="burn-reason">{burnDisabledReason}</span> : null}
            {burnMessage("burn")}
            <p className="burn-note">
              Writing a disc can take 7 to 20 minutes. MXTP writes album, artist and track names as CD-Text; your player must support CD-Text to show them.
            </p>
          </section>
        </div>
      </div>

      <details className="status-band">
        <summary>Project details</summary>
        <div data-testid="insert-coverage">Insert types: {specs.map((spec) => spec.id).join(", ")}</div>
        <div data-testid="research-applied">Research: {researchApplied.join(" | ") || "none"}</div>
        <div data-testid="composed-inserts">Composed: {composedSummary}</div>
        <div data-testid="export-list">Exports: {exports.join(" | ") || "none"}</div>
      </details>

      {leaveDialogOpen ? (
        <div className="project-delete-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setLeaveDialogOpen(false);
        }}>
          <section
            className="project-delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="leave-draft-title"
            aria-describedby="leave-draft-description"
          >
            <header>
              <h2 id="leave-draft-title">Save this CD as a project?</h2>
            </header>
            <p id="leave-draft-description">
              An unsaved draft is not listed in Projects and is gone when MXTP MKR closes.
            </p>
            <div className="project-delete-actions">
              <button type="button" className="primary" autoFocus onClick={() => void saveAndLeave()}>Save as project</button>
              <button type="button" onClick={() => {
                setLeaveDialogOpen(false);
                onDiscard();
              }}>Discard</button>
              <button type="button" onClick={() => setLeaveDialogOpen(false)}>Cancel</button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

/** Load every project; a damaged one is named in the error instead of hiding the rest. */
async function loadProjectsKeepingGoodOnes(): Promise<{ saved: CdProject[]; error: string }> {
  const raw = await invokeCommand<Array<Partial<CdProject> & Pick<CdProject, "id" | "entry">>>("load_cd_projects");
  const saved: CdProject[] = [];
  const damaged: string[] = [];
  for (const item of raw) {
    try {
      saved.push(normalizeCdProject(item));
    } catch {
      damaged.push(`"${typeof item?.id === "string" ? item.id : "unknown"}" is damaged`);
    }
  }
  return { saved: sortCdProjects(saved), error: damaged.join(", ") };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLibraryNotFound(error: unknown): boolean {
  return /not found|unsupported on this OS|HOME is unavailable/i.test(errorText(error));
}

/** Two projects are the same when only updatedAt differs (key order does not matter). */
function sameProject(left: CdProject, right: CdProject): boolean {
  return stableJson({ ...left, updatedAt: "" }) === stableJson({ ...right, updatedAt: "" });
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : item
  );
}

/** project.tracks is the retained audio pool: it keeps everything and gains new downloads. */
function retainTracks(pool: Track[], playable: Track[]): Track[] {
  const known = new Set(pool.map((track) => track.id));
  const added = playable.filter((track) => !known.has(track.id));
  return added.length > 0 ? [...pool, ...added] : pool;
}

function overCapacityMessage(capacity: CapacityResult): string {
  return `Over by ${formatDuration(capacity.totalSec - capacity.limitSec)}. Remove tracks to fit an 80-minute CD.`;
}

/** The first sentence of a backend error, for the visible line; the full text goes in Technical details. */
function shortError(error: string): string {
  const first = /^(.*?[.!?])(\s|$)/.exec(error)?.[1] ?? error;
  return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

/** YouTube auto-generated channels are named "<Artist> - Topic". */
function channelName(name: string): string {
  return name.replace(/\s+-\s+Topic$/i, "");
}

function exportTimeFromPath(path: string | undefined): string {
  const match = /(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})[\\/][^\\/]+$/.exec(path ?? "");
  if (!match) return "";
  const [, year, month, day, hour, minute] = match;
  return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function formatDay(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString([], { dateStyle: "medium" });
}

function summarizeComposedArt(art: SlotArt[]): string {
  const front = art.find((item) => item.slotId === "front" && item.imageRef);
  const tray = art.find((item) => item.slotId === "tray" && item.textContent);
  const booklet = art.find((item) => item.slotId.startsWith("saddle") && item.textContent);
  const summary = [];
  if (front?.imageRef) {
    summary.push(`front ${fileName(front.imageRef)}`);
  }
  if (tray?.textContent) {
    summary.push(`tray ${tray.textContent.lines.length} tracks`);
  }
  if (booklet?.textContent) {
    summary.push(`${booklet.slotId} ${booklet.textContent.lines.length} lyric lines`);
  }
  return summary.join(" | ") || "none";
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function inferArtistFromTracks(tracks: Track[]): string {
  const counts = new Map<string, { label: string; count: number }>();
  for (const track of tracks) {
    const match = /^(.+?)\s+-\s+.+$/.exec(track.title.trim());
    if (!match) continue;
    const label = match[1].trim();
    const key = label.toLowerCase();
    const current = counts.get(key);
    counts.set(key, { label, count: (current?.count ?? 0) + 1 });
  }
  return [...counts.values()].sort((left, right) => right.count - left.count)[0]?.label ?? "";
}

function lyricLookupTitle(artist: string, title: string): string {
  const escapedArtist = artist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return title
    .replace(new RegExp(`^${escapedArtist}\\s+-\\s+`, "i"), "")
    .replace(/\s*\((?:official\s+)?(?:music\s+)?video\)\s*$/i, "")
    .trim();
}

function recommendedPagesFromError(message: string): number | undefined {
  const match = /Choose (8|12|16|20|24) pages\./.exec(message);
  return match ? Number(match[1]) : undefined;
}

function tracksWithMetadata(tracks: Track[], artist: string, album: string): Track[] {
  return tracks.map((track) => ({
    ...track,
    artist: track.artist?.trim() || artist.trim() || "Unknown Artist",
    album: track.album?.trim() || album.trim() || "MXTP Mix"
  }));
}
