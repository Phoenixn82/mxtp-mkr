import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { capacityCheck, formatDuration, type Track } from "../audio/audio";
import { usePlaybackSource } from "../audio/playbackSource";
import {
  burnReal,
  confirmRealBurn,
  detectBurners,
  downloadPlaylistBest,
  findYouTubeAlbumPlaylist,
  findYouTubeTrack,
  type DriveInfo,
  type PlaylistImport,
  type YouTubeAlbumMatch
} from "../app/orchestration";
import { resolveArtSrc } from "../art/editor";
import {
  createCdProject,
  emptyCuratorState,
  projectCover,
  projectFromBurnQueue,
  savedProjects,
  type CdBurnItem,
  type CdProject,
  type CuratorMemory,
  type CuratorProposal,
  type CuratorState,
  type ProjectKind
} from "../project/catalog";
import {
  albumKey,
  albumsFromLibrary,
  downloadedTracksForAlbum,
  isAppleLibraryTrack,
  readyTracksForAlbum,
  type AlbumSort,
  type AppleMusicAlbum,
  type AppleMusicLibraryData,
  type AppleMusicTrack,
  type MusicSource,
  type MusicSourceSummary
} from "./appleMusic";
import { SOURCE_LABELS, type ImportedMusicSource, type ImportTextFile } from "./multiLibrary";
import { choicesToQueue, curateMix } from "../curator/curator";
import { CuratorChat } from "../curator/CuratorChat";
import { HELP_TARGETS, HelpCoach, matchHelpIntent, type CoachStep, type HelpIntentMatch, type HelpView } from "../help";
import { ThemeToggle } from "../theme/ThemeToggle";
import { invokeCommand } from "../tauriClient";

interface AppleMusicLibraryProps {
  library: AppleMusicLibraryData;
  projects: CdProject[];
  projectsLoading: boolean;
  onCreateCustom: () => void;
  onOpenStudio: (album: AppleMusicAlbum) => void;
  onPreparedAlbum: (album: AppleMusicAlbum, playlist: PlaylistImport) => void;
  onUpdateProject: (project: CdProject) => void;
  onSaveProject: (project: CdProject) => boolean | void | Promise<boolean | void>;
  onDeleteProject: (project: CdProject) => void;
  enabledSources?: Set<MusicSource>;
  onToggleSource?: (source: MusicSource) => void;
  onRefreshApple?: (path?: string) => Promise<AppleMusicLibraryData>;
  onImportSource?: (source: ImportedMusicSource["source"], files: ImportTextFile[]) => Promise<ImportedMusicSource>;
  /** Open this saved project (album layout + tracklist) once per new id. */
  initialProjectId?: string;
  /** Open the cover + booklet studio for a saved project. */
  onOpenProjectStudio?: (project: CdProject) => void;
  /** App-level failure (for example a failed autosave) shown at the top. */
  appError?: string;
  /** Leaves project mode whenever this number changes. */
  exitProjectSignal?: number;
}

type MainView = "library" | "projects" | "sources" | "curator";
type ProjectFilter = "all" | ProjectKind;
type ProjectSort = "edited" | "name" | "burned";
type AlbumScope = "liked" | "full";
type ProjectAlbumView = AppleMusicAlbum & { fallbackArtworkPath?: string; fixedTracks?: boolean };
type SourceKey = MusicSource | "files";
interface SourceNotice { text: string; error?: boolean; detail?: string }
interface ConfirmState { title: string; body: string; proceed: () => void }
interface UndoState { items: CdBurnItem[]; name: string; project?: CdProject }
interface PrepareFailure { id: string; title: string; reason: string; unmatched: boolean }
interface PrepareOptions { addToQueue?: boolean; drive?: DriveInfo; project?: CdProject }

const UNSAVED_KEY = "mxtp.unsavedBurnList";
const CURATOR_MEMORY_KEY = "mxtp.curatorMemory";
const LOCAL_FILES_KEY = "local::audio-files";
const UNDO_MS = 15_000;
const RESYNC_GRACE_MS = 15_000;
const MENU_WIDTH = 252;
const VISUALLY_HIDDEN: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0
};

