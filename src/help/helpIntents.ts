export type HelpView = "current" | "library" | "sources" | "projects" | "curator" | "studio";

export type HelpIntent =
  | "update-apple-music"
  | "import-spotify"
  | "import-soundcloud"
  | "import-youtube-music"
  | "filter-sources"
  | "find-albums"
  | "choose-album-scope"
  | "download-audio"
  | "burn-cd"
  | "save-project"
  | "exit-project"
  | "open-projects"
  | "use-ai-curator"
  | "change-theme"
  | "open-cover-studio";

export type HelpAction = "click" | "type" | "choose" | "drag";

export interface HelpTarget {
  view: HelpView;
  selector: string;
  action: HelpAction;
  label: string;
}

export interface HelpIntentMatch {
  intent: HelpIntent;
  title: string;
  instructions: string;
  target: HelpTarget;
}

export const HELP_TARGETS = {
  appleUpdate: '[data-help-target="apple-update"]',
  spotifyImport: '[data-help-target="spotify-import"]',
  soundcloudImport: '[data-help-target="soundcloud-import"]',
  youtubeMusicImport: '[data-help-target="youtube-music-import"]',
  sourceFilters: '[data-help-target="source-filters"]',
  albumSearch: '[data-help-target="album-search"]',
  albumScope: '[data-help-target="album-scope"]',
  albumDownload: '[data-help-target="album-download"]',
  burnCd: '[data-help-target="burn-cd"]',
  saveProject: '[data-help-target="save-project"]',
  exitProject: '[data-testid="exit-project-button"]',
  projects: '[data-help-target="projects"]',
  curatorPrompt: '[data-help-target="curator-prompt"]',
  themeToggle: '[data-help-target="theme-toggle"]',
  coverStudio: '[data-help-target="cover-studio"]'
} as const;

interface HelpRule extends HelpIntentMatch {
  patterns: readonly RegExp[];
}

