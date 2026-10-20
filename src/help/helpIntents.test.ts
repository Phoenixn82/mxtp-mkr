import { describe, expect, it } from "vitest";
import { HELP_TARGETS, matchHelpIntent, type HelpIntent } from "./helpIntents";

describe("matchHelpIntent", () => {
  it.each<[string, HelpIntent]>([
    ["How do I fetch my latest Apple Music data?", "update-apple-music"],
    ["Where do I import my Spotify export?", "import-spotify"],
    ["I requested a SoundCloud data copy. How do I load it?", "import-soundcloud"],
    ["How do I use my Google Takeout for YouTube Music?", "import-youtube-music"],
    ["Can I show only Spotify and Apple sources?", "filter-sources"],
    ["Where can I search for an album?", "find-albums"],
    ["How do I switch between liked songs and the full album?", "choose-album-scope"],
    ["How do I download a whole album?", "download-audio"],
    ["How do I burn this mixtape to a blank CD-R?", "burn-cd"],
    ["How can I save this project?", "save-project"],
    ["How do I exit the current project?", "exit-project"],
    ["Where are my saved projects?", "open-projects"],
    ["How do I use the AI curator?", "use-ai-curator"],
    ["How do I switch to Y2K dark mode", "change-theme"],
    ["Where do I edit the cover and booklet?", "open-cover-studio"],
    ["How do I open the cover studio for my project?", "open-cover-studio"]
  ])("matches %s", (question, intent) => {
    expect(matchHelpIntent(question)?.intent).toBe(intent);
  });

  it("returns the navigation view, stable integration selector, and concise answer", () => {
    const match = matchHelpIntent("how do I refresh apple music");
    expect(match).toEqual(expect.objectContaining({
      target: {
        view: "sources",
        selector: HELP_TARGETS.appleUpdate,
        action: "click",
        label: "Read Apple Music library"
      }
    }));
    expect(match?.instructions.length).toBeLessThan(240);
  });

  it("prefers a named service import over the generic source filter", () => {
    expect(matchHelpIntent("Can I include my spotify export?")?.intent).toBe("import-spotify");
  });

  it("does not guess when the question is outside the local help catalog", () => {
    expect(matchHelpIntent("what should I have for dinner?")).toBeNull();
    expect(matchHelpIntent("  ")).toBeNull();
  });

  it.each([
    "Show my favorite songs from 2026",
    "Write me a heavy metal mixtape",
    "Make me a heavy metal mixtape",
    "Write me a mixtape of 90s rock",
    "Find me a mix of music for a road trip",
    "Use a dark vibe mix",
    "remember this mixtape",
    "Make a road trip mix and burn it to a cd later",
    "Switch to Y2K dark mode",
    "yes"
  ])("leaves the mix request %s to the curator", (prompt) => {
    expect(matchHelpIntent(prompt)).toBeNull();
  });

  it("uses the current labels and never tells people to save first", () => {
    const questions = [
      "How do I fetch my latest Apple Music data?", "Where do I import my Spotify export?", "How do I load a SoundCloud export?",
      "How do I use my Google Takeout for YouTube Music?", "Can I show only Spotify sources?", "Where can I search for an album?",
      "How do I switch between liked songs and the full album?", "How do I download a whole album?", "How do I burn a CD?",
      "How can I save this project?", "How do I exit the current project?", "Where are my saved projects?",
      "How do I use the AI curator?", "How do I change the theme?", "Where do I edit the cover and booklet?"
    ];
    const matches = questions.map((question) => matchHelpIntent(question));
    expect(new Set(matches.map((match) => match?.intent)).size).toBe(questions.length);
    for (const match of matches) {
      const text = `${match?.title} ${match?.instructions} ${match?.target.label}`;
      expect(text).not.toMatch(/Prepare audio|Update Apple Music|Save first|Liked songs|—/);
    }
    expect(matchHelpIntent("How do I switch between liked songs and the full album?")?.instructions).toContain("My Apple Music songs");
    expect(matchHelpIntent("How do I switch between liked songs and the full album?")?.instructions).toContain("Full album");
    expect(matchHelpIntent("How do I exit the current project?")?.instructions).toContain("Changes save automatically");
    expect(matchHelpIntent("Where do I edit the cover and booklet?")?.target.label).toBe("Design cover + booklet");
  });
});