export function AppleMusicLibrary({
  library,
  projects,
  projectsLoading,
  onCreateCustom,
  onOpenStudio,
  onPreparedAlbum,
  onUpdateProject,
  onSaveProject,
  onDeleteProject,
  enabledSources = new Set(["apple"]),
  onToggleSource = () => undefined,
  onRefreshApple = async () => library,
  onImportSource = async () => { throw new Error("Import is unavailable in this test environment."); },
  initialProjectId,
  onOpenProjectStudio,
  appError,
  exitProjectSignal
}: AppleMusicLibraryProps) {
  const [view, setView] = useState<MainView>(() => !initialProjectId && library.summary.trackCount === 0 ? "sources" : "library");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<AlbumSort>("recent");
  const [visibleCount, setVisibleCount] = useState(60);
  const [activeAlbumKey, setActiveAlbumKey] = useState<string>();
  const [activeProjectAlbum, setActiveProjectAlbum] = useState<ProjectAlbumView>();
  const [activeProjectId, setActiveProjectIdState] = useState<string>();
  const [albumScope, setAlbumScope] = useState<AlbumScope>("liked");
  const [albumDragScope, setAlbumDragScope] = useState<AlbumScope>(() => {
    try { return localStorage.getItem("mxtp.albumDragScope") === "full" ? "full" : "liked"; } catch { return "liked"; }
  });
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(new Set());
  const [queue, setQueueState] = useState<CdBurnItem[]>(() => initialProjectId ? [] : readUnsavedList().items);
  const [projectName, setProjectNameState] = useState(() => initialProjectId ? "" : readUnsavedList().name);
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>("all");
  const [listeningId, setListeningId] = useState<string>();
  const [playbackError, setPlaybackError] = useState("");
  const [draggedId, setDraggedId] = useState<string>();
  const [dragOverId, setDragOverId] = useState<string>();
  const [optimisticProjects, setOptimisticProjects] = useState<CdProject[]>([]);
  const [downloadedOverrides, setDownloadedOverrides] = useState<Record<string, CdBurnItem[]>>({});
  const [working, setWorkingState] = useState(false);
  const [workStartedAt, setWorkStartedAt] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const [message, setMessageState] = useState("");
  const [albumNotice, setAlbumNotice] = useState(false);
  const [sourceNotices, setSourceNotices] = useState<Partial<Record<SourceKey, SourceNotice>>>({});
  const [sourceBusy, setSourceBusy] = useState<SourceKey>();
  const [curatorSession, setCuratorSession] = useState<CuratorState>(() => ({ ...emptyCuratorState(), memory: readCuratorMemory() }));
  const [fullTracklists, setFullTracklists] = useState<Record<string, AppleMusicTrack[]>>({});
  const [fullTracklistErrors, setFullTracklistErrors] = useState<Record<string, string>>({});
  const [fullTracklistLoading, setFullTracklistLoading] = useState<string>();
  const [coachSteps, setCoachSteps] = useState<CoachStep[]>([]);
  const [showGettingStarted, setShowGettingStarted] = useState(() => {
    try { return localStorage.getItem("mxtp.gettingStartedDismissed") !== "1"; } catch { return true; }
  });
  const [confirm, setConfirm] = useState<ConfirmState>();
  const [undo, setUndo] = useState<UndoState>();
  const [failures, setFailures] = useState<PrepareFailure[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [moveAnnouncement, setMoveAnnouncement] = useState("");
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [selectedDriveId, setSelectedDriveId] = useState<string>();
  const [optionsOpen, setOptionsOpen] = useState(() => matches("(min-width: 641px)", true));
  const [narrow, setNarrow] = useState(() => matches("(max-width: 900px)", false));
  const [queueExpanded, setQueueExpanded] = useState(false);
  const dismissGettingStarted = () => {
    setShowGettingStarted(false);
    try { localStorage.setItem("mxtp.gettingStartedDismissed", "1"); } catch { /* storage unavailable: fine */ }
  };
  const audioRef = useRef<HTMLAudioElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const draggedIdRef = useRef<string>();
  const queueRef = useRef(queue);
  const projectNameRef = useRef(projectName);
  const activeProjectIdRef = useRef<string>();
  const workingRef = useRef(false);
  const pendingFocusIdRef = useRef<string>();
  const focusNameRef = useRef(false);
  // Queue signatures this component published, with when; an external project
  // change carrying one of them is our own save landing late, not an edit.
  const lastPublishedRef = useRef(new Map<string, number>());
  const seenProjectStampRef = useRef<string>();
  const openedInitialRef = useRef<string>();
  // Bumped whenever the burn list becomes a different list (another project,
  // a new mix, a discard). A long download that started on the old list must
  // not land in the new one.
  const queueEpochRef = useRef(0);
  // An unsaved list stored from last time, kept aside while a requested project
  // is open; Exit project brings it back instead of the mirror deleting it.
  const deferredUnsavedRef = useRef(initialProjectId ? readUnsavedList() : undefined);
  const exitSignalRef = useRef(exitProjectSignal);
  const fullTracklistsRef = useRef(fullTracklists);
  fullTracklistsRef.current = fullTracklists;
  const fullTracklistErrorsRef = useRef(fullTracklistErrors);
  fullTracklistErrorsRef.current = fullTracklistErrors;

  const albums = useMemo(() => albumsFromLibrary(library, sort), [library, sort]);
  const albumByKey = useMemo(() => new Map(albums.map((album) => [album.key, album])), [albums]);
  const effectiveProjects = useMemo(() => {
    const byId = new Map(projects.map((project) => [project.id, project]));
    optimisticProjects.forEach((project) => byId.set(project.id, project));
    return [...byId.values()];
  }, [optimisticProjects, projects]);
  const effectiveProjectsRef = useRef(effectiveProjects);
  effectiveProjectsRef.current = effectiveProjects;
  const activeCdProject = effectiveProjects.find((project) => project.id === activeProjectId);
  const activeAlbum = useMemo<ProjectAlbumView | undefined>(() => {
    if (activeProjectAlbum?.fixedTracks && activeCdProject) {
      return { ...albumFromProject(activeCdProject), fixedTracks: true, fallbackArtworkPath: activeProjectAlbum.fallbackArtworkPath };
    }
    return activeProjectAlbum ?? (activeAlbumKey ? albumByKey.get(activeAlbumKey) : undefined);
  }, [activeAlbumKey, activeCdProject, activeProjectAlbum, albumByKey]);
  const visibleProjects = useMemo(() => savedProjects(effectiveProjects), [effectiveProjects]);
  const activeDownloaded = useMemo(() => {
    if (!activeAlbum) return [];
    if (activeAlbum.fixedTracks && activeCdProject) return queueFromProject(activeCdProject).filter((item) => item.ready?.path);
    return downloadedOverrides[activeAlbum.key] ?? downloadedTracksForAlbum(effectiveProjects, activeAlbum);
  }, [activeAlbum, activeCdProject, downloadedOverrides, effectiveProjects]);
  const listeningTrack = queue.find((item) => item.id === listeningId)?.ready;
  const playback = usePlaybackSource(listeningTrack);
  const filteredAlbums = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return albums;
    return albums.filter((album) => `${album.artist} ${album.title} ${album.genre}`.toLocaleLowerCase().includes(needle));
  }, [albums, query]);

  function setQueueNow(next: CdBurnItem[]) {
    queueRef.current = next;
    setQueueState(next);
  }

  function setProjectName(name: string) {
    projectNameRef.current = name;
    setProjectNameState(name);
  }

  function newListEpoch() {
    queueEpochRef.current += 1;
  }

  /** Which list a long job started on; see listChanged. */
  function listToken() {
    return { epoch: queueEpochRef.current, projectId: activeProjectIdRef.current };
  }

  /** True when the burn list is now a different list than the job's (reopening the same project is not). */
  function listChanged(token: { epoch: number; projectId?: string }) {
    return token.epoch !== queueEpochRef.current && !(token.projectId && token.projectId === activeProjectIdRef.current);
  }

  function setActiveProjectId(id?: string) {
    activeProjectIdRef.current = id;
    setActiveProjectIdState(id);
  }

  function setWorking(value: boolean) {
    workingRef.current = value;
    setWorkingState(value);
    if (value) {
      setWorkStartedAt(Date.now());
      setClock(Date.now());
    }
  }

  /** The burn-list status line. */
  function say(text: string) {
    setMessageState(text);
    setAlbumNotice(false);
  }

  /** A confirmation that belongs on the open album page as well. */
  function sayOnAlbum(text: string) {
    setMessageState(text);
    setAlbumNotice(true);
  }

  function currentProject(): CdProject | undefined {
    return effectiveProjectsRef.current.find((project) => project.id === activeProjectIdRef.current);
  }

  useEffect(() => setVisibleCount(60), [query, sort]);
  useEffect(() => {
    setOptimisticProjects((current) => current.filter((local) => {
      const parent = projects.find((project) => project.id === local.id);
      return !parent || parent.updatedAt < local.updatedAt || (local.saved && !parent.saved);
    }));
  }, [projects]);
  // Leave project mode when the open project goes away (deleted), but not while
  // a just-created project is still on its way into the list.
  const activeSeenRef = useRef<string>();
  useEffect(() => {
    if (!activeProjectId) return;
    if (effectiveProjects.some((project) => project.id === activeProjectId)) {
      activeSeenRef.current = activeProjectId;
      return;
    }
    if (activeSeenRef.current !== activeProjectId) return;
    // Hand back an unsaved list kept aside, as exitProjectMode does.
    const deferred = deferredUnsavedRef.current;
    deferredUnsavedRef.current = undefined;
    newListEpoch();
    setActiveProjectId(undefined);
    setActiveProjectAlbum(undefined);
    setProjectName(deferred?.name ?? "");
    setQueueNow(deferred?.items ?? []);
    setListeningId(undefined);
  }, [activeProjectId, effectiveProjects]);
  useEffect(() => {
    if (!listeningTrack || !playback.src) return;
    const result = audioRef.current?.play();
    if (result && "catch" in result) {
      void result.catch(() => setPlaybackError(`Could not play ${listeningTrack.title}.`));
    }
  }, [listeningTrack, playback.src]);
  useEffect(() => {
    if (listeningTrack && playback.error) {
      setPlaybackError(`Could not load ${listeningTrack.title}: ${playback.error}`);
    }
  }, [listeningTrack, playback.error]);

  // Keep-alive: while the studio shows, this component stays mounted. When the
  // open project changes from elsewhere (studio reorder or import), take its
  // burn list; ignore our own publishes landing late.
  useEffect(() => {
    if (!activeCdProject) {
      seenProjectStampRef.current = undefined;
      return;
    }
    const stamp = `${activeCdProject.id}\n${activeCdProject.updatedAt}`;
    const previous = seenProjectStampRef.current;
    seenProjectStampRef.current = stamp;
    if (!previous || previous === stamp || !previous.startsWith(`${activeCdProject.id}\n`)) return;
    const incoming = queueFromProject(activeCdProject);
    const signature = queueSignature(incoming);
    if (signature === queueSignature(queueRef.current)) return;
    const publishedAt = lastPublishedRef.current.get(signature);
    if (publishedAt !== undefined && Date.now() - publishedAt < RESYNC_GRACE_MS) return;
    setQueueNow(incoming);
    if (document.activeElement !== nameInputRef.current) setProjectName(activeCdProject.name);
  }, [activeCdProject]);

  useEffect(() => {
    if (!initialProjectId || openedInitialRef.current === initialProjectId) return;
    const project = effectiveProjects.find((candidate) => candidate.id === initialProjectId);
    if (!project) return;
    openedInitialRef.current = initialProjectId;
    requestLeave(() => openProject(project));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialProjectId, effectiveProjects]);

  useEffect(() => {
    if (exitProjectSignal === exitSignalRef.current) return;
    exitSignalRef.current = exitProjectSignal;
    // No project open: there is nothing to exit, and the unsaved list must stay.
    if (activeProjectIdRef.current) exitProjectMode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exitProjectSignal]);

  // An unsaved burn list survives a relaunch. A project's list lives in the project.
  useEffect(() => {
    if (activeProjectId) return;
    if (initialProjectId && openedInitialRef.current !== initialProjectId) return;
    if (deferredUnsavedRef.current?.items.length) return;
    try {
      if (queue.length === 0) localStorage.removeItem(UNSAVED_KEY);
      else localStorage.setItem(UNSAVED_KEY, JSON.stringify({ name: projectName, items: queue }));
    } catch { /* storage unavailable: the list still works for this session */ }
  }, [activeProjectId, initialProjectId, projectName, queue]);

  useEffect(() => {
    try { localStorage.setItem(CURATOR_MEMORY_KEY, JSON.stringify(curatorSession.memory)); } catch { /* storage unavailable */ }
  }, [curatorSession.memory]);

  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(undefined), UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [undo]);

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [working]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const wide = window.matchMedia("(min-width: 641px)");
    const small = window.matchMedia("(max-width: 900px)");
    const sync = () => {
      setOptionsOpen(wide.matches);
      setNarrow(small.matches);
    };
    wide.addEventListener?.("change", sync);
    small.addEventListener?.("change", sync);
    return () => {
      wide.removeEventListener?.("change", sync);
      small.removeEventListener?.("change", sync);
    };
  }, []);

  useLayoutEffect(() => {
    const id = pendingFocusIdRef.current;
    if (!id) return;
    pendingFocusIdRef.current = undefined;
    const handle = [...document.querySelectorAll<HTMLElement>("[data-queue-handle]")].find((element) => element.dataset.queueHandle === id);
    handle?.focus();
  }, [queue]);

  useEffect(() => {
    if (!focusNameRef.current) return;
    focusNameRef.current = false;
    nameInputRef.current?.focus();
  });

  const queueDuration = queue.reduce((total, item) => total + item.durationSec, 0);
  const queueCapacity = capacityCheck(queue);
  const needAudio = queue.filter((item) => !item.ready).length;
  const currentCurator = activeCdProject?.curator ?? curatorSession;
  const activeFullTracklist = activeAlbum ? fullTracklists[activeAlbum.key] : undefined;
  const unsavedList = !activeCdProject && queue.length > 0;
  const unmatchedIds = new Map(failures.filter((failure) => failure.unmatched).map((failure) => [failure.id, failure.reason]));
  const capacityReason = queue.length === 0
    ? "Add songs to the burn list first."
    : queueCapacity.ok
      ? ""
      : `Over by ${formatDuration(queueCapacity.totalSec - queueCapacity.limitSec)}. Remove tracks to fit an 80-minute CD.`;
  const saveFailureReason = saveFailed || (activeCdProject && appError && /sav/i.test(appError))
    ? (appError ?? "").replace(/^Could not save this project:\s*/i, "") || "the project could not be written to disk"
    : "";

  useEffect(() => {
    if (!activeAlbum || albumScope !== "full" || activeAlbum.sourceCollection || activeAlbum.fixedTracks) return;
    if (fullTracklists[activeAlbum.key] || fullTracklistErrors[activeAlbum.key] !== undefined || fullTracklistLoading === activeAlbum.key) return;
    void loadVerifiedTracklist(activeAlbum);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAlbum, albumScope, fullTracklists, fullTracklistErrors, fullTracklistLoading]);

  function scrollToTop() {
    const reduce = matches("(prefers-reduced-motion: reduce)", false);
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  }

  /** Ask before a step that would throw away an unsaved burn list. */
  function requestLeave(proceed: () => void) {
    const count = queueRef.current.length;
    if (activeProjectIdRef.current || count === 0) {
      proceed();
      return;
    }
    setConfirm({
      title: "Save your burn list first?",
      body: `Your ${count}-track burn list isn't saved. Leaving will clear it.`,
      proceed
    });
  }

  function discardUnsavedList() {
    newListEpoch();
    deferredUnsavedRef.current = undefined;
    clearUnsavedStorage();
    setQueueNow([]);
    setProjectName("");
    setListeningId(undefined);
  }

  function openAlbum(album: AppleMusicAlbum) {
    setView("library");
    setAlbumScope(album.tracks.some(isAppleLibraryTrack) ? "liked" : "full");
    setSelectedTrackIds(new Set());
    setActiveProjectAlbum(undefined);
    setActiveAlbumKey(album.key);
    say("");
    scrollToTop();
  }

  function projectAlbumView(project: CdProject): ProjectAlbumView {
    const savedProjectAlbum = albumFromProject(project);
    if (project.kind === "custom") return { ...savedProjectAlbum, fixedTracks: true };
    const libraryAlbum = albumByKey.get(albumKey(project.entry.artist, project.entry.album))
      ?? albums.find((album) => downloadedTracksForAlbum([project], album).length > 0);
    if (!libraryAlbum) return savedProjectAlbum;
    return {
      ...libraryAlbum,
      artworkPath: savedProjectAlbum.artworkPath ?? libraryAlbum.artworkPath,
      fallbackArtworkPath: savedProjectAlbum.artworkPath && savedProjectAlbum.artworkPath !== libraryAlbum.artworkPath
        ? libraryAlbum.artworkPath
        : undefined
    };
  }

  function freshGlobalCurator() {
    setCuratorSession((current) => ({ ...emptyCuratorState(), memory: current.memory }));
  }

  function openProject(project: CdProject) {
    newListEpoch();
    setView("library");
    setAlbumScope("full");
    setSelectedTrackIds(new Set());
    setActiveAlbumKey(undefined);
    setActiveProjectId(project.id);
    freshGlobalCurator();
    setProjectName(project.name);
    setQueueNow(queueFromProject(project));
    setListeningId(undefined);
    setFailures([]);
    setUndo(undefined);
    setSaveFailed(false);
    setActiveProjectAlbum(projectAlbumView(project));
    say("");
    scrollToTop();
  }

  function leaveToNewMix(text: string) {
    newListEpoch();
    setActiveProjectId(undefined);
    setActiveProjectAlbum(undefined);
    setActiveAlbumKey(undefined);
    setProjectName("");
    setQueueNow([]);
    setListeningId(undefined);
    setSelectedTrackIds(new Set());
    freshGlobalCurator();
    setAlbumScope("liked");
    setFailures([]);
    setUndo(undefined);
    setSaveFailed(false);
    say(text);
  }

  function exitProjectMode() {
    const name = currentProject()?.name;
    const deferred = deferredUnsavedRef.current;
    deferredUnsavedRef.current = undefined;
    if (deferred?.items.length) {
      leaveToNewMix(`${name ? `Closed ${name}. ` : ""}Your unsaved ${deferred.items.length}-track burn list is back.`);
      setQueueNow(deferred.items);
      setProjectName(deferred.name);
      return;
    }
    leaveToNewMix(name
      ? `Closed ${name}. The burn list is empty and ready for a new mix.`
      : "The burn list is empty and ready for a new mix.");
  }

  function startNewMix() {
    const begin = (text: string) => {
      deferredUnsavedRef.current = undefined;
      leaveToNewMix(text);
      clearUnsavedStorage();
      setView("library");
      focusNameRef.current = true;
    };
    if (activeProjectIdRef.current) {
      // Exit may bring back an unsaved list kept aside; that one still gets asked about.
      exitProjectMode();
      if (queueRef.current.length === 0) {
        setView("library");
        focusNameRef.current = true;
        return;
      }
    }
    const count = queueRef.current.length;
    if (count === 0) {
      begin("New mix. Add songs to the burn list.");
      return;
    }
    setConfirm({
      title: "Start a new mix?",
      body: `The burn list has ${plural(count, "unsaved track")}.`,
      proceed: () => begin("New mix. Add songs to the burn list.")
    });
  }

  function navigateHelpView(target: HelpView) {
    if (target === "library") setView("library");
    if (target === "sources") setView("sources");
    if (target === "projects") setView("projects");
    if (target === "curator") setView("curator");
  }

  function showHelp(match: HelpIntentMatch) {
    navigateHelpView(match.target.view);
    const needsAlbum = match.intent === "choose-album-scope" || match.intent === "download-audio";
    const missingProject = match.intent === "exit-project" && !activeCdProject;
    const target = needsAlbum && !activeAlbum
      ? HELP_TARGETS.albumSearch
      : missingProject
        ? HELP_TARGETS.projects
        : match.target.selector;
    const text = needsAlbum && !activeAlbum
      ? `${match.instructions} Start here by finding and opening the album you want.`
      : missingProject
        ? "No project is open right now. Open Projects to choose one; when it is open, Exit project appears at the top of the right-hand burn list."
        : match.instructions;
    // On a narrow window the burn list is collapsed: open it so the guide can point inside it.
    if (narrow && document.getElementById("burn-list")?.querySelector(target)) setQueueExpanded(true);
    setCoachSteps([{ id: match.intent, title: match.title, text, target }]);
  }

  function handleHelpPrompt(prompt: string): boolean {
    const match = matchHelpIntent(prompt);
    if (!match) return false;
    if (match.intent === "use-ai-curator" && !/\b(how|where|what|help|guide|show|explain|use)\b/i.test(prompt)) {
      return false;
    }
    showHelp(match);
    return true;
  }

  function scopeTracks(album: AppleMusicAlbum, scope: AlbumScope, downloaded = activeDownloaded) {
    return tracksForAlbumScope(album, downloaded, scope, fullTracklistsRef.current[album.key]);
  }

  function selectedItems(album: AppleMusicAlbum): CdBurnItem[] {
    const ready = readyForAlbum(effectiveProjects, album, activeDownloaded, activeFullTracklist);
    return scopeTracks(album, albumScope)
      .filter((track) => selectedTrackIds.has(track.id))
      .map((track) => queueItem(album, track, ready.get(track.id)));
  }

  function rememberProject(project: CdProject) {
    effectiveProjectsRef.current = [project, ...effectiveProjectsRef.current.filter((candidate) => candidate.id !== project.id)];
    setOptimisticProjects((current) => [project, ...current.filter((candidate) => candidate.id !== project.id)]);
  }

  function markPublished(project: CdProject) {
    const now = Date.now();
    for (const [signature, at] of lastPublishedRef.current) {
      if (now - at > RESYNC_GRACE_MS) lastPublishedRef.current.delete(signature);
    }
    lastPublishedRef.current.set(queueSignature(project.burnQueue), now);
  }

  function updateRememberedProject(project: CdProject) {
    markPublished(project);
    rememberProject(project);
    onUpdateProject(project);
  }

  async function saveRememberedProject(project: CdProject): Promise<boolean> {
    markPublished(project);
    setSaving(true);
    try {
      const saved = await onSaveProject(project);
      if (saved === false) {
        setSaveFailed(true);
        return false;
      }
    } finally {
      setSaving(false);
    }
    setSaveFailed(false);
    rememberProject(project);
    return true;
  }

  function deleteRememberedProject(project: CdProject) {
    setOptimisticProjects((current) => current.filter((candidate) => candidate.id !== project.id));
    onDeleteProject(project);
  }

  function publishProjectQueue(next: CdBurnItem[]) {
    const active = currentProject();
    if (!active?.saved) return;
    updateRememberedProject(projectFromQueuePreservingAudio(next, projectNameRef.current || active.name, active));
  }

  /** Every burn-list edit goes through here: it reads the latest list, never a stale render. */
  function updateQueue(change: (current: CdBurnItem[]) => CdBurnItem[]): CdBurnItem[] {
    const next = change(queueRef.current);
    setQueueNow(next);
    publishProjectQueue(next);
    setUndo(undefined);
    return next;
  }

  function replaceQueue(next: CdBurnItem[]) {
    return updateQueue(() => next);
  }

  function mergeIntoQueue(items: CdBurnItem[]) {
    return updateQueue((current) => mergeQueueItems(current, items));
  }

  function removeQueueItem(id: string) {
    updateQueue((current) => current.filter((track) => track.id !== id));
    setFailures((current) => current.filter((failure) => failure.id !== id));
  }

  function clearBurnList() {
    const items = queueRef.current;
    if (items.length === 0 || workingRef.current) return;
    const active = currentProject();
    const name = active?.name || projectNameRef.current.trim();
    // The emptied project lets go of its download folder so the cache recovers
    // it; until then the cleared audio still counts as ready for its albums.
    const known = effectiveProjectsRef.current;
    const readyByAlbum = new Map<string, CdBurnItem[]>();
    for (const item of items) {
      if (item.ready?.path) readyByAlbum.set(item.albumKey, [...(readyByAlbum.get(item.albumKey) ?? []), item]);
    }
    if (readyByAlbum.size > 0) {
      setDownloadedOverrides((current) => {
        const next = { ...current };
        for (const [key, cleared] of readyByAlbum) {
          const album = albumByKey.get(key);
          next[key] = mergeAlbumItems(current[key] ?? (album ? downloadedTracksForAlbum(known, album) : []), cleared);
        }
        return next;
      });
    }
    replaceQueue([]);
    setListeningId(undefined);
    setFailures([]);
    if (!active) setProjectName("");
    say(`Cleared ${plural(items.length, "track")} from ${name || "the burn list"}.`);
    setUndo({ items, name: projectNameRef.current || name, project: active });
  }

  function undoClear() {
    if (!undo) return;
    const { items, name, project } = undo;
    const active = currentProject();
    // Take the download folder and audio back along with the order.
    if (project && active?.id === project.id) rememberProject({ ...active, sourcePath: project.sourcePath, tracks: project.tracks });
    replaceQueue(items);
    if (!activeProjectIdRef.current) setProjectName(name);
    say(`Restored ${plural(items.length, "track")}.`);
  }

  function suggestedName(items: CdBurnItem[]) {
    return items.length > 0 && items.every((item) => item.albumKey === items[0].albumKey)
      ? items[0].album
      : `Custom CD · ${new Date().toLocaleDateString()}`;
  }

  /** Save a list as a project. activate=false saves it without making it the open list. */
  async function saveQueue(items = queueRef.current, burnedAt?: string, existingProject?: CdProject, activate = true): Promise<CdProject | undefined> {
    if (items.length === 0) return undefined;
    const active = existingProject ?? currentProject();
    const typedName = activate ? projectNameRef.current.trim() : "";
    let project = projectFromQueuePreservingAudio(items, typedName || active?.name || suggestedName(items), active);
    const album = items.every((item) => item.albumKey === items[0].albumKey) ? albumByKey.get(items[0].albumKey) : undefined;
    if (album && !active) {
      project = {
        ...project,
        art: album.artworkPath
          ? [{ slotId: "front", imageRef: album.artworkPath, imageSource: "manual", transform: { x: 0, y: 0, scale: 1, rotation: 0 } }]
          : [],
        research: {
          album: {
            artist: album.artist,
            album: album.title,
            year: album.year ?? 0,
            label: "MXTP combined music library",
            tracks: album.tracks.map((track) => track.title),
            coverArtUrls: [],
            tags: album.genre ? [album.genre] : []
          },
          lyricsByTrack: []
        }
      };
    }
    const saved = {
      ...project,
      saved: true,
      burnProgress: burnedAt ? 100 : project.burnProgress,
      lastBurnedAt: burnedAt ?? project.lastBurnedAt
    };
    if (!(await saveRememberedProject(saved))) {
      say("The audio is still ready, but the project was not saved. Fix the storage error and try again.");
      return undefined;
    }
    if (!activate) return saved;
    if (!active) {
      deferredUnsavedRef.current = undefined;
      clearUnsavedStorage();
    }
    setActiveProjectId(saved.id);
    setProjectName(saved.name);
    if (!active && !burnedAt) say(`Saved ${saved.name} to Projects. Changes now save automatically.`);
    return saved;
  }

  async function retrySave() {
    const active = currentProject();
    if (!active) return;
    if (await saveRememberedProject({ ...active, updatedAt: new Date().toISOString() })) say(`Saved ${active.name}.`);
  }

  function commitProjectName() {
    const active = currentProject();
    if (!active?.saved) return;
    const name = projectNameRef.current.trim() || active.name;
    if (name !== projectNameRef.current) setProjectName(name);
    if (name === active.name) return;
    updateRememberedProject({ ...active, name, updatedAt: new Date().toISOString() });
  }

  async function openCoverStudio() {
    if (queueRef.current.length === 0) return;
    const project = currentProject() ?? await saveQueue();
    if (!project) return;
    if (onOpenProjectStudio) onOpenProjectStudio(project);
    else onOpenStudio(albumFromProject(project));
  }

  function moveQueueItem(sourceId: string, targetId: string) {
    if (workingRef.current) return;
    const current = queueRef.current;
    const from = current.findIndex((item) => item.id === sourceId);
    const to = current.findIndex((item) => item.id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...current];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    replaceQueue(next);
    setMoveAnnouncement(`Moved ${moved.title} to position ${to + 1} of ${next.length}`);
  }

  function nudgeQueueItem(id: string, offset: -1 | 1) {
    if (workingRef.current) return;
    const current = queueRef.current;
    const from = current.findIndex((item) => item.id === id);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= current.length) return;
    const next = [...current];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    pendingFocusIdRef.current = id;
    replaceQueue(next);
    setMoveAnnouncement(`Moved ${moved.title} to position ${to + 1} of ${next.length}`);
  }

  function finishDragging() {
    draggedIdRef.current = undefined;
    setDraggedId(undefined);
    setDragOverId(undefined);
  }

  function setDragScope(scope: AlbumScope) {
    setAlbumDragScope(scope);
    try { localStorage.setItem("mxtp.albumDragScope", scope); } catch { /* storage unavailable: the in-memory setting still works */ }
  }

  async function loadVerifiedTracklist(album: AppleMusicAlbum): Promise<AppleMusicTrack[]> {
    const cached = fullTracklistsRef.current[album.key];
    if (cached) return cached;
    if (fullTracklistErrorsRef.current[album.key] !== undefined) return album.tracks;
    setFullTracklistLoading(album.key);
    let reason = "no matching release was found";
    try {
      const match = await findYouTubeAlbumPlaylist(album.artist, album.title, album.tracks.map((track) => ({ title: track.title, durationSec: track.durationSec })));
      const verified = (match.tracks ?? []).map((track) => ({
        id: `${album.key}:verified:${track.position}`,
        title: cleanVerifiedTrackTitle(track.title, album.artist),
        artist: album.artist,
        album: album.title,
        albumArtist: album.artist,
        genre: album.genre,
        trackNumber: track.position,
        year: album.year,
        durationSec: track.durationSec,
        playCount: 0,
        likeStatus: 0,
        inAppleLibrary: false,
        artworkPath: album.artworkPath
      } satisfies AppleMusicTrack));
      if (verified.length > 0) {
        fullTracklistsRef.current = { ...fullTracklistsRef.current, [album.key]: verified };
        setFullTracklists((current) => ({ ...current, [album.key]: verified }));
        return verified;
      }
    } catch (error) {
      reason = errorText(error);
    } finally {
      setFullTracklistLoading((current) => current === album.key ? undefined : current);
    }
    // Remember the failure so the Full album view settles on the local
    // tracklist instead of retrying the lookup forever; Retry clears it.
    fullTracklistErrorsRef.current = { ...fullTracklistErrorsRef.current, [album.key]: reason };
    setFullTracklistErrors((current) => ({ ...current, [album.key]: reason }));
    return album.tracks;
  }

  function retryVerifiedTracklist(album: AppleMusicAlbum) {
    const next = { ...fullTracklistErrorsRef.current };
    delete next[album.key];
    fullTracklistErrorsRef.current = next;
    setFullTracklistErrors(next);
  }

  function queueAlbum(album: AppleMusicAlbum, tracks: AppleMusicTrack[], scope: AlbumScope, fromDrag: boolean): number {
    const downloaded = downloadedOverrides[album.key] ?? downloadedTracksForAlbum(effectiveProjectsRef.current, album);
    const verified = fullTracklistsRef.current[album.key];
    const ready = readyForAlbum(effectiveProjectsRef.current, album, downloaded, verified);
    const selected = tracksForAlbumScope(album, downloaded, scope, scope === "full" ? tracks : undefined)
      .map((track) => queueItem(album, track, ready.get(track.id)));
    if (selected.length === 0) {
      say(fromDrag
        ? "This album has no My Apple Music songs. Choose Full album in the Album drag setting to add the release."
        : "This album has no My Apple Music songs. Choose Full album to add the release.");
      return 0;
    }
    mergeIntoQueue(selected);
    const text = `${plural(selected.length, "track")} added to the burn list.`;
    if (fromDrag) say(text);
    else sayOnAlbum(text);
    return selected.length;
  }

  async function dropAlbum(event: DragEvent) {
    event.preventDefault();
    const key = event.dataTransfer.getData("application/x-mxtp-album-key");
    const album = albumByKey.get(key);
    if (!album) return;
    const tracks = albumDragScope === "full" ? await loadVerifiedTracklist(album) : album.tracks;
    queueAlbum(album, tracks, albumDragScope, true);
  }

  function dropQueueItem(event: DragEvent, targetId: string) {
    event.preventDefault();
    // The burn list itself also handles drops; one drop must add an album once.
    event.stopPropagation();
    if (event.dataTransfer.getData("application/x-mxtp-album-key")) {
      void dropAlbum(event);
      finishDragging();
      return;
    }
    const sourceId = event.dataTransfer.getData("application/x-mxtp-track-id")
      || event.dataTransfer.getData("text/plain")
      || draggedIdRef.current;
    if (sourceId) moveQueueItem(sourceId, targetId);
    finishDragging();
  }

  function playQueueItem(item: CdBurnItem) {
    if (!item.ready) return;
    setListeningId(item.id);
    setPlaybackError("");
  }

  async function prepare(items: CdBurnItem[], options: PrepareOptions = {}): Promise<CdBurnItem[] | undefined> {
    const { addToQueue = false, drive, project } = options;
    if (items.length === 0) return;
    const capacity = capacityCheck(items);
    if (!capacity.ok) {
      say(`That selection is ${capacity.label}. Remove enough music to fit an 80-minute CD.`);
      return;
    }
    const token = listToken();
    const owner = project ?? currentProject();
    setWorking(true);
    setFailures([]);
    say("Checking your downloaded audio…");
    const failed: PrepareFailure[] = [];
    let prepared = items.map((item) => ({ ...item }));
    const setReady = (id: string, ready: Track) => {
      prepared = prepared.map((candidate) => candidate.id === id ? { ...candidate, ready } : candidate);
    };
    try {
      const prepareIndividually = async (pending: CdBurnItem[]) => {
        for (const item of pending) {
          say(`Verifying ${item.artist} - ${item.title} on YouTube…`);
          let url: string;
          try {
            url = (await findYouTubeTrack(item.artist, item.title, item.durationSec)).url;
          } catch (error) {
            // The confidence gate is deliberately fail-closed: no confident match, no download.
            failed.push({ id: item.id, title: item.title, reason: errorText(error), unmatched: true });
            continue;
          }
          try {
            const download = await downloadPlaylistBest(url);
            const ready = download.tracks.find((track) => track.path);
            if (!ready?.path) throw new Error("no audio file was produced");
            setReady(item.id, canonicalTrack(ready, item));
          } catch (error) {
            failed.push({ id: item.id, title: item.title, reason: errorText(error), unmatched: false });
          }
        }
      };
      for (const [groupKey, group] of groupQueue(prepared)) {
        const album = albumByKey.get(groupKey);
        if (!album) {
          await prepareIndividually(group.filter((item) => !item.ready));
          continue;
        }
        const knownReady = readyForAlbum(
          effectiveProjectsRef.current,
          album,
          downloadedOverrides[album.key] ?? downloadedTracksForAlbum(effectiveProjectsRef.current, album),
          fullTracklistsRef.current[album.key]
        );
        prepared = prepared.map((item) => item.albumKey === groupKey && knownReady.has(item.id)
          ? { ...item, ready: knownReady.get(item.id) }
          : item);
        const pending = prepared.filter((item) => item.albumKey === groupKey && !item.ready);
        if (pending.length === 0) continue;

        let match: YouTubeAlbumMatch;
        try {
          say(`Finding ${album.artist} - ${album.title} on YouTube…`);
          match = await findYouTubeAlbumPlaylist(album.artist, album.title, album.tracks.map((track) => ({
            title: track.title,
            durationSec: track.durationSec
          })));
        } catch {
          await prepareIndividually(pending);
          continue;
        }
        // Only verified release positions go to the album batch; anything
        // else is matched one track at a time.
        const positioned = pending
          .map((item) => ({ item, position: verifiedPosition(item, match, album.artist) }))
          .filter((entry) => entry.position > 0);
        const unpositioned = pending.filter((item) => !positioned.some((entry) => entry.item.id === item.id));
        if (positioned.length > 0) {
          try {
            say(`Downloading ${plural(positioned.length, "selected track")} in the best available source quality…`);
            const playlist = await downloadPlaylistBest(match.url, positioned.map((entry) => entry.position));
            onPreparedAlbum(album, playlist);
            for (const { item, position } of positioned) {
              const ready = playlist.tracks.find((track) => track.path && filePosition(track) === position)
                ?? playlist.tracks.find((track) => track.path && filePosition(track) === undefined && titleKey(track.title) === titleKey(item.title));
              if (ready?.path) setReady(item.id, { ...ready, title: item.title, durationSec: item.durationSec || ready.durationSec });
              else failed.push({ id: item.id, title: item.title, reason: "it was not in the downloaded YouTube release", unmatched: true });
            }
          } catch {
            await prepareIndividually(positioned.map((entry) => entry.item));
          }
        }
        await prepareIndividually(unpositioned);
      }

      prepared = canonicalQueue(prepared);
      const readyById = new Map(prepared.flatMap((item) => item.ready ? [[item.id, item.ready] as const] : []));
      const withReady = (list: CdBurnItem[]) => list.map((item) => readyById.has(item.id) ? { ...item, ready: readyById.get(item.id) } : item);
      let finalItems: CdBurnItem[];
      if (!listChanged(token)) {
        finalItems = addToQueue ? (mergeIntoQueue(prepared), prepared) : updateQueue(withReady);
      } else {
        // The burn list became another list while this ran. Leave that list
        // alone; the audio goes to the saved project it was downloaded for.
        finalItems = prepared;
        const latest = owner && effectiveProjectsRef.current.find((candidate) => candidate.id === owner.id);
        if (latest?.saved && !addToQueue) {
          updateRememberedProject(projectFromQueuePreservingAudio(withReady(queueFromProject(latest)), latest.name, latest));
        }
      }
      setFailures(failed.filter((failure) => finalItems.some((item) => item.id === failure.id && !item.ready)));
      const ready = finalItems.flatMap((item) => item.ready ? [item.ready] : []);
      const missing = finalItems.length - ready.length;
      if (missing > 0) {
        const unmatched = failed.filter((failure) => failure.unmatched);
        const broken = failed.filter((failure) => !failure.unmatched);
        say([
          `${plural(ready.length, "track")} ready.`,
          unmatched.length > 0 ? `Not found on YouTube: ${unmatched.map((failure) => failure.title).join(", ")}.` : "",
          broken.length > 0 ? `${broken.length} could not be downloaded: ${broken[0].reason}` : ""
        ].filter(Boolean).join(" "));
        return finalItems;
      }
      if (!drive) {
        say(`${ready.length === 1 ? "1 track is" : `${ready.length} tracks are`} downloaded and audio ready forever.`);
        return finalItems;
      }
      const sameAlbumTitle = finalItems.every((item) => item.albumKey === finalItems[0]?.albumKey) ? finalItems[0]?.album : undefined;
      const discTitle = project?.name || projectNameRef.current.trim() || sameAlbumTitle || "MXTP CD";
      if (!(await confirmRealBurn(drive.name || "", ready.length, discTitle))) {
        say(`${ready.length === 1 ? "1 track is" : `${ready.length} tracks are`} ready and loaded. Burn canceled. Click Burn CD when you're ready.`);
        return finalItems;
      }
      say("Burning the CD. Do not remove the disc…");
      const result = await burnReal(ready, drive.id, false, discTitle);
      say(result.ok ? result.message : `Burn failed: ${result.errors.join("; ")}`);
      if (result.ok) {
        const burnedAt = new Date().toISOString();
        if (!listChanged(token)) await saveQueue(finalItems, burnedAt, project ?? currentProject());
        else if (owner) await saveQueue(finalItems, burnedAt, effectiveProjectsRef.current.find((candidate) => candidate.id === owner.id) ?? owner, false);
      }
      return finalItems;
    } catch (error) {
      say(`Could not prepare this selection: ${errorText(error)}`);
    } finally {
      setWorking(false);
    }
  }

  /** Burn CD: look for a writer before downloading anything. */
  async function burn(items: CdBurnItem[], project?: CdProject) {
    if (items.length === 0 || workingRef.current) return;
    say("Checking for a CD writer…");
    let found: DriveInfo[];
    try {
      found = await detectBurners();
    } catch (error) {
      say(`Could not check for a CD writer: ${errorText(error)}`);
      return;
    }
    setDrives(found);
    if (found.length === 0) {
      say("No CD writer found. You can download the audio now and burn later.");
      return;
    }
    const drive = found.find((candidate) => candidate.id === selectedDriveId) ?? found[0];
    setSelectedDriveId(drive.id);
    await prepare(items, { drive, project });
  }

  function burnProject(project: CdProject) {
    requestLeave(() => {
      newListEpoch();
      const items = queueFromProject(project);
      setActiveProjectId(project.id);
      setProjectName(project.name);
      setQueueNow(items);
      setListeningId(undefined);
      setActiveProjectAlbum(undefined);
      setActiveAlbumKey(undefined);
      say(`Loaded ${plural(items.length, "track")} from ${project.name} into the burn list.`);
      void burn(items, project);
    });
  }

  function setSourceNotice(source: SourceKey, notice?: SourceNotice) {
    setSourceNotices((current) => ({ ...current, [source]: notice }));
  }

  async function refreshApple(path?: string) {
    setSourceBusy("apple");
    setSourceNotice("apple", { text: "Reading your Apple Music library on this PC…" });
    try {
      const refreshed = await onRefreshApple(path);
      setSourceNotice("apple", { text: `Apple Music library read: ${plural(refreshed.summary.trackCount, "song")} and ${plural(refreshed.summary.totalPlays, "recorded play")}.` });
    } catch (error) {
      const raw = errorText(error);
      setSourceNotice("apple", {
        error: true,
        text: /not found|no such file|cannot find|could not find/i.test(raw)
          ? "MXTP could not find your Apple Music library on this PC. Open Apple Music once so it syncs, or choose your Library.musicdb file."
          : "MXTP could not read your Apple Music library.",
        detail: raw
      });
    } finally {
      setSourceBusy(undefined);
    }
  }

  async function chooseAppleLibrary() {
    let picked: string | string[] | null;
    try {
      picked = await open({ multiple: false, directory: false, filters: [{ name: "Apple Music library", extensions: ["musicdb"] }] });
    } catch (error) {
      setSourceNotice("apple", { error: true, text: "The file picker could not open.", detail: errorText(error) });
      return;
    }
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (path) await refreshApple(path);
  }

  async function importSource(source: ImportedMusicSource["source"], files: FileList | null) {
    if (!files?.length) return;
    setSourceBusy(source);
    setSourceNotice(source, { text: `Importing your ${SOURCE_LABELS[source]} export…` });
    try {
      const input = await Promise.all([...files].map(async (file) => ({ name: file.name, path: file.webkitRelativePath || file.name, text: await file.text() })));
      const imported = await onImportSource(source, input);
      setSourceNotice(source, { text: `${SOURCE_LABELS[source]} imported: ${plural(imported.tracks.length, "track")}. Your albums now include them.` });
    } catch (error) {
      setSourceNotice(source, {
        error: true,
        text: `Could not import that ${SOURCE_LABELS[source]} export. Your previous ${SOURCE_LABELS[source]} import is unchanged.`,
        detail: errorText(error)
      });
    } finally {
      setSourceBusy(undefined);
    }
  }

  async function addAudioFiles() {
    let picked: string | string[] | null;
    try {
      picked = await open({ multiple: true, filters: [{ name: "Audio", extensions: ["wav", "flac", "mp3"] }] });
    } catch (error) {
      setSourceNotice("files", { error: true, text: "The file picker could not open.", detail: errorText(error) });
      return;
    }
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length === 0) return;
    setSourceBusy("files");
    const items: CdBurnItem[] = [];
    const problems: string[] = [];
    for (const sourcePath of paths) {
      const title = fileTitle(sourcePath);
      try {
        const path = await invokeCommand<string>("copy_audio_file", { sourcePath, projectId: "library-imports" });
        const meta = await invokeCommand<{ durationSec: number }>("probe_audio", { path });
        items.push({
          id: path,
          albumKey: LOCAL_FILES_KEY,
          title,
          artist: "",
          album: "Audio files",
          durationSec: meta.durationSec,
          ready: { id: path, title, durationSec: meta.durationSec, path }
        });
      } catch (error) {
        problems.push(`${title} (${errorText(error)})`);
      }
    }
    setSourceBusy(undefined);
    if (items.length > 0) mergeIntoQueue(items);
    const text = [
      items.length > 0 ? `Added ${plural(items.length, "audio file")} to the burn list.` : "",
      problems.length > 0 ? `Could not add ${problems.join("; ")}.` : ""
    ].filter(Boolean).join(" ");
    setSourceNotice("files", { text, error: items.length === 0 });
    say(text);
  }

  function updateCuratorMemory(memory: CuratorMemory) {
    const active = currentProject();
    if (!active) {
      // Written now as well: the editor commits on unmount, when an effect would not run.
      try { localStorage.setItem(CURATOR_MEMORY_KEY, JSON.stringify(memory)); } catch { /* storage unavailable */ }
      setCuratorSession((current) => ({ ...current, memory }));
      return;
    }
    // Remember every keystroke now; the parent persists it in the background.
    updateRememberedProject({
      ...active,
      curator: { ...(active.curator ?? emptyCuratorState()), memory },
      updatedAt: new Date().toISOString()
    });
  }

  async function runCurator(prompt: string) {
    if (handleHelpPrompt(prompt)) return;
    const now = new Date();
    const active = currentProject();
    const baseState = active?.curator ?? curatorSession;
    const pending = baseState.pendingProposal;
    const answer = prompt.trim();
    if (pending && ACCEPT_REPLY.test(answer)) {
      await acceptCuratorProposal(pending.id);
      return;
    }
    if (pending && DECLINE_REPLY.test(answer)) {
      await declineCuratorProposal(pending.id);
      return;
    }
    const result = curateMix(prompt, library.tracks, baseState.memory, queueRef.current);
    const proposal: CuratorProposal = {
      id: `proposal-${now.getTime()}`,
      title: result.title,
      items: choicesToQueue(result.choices),
      replaceExisting: result.replaceExisting,
      createdAt: now.toISOString()
    };
    const hint = proposal.items.length > 0
      ? ` This is only a proposal. Say yes or click Add to burn list to put ${plural(proposal.items.length, "track")} in ${active ? "this burn list" : "a new burn list"}.`
      : "";
    const messages = [
      ...baseState.messages,
      { id: `user-${now.getTime()}`, role: "user" as const, content: prompt, createdAt: now.toISOString() },
      {
        id: `assistant-${now.getTime()}`,
        role: "assistant" as const,
        content: `${result.reply}${hint}`,
        createdAt: now.toISOString(),
        choices: result.choices.map((choice) => ({ trackId: choice.track.id, title: choice.track.title, artist: choice.track.artist, explanation: choice.explanation })),
        citations: Array.from(new Set(result.choices.flatMap((choice) => choice.citations))),
        proposal: { id: proposal.id, trackCount: proposal.items.length }
      }
    ];
    const curator = { memory: result.memory, messages, revision: baseState.revision + 1, pendingProposal: proposal };
    if (!active) {
      setCuratorSession(curator);
      say(`Curator proposal ready: ${plural(proposal.items.length, "track")}. Decide in AI Curator.`);
      return;
    }
    if (!(await saveRememberedProject({ ...active, curator, updatedAt: now.toISOString() }))) {
      say("MXTP kept the suggestion on screen, but could not save this project's chat. Fix the storage error and try again.");
      return;
    }
    say(`Curator proposal ready: ${plural(proposal.items.length, "track")}. Decide in AI Curator.`);
  }

  async function acceptCuratorProposal(proposalId: string) {
    const active = currentProject();
    const baseState = active?.curator ?? curatorSession;
    const proposal = baseState.pendingProposal;
    if (!proposal || proposal.id !== proposalId || workingRef.current) return;
    if (active) {
      await addProposal(proposal, baseState, active);
      return;
    }
    // A global proposal starts a new mix that holds only the proposal.
    if (queueRef.current.length > 0) {
      setConfirm({
        title: "Save your burn list first?",
        body: `Your ${queueRef.current.length}-track burn list isn't saved. The proposal starts a new mix and will clear it.`,
        proceed: () => {
          setActiveProjectId(undefined);
          void addProposal(proposal, baseState);
        }
      });
      return;
    }
    await addProposal(proposal, baseState);
  }

  async function addProposal(proposal: CuratorProposal, baseState: CuratorState, target?: CdProject) {
    const now = new Date();
    let nextQueue = proposal.items;
    if (target) {
      const disliked = new Set(baseState.memory.dislikedArtists.map(normalizeKey));
      const current = queueRef.current;
      const preserved = proposal.replaceExisting ? current.filter((item) => !disliked.has(normalizeKey(item.artist))) : current;
      nextQueue = mergeQueueItems(preserved, proposal.items);
    }
    const confirmation = {
      id: `assistant-${now.getTime()}`,
      role: "assistant" as const,
      content: `Confirmed. I added ${plural(proposal.items.length, "proposed track")} to the burn list. Click Download in the burn list when you want the audio.`,
      createdAt: now.toISOString()
    };
    const curator = { ...baseState, messages: [...baseState.messages, confirmation], revision: baseState.revision + 1, pendingProposal: undefined };
    const base = target ?? createCdProject({ artist: "", album: proposal.title, formatId: "jewelcase" }, now);
    const project: CdProject = {
      ...projectFromQueuePreservingAudio(nextQueue, base.name || proposal.title, base, now),
      name: base.name || proposal.title,
      saved: true,
      curator
    };
    if (!target) {
      newListEpoch();
      freshGlobalCurator();
      clearUnsavedStorage();
      setActiveProjectAlbum(projectAlbumView(project));
      setActiveAlbumKey(undefined);
    }
    setActiveProjectId(project.id);
    setProjectName(project.name);
    setQueueNow(nextQueue);
    setFailures([]);
    if (!(await saveRememberedProject(project))) {
      if (!target) setActiveProjectId(undefined);
      say("The proposal was accepted, but the project was not saved. Fix the storage error and try again.");
      return;
    }
    say(`Added ${plural(proposal.items.length, "track")} to ${project.name}. Click Download in the burn list when you want the audio.`);
  }

  async function declineCuratorProposal(proposalId: string) {
    const now = new Date();
    const active = currentProject();
    const baseState = active?.curator ?? curatorSession;
    const proposal = baseState.pendingProposal;
    if (!proposal || proposal.id !== proposalId) return;
    const curator = {
      ...baseState,
      messages: [...baseState.messages, { id: `assistant-${now.getTime()}`, role: "assistant" as const, content: "No problem. I left the proposed tracks out of the burn list and did not download anything.", createdAt: now.toISOString() }],
      revision: baseState.revision + 1,
      pendingProposal: undefined
    };
    if (!active) {
      setCuratorSession(curator);
      say("Proposal dismissed. Nothing was downloaded or added.");
      return;
    }
    if (await saveRememberedProject({ ...active, curator, updatedAt: now.toISOString() })) {
      say("Proposal dismissed. Nothing was downloaded or added.");
    } else {
      say("The proposal was dismissed on screen, but the project chat could not be saved.");
    }
  }

  /**
   * Save downloaded album audio to its own artist project. An existing project
   * is reused only when it is this album's artist project or a recovered
   * playlist of it; its order, format and items are kept and audio is attached.
   */
  // `list` is the unsaved burn list that becomes this album's project: its order
  // and extra tracks are kept instead of rebuilding from the release.
  async function persistAlbumDownload(album: AppleMusicAlbum, items: CdBurnItem[], list?: CdBurnItem[]): Promise<CdProject | undefined> {
    const fresh = canonicalQueue(items);
    const known = effectiveProjectsRef.current;
    // Prefer the saved album project over App's unsaved prepared-album stub.
    const sameAlbum = known.filter((project) => project.kind === "artist" && albumKey(project.entry.artist, project.entry.album) === album.key);
    const existing = sameAlbum.find((project) => project.saved) ?? sameAlbum[0]
      ?? known.find((project) => project.id.startsWith("recovered-") && downloadedTracksForAlbum([project], album).length > 0);
    let project: CdProject;
    if (existing) {
      const merged = projectFromQueuePreservingAudio(attachAudio(queueFromProject(existing), list ?? fresh), existing.name, existing);
      const recovered = existing.id.startsWith("recovered-");
      project = {
        ...merged,
        saved: true,
        kind: recovered ? "artist" : existing.kind,
        entry: recovered ? { artist: album.artist, album: album.title, formatId: existing.entry.formatId } : existing.entry
      };
    } else {
      const complete = list ? attachAudio(list, fresh) : mergeAlbumItems(fresh, downloadedTracksForAlbum(known, album));
      project = {
        ...projectFromQueuePreservingAudio(complete, album.title, createCdProject({ artist: album.artist, album: album.title, formatId: "jewelcase" })),
        saved: true,
        kind: "artist",
        entry: { artist: album.artist, album: album.title, formatId: "jewelcase" }
      };
    }
    project = {
      ...project,
      art: project.art.length > 0 || !album.artworkPath
        ? project.art
        : [{ slotId: "front", imageRef: album.artworkPath, imageSource: "manual", transform: { x: 0, y: 0, scale: 1, rotation: 0 } }],
      research: project.research ?? {
        album: {
          artist: album.artist,
          album: album.title,
          year: album.year ?? 0,
          label: "MXTP combined music library",
          tracks: project.burnQueue.map((item) => item.title),
          coverArtUrls: [],
          tags: album.genre ? [album.genre] : []
        },
        lyricsByTrack: []
      }
    };
    setDownloadedOverrides((current) => ({ ...current, [album.key]: mergeAlbumItems(fresh, downloadedTracksForAlbum(known, album)) }));
    return await saveRememberedProject(project) ? project : undefined;
  }

  async function downloadAlbum(album: ProjectAlbumView, fullTracks = activeFullTracklist) {
    if (album.fixedTracks) {
      await prepare(queueRef.current);
      return;
    }
    if (albumScope === "liked") {
      const liked = tracksForAlbumScope(album, activeDownloaded, "liked", fullTracks);
      if (liked.length === 0) {
        sayOnAlbum("This album has no My Apple Music songs. Choose Full album to download the release.");
        return;
      }
      const ready = readyForAlbum(effectiveProjects, album, activeDownloaded, fullTracks);
      const prepared = await prepare(liked.map((track) => queueItem(album, track, ready.get(track.id))), { addToQueue: true });
      const downloaded = prepared?.filter((item) => item.ready?.path) ?? [];
      if (downloaded.length === 0) return;
      const saved = await persistAlbumDownload(album, downloaded);
      if (!saved) {
        say("The audio downloaded successfully, but the project was not saved. Fix the storage error and try again.");
        return;
      }
      const missing = liked.length - downloaded.length;
      say(`Downloaded ${plural(downloaded.length, "song")}. Audio ready forever, saved to the project ${saved.name} in Projects.${missing > 0 ? ` ${missing} could not be matched.` : ""}`);
      return;
    }

    const token = listToken();
    setListeningId(undefined);
    setWorking(true);
    say(`Finding the complete ${album.artist} - ${album.title} release on YouTube…`);
    try {
      const match = await findYouTubeAlbumPlaylist(album.artist, album.title, (fullTracks ?? album.tracks).map((track) => ({
        title: track.title,
        durationSec: track.durationSec
      })));
      say(`Downloading the complete ${match.trackCount || "album"}-track release in the best available source quality…`);
      const playlist = await downloadPlaylistBest(match.url, match.safeTrackPositions);
      onPreparedAlbum(album, playlist);
      const items = queueItemsFromPlaylist(album, playlist.tracks);
      if (items.length === 0) throw new Error("the matched release did not contain any downloadable tracks");
      // A different list opened meanwhile: the album goes to its own project only.
      const next = listChanged(token) ? undefined : updateQueue((current) => attachAudio(current, items));
      const adopt = Boolean(next) && !activeProjectIdRef.current && next!.every((item) => item.albumKey === album.key);
      const saved = await persistAlbumDownload(album, items, adopt ? next : undefined);
      if (!saved) {
        say("The album downloaded successfully, but the project was not saved. Fix the storage error and try again.");
        return;
      }
      if (!next || listChanged(token)) {
        say(`Downloaded ${plural(items.length, "track")} and saved them to the project ${saved.name} in Projects.`);
        return;
      }
      const capacity = capacityCheck(next);
      const capacityNote = capacity.ok ? "" : ` The burn list is ${capacity.label}, over CD capacity; remove tracks before burning.`;
      if (adopt && !activeProjectIdRef.current) {
        clearUnsavedStorage();
        setActiveProjectId(saved.id);
        setProjectName(saved.name);
        // The saved project keeps its curated order; show that, not release order.
        setQueueNow(queueFromProject(saved));
        say(`Downloaded ${plural(items.length, "track")} and saved them as the project ${saved.name}. Burn-list changes now update it.${capacityNote}`);
      } else {
        say(`Downloaded ${plural(items.length, "track")}. Audio ready forever, saved to the project ${saved.name} in Projects.${capacityNote}`);
      }
    } catch (error) {
      say(`Could not download the complete album: ${errorText(error)}`);
    } finally {
      setWorking(false);
    }
  }

  const projectPage = activeProjectAlbum && activeCdProject ? activeCdProject : undefined;
  const curatorModeNotice = activeCdProject ? (
    <div className="curator-mode-notice project" role="note">
      <span>Requests here change {activeCdProject.name}. Use Exit project to start a new mix.</span>
    </div>
  ) : null;
  const curatorChatProps = {
    projectName: activeCdProject?.name,
    messages: currentCurator.messages,
    memory: currentCurator.memory,
    busy: working,
    onSend: runCurator,
    onMemoryChange: updateCuratorMemory,
    pendingProposalId: currentCurator.pendingProposal?.id,
    onAcceptProposal: (id: string) => void acceptCuratorProposal(id),
    onDeclineProposal: (id: string) => void declineCuratorProposal(id)
  };
  const albumStatus = activeAlbum && view === "library" && message && (working || albumNotice)
    ? working ? `${message} · ${formatDuration((clock - workStartedAt) / 1000)} elapsed` : message
    : "";

  const main = view === "curator" ? (
    <section className="curator-workspace" data-mode={activeCdProject ? "project" : "global"}>
      {curatorModeNotice}
      <CuratorChat key={activeCdProject?.id ?? "new-personal-mix"} {...curatorChatProps} />
    </section>
  ) : view === "sources" ? (
    <SourcesView
      sources={library.sources ?? []}
      busy={sourceBusy}
      notices={sourceNotices}
      onRefreshApple={() => void refreshApple()}
      onChooseAppleLibrary={() => void chooseAppleLibrary()}
      onImport={(source, files) => void importSource(source, files)}
      onAddAudioFiles={() => void addAudioFiles()}
    />
  ) : activeAlbum ? (
    <>
    <AlbumDetail
      album={activeAlbum}
      project={projectPage}
      projects={effectiveProjects}
      downloadedItems={activeDownloaded}
      fallbackArtworkPath={activeAlbum.fallbackArtworkPath}
      scope={albumScope}
      fullTracks={activeFullTracklist}
      fullTracklistLoading={fullTracklistLoading === activeAlbum.key}
      fullTracklistError={fullTracklistErrors[activeAlbum.key]}
      selectedTrackIds={selectedTrackIds}
      working={working}
      status={albumStatus}
      backLabel={projectPage ? "Projects" : "All albums"}
      onBack={() => {
        if (projectPage) setView("projects");
        setActiveAlbumKey(undefined);
        setActiveProjectAlbum(undefined);
      }}
      onToggle={(trackId) => setSelectedTrackIds((current) => toggleSet(current, trackId))}
      onScopeChange={(scope) => { setAlbumScope(scope); setSelectedTrackIds(new Set()); }}
      onSelectAll={() => setSelectedTrackIds(new Set(scopeTracks(activeAlbum, albumScope).map((track) => track.id)))}
      onClear={() => setSelectedTrackIds(new Set())}
      onAdd={() => {
        const items = selectedItems(activeAlbum);
        if (items.length === 0) return;
        mergeIntoQueue(items);
        setSelectedTrackIds(new Set());
        sayOnAlbum(`${plural(items.length, "track")} added to the burn list.`);
      }}
      onAddAlbum={() => void queueAlbum(activeAlbum, scopeTracks(activeAlbum, albumScope), albumScope, false)}
      onDownload={() => void downloadAlbum(activeAlbum, activeFullTracklist)}
      onRetryTracklist={() => retryVerifiedTracklist(activeAlbum)}
      onOpenStudio={activeCdProject
        ? () => onOpenProjectStudio ? onOpenProjectStudio(activeCdProject) : onOpenStudio(activeAlbum)
        : undefined}
      onBurnProject={projectPage ? () => burnProject(projectPage) : undefined}
      onDeleteProject={projectPage ? () => deleteRememberedProject(projectPage) : undefined}
    />
    {projectPage ? (
      <section className="curator-workspace" data-mode="project">
        {curatorModeNotice}
        <CuratorChat key={projectPage.id} {...curatorChatProps} />
      </section>
    ) : null}
    </>
  ) : view === "projects" ? (
    <ProjectsView
      projects={visibleProjects}
      loading={projectsLoading}
      filter={projectFilter}
      onFilter={setProjectFilter}
      onOpen={(project) => requestLeave(() => openProject(project))}
      onBurn={burnProject}
      onRequestDelete={deleteRememberedProject}
      onCreateCustom={onCreateCustom}
    />
  ) : (
    <AlbumGrid
      albums={filteredAlbums.slice(0, visibleCount)}
      projects={effectiveProjects}
      total={filteredAlbums.length}
      query={query.trim()}
      librarySize={library.summary.trackCount}
      onOpen={openAlbum}
      onLoadMore={() => setVisibleCount((count) => count + 60)}
      onClearSearch={() => setQuery("")}
      onOpenSources={() => setView("sources")}
      onAddAudioFiles={() => void addAudioFiles()}
      onDragAlbum={(event, album) => {
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("application/x-mxtp-album-key", album.key);
        event.dataTransfer.setData("text/plain", album.key);
      }}
    />
  );

  const checklist = [
    { label: "Bring in music", done: library.summary.trackCount > 0 },
    { label: "Fill the burn list", done: queue.length > 0 || visibleProjects.length > 0 },
    { label: "Save it as a project", done: visibleProjects.length > 0 },
    { label: "Design cover + booklet", done: effectiveProjects.some(hasDesignedArt) },
    { label: "Print + burn", done: effectiveProjects.some((project) => project.exports.length > 0 || Boolean(project.lastBurnedAt)) }
  ];
  const onGrid = view === "library" && !activeAlbum;
  const showChecklist = onGrid && showGettingStarted && !activeCdProject && checklist.some((row) => !row.done);
  const continueProjects = onGrid && !activeCdProject && queue.length === 0
    ? [...visibleProjects].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 3)
    : [];
  const libraryEmpty = library.summary.trackCount === 0;
  const importedSources = (library.sources ?? []).filter((source) => source.imported);
  const navButton = (target: MainView, label: string, extra: Record<string, string> = {}, count?: number) => (
    <button
      type="button"
      {...extra}
      className={view === target ? "active" : ""}
      aria-current={view === target ? "page" : undefined}
      onClick={() => {
        setView(target);
        if (target === "library" || target === "projects") {
          setActiveAlbumKey(undefined);
          setActiveProjectAlbum(undefined);
        }
      }}
    >
      {label}{count === undefined ? null : <> <span>{count}</span></>}
    </button>
  );
  const burnButton = (
    <button
      data-help-target="burn-cd"
      className="primary"
      disabled={working || queue.length === 0 || !queueCapacity.ok}
      aria-describedby={capacityReason ? "capacity-reason" : undefined}
      onClick={() => void burn(queueRef.current, activeCdProject)}
    >{working ? "Working…" : "Burn CD"}</button>
  );

  return (
    <main className="music-shell" data-testid="apple-library">
      <aside className="music-sidebar">
        <div className="music-brand">
          <span className="music-brand-mark">MX</span>
          <div><strong>MXTP MKR</strong><small>Your music → your CD</small></div>
        </div>
        <ThemeToggle className="music-theme-toggle" helpTarget="theme-toggle" />
        <nav aria-label="Music library">
          {navButton("library", "Albums")}
          {navButton("projects", "Projects", { "data-help-target": "projects" }, visibleProjects.length)}
          {navButton("curator", "AI Curator")}
          {navButton("sources", "Music sources")}
        </nav>
        <details className="music-library-options" open={optionsOpen} onToggle={(event) => setOptionsOpen(event.currentTarget.open)}>
          <summary>Sources and drag setting</summary>
          <div className="music-source-toggles" aria-label="Included music sources" data-help-target="source-filters">
            {importedSources.map((source) => (
              <label key={source.source} data-available="true">
                <input type="checkbox" checked={enabledSources.has(source.source)} onChange={() => onToggleSource(source.source)} />
                <span>{source.label}</span><small>{source.trackCount.toLocaleString()}</small>
              </label>
            ))}
            <button type="button" className="music-add-source" onClick={() => setView("sources")}>Add a source</button>
          </div>
          {!libraryEmpty ? (
            <>
              <fieldset className="music-drag-settings">
                <legend>Album drag setting</legend>
                <label><input type="radio" name="album-drag-scope" checked={albumDragScope === "liked"} onChange={() => setDragScope("liked")} /> My Apple Music songs</label>
                <label><input type="radio" name="album-drag-scope" checked={albumDragScope === "full"} onChange={() => setDragScope("full")} /> Full album</label>
                <small>Dragging an album adds its My Apple Music songs. Full album adds the verified release tracklist when MXTP can find one.</small>
              </fieldset>
              <div className="music-sidebar-stats">
                <span>{plural(library.summary.trackCount, "song")}</span>
                <span>{plural(library.summary.albumCount, "album")}</span>
                <span>{plural(library.summary.totalPlays, "play")}</span>
              </div>
            </>
          ) : null}
        </details>
        <button type="button" className="music-secondary-action" onClick={startNewMix}>New mix</button>
      </aside>

      <section className="music-main">
        {appError || activeCdProject || onGrid ? (
          <header className="music-toolbar" style={{ flexWrap: "wrap" }}>
            {appError ? <p className="error music-app-error" role="alert" style={{ flexBasis: "100%", margin: 0 }}>{appError}</p> : null}
            {activeCdProject ? (
              <div className="music-project-mode-banner" role="note" style={{ flexBasis: "100%" }}>
                <strong>Editing project: {activeCdProject.name} · changes save automatically</strong>
                <button type="button" disabled={working} onClick={exitProjectMode}>Exit project</button>
              </div>
            ) : null}
            {onGrid ? (
              <>
                <label className="music-search" data-help-target="album-search">
                  <span>Search library</span>
                  <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Artists, albums, genres" />
                </label>
                <label className="music-sort">
                  <span>Sort</span>
                  <select value={sort} onChange={(event) => setSort(event.target.value as AlbumSort)}>
                    <option value="recent">Recently played</option>
                    <option value="plays">Most played</option>
                    <option value="artist">Artist</option>
                    <option value="album">Album title</option>
                  </select>
                </label>
              </>
            ) : null}
          </header>
        ) : null}
        {showChecklist ? (
          <section className="music-getting-started music-checklist" role="note" aria-label="Your first CD">
            <div className="music-getting-started-head">
              <h2>Your first CD</h2>
              <button type="button" aria-label="Dismiss getting started" onClick={dismissGettingStarted}>Dismiss</button>
            </div>
            <ol>
              {checklist.map((row, index) => (
                <li key={row.label} data-done={row.done ? "true" : undefined}>
                  <strong>{row.label}</strong>{row.done ? <small> Done</small> : null}
                  {index === 0 && !row.done ? <> <button type="button" onClick={() => setView("sources")}>Open Music sources</button></> : null}
                  {index === 3 && !row.done && queue.length > 0 ? <> <button type="button" onClick={() => void openCoverStudio()}>Design cover + booklet</button></> : null}
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        {continueProjects.length > 0 ? (
          <section className="music-continue" aria-label="Continue a project">
            <h2>Continue</h2>
            <div>
              {continueProjects.map((project) => (
                <button type="button" key={project.id} onClick={() => openProject(project)}>
                  <strong>{projectLabel(project)}</strong>
                  <small>{projectMeta(project)}</small>
                </button>
              ))}
            </div>
          </section>
        ) : null}
        {main}
      </section>

      <aside
        id="burn-list"
        className="music-queue"
        aria-label="CD burn list"
        data-expanded={narrow && queueExpanded ? "true" : undefined}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => void dropAlbum(event)}
      >
        {narrow ? (
          <div className="music-queue-peek-bar">
            <button type="button" className="music-queue-peek" aria-expanded={queueExpanded} aria-controls="burn-list" onClick={() => setQueueExpanded((current) => !current)}>
              <strong>Burn list · {plural(queue.length, "track")} · {formatDuration(queueDuration)} / 80:00</strong>
              {message ? <small>{message}</small> : null}
            </button>
            {burnButton}
          </div>
        ) : null}
        {activeCdProject ? (
          <div className="music-queue-project-mode">
            <span>Project</span>
            <strong>{activeCdProject.name}</strong>
            <button type="button" data-testid="exit-project-button" disabled={working} onClick={exitProjectMode}>Exit project</button>
          </div>
        ) : null}
        <div className="music-queue-head">
          <div>
            <span>Burn list</span>
            <strong>{plural(queue.length, "track")}</strong>
            {unsavedList ? <em className="music-unsaved-tag">Not saved</em> : null}
          </div>
          {queue.length > 0 ? <button type="button" disabled={working} onClick={clearBurnList}>Clear burn list</button> : null}
        </div>
        <label className="music-project-name">
          <span>Project name</span>
          <input
            ref={nameInputRef}
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            onBlur={commitProjectName}
            onKeyDown={(event) => { if (event.key === "Enter") commitProjectName(); }}
            placeholder={queue.length > 0 ? suggestedName(queue) : "Name this CD"}
          />
        </label>
        <div className="music-capacity" data-over={queueCapacity.ok ? "false" : "true"}>
          <div><span>{formatDuration(queueDuration)}</span><span>80:00</span></div>
          <i><b style={{ width: `${Math.min(100, queueDuration / queueCapacity.limitSec * 100)}%` }} /></i>
        </div>
        {capacityReason ? <small id="capacity-reason" className="music-capacity-reason" role="status">{capacityReason}</small> : null}
        {queue.length > 0 ? (
          <small className="music-audio-summary">
            {needAudio === 0
              ? queue.length === 1 ? "1 track has audio" : `All ${queue.length} tracks have audio`
              : `${plural(queue.length, "track")} · ${needAudio} ${needAudio === 1 ? "needs" : "need"} audio`}
          </small>
        ) : null}
        <span id="queue-handle-hint" hidden>Press up or down arrow to move</span>
        <p aria-live="polite" style={VISUALLY_HIDDEN}>{moveAnnouncement}</p>
        <div className="music-queue-list">
          {queue.length === 0 ? <p>Choose songs or an album. Your CD fills up here.</p> : queue.map((item, index) => (
            <div
              className={`music-queue-item ${listeningId === item.id ? "listening" : ""}`}
              key={item.id}
              data-dragging={draggedId === item.id ? "true" : "false"}
              data-drag-over={dragOverId === item.id && draggedId !== item.id ? "true" : "false"}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDragOverId(item.id);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverId(undefined);
              }}
              onDrop={(event) => dropQueueItem(event, item.id)}
            >
              <button
                type="button"
                className="music-drag-handle"
                draggable={!working}
                data-queue-handle={item.id}
                aria-disabled={working || undefined}
                aria-label={`Reorder ${item.title}`}
                aria-describedby="queue-handle-hint"
                title="Drag to reorder, or press the up and down arrow keys."
                onDragStart={(event) => {
                  draggedIdRef.current = item.id;
                  setDraggedId(item.id);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("application/x-mxtp-track-id", item.id);
                  event.dataTransfer.setData("text/plain", item.id);
                }}
                onDragEnd={finishDragging}
                onKeyDown={(event: ReactKeyboardEvent) => {
                  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                  event.preventDefault();
                  nudgeQueueItem(item.id, event.key === "ArrowUp" ? -1 : 1);
                }}
              >⋮⋮</button>
              <span>{index + 1}</span>
              <button className="music-queue-play" disabled={!item.ready} onClick={() => playQueueItem(item)} aria-label={item.ready ? `Play ${item.title}` : `${item.title} is not downloaded`}>
                <strong>{item.title}</strong>
                <small>{[item.artist, formatDuration(item.durationSec), item.ready ? "" : "needs audio"].filter(Boolean).join(" · ")}</small>
                {unmatchedIds.has(item.id) ? <em className="music-unmatched-tag" title={unmatchedIds.get(item.id)}>Not found on YouTube</em> : null}
              </button>
              <button aria-label={`Remove ${item.title} from burn list`} onClick={() => removeQueueItem(item.id)}>×</button>
            </div>
          ))}
        </div>
        {listeningId ? (
          <audio
            ref={audioRef}
            src={playback.src || undefined}
            controls
            data-testid="burn-list-audio-player"
            onPlaying={() => setPlaybackError("")}
            onError={() => setPlaybackError("Could not play that downloaded track.")}
          />
        ) : null}
        {playbackError ? <p className="music-playback-error" role="alert">{playbackError}</p> : null}
        <div className="music-queue-actions">
          <button
            disabled={working || needAudio === 0 || !queueCapacity.ok}
            aria-describedby={capacityReason ? "capacity-reason" : undefined}
            onClick={() => void prepare(queueRef.current)}
          >{working ? "Downloading…" : `Download (${needAudio})`}</button>
          {drives.length > 1 ? (
            <label className="music-burner-select">
              <span>CD writer</span>
              <select value={selectedDriveId} onChange={(event) => setSelectedDriveId(event.target.value)}>
                {drives.map((drive) => <option key={drive.id} value={drive.id}>{drive.name || drive.id}</option>)}
              </select>
            </label>
          ) : null}
          {burnButton}
          {activeCdProject ? (
            <span className="save music-autosave" role="status" data-help-target="save-project">{saving ? "Saving…" : "Changes save automatically"}</span>
          ) : (
            <button data-help-target="save-project" className="save" disabled={queue.length === 0 || working} onClick={() => void saveQueue()}>Save as project</button>
          )}
          <button
            type="button"
            data-help-target="cover-studio"
            disabled={queue.length === 0}
            aria-describedby={queue.length === 0 ? "cover-studio-hint" : undefined}
            onClick={() => void openCoverStudio()}
          >Design cover + booklet</button>
          {queue.length === 0 ? <small id="cover-studio-hint">Add tracks first</small> : null}
        </div>
        {saveFailureReason ? (
          <p className="music-save-error" role={appError ? undefined : "alert"}>
            Couldn't save: {saveFailureReason} <button type="button" onClick={() => void retrySave()}>Retry</button>
          </p>
        ) : null}
        {message ? (
          <p className="music-message" role="status" aria-hidden={albumStatus ? true : undefined}>
            {message}
            {undo ? <> <button type="button" className="music-undo" onClick={undoClear}>Undo</button></> : null}
            {unmatchedIds.size > 0 && !working ? (
              <> <button type="button" onClick={() => {
                updateQueue((current) => current.filter((item) => !unmatchedIds.has(item.id)));
                setFailures([]);
                say(`Removed ${plural(unmatchedIds.size, "unmatched track")}.`);
              }}>Remove unmatched</button></>
            ) : null}
          </p>
        ) : null}
      </aside>
      {confirm ? (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          onSave={async () => {
            const proceed = confirm.proceed;
            setConfirm(undefined);
            if (await saveQueue()) proceed();
          }}
          onDiscard={() => {
            const proceed = confirm.proceed;
            setConfirm(undefined);
            discardUnsavedList();
            proceed();
          }}
          onCancel={() => setConfirm(undefined)}
        />
      ) : null}
      <HelpCoach open={coachSteps.length > 0} steps={coachSteps} onClose={() => setCoachSteps([])} />
    </main>
  );
}

function ConfirmDialog({ title, body, onSave, onDiscard, onCancel }: {
  title: string;
  body: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Parents pass fresh callbacks every render (the work clock ticks each second);
  // read them through a ref so a re-render never pulls focus back to Cancel.
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  useEffect(() => {
    cancelRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancelRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
  return (
    <div className="project-delete-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="project-delete-dialog music-confirm" role="alertdialog" aria-modal="true" aria-labelledby="music-confirm-title" aria-describedby="music-confirm-body">
        <header><h2 id="music-confirm-title">{title}</h2></header>
        <p id="music-confirm-body">{body}</p>
        <div className="project-delete-actions">
          <button type="button" className="primary" onClick={onSave}>Save as project</button>
          <button type="button" className="danger" onClick={onDiscard}>Discard list</button>
          <button ref={cancelRef} type="button" onClick={onCancel}>Cancel</button>
        </div>
      </section>
    </div>
  );
}

function AlbumGrid({ albums, projects, total, query, librarySize, onOpen, onLoadMore, onClearSearch, onOpenSources, onAddAudioFiles, onDragAlbum }: {
  albums: AppleMusicAlbum[];
  projects: CdProject[];
  total: number;
  query: string;
  librarySize: number;
  onOpen: (album: AppleMusicAlbum) => void;
  onLoadMore: () => void;
  onClearSearch: () => void;
  onOpenSources: () => void;
  onAddAudioFiles: () => void;
  onDragAlbum: (event: DragEvent, album: AppleMusicAlbum) => void;
}) {
  const includesSourceTracks = albums.some((album) => album.sourceTrack);
  return (
    <section className="music-library-view">
      <div className="music-section-heading">
        <div><span>Your library</span><h1>{includesSourceTracks ? "Albums + imported tracks" : "Albums"}</h1></div>
        <p>{includesSourceTracks ? `${plural(total, "album")} and imported tracks` : `${plural(total, "album")} from your listening data`}</p>
      </div>
      {query && total > 0 ? (
        <p className="music-search-summary">Showing {plural(total, "album")} for “{query}” <button type="button" onClick={onClearSearch}>Clear search</button></p>
      ) : null}
      {!query && librarySize === 0 ? (
        <div className="music-empty music-empty-library">
          <p>Your library is empty. Import your Apple Music, Spotify, SoundCloud or YouTube Music listening data to see albums here.</p>
          <button type="button" className="primary" onClick={onOpenSources}>Open Music sources</button>
          <button type="button" onClick={onAddAudioFiles}>Add audio files…</button>
        </div>
      ) : null}
      {query && total === 0 ? <p className="music-empty">No albums match “{query}”. <button type="button" onClick={onClearSearch}>Clear search</button></p> : null}
      <div className="music-album-grid">
        {albums.map((album) => {
          const downloaded = downloadedTracksForAlbum(projects, album);
          const ready = downloaded.length;
          const knownTrackCount = Math.max(album.tracks.length, ready);
          const knownDurationSec = ready > album.tracks.length
            ? downloaded.reduce((sum, item) => sum + item.durationSec, 0)
            : album.durationSec;
          const cover = resolveArtSrc({ imageRef: album.artworkPath });
          return (
            <button key={album.key} className="music-album-card" draggable onDragStart={(event) => onDragAlbum(event, album)} onClick={() => onOpen(album)} aria-label={`Open ${album.title}`} title={`Drag this ${album.sourceTrack ? "track" : "album"} to the burn list`}>
              <span className="music-album-art"><CoverArtwork src={cover} lazy /><b>View {album.sourceTrack ? "track" : "album"}</b></span>
              <strong>{album.title}</strong><span>{album.artist}</span>
              <small>{plural(knownTrackCount, "track")} · {formatDuration(knownDurationSec)}</small>
              {ready > 0 ? <em>{ready}/{knownTrackCount} audio ready forever</em> : null}
            </button>
          );
        })}
      </div>
      {albums.length < total ? <button className="music-load-more" onClick={onLoadMore}>Show more albums</button> : null}
    </section>
  );
}

function AlbumDetail({
  album, project, projects, downloadedItems, fallbackArtworkPath, scope, fullTracks, fullTracklistLoading, fullTracklistError,
  selectedTrackIds, working, status, backLabel, onBack, onToggle, onScopeChange, onSelectAll, onClear, onAdd, onAddAlbum,
  onDownload, onRetryTracklist, onOpenStudio, onBurnProject, onDeleteProject
}: {
  album: ProjectAlbumView; project?: CdProject; projects: CdProject[]; downloadedItems: CdBurnItem[]; fallbackArtworkPath?: string; scope: AlbumScope;
  fullTracks?: AppleMusicTrack[]; fullTracklistLoading: boolean; fullTracklistError?: string; selectedTrackIds: Set<string>; working: boolean; status: string; backLabel: string;
  onBack: () => void; onToggle: (id: string) => void; onScopeChange: (scope: AlbumScope) => void; onSelectAll: () => void; onClear: () => void;
  onAdd: () => void; onAddAlbum: () => void; onDownload: () => void; onRetryTracklist: () => void; onOpenStudio?: () => void;
  onBurnProject?: () => void; onDeleteProject?: () => void;
}) {
  const fixed = Boolean(album.sourceCollection || album.fixedTracks);
  const tracks = tracksForAlbumScope(album, downloadedItems, scope, fullTracks);
  const likedCount = fixed ? 0 : tracksForAlbumScope(album, downloadedItems, "liked").length;
  const fullCount = fixed ? 0 : tracksForAlbumScope(album, downloadedItems, "full", fullTracks).length;
  const ready = readyForAlbum(projects, album, downloadedItems, fullTracks);
  const readyCount = tracks.filter((track) => ready.has(track.id)).length;
  const durationSec = tracks.reduce((total, track) => total + track.durationSec, 0);
  const cover = resolveArtSrc({ imageRef: album.artworkPath });
  const fallbackCover = resolveArtSrc({ imageRef: fallbackArtworkPath });
  const isSourceCollection = Boolean(album.sourceCollection);
  const isSourceTrack = Boolean(album.sourceTrack);
  const verifiedRows = !fixed && scope === "full" && Boolean(fullTracks);
  const otherSources = Array.from(new Set(album.tracks.flatMap((track) => track.sourceStats?.filter((stat) => stat.source !== "apple").map((stat) => SOURCE_LABELS[stat.source]) ?? [])));
  const eyebrow = project
    ? `Project · ${project.kind === "artist" ? "Artist release" : "Custom CD"}`
    : isSourceTrack ? `${SOURCE_LABELS[album.sourceCollection!]} track` : isSourceCollection ? "Collection" : "Album";
  const heading = project?.name ?? album.title;
  const subheading = project
    ? [project.entry.artist, project.entry.album].filter(Boolean).join(" · ")
    : album.artist || "Custom CD";
  const scopeNote = isSourceTrack
    ? "Artwork and artist details come from the original SoundCloud track. MXTP never invents an album for it."
    : isSourceCollection
      ? "These imported tracks came without album details, so MXTP shows them together instead of inventing albums."
      : album.fixedTracks
        ? "This custom CD's own tracklist, in burn order."
        : scope === "liked"
          ? "My Apple Music songs are the tracks saved in your Apple Music library. Spotify and SoundCloud likes are not included."
          : fullTracklistLoading
            ? "Checking the release tracklist. Nothing is being downloaded."
            : fullTracklistError !== undefined
              ? `Could not verify the release tracklist: ${fullTracklistError}. Showing your local tracklist.`
              : fullTracks
                ? "Showing the verified release tracklist."
                : "Showing the tracklist from your library.";
  const downloadLabel = working
    ? "Downloading…"
    : fixed || scope === "liked" ? `Download ${plural(tracks.length, "song")}` : "Download full album";
  const emptyText = isSourceCollection
    ? "No imported tracks are available in this collection."
    : `No songs from this album are in your Apple Music library. ${otherSources.length > 0 ? `It came from ${otherSources.join(" + ")}. ` : ""}Choose Full album to see the release.`;
  return (
    <section className="music-album-detail" data-testid="album-detail">
      <button className="music-back" onClick={onBack}>← {backLabel}</button>
      <div className="music-album-hero">
        <div className="music-album-hero-art"><CoverArtwork src={cover} fallbackSrc={fallbackCover} alt={`${album.title} cover`} /></div>
        <div className="music-album-meta">
          <span>{eyebrow}</span><h1>{heading}</h1>{subheading && subheading !== heading ? <h2>{subheading}</h2> : null}
          <p>{[
            album.genre,
            album.year,
            fixed ? plural(tracks.length, isSourceCollection ? "imported track" : "track") : scope === "liked" ? `My Apple Music songs: ${tracks.length}` : `Full album: ${plural(tracks.length, "song")}`,
            formatDuration(durationSec),
            plural(album.playCount, "play"),
            tracks.length > 0 ? `${readyCount} of ${tracks.length} downloaded` : ""
          ].filter(Boolean).join(" · ")}</p>
          {!fixed ? <div className="music-album-scope" role="group" aria-label="Album download scope" data-help-target="album-scope">
            <button type="button" aria-pressed={scope === "liked"} onClick={() => onScopeChange("liked")}>My Apple Music songs ({likedCount})</button>
            <button type="button" aria-pressed={scope === "full"} onClick={() => onScopeChange("full")}>Full album ({fullCount})</button>
          </div> : null}
          <p className="music-timing-note">
            {scopeNote}
            {!fixed && scope === "full" && fullTracklistError !== undefined ? <> <button type="button" onClick={onRetryTracklist}>Retry</button></> : null}
          </p>
          <div className="music-album-actions">
            <button type="button" className="primary" disabled={working || tracks.length === 0} onClick={onAddAlbum}>Add album to burn list</button>
            <button type="button" data-help-target="album-download" aria-busy={working} disabled={working || tracks.length === 0} onClick={onDownload}>{downloadLabel}</button>
            {onOpenStudio ? <button type="button" onClick={onOpenStudio}>Open cover + booklet studio</button> : null}
            {project && onBurnProject && onDeleteProject ? <ProjectMoreButton project={project} onBurn={onBurnProject} onDelete={onDeleteProject} /> : null}
          </div>
          {status ? <p className="music-album-status" role="status">{status}</p> : null}
          <p className="music-timing-note music-timing-estimate">About 7-20 minutes. Nothing burns until you click Burn CD.</p>
        </div>
      </div>
      <div className="music-track-actions">
        <span>{selectedTrackIds.size} selected</span>
        <button type="button" className="primary" disabled={selectedTrackIds.size === 0} onClick={onAdd}>Add to burn list</button>
        <button type="button" onClick={onSelectAll}>Select all</button>
        <button type="button" onClick={onClear}>Clear selection</button>
      </div>
      {tracks.length === 0 ? <p className="music-empty">{emptyText}</p> : (
        <ul className="music-tracklist" aria-label={`${album.title} tracklist`} style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {tracks.map((track, index) => {
            const isReady = ready.has(track.id);
            const verified = verifiedRows && track.id.includes(":verified:");
            return (
              <li className="music-track-row" key={track.id}>
                <label style={{ display: "contents" }}>
                  <input type="checkbox" checked={selectedTrackIds.has(track.id)} onChange={() => onToggle(track.id)} aria-label={`Select ${track.title}`} />
                  <span className="music-track-number" title={verified ? `Playlist position ${track.trackNumber}` : undefined}>{verified || fixed ? index + 1 : track.trackNumber ?? index + 1}</span>
                  <span className="music-track-title"><strong>{track.title}</strong><small>{track.artist} · {trackSourceLabel(track, album, isReady)}</small></span>
                  {isReady ? <span className="music-download-state ready">Audio ready forever</span> : <span aria-hidden="true" />}
                  <span className="music-track-plays">{plural(track.playCount, "play")}</span>
                  <span className="music-track-duration">{formatDuration(track.durationSec)}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function SourcesView({ sources, busy, notices, onRefreshApple, onChooseAppleLibrary, onImport, onAddAudioFiles }: {
  sources: MusicSourceSummary[];
  busy?: SourceKey;
  notices: Partial<Record<SourceKey, SourceNotice>>;
  onRefreshApple: () => void;
  onChooseAppleLibrary: () => void;
  onImport: (source: ImportedMusicSource["source"], files: FileList | null) => void;
  onAddAudioFiles: () => void;
}) {
  return (
    <section className="music-sources-view" data-testid="music-sources">
      <div className="music-section-heading">
        <div><span>Private local imports</span><h1>Music sources</h1></div>
        <p>Sources tell MXTP what you listen to. MXTP lists those albums, then downloads matching audio from YouTube only when you click Download. Nothing leaves this PC.</p>
      </div>
      <div className="music-source-grid">
        {sources.map((source) => (
          <article className="music-source-card" key={source.source} data-imported={source.imported ? "true" : "false"}>
            <header>
              <span>{source.source === "apple" ? source.imported ? "Read from this computer" : "Not found on this PC" : source.imported ? "Imported" : "Not imported"}</span>
              <h2>{source.label}</h2>
            </header>
            <div className="music-source-metrics">
              <strong>{source.trackCount.toLocaleString()}<small>tracks</small></strong>
              <strong>{source.totalPlays.toLocaleString()}<small>plays</small></strong>
              <strong>{source.playlistCount.toLocaleString()}<small>playlists</small></strong>
            </div>
            {source.source === "apple" ? (
              <>
                <button type="button" data-help-target="apple-update" className="primary music-import-button" onClick={onRefreshApple} disabled={Boolean(busy)}>
                  {busy === "apple" ? "Reading…" : source.imported ? "Re-read Apple Music library" : "Read Apple Music library"}
                </button>
                {!source.imported ? <button type="button" onClick={onChooseAppleLibrary} disabled={Boolean(busy)}>Choose Library.musicdb…</button> : null}
              </>
            ) : (
              <label
                className={`music-import-button ${busy ? "disabled" : ""}`}
                data-help-target={source.source === "spotify" ? "spotify-import" : source.source === "soundcloud" ? "soundcloud-import" : "youtube-music-import"}
              >
                <input type="file" accept=".json,.csv,application/json,text/csv" multiple disabled={Boolean(busy)} onChange={(event) => { onImport(source.source as ImportedMusicSource["source"], event.target.files); event.currentTarget.value = ""; }} />
                <span>{busy === source.source ? "Importing…" : source.imported ? `Replace ${source.label} export` : `Choose ${source.label} export`}</span>
              </label>
            )}
            <SourceNoticeView notice={notices[source.source]} />
            <details className="music-source-howto"><summary>How to get this file</summary><p>{SOURCE_HOWTO[source.source]}</p></details>
            <details><summary>What this source can provide</summary><ul>{source.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></details>
            {source.importedAt ? <small>Imported {new Date(source.importedAt).toLocaleString()}</small> : null}
          </article>
        ))}
        <article className="music-source-card" data-imported="false">
          <header><span>On this PC</span><h2>Audio files on this PC</h2></header>
          <button type="button" className="primary music-import-button" onClick={onAddAudioFiles} disabled={Boolean(busy)}>{busy === "files" ? "Adding…" : "Add audio files…"}</button>
          <SourceNoticeView notice={notices.files} />
          <details className="music-source-howto"><summary>How to get this file</summary><p>Pick WAV, FLAC or MP3 files you already have. MXTP copies them into its own folder and adds them to the burn list, ready to burn.</p></details>
        </article>
      </div>
    </section>
  );
}

function SourceNoticeView({ notice }: { notice?: SourceNotice }) {
  if (!notice?.text) return null;
  if (!notice.error) return <p className="music-source-message" role="status">{notice.text}</p>;
  return (
    <div className="music-source-message error" role="alert">
      <p>{notice.text}</p>
      {notice.detail ? <details><summary>Technical details</summary><p>{notice.detail}</p></details> : null}
    </div>
  );
}

const SOURCE_HOWTO: Record<MusicSource, string> = {
  apple: "MXTP reads the Library.musicdb file the Apple Music app keeps on this PC. Open Apple Music once so it syncs, then click Read Apple Music library. If it lives somewhere else, choose the file yourself.",
  spotify: "Request your data in Spotify's account privacy settings and ask for Extended Streaming History. When the email arrives, choose its JSON files, plus YourLibrary and Playlist JSON if they came with it.",
  soundcloud: "In SoundCloud settings, request a copy of your data. Choose the JSON files from that download.",
  youtubeMusic: "Use Google Takeout, pick YouTube and YouTube Music, and include watch history as JSON. Choose the watch-history JSON and the playlist CSV files."
};

interface ProjectMenuState {
  project: CdProject;
  x: number;
  y: number;
  anchor?: HTMLElement;
}

function menuPositionFromButton(button: HTMLElement) {
  const rect = button.getBoundingClientRect();
  return {
    x: Math.max(12, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 12)),
    y: Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - 190))
  };
}

function ProjectMenu({ menu, onClose, onBurn, onDelete }: {
  menu: ProjectMenuState;
  onClose: (returnFocus: boolean) => void;
  onBurn: (project: CdProject) => void;
  onDelete: (project: CdProject) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const label = projectLabel(menu.project);
  // Focus moves into the menu once per opening, never on a parent re-render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const onClose = (returnFocus: boolean) => onCloseRef.current(returnFocus);
    const closeFromPointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !menu.anchor?.contains(event.target as Node)) onClose(false);
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose(true);
    };
    const closeFromBlur = () => onClose(false);
    window.addEventListener("pointerdown", closeFromPointer);
    window.addEventListener("keydown", closeFromKeyboard);
    window.addEventListener("blur", closeFromBlur);
    return () => {
      window.removeEventListener("pointerdown", closeFromPointer);
      window.removeEventListener("keydown", closeFromKeyboard);
      window.removeEventListener("blur", closeFromBlur);
    };
  }, [menu]);

  function moveFocus(event: ReactKeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next].focus();
  }

  return (
    <div
      ref={menuRef}
      className="music-project-menu"
      role="menu"
      aria-label={`Actions for ${label}`}
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={moveFocus}
    >
      <header><span>Project actions</span><strong>{label}</strong></header>
      <button
        type="button"
        role="menuitem"
        disabled={(menu.project.burnQueue.length || menu.project.tracks.length) === 0}
        onClick={() => { const project = menu.project; onClose(false); onBurn(project); }}
      >
        <strong>Burn project</strong>
        <small>Load its saved order and start the CD burn</small>
      </button>
      <button
        className="danger"
        type="button"
        role="menuitem"
        onClick={() => { const project = menu.project; onClose(false); onDelete(project); }}
      >
        <strong>Delete project…</strong>
        <small>Review a warning before it is removed</small>
      </button>
    </div>
  );
}

function ProjectMoreButton({ project, onBurn, onDelete }: { project: CdProject; onBurn: () => void; onDelete: () => void }) {
  const [menu, setMenu] = useState<ProjectMenuState>();
  const close = (returnFocus: boolean) => {
    const anchor = menu?.anchor;
    setMenu(undefined);
    if (returnFocus) anchor?.focus();
  };
  return (
    <>
      <button
        type="button"
        className="music-card-more"
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        aria-label={`Actions for ${projectLabel(project)}`}
        onClick={(event) => {
          if (menu) { setMenu(undefined); return; }
          const anchor = event.currentTarget;
          setMenu({ project, anchor, ...menuPositionFromButton(anchor) });
        }}
      >⋯</button>
      {menu ? <ProjectMenu menu={menu} onClose={close} onBurn={onBurn} onDelete={onDelete} /> : null}
    </>
  );
}

function ProjectsView({ projects, loading, filter, onFilter, onOpen, onBurn, onRequestDelete, onCreateCustom }: {
  projects: CdProject[];
  loading: boolean;
  filter: ProjectFilter;
  onFilter: (filter: ProjectFilter) => void;
  onOpen: (project: CdProject) => void;
  onBurn: (project: CdProject) => void;
  onRequestDelete: (project: CdProject) => void;
  onCreateCustom: () => void;
}) {
  const [menu, setMenu] = useState<ProjectMenuState>();
  // WebKitGTK follows a right-click's contextmenu with a left-button click that
  // has no press of its own; a real click or key press always comes with one.
  const strayClickRef = useRef(false);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<ProjectSort>("edited");
  const needle = search.trim().toLocaleLowerCase();
  const visible = projects
    .filter((project) => filter === "all" || project.kind === filter)
    .filter((project) => !needle || `${project.name} ${project.entry.artist} ${project.entry.album}`.toLocaleLowerCase().includes(needle))
    .sort((left, right) => sortBy === "name"
      ? projectLabel(left).localeCompare(projectLabel(right))
      : sortBy === "burned"
        ? (right.lastBurnedAt ?? "").localeCompare(left.lastBurnedAt ?? "") || right.updatedAt.localeCompare(left.updatedAt)
        : right.updatedAt.localeCompare(left.updatedAt));

  function openMenu(project: CdProject, x: number, y: number, anchor?: HTMLElement) {
    setMenu({
      project,
      anchor,
      x: Math.max(12, Math.min(x, window.innerWidth - 264)),
      y: Math.max(12, Math.min(y, window.innerHeight - 190))
    });
  }

  function closeMenu(returnFocus: boolean) {
    const anchor = menu?.anchor;
    setMenu(undefined);
    if (returnFocus) anchor?.focus();
  }

  return (
    <section className="music-library-view">
      <div className="music-section-heading">
        <div><span>Your work</span><h1>Projects</h1></div>
        <p>Saved CDs and completed burns. <button type="button" className="music-link-button" onClick={onCreateCustom}>Start a CD for one album</button></p>
      </div>
      <div className="music-project-tools">
        <label className="music-search">
          <span>Find a project</span>
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, artist or album" />
        </label>
        <label className="music-sort">
          <span>Sort</span>
          <select value={sortBy} onChange={(event) => setSortBy(event.target.value as ProjectSort)}>
            <option value="edited">Last edited</option>
            <option value="name">Name</option>
            <option value="burned">Last burned</option>
          </select>
        </label>
      </div>
      <div className="music-project-filters" role="group" aria-label="Filter projects">
        <button className={filter === "all" ? "active" : ""} onClick={() => onFilter("all")}>All</button>
        <button className={filter === "artist" ? "active" : ""} onClick={() => onFilter("artist")}>Artist releases</button>
        <button className={filter === "custom" ? "active" : ""} onClick={() => onFilter("custom")}>Custom CDs</button>
      </div>
      {loading ? <p className="music-empty">Loading projects…</p> : null}
      <div className="music-album-grid">
        {visible.map((project) => {
          const cover = resolveArtSrc(projectCover(project));
          const label = projectLabel(project);
          return (
            <div className="music-project-card" key={project.id} style={{ position: "relative", display: "grid" }}>
              <button
                className="music-album-card"
                onPointerDown={() => { strayClickRef.current = false; }}
                onClick={() => {
                  if (strayClickRef.current) {
                    strayClickRef.current = false;
                    return;
                  }
                  onOpen(project);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  strayClickRef.current = true;
                  openMenu(project, event.clientX, event.clientY, event.currentTarget);
                }}
                onKeyDown={(event) => {
                  strayClickRef.current = false;
                  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                  event.preventDefault();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  openMenu(project, bounds.left + 24, bounds.top + 24, event.currentTarget);
                }}
                aria-label={`Open ${label}`}
                title="Open project"
              >
                <span className="music-album-art">
                  <CoverArtwork src={cover} lazy />
                  <b>Open project</b>
                </span>
                <strong>{label}</strong>
                <span>{project.entry.artist || "Custom CD"}</span>
                <small>{projectMeta(project)}</small>
              </button>
              <button
                type="button"
                className="music-card-more"
                aria-haspopup="menu"
                aria-expanded={menu?.project.id === project.id}
                aria-label={`Actions for ${label}`}
                onClick={(event) => {
                  if (menu?.project.id === project.id) { setMenu(undefined); return; }
                  const anchor = event.currentTarget;
                  setMenu({ project, anchor, ...menuPositionFromButton(anchor) });
                }}
              >⋯</button>
            </div>
          );
        })}
      </div>
      {menu ? <ProjectMenu menu={menu} onClose={closeMenu} onBurn={onBurn} onDelete={onRequestDelete} /> : null}
      {!loading && visible.length === 0 ? <p className="music-empty">{needle ? `No projects match “${search.trim()}”.` : "No saved projects match this filter."}</p> : null}
    </section>
  );
}

const ACCEPT_REPLY = /^(?:yes|yeah|yep|sure|ok|okay|confirm|do it|add it|add them|download it|download them)(?:,?\s*please)?[\s.!]*$/i;
const DECLINE_REPLY = /^(?:no|nope|nah|cancel|skip|no,?\s*thanks)[\s.!]*$/i;

function matches(query: string, fallback: boolean): boolean {
  try {
    return typeof window.matchMedia === "function" ? window.matchMedia(query).matches : fallback;
  } catch {
    return fallback;
  }
}

function readUnsavedList(): { name: string; items: CdBurnItem[] } {
  try {
    const raw = JSON.parse(localStorage.getItem(UNSAVED_KEY) ?? "null") as { name?: unknown; items?: unknown } | null;
    const items = Array.isArray(raw?.items)
      ? (raw.items as CdBurnItem[]).filter((item) => item && typeof item.id === "string" && typeof item.title === "string" && typeof item.durationSec === "number")
      : [];
    return { name: typeof raw?.name === "string" ? raw.name : "", items };
  } catch {
    return { name: "", items: [] };
  }
}

function clearUnsavedStorage() {
  try { localStorage.removeItem(UNSAVED_KEY); } catch { /* storage unavailable */ }
}

function readCuratorMemory(): CuratorMemory {
  const fallback = emptyCuratorState().memory;
  try {
    const raw = JSON.parse(localStorage.getItem(CURATOR_MEMORY_KEY) ?? "null") as Partial<CuratorMemory> | null;
    if (!raw || typeof raw !== "object") return fallback;
    return {
      ...fallback,
      ...raw,
      dislikedArtists: Array.isArray(raw.dislikedArtists) ? raw.dislikedArtists.filter((item) => typeof item === "string") : [],
      preferredGenres: Array.isArray(raw.preferredGenres) ? raw.preferredGenres.filter((item) => typeof item === "string") : [],
      notes: typeof raw.notes === "string" ? raw.notes : ""
    };
  } catch {
    return fallback;
  }
}

function plural(count: number, word: string, many = `${word}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? word : many}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Unicode-aware comparison key: NFKD, marks stripped, letters and digits only. */
function normalizeKey(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}+/gu, "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function titleKey(value: string): string {
  return normalizeKey(
    value
      .replace(/^\d{1,3}\s*[-.]\s*/, "")
      .replace(/\s*[([](?:official\s+)?(?:music\s+)?(?:audio|video|visualizer|lyric(?:s|\s+video)?)(?:\s+\d+k)?[)\]]\s*$/i, "")
      .replace(/\s*[([](?:feat(?:uring)?|ft)\.?\s+[^)\]]+[)\]]\s*$/i, "")
      .replace(/\s+(?:feat(?:uring)?|ft)\.?\s+.+$/i, "")
  );
}

function queueSignature(items: CdBurnItem[]): string {
  // The title counts: a studio rename must resync, or a later library edit saves the old title over it.
  return items.map((item) => `${item.id}|${item.title}|${item.ready?.path ?? item.ready?.url ?? ""}`).join("\n");
}

/** Playlist position from a downloaded file's "NNN - " name prefix. */
function filePosition(track: Track): number | undefined {
  const name = (track.path ?? "").split(/[\\/]/).pop() || track.title;
  const match = /^(\d{3}) - /.exec(name);
  return match ? Number(match[1]) : undefined;
}

/** A verified release position for this item, or 0: never a local-library position. */
function verifiedPosition(item: CdBurnItem, match: YouTubeAlbumMatch, artist: string): number {
  const fromId = /:verified:(\d+)$/.exec(item.id);
  if (fromId) return Number(fromId[1]);
  const key = titleKey(item.title);
  const verified = match.tracks?.find((track) => titleKey(cleanVerifiedTrackTitle(track.title, artist)) === key)?.position;
  if (verified && verified > 0) return verified;
  const positioned = match.trackPositions?.find((track) => titleKey(track.title) === key)?.position;
  return positioned && positioned > 0 ? positioned : 0;
}

/** Downloaded items for each verified row: by file position first, then by title. */
function verifiedReady(fullTracks: AppleMusicTrack[], downloaded: CdBurnItem[]): Map<string, CdBurnItem> {
  const result = new Map<string, CdBurnItem>();
  const taken = new Set<string>();
  const keys = fullTracks.map((track) => titleKey(track.title));
  for (const [index, track] of fullTracks.entries()) {
    const usable = downloaded.filter((item) => item.ready?.path && !taken.has(item.id));
    const byPosition = usable.find((item) => {
      if (filePosition(item.ready!) !== track.trackNumber) return false;
      const own = keys.indexOf(titleKey(item.title));
      return own < 0 || own === index;
    });
    const found = byPosition ?? usable.find((item) => titleKey(item.title) === keys[index]);
    if (!found) continue;
    taken.add(found.id);
    result.set(track.id, found);
  }
  return result;
}

function trackSourceLabel(track: AppleMusicTrack, album: AppleMusicAlbum, isReady: boolean): string {
  const sources = Array.from(new Set(track.sourceStats?.map((item) => SOURCE_LABELS[item.source]) ?? []));
  if (sources.length > 0) return sources.join(" + ");
  if (isAppleLibraryTrack(track)) return "Apple Music";
  if (track.id.includes(":verified:")) {
    const local = album.tracks.find((candidate) => titleKey(candidate.title) === titleKey(track.title));
    return local ? trackSourceLabel(local, album, isReady) : "Release tracklist";
  }
  return isReady ? "MXTP download" : "Your library";
}

function hasDesignedArt(project: CdProject): boolean {
  return project.researchApplied.length > 0 || project.art.some((slot) => slot.slotId !== "front" || slot.imageSource !== "manual");
}

function projectLabel(project: CdProject): string {
  return project.name || project.entry.album || "Untitled CD";
}

function shortDate(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function projectMeta(project: CdProject): string {
  const items = queueFromProject(project);
  const withAudio = items.filter((item) => item.ready).length;
  const edited = shortDate(project.updatedAt);
  const burned = shortDate(project.lastBurnedAt);
  return [
    edited ? `Edited ${edited}` : "",
    plural(items.length, "track"),
    items.length > 0 ? `${withAudio} with audio` : "",
    burned ? `Burned ${burned}` : ""
  ].filter(Boolean).join(" · ");
}

function fileTitle(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name.replace(/\.[^.]+$/, "") || name;
}

function groupQueue(items: CdBurnItem[]): Map<string, CdBurnItem[]> {
  const groups = new Map<string, CdBurnItem[]>();
  items.forEach((item) => groups.set(item.albumKey, [...(groups.get(item.albumKey) ?? []), item]));
  return groups;
}

function queueItemsFromPlaylist(album: AppleMusicAlbum, tracks: Track[]): CdBurnItem[] {
  const libraryTracks = new Map(album.tracks.map((track) => [titleKey(track.title), track]));
  const items: CdBurnItem[] = [];
  tracks.forEach((ready, index) => {
    const title = cleanDownloadedTitle(ready.title, album.artist);
    const libraryTrack = libraryTracks.get(titleKey(title));
    const item: CdBurnItem = {
      id: libraryTrack?.id ?? ready.id,
      albumKey: album.key,
      title: libraryTrack?.title ?? title,
      artist: album.artist,
      album: album.title,
      durationSec: ready.durationSec,
      trackNumber: index + 1,
      sourceStats: libraryTrack?.sourceStats,
      ready: { ...ready, title: libraryTrack?.title ?? title, artist: album.artist, album: album.title }
    };
    if (items.some((candidate) =>
      titleKey(candidate.title) === titleKey(item.title)
      && Math.abs(candidate.durationSec - item.durationSec) <= 5
    )) return;
    items.push(item);
  });
  return items;
}

function cleanDownloadedTitle(title: string, artist: string): string {
  const escapedArtist = artist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return title
    .replace(/^\d{1,3}\s*[-.]\s*/, "")
    .replace(new RegExp(`^${escapedArtist}\\s*[-–—]\\s*`, "i"), "")
    .replace(/\s*[([](?:official\s+)?(?:music\s+)?(?:audio|video|visualizer|lyric(?:s|\s+video)?)(?:\s+\d+k)?[)\]]\s*$/i, "")
    .trim();
}

function tracksForAlbumScope(album: ProjectAlbumView, downloaded: CdBurnItem[], scope: AlbumScope, fullTracks?: AppleMusicTrack[]): AppleMusicTrack[] {
  if (album.sourceCollection || album.fixedTracks) return album.tracks;
  if (scope === "liked") return album.tracks.filter(isAppleLibraryTrack);
  const extraRow = (item: CdBurnItem, index: number): AppleMusicTrack => ({
    id: item.id,
    title: item.title,
    artist: item.artist || album.artist,
    album: album.title,
    albumArtist: album.artist,
    genre: album.genre,
    trackNumber: item.trackNumber ?? index + 1,
    year: album.year,
    durationSec: item.durationSec,
    playCount: 0,
    likeStatus: 0,
    inAppleLibrary: false,
    artworkPath: album.artworkPath,
    sourceStats: item.sourceStats
  });
  if (fullTracks?.length) {
    // The verified release order is the tracklist; downloads that match no
    // verified row (bonus or renamed tracks) follow it.
    const matched = new Set([...verifiedReady(fullTracks, downloaded).values()].map((item) => item.id));
    const verifiedKeys = new Set(fullTracks.map((track) => titleKey(track.title)));
    const extras = downloaded.filter((item) => !matched.has(item.id) && !verifiedKeys.has(titleKey(item.title)));
    return [...fullTracks, ...extras.map((item, index) => extraRow(item, fullTracks.length + index))];
  }
  const sourceTracks = album.tracks;
  if (downloaded.length === 0) return sourceTracks;
  const libraryByTitle = new Map(sourceTracks.map((track) => [titleKey(track.title), track]));
  const usedLibraryIds = new Set<string>();
  const tracks = downloaded.map((item, index) => {
    const libraryTrack = libraryByTitle.get(titleKey(item.title));
    if (libraryTrack) {
      usedLibraryIds.add(libraryTrack.id);
      return libraryTrack;
    }
    return extraRow(item, index);
  });
  return [...tracks, ...sourceTracks.filter((track) => !usedLibraryIds.has(track.id))];
}

function readyForAlbum(projects: CdProject[], album: AppleMusicAlbum, downloaded: CdBurnItem[], fullTracks?: AppleMusicTrack[]): Map<string, Track> {
  const ready = readyTracksForAlbum(projects, album);
  for (const item of downloaded) {
    if (!item.ready?.path) continue;
    ready.set(item.id, canonicalTrack(item.ready, item));
    const libraryTrack = album.tracks.find((track) => titleKey(track.title) === titleKey(item.title));
    if (libraryTrack) ready.set(libraryTrack.id, canonicalTrack(item.ready, item));
  }
  if (fullTracks?.length) {
    for (const [trackId, item] of verifiedReady(fullTracks, downloaded)) ready.set(trackId, canonicalTrack(item.ready!, item));
  }
  return ready;
}

function canonicalTrack(track: Track, item: CdBurnItem): Track {
  return {
    ...track,
    title: item.title,
    artist: item.artist,
    album: item.album,
    durationSec: item.durationSec || track.durationSec
  };
}

function canonicalQueue(items: CdBurnItem[]): CdBurnItem[] {
  return items.map((item) => item.ready ? { ...item, ready: canonicalTrack(item.ready, item) } : item);
}

function mergeAlbumItems(primary: CdBurnItem[], existing: CdBurnItem[]): CdBurnItem[] {
  const merged = [...primary];
  for (const item of existing) {
    if (merged.some((candidate) =>
      titleKey(candidate.title) === titleKey(item.title)
      && Math.abs(candidate.durationSec - item.durationSec) <= 5
    )) continue;
    merged.push(item);
  }
  return canonicalQueue(merged);
}

function mergeQueueItems(existing: CdBurnItem[], additions: CdBurnItem[]): CdBurnItem[] {
  const next = new Map(existing.map((item) => [item.id, item]));
  additions.forEach((item) => next.set(item.id, { ...next.get(item.id), ...item }));
  return [...next.values()];
}

/**
 * Attach fresh audio to the items already in a list (same id, or the same
 * title from the same album) and append only the tracks that are missing.
 * Order and every other item stay as they were.
 */
function attachAudio(existing: CdBurnItem[], fresh: CdBurnItem[]): CdBurnItem[] {
  const next = [...existing];
  for (const item of fresh) {
    const index = next.findIndex((candidate) => candidate.id === item.id);
    const at = index >= 0
      ? index
      : next.findIndex((candidate) => candidate.albumKey === item.albumKey && titleKey(candidate.title) === titleKey(item.title));
    if (at >= 0) next[at] = { ...next[at], ready: item.ready ?? next[at].ready };
    else next.push(item);
  }
  return canonicalQueue(next);
}

function cleanVerifiedTrackTitle(title: string, artist: string): string {
  const escapedArtist = artist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return title
    .replace(new RegExp(`^${escapedArtist}\\s*[-–—]\\s*`, "i"), "")
    .replace(/\s*[([](?:official\s+)?(?:music\s+)?(?:audio|video|visualizer|lyric(?:s|\s+video)?)(?:\s+\d+k)?[)\]]\s*$/i, "")
    .trim() || title;
}

function projectFromQueuePreservingAudio(queue: CdBurnItem[], name: string, existing?: CdProject, now = new Date()): CdProject {
  const canonical = canonicalQueue(queue);
  const project = projectFromBurnQueue(canonical, name, existing, now);
  const retained = new Map<string, Track>();
  for (const track of [...(existing?.tracks ?? []), ...project.tracks]) {
    if (!track.path && !track.url) continue;
    retained.set(track.path || track.url || track.id, track);
  }
  // An emptied project is still the same CD: keep its artist, album and kind.
  // It keeps no tracks either: loading falls back to tracks when the burn list
  // is empty, which would bring a cleared list back. It also lets go of its
  // download folder (sourcePath), so the playlist cache recovers that audio as
  // ready again.
  if (canonical.length === 0 && existing) return { ...project, entry: existing.entry, kind: existing.kind, tracks: [], sourcePath: undefined };
  return { ...project, tracks: [...retained.values()] };
}

function CoverArtwork({ src, fallbackSrc, alt = "", lazy = false }: { src?: string; fallbackSrc?: string; alt?: string; lazy?: boolean }) {
  const sources = [src, fallbackSrc].filter((candidate, index, all): candidate is string => Boolean(candidate) && all.indexOf(candidate) === index);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setAttempt(0), [src, fallbackSrc]);
  const candidate = sources[attempt];
  if (!candidate) return <i data-testid="artwork-fallback">MXTP</i>;
  return <img src={candidate} alt={alt} loading={lazy ? "lazy" : undefined} onError={() => setAttempt((current) => current + 1)} />;
}

function albumFromProject(project: CdProject): AppleMusicAlbum {
  const cover = projectCover(project);
  const artworkPath = cover?.previewRef ?? cover?.imageRef;
  const artist = project.entry.artist;
  const queue = queueFromProject(project);
  const tracks = queue.map((item, index) => ({
    id: item.id || `${project.id}-${index}`,
    title: item.title,
    artist: item.artist || artist,
    album: item.album || project.entry.album,
    albumArtist: artist,
    genre: project.research?.album.tags?.[0] ?? "",
    trackNumber: index + 1,
    year: project.research?.album.year || undefined,
    durationSec: item.durationSec,
    playCount: 0,
    likeStatus: 0,
    inAppleLibrary: false,
    artworkPath,
    sourceStats: item.sourceStats
  } satisfies AppleMusicTrack));
  return {
    key: albumKey(artist, project.entry.album),
    title: project.entry.album || "Untitled CD",
    artist,
    year: project.research?.album.year || undefined,
    genre: project.research?.album.tags?.[0] ?? "",
    artworkPath,
    tracks,
    durationSec: tracks.reduce((total, track) => total + track.durationSec, 0),
    playCount: 0
  };
}

function queueItem(album: AppleMusicAlbum, track: AppleMusicTrack, ready?: Track): CdBurnItem {
  return {
    id: track.id,
    albumKey: album.key,
    title: track.title,
    artist: track.artist || album.artist,
    album: album.title,
    durationSec: track.durationSec,
    trackNumber: track.trackNumber,
    ready,
    sourceStats: track.sourceStats
  };
}

function queueFromProject(project: CdProject): CdBurnItem[] {
  if (project.burnQueue.length > 0) return project.burnQueue;
  return project.tracks.map((track, index) => ({
    id: track.id,
    albumKey: albumKey(project.entry.artist, project.entry.album),
    title: track.title,
    artist: project.entry.artist,
    album: project.entry.album,
    durationSec: track.durationSec,
    trackNumber: index + 1,
    ready: track.path || track.url ? track : undefined
  }));
}

function toggleSet(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