const RULES: readonly HelpRule[] = [
  {
    intent: "import-spotify",
    title: "Import Spotify",
    instructions: "Open Music sources and choose your Spotify export. Extended Streaming History JSON gives MXTP the richest local play history; add library or playlist JSON too when Spotify includes it.",
    target: { view: "sources", selector: HELP_TARGETS.spotifyImport, action: "click", label: "Choose Spotify export" },
    patterns: [
      /\b(import|add|connect|load|upload|export|request|get)\b.*\bspotify\b/,
      /\bspotify\b.*\b(import|add|connect|load|upload|export|request|get)\b/
    ]
  },
  {
    intent: "import-soundcloud",
    title: "Import SoundCloud",
    instructions: "Open Music sources and choose the JSON files from your SoundCloud account-data copy. MXTP reads likes, playlists, uploads, and metadata when those files are present.",
    target: { view: "sources", selector: HELP_TARGETS.soundcloudImport, action: "click", label: "Choose SoundCloud export" },
    patterns: [
      /\b(import|add|connect|load|upload|export|request|get|copy)\b.*\bsound\s*cloud\b/,
      /\bsound\s*cloud\b.*\b(import|add|connect|load|upload|export|request|get|copy)\b/
    ]
  },
  {
    intent: "import-youtube-music",
    title: "Import YouTube Music",
    instructions: "Open Music sources and choose the YouTube Music files from Google Takeout. Include watch-history JSON and playlist CSV files so MXTP can recover dated listens and playlist membership.",
    target: { view: "sources", selector: HELP_TARGETS.youtubeMusicImport, action: "click", label: "Choose YouTube Music export" },
    patterns: [
      /\b(import|add|connect|load|upload|export|takeout|request|get)\b.*\byoutube\s*music\b/,
      /\byoutube\s*music\b.*\b(import|add|connect|load|upload|export|takeout|request|get)\b/,
      /\bgoogle\s+takeout\b.*\b(music|youtube)\b/
    ]
  },
  {
    intent: "update-apple-music",
    title: "Read Apple Music library",
    instructions: "Open Music sources and choose Read Apple Music library. MXTP rereads the Apple Music database on this PC and refreshes the album list. Audio you already downloaded stays.",
    target: { view: "sources", selector: HELP_TARGETS.appleUpdate, action: "click", label: "Read Apple Music library" },
    patterns: [
      /\b(update|refresh|rescan|re-?scan|sync|latest|import)\b.*\bapple\s*music\b/,
      /\bapple\s*music\b.*\b(update|refresh|rescan|re-?scan|sync|latest|import)\b/,
      /\b(update|refresh|sync)\b.*\b(library|music data|album list)\b/
    ]
  },
  {
    intent: "filter-sources",
    title: "Choose music sources",
    instructions: "Use the source checkboxes to include Apple Music, Spotify, SoundCloud, or YouTube Music independently. Album and song counts update for exactly the enabled combination.",
    target: { view: "library", selector: HELP_TARGETS.sourceFilters, action: "choose", label: "Included music sources" },
    patterns: [
      /\b(show|view|filter|toggle|switch|combine|include|only)\b.*\b(source|apple|spotify|sound\s*cloud|youtube\s*music)\b/,
      /\b(source|apple|spotify|sound\s*cloud|youtube\s*music)\b.*\b(show|view|filter|toggle|switch|combine|include|only)\b/
    ]
  },
  {
    intent: "choose-album-scope",
    title: "My Apple Music songs or Full album",
    instructions: "Open an album, then choose My Apple Music songs for the tracks saved in your Apple Music library, or Full album for every track on the release. Download follows your choice.",
    target: { view: "library", selector: HELP_TARGETS.albumScope, action: "choose", label: "My Apple Music songs or Full album" },
    patterns: [
      /\b(toggle|switch|choose|show|view|difference|instead)\b.*\b(liked|favorite|saved|full|whole)\b.*\b(album|songs?|tracks?)\b/,
      /\b(liked|favorite|saved)\s+(songs?|tracks?)\b.*\b(full|whole|all)\s+album\b/,
      /\bfull\s+album\b.*\b(liked|favorite|saved|toggle|switch)\b/
    ]
  },
  {
    intent: "find-albums",
    title: "Find an album",
    instructions: "Open Albums and type an artist, album, or genre in Search library. Use the source checkboxes first if you want results from only one service or a specific combination.",
    target: { view: "library", selector: HELP_TARGETS.albumSearch, action: "type", label: "Search library" },
    patterns: [
      /\b(find|search|look\s*for|locate|where)\b.*\b(album|artist|music|library)\b/,
      /\b(album|artist|library)\b.*\b(find|search|look\s*for|locate|where)\b/
    ]
  },
  {
    intent: "download-audio",
    title: "Download audio",
    instructions: "Open an album, choose My Apple Music songs or Full album, then select Download. A full album usually takes 7 to 20 minutes. Finished tracks stay on this PC for good.",
    target: { view: "library", selector: HELP_TARGETS.albumDownload, action: "click", label: "Download" },
    patterns: [
      /\b(download|prepare|make\s+offline|audio\s+ready)\b.*\b(album|songs?|tracks?|audio|music)\b/,
      /\b(album|songs?|tracks?|audio|music)\b.*\b(download|prepare|offline|audio\s+ready)\b/
    ]
  },
  {
    intent: "burn-cd",
    title: "Burn a CD",
    instructions: "Add tracks to the burn list and drag them into order. If some have no audio yet, choose Download in the burn list first. Then insert a blank CD-R, select Burn CD, and keep MXTP open until it finishes.",
    target: { view: "library", selector: HELP_TARGETS.burnCd, action: "click", label: "Burn CD" },
    patterns: [
      /\b(burn|write)\b.*\b(cd|disc|mixtape|album)\b/,
      /\b(cd|disc|cd-r|writer|burner)\b.*\b(burn|write|make|create|use)\b/,
      /\bhow\b.*\b(burner|blank\s+cd)\b/
    ]
  },
  {
    intent: "save-project",
    title: "Save as project",
    instructions: "Name the burn list and choose Save as project. Once a project is open, changes save automatically. It keeps the track order, downloaded audio, artwork, booklet, and curator memory together.",
    target: { view: "library", selector: HELP_TARGETS.saveProject, action: "click", label: "Save as project" },
    patterns: [
      /\b(save|keep|store|remember)\b.*\b(project|cd|mixtape|burn\s*list|work)\b/,
      /\b(project|cd|mixtape|burn\s*list)\b.*\b(save|keep|store|remember)\b/
    ]
  },
  {
    intent: "exit-project",
    title: "Exit the current project",
    instructions: "Choose Exit project to leave the open project and go back to the library. Changes save automatically, so nothing is lost. Use New mix to start a fresh burn list.",
    target: { view: "current", selector: HELP_TARGETS.exitProject, action: "click", label: "Exit project" },
    patterns: [
      /\b(exit|leave|close|quit|back\s+out\s+of)\b.*\b(current\s+|this\s+|open\s+)?project\b/,
      /\bhow\b.*\b(get\s+out\s+of|leave)\b.*\bproject\b/
    ]
  },
  {
    intent: "open-cover-studio",
    title: "Design cover + booklet",
    instructions: "Choose Design cover + booklet under the burn list. The studio edits the case art and booklet at exact print sizes and never changes your print colors. Use ← Library to come back.",
    target: { view: "library", selector: HELP_TARGETS.coverStudio, action: "click", label: "Design cover + booklet" },
    patterns: [
      /\b(open|edit|design|make|create|change)\b.*\b(cover|booklet|artwork|studio|insert)\b/,
      /\b(cover|booklet|artwork|studio|insert)\b.*\b(open|edit|design|make|create|change)\b/
    ]
  },
  {
    intent: "open-projects",
    title: "Open saved projects",
    instructions: "Open Projects to resume a saved artist release or custom CD. Selecting a project restores its burn order and gives you access to its cover, booklet, and curator history.",
    target: { view: "projects", selector: HELP_TARGETS.projects, action: "click", label: "Projects" },
    patterns: [
      /\b(open|find|view|resume|continue|where|manage)\b.*\b(saved\s+)?projects?\b/,
      /\bprojects?\b.*\b(open|find|view|resume|continue|where|manage)\b/
    ]
  },
  {
    intent: "use-ai-curator",
    title: "Ask the AI Curator",
    instructions: "Open AI Curator and describe the mix you want in plain words. It ranks your listening history, explains each pick, and adds them when you choose Add to burn list. Nothing downloads until you do.",
    target: { view: "curator", selector: HELP_TARGETS.curatorPrompt, action: "type", label: "AI Curator request" },
    patterns: [
      /\b(ai\s+)?curator\b/,
      /\b(make|build|create|suggest|recommend)\b.*\b(mixtape|mix|playlist)\b/,
      /\b(replace|avoid|remove)\b.*\b(artist|songs?|tracks?)\b.*\b(mix|mixtape|project)\b/
    ]
  },
  {
    intent: "change-theme",
    title: "Change the theme",
    instructions: "Use Mode to switch between MXTP Light and Y2K Dark. Your choice is saved and does not alter the colors in authored cover or booklet output.",
    target: { view: "current", selector: HELP_TARGETS.themeToggle, action: "choose", label: "Color theme" },
    patterns: [
      /\b(change|switch|toggle|use|turn\s+on)\b.*\b(theme|mode|light|dark|y2k)\b/,
      /\b(light|dark|y2k)\s+(theme|mode)\b/,
      /\btheme\b.*\b(change|switch|toggle|light|dark|y2k)\b/
    ]
  }
];

// Help only answers questions. Without one of these, a prompt such as "Write me
// a heavy metal mixtape" or "Show my favorite songs from 2026" is a mix request
// for the curator, even when it shares words with a help rule.
const HELP_SIGNAL = /\b(how|where|what|which|why|can i|help|guide|explain)\b/;

export function matchHelpIntent(question: string): HelpIntentMatch | null {
  const normalized = normalizeQuestion(question);
  if (!normalized) return null;
  if (!/\?\s*$/.test(question) && !HELP_SIGNAL.test(normalized)) return null;

  const rule = RULES.find((candidate) => candidate.patterns.some((pattern) => pattern.test(normalized)));
  if (!rule) return null;
  const { patterns: _patterns, ...match } = rule;
  return match;
}

function normalizeQuestion(question: string): string {
  return question
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9'+-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
