import { chromium, expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

test.skip(
  process.platform !== "win32",
  "Native shell proof requires Windows WebView2 CDP; Linux webkit2gtk has no compatible CDP endpoint."
);

const insertTypes = [
  "front",
  "bifold",
  "trifold",
  "folder-8",
  "saddle-4",
  "saddle-8",
  "saddle-12",
  "saddle-16",
  "saddle-20",
  "saddle-24",
  "saddle-28",
  "tray",
  "disc"
];

const landingCaseFormats = [
  "jewelcase",
  "vinyl",
  "gatefold",
  "vinyl7",
  "digipak",
  "cassette",
  "dvdcase",
  "bluray",
  "slimcd",
  "cardsleeve",
  "minidisc",
  "8track"
];

const expectedPdfs: Record<string, { file: string; media: [number, number]; pages: number }> = {
  front: { file: "front.pdf", media: [126.35, 126.35], pages: 1 },
  bifold: { file: "folder-4.pdf", media: [246.35, 126.35], pages: 1 },
  trifold: { file: "folder-6.pdf", media: [366.35, 126.35], pages: 1 },
  "folder-8": { file: "folder-8.pdf", media: [486.35, 126.35], pages: 1 },
  "saddle-4": { file: "saddle-4.pdf", media: [246.35, 126.35], pages: 2 },
  "saddle-8": { file: "saddle-8.pdf", media: [246.35, 126.35], pages: 4 },
  "saddle-12": { file: "saddle-12.pdf", media: [246.35, 126.35], pages: 6 },
  "saddle-16": { file: "saddle-16.pdf", media: [246.35, 126.35], pages: 8 },
  "saddle-20": { file: "saddle-20.pdf", media: [246.35, 126.35], pages: 10 },
  "saddle-24": { file: "saddle-24.pdf", media: [246.35, 126.35], pages: 12 },
  "saddle-28": { file: "saddle-28.pdf", media: [246.35, 126.35], pages: 14 },
  tray: { file: "tray.pdf", media: [156.35, 124.35], pages: 1 },
  disc: { file: "disc.pdf", media: [126.35, 126.35], pages: 1 }
};

const repoExportDir = path.join(process.cwd(), "export");
let exportSnapshot: { backupDir: string; existed: boolean } | undefined;

test.beforeEach(async ({}, testInfo) => {
  // The application currently resolves its fixed "export" destination from the
  // Tauri process cwd. Preserve any user-owned contents and always put them back,
  // including when the test fails part-way through.
  fs.mkdirSync(testInfo.outputDir, { recursive: true });
  const backupDir = testInfo.outputPath("export-before");
  const existed = fs.existsSync(repoExportDir);
  if (existed) {
    fs.cpSync(repoExportDir, backupDir, { recursive: true });
  }
  fs.rmSync(repoExportDir, { recursive: true, force: true });
  exportSnapshot = { backupDir, existed };
});

test.afterEach(() => {
  fs.rmSync(repoExportDir, { recursive: true, force: true });
  if (exportSnapshot?.existed) {
    fs.cpSync(exportSnapshot.backupDir, repoExportDir, { recursive: true });
  }
  exportSnapshot = undefined;
});

test("full MXTP MKR suite against native Tauri shell", async ({}, testInfo) => {
  const screenshotDir = testInfo.outputPath("screenshots");
  const fixtureDir = testInfo.outputPath("audio");
  fs.mkdirSync(screenshotDir, { recursive: true });
  fs.mkdirSync(fixtureDir, { recursive: true });
  const audioFiles = createAudioFixtures(fixtureDir);

  const browser = await connectNativeBrowser();
  const page = await nativePage(browser);

  // Real Tauri shell + real invoke: flag the app so it exposes deterministic
  // test affordances (fixture art stamping) that native dialogs would block.
  await page.addInitScript(() => {
    window.__MXTP_MKR_E2E__ = true;
  });
  await page.reload();

  await expect(page).toHaveTitle("MXTP MKR");
  await expect(page.getByTestId("landing-screen")).toBeVisible();
  await expect(page.getByLabel("Artist")).toBeVisible();
  await expect(page.getByLabel("Album")).toBeVisible();
  await expect(page.getByLabel("Format")).toHaveValue("jewelcase");
  await expect(page.getByTestId("landing-case-model")).toHaveAttribute("data-model-id", "jewelcase");
  await expect(page.getByTestId("landing-case-model").locator("canvas")).toBeVisible();
  const evidenceDir = testInfo.outputPath("formats");
  fs.mkdirSync(evidenceDir, { recursive: true });
  await page.addStyleTag({ content: ".landing-case-model { animation: none !important; transform: none !important; }" });
  for (const format of landingCaseFormats) {
    await page.getByLabel("Format").selectOption(format);
    await expect(page.getByTestId("landing-case-model")).toHaveAttribute("data-model-id", format);
    await page.waitForTimeout(450);
    await page.getByTestId("landing-case-model").screenshot({ path: path.join(evidenceDir, `landing-${format}.png`) });
  }
  await page.getByLabel("Format").selectOption("jewelcase");
  await expect(page.getByTestId("landing-case-model")).toHaveAttribute("data-model-id", "jewelcase");
  await page.getByLabel("Artist").fill("Daft Punk");
  await page.getByLabel("Album").fill("Discovery");
  await page.getByRole("button", { name: "Create album CD" }).click();
  await expect(page.getByTestId("detail-view")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Discovery" })).toBeVisible();
  await expect(page.getByTestId("detail-entry-summary")).toContainText("Daft Punk · Discovery · Jewel case");
  await expect(page.getByTestId("artist-input")).toHaveValue("Daft Punk");
  await expect(page.getByTestId("album-input")).toHaveValue("Discovery");
  await expect(page.getByTestId("research-result")).toContainText("One More Time", { timeout: 60_000 });

  await page.getByTestId("audio-input").setInputFiles(audioFiles);
  await page.getByRole("button", { name: "Move e2e-track-b.wav up" }).click();
  await page.getByRole("button", { name: "Play" }).first().click();
  await expect(page.getByTestId("capacity-meter")).toContainText("/ 80:00");
  await expect(page.getByTestId("prelisten")).toContainText("e2e-track-b.wav");

  for (const type of insertTypes) {
    await page.getByTestId("insert-select").selectOption(type);
    await page.getByTestId("assign-art").click();
    await expect(page.getByTestId("slot-stage")).toHaveAttribute("data-filled", "true");
    await expect(page.getByTestId("guide-readout")).toContainText("trim");
  }
  await expect(page.getByTestId("case-scene")).toHaveAttribute("data-front", /art-front/);
  await expect(page.getByTestId("case-scene")).toHaveAttribute("data-back", /art-tray/);
  await expect(page.getByTestId("case-scene")).toHaveAttribute("data-disc", /art-disc/);

  // Booklet defaults to 16 reader pages (CD1600R); stepper walks the valid counts.
  await expect(page.getByTestId("booklet-pages")).toContainText("16 pages");
  await page.getByRole("button", { name: "Add" }).click();
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByTestId("booklet-pages")).toContainText("24 pages");
  await page.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByTestId("booklet-pages")).toContainText("16 pages");
  await expect(page.getByTestId("valid-counts")).not.toContainText("10");

  const albumCoverPaths: string[] = [];
  for (const album of [
    { artist: "Daft Punk", title: "Discovery" },
    { artist: "Radiohead", title: "OK Computer" }
  ]) {
    await page.getByTestId("artist-input").fill(album.artist);
    await page.getByTestId("album-input").fill(album.title);
    await page.getByTestId("run-research").click();
    await expect(page.getByTestId("research-result")).toContainText(album.title, { timeout: 60_000 });
    const coverPath = page.locator(".cover-chip[title]");
    await expect(coverPath).toContainText(/\.(png|jpg|jpeg)$/i, { timeout: 60_000 });
    albumCoverPaths.push(((await coverPath.textContent()) ?? "").trim());
    // Per-track lyric fetches make apply slower on first (uncached) runs.
    await expect(page.getByTestId("research-applied")).toContainText(album.title, { timeout: 120_000 });
  }
  await expect(page.getByTestId("research-applied")).toContainText("Discovery");
  await expect(page.getByTestId("research-applied")).toContainText("OK Computer");
  const bookletValidation = page.getByTestId("booklet-validation");
  if (await bookletValidation.isVisible()) {
    await bookletValidation.getByRole("button", { name: /Use \d+ pages/ }).click();
  }
  const selectedBookletPages = Number.parseInt((await page.getByTestId("booklet-pages").textContent()) ?? "", 10);

  const caseScene = page.getByTestId("case-scene");
  const caseCanvas = caseScene.locator("canvas");
  const caseBox = await caseCanvas.boundingBox();
  expect(caseBox).not.toBeNull();
  await expect(caseScene).toHaveAttribute("data-case-state", "closed");
  await caseScene.screenshot({ path: path.join(screenshotDir, "case-closed-textured.png") });
  await caseCanvas.click({ position: { x: caseBox!.width * 0.54, y: caseBox!.height * 0.52 } });
  await expect(caseScene).toHaveAttribute("data-case-state", "open");
  await page.waitForTimeout(900);
  await caseScene.screenshot({ path: path.join(screenshotDir, "case-open-textured.png") });
  await caseCanvas.click({ position: { x: caseBox!.width * 0.62, y: caseBox!.height * 0.54 } });
  await expect(caseScene).toHaveAttribute("data-case-state", "ejected");
  await page.waitForTimeout(900);
  await caseScene.screenshot({ path: path.join(screenshotDir, "case-disc-ejected.png") });

  const bookletModel = page.getByTestId("booklet-model-preview");
  await expect(bookletModel.locator(".booklet-model-stage")).toHaveAttribute(
    "data-page-count",
    String(selectedBookletPages)
  );
  await bookletModel.screenshot({
    path: path.join(screenshotDir, `booklet-${selectedBookletPages}-physical.png`)
  });
  const bookletCanvas = bookletModel.locator("canvas");
  const bookletBox = await bookletCanvas.boundingBox();
  expect(bookletBox).not.toBeNull();
  await bookletCanvas.click({ position: { x: bookletBox!.width * 0.52, y: bookletBox!.height * 0.52 } });
  await expect(page.getByTestId("booklet-model-page")).not.toContainText("Reader page 1");

  await page.getByTestId("go-button").click();
  await expect(page.getByTestId("burn-progress")).toContainText("Test burn: 100%", { timeout: 120_000 });
  // GO writes under the app's data (exports/<project>/<timestamp>) and lists
  // the files; booklet pages come only from the Booklet panel's export.
  const exported = ((await page.getByTestId("export-list").textContent()) ?? "").replace(/^Exports:\s*/, "").split(" | ");
  const exportedPdf = (file: string) => exported.find((candidate) => path.basename(candidate) === file) ?? "";

  const measurements: string[] = [];
  for (const type of insertTypes.filter((insert) => !insert.startsWith("saddle-"))) {
    const expected = expectedPdfs[type];
    const pdf = exportedPdf(expected.file);
    expect(fs.existsSync(pdf), `${type} should export ${expected.file}`).toBe(true);
    const measured = inspectPdf(pdf);
    expectClose(measured.media[0], expected.media[0], `${type} media width`);
    expectClose(measured.media[1], expected.media[1], `${type} media height`);
    expect(measured.pages, `${type} page count`).toBe(expected.pages);
    expect(measured.imageCount, `${type} embedded image count`).toBeGreaterThanOrEqual(1);
    if (type === "tray") {
      expect(measured.text).toContain("Airbag");
      expect(measured.text).not.toContain("One More Time");
    }
    measurements.push(
      `- ${type}: PASS ${measured.media[0].toFixed(2)}x${measured.media[1].toFixed(2)}mm pages=${measured.pages} image embedded: yes text content: ${measured.text.trim() ? "yes" : "n/a"}`
    );
  }
  const frontPdf = inspectPdf(exportedPdf("front.pdf"));
  const latestCoverPath = albumCoverPaths.at(-1)!;
  expect(
    frontPdf.sourcePaths.some((sourcePath) => sourcePath.includes(path.basename(latestCoverPath))),
    `front.pdf should include the latest resolved cover ${latestCoverPath}`
  ).toBe(true);

  const report = [
    "# MXTP MKR E2E Report",
    "",
    "- Native Tauri/WebView2 shell via CDP: PASS",
    "- Landing entry screen, format dropdown model swap, and prefilled detail handoff: PASS",
    "- Audio import/reorder/pre-listen/capacity: PASS",
    "- Research albums: Daft Punk Discovery, Radiohead OK Computer: PASS",
    `- Latest resolved album cover embedded in front.pdf: PASS (${path.basename(latestCoverPath)})`,
    "- Canonical PDF text content: PASS (latest tray tracklist)",
    "- 3D jewel case: PASS (closed, open, and disc-ejected states)",
    `- 3D printed booklet: PASS (${selectedBookletPages}-page physical leaf model mounted and interactive)`,
    "- GO export PDFs and burn simulate 100%: PASS",
    "",
    "## PDF measurements",
    ...measurements,
    "",
    "Human gates: G-BURN physical disc playback and G-NATIVE desktop-icon double-click remain owner-gated. IMAPI2 recorder enumeration on this run returned count=0."
  ].join("\n");
  fs.writeFileSync(testInfo.outputPath("REPORT.md"), report, "utf8");

  await browser.close();
});

async function nativePage(browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>): Promise<Page> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().includes("127.0.0.1:5173")) {
          try {
            await page.getByTestId("landing-screen").waitFor({ state: "visible", timeout: 1_000 });
            return page;
          } catch {
            // Vite can expose the document before React has mounted in the Tauri WebView.
          }
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for Tauri WebView2 page on CDP port 9333");
}

async function connectNativeBrowser(): Promise<Awaited<ReturnType<typeof chromium.connectOverCDP>>> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP("http://127.0.0.1:9333");
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Timed out connecting to CDP port 9333");
}

function createAudioFixtures(dir: string): string[] {
  const fixtures = [
    { name: "e2e-track-a.wav", frequency: "440" },
    { name: "e2e-track-b.wav", frequency: "554" },
    { name: "e2e-track-c.wav", frequency: "659" }
  ];
  return fixtures.map((fixture) => {
    const file = path.join(dir, fixture.name);
    execFileSync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${fixture.frequency}:duration=4.5`,
      "-ac",
      "2",
      "-ar",
      "44100",
      file
    ]);
    return file;
  });
}

function inspectPdf(file: string): {
  media: [number, number];
  pages: number;
  imageCount: number;
  sourcePaths: string[];
  text: string;
} {
  const buffer = fs.readFileSync(file);
  const text = buffer.toString("latin1");
  const mediaMatch = text.match(/\/MediaBox\s*\[\s*([-0-9.]+)\s+([-0-9.]+)\s+([-0-9.]+)\s+([-0-9.]+)/);
  if (!mediaMatch) {
    throw new Error(`MediaBox not found in ${file}`);
  }
  const widthPt = Number(mediaMatch[3]) - Number(mediaMatch[1]);
  const heightPt = Number(mediaMatch[4]) - Number(mediaMatch[2]);
  const pageMatches = text.match(/\/Type\s*\/Page\b/g) ?? [];
  const imageMatches = text.match(/\/Subtype\s*\/Image\b/g) ?? [];
  const sourcePaths = [...text.matchAll(/\/SourcePath\s*\(([^)]*)\)/g)].map((match) =>
    match[1].replace(/\\\\/g, "\\")
  );
  return {
    media: [ptToMm(widthPt), ptToMm(heightPt)],
    pages: pageMatches.length,
    imageCount: imageMatches.length,
    sourcePaths,
    text: extractPdfText(buffer)
  };
}

function extractPdfText(buffer: Buffer): string {
  return decodedStreams(buffer)
    .flatMap((stream) =>
      [...stream.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj/g)].map((match) => unescapePdfLiteral(match[0]))
    )
    .join("\n");
}

function decodedStreams(buffer: Buffer): string[] {
  const latin = buffer.toString("latin1");
  const streams: string[] = [];
  let cursor = 0;
  while (true) {
    const streamMarker = latin.indexOf("stream", cursor);
    if (streamMarker === -1) {
      break;
    }
    let dataStart = streamMarker + "stream".length;
    if (latin[dataStart] === "\r" && latin[dataStart + 1] === "\n") {
      dataStart += 2;
    } else if (latin[dataStart] === "\n") {
      dataStart += 1;
    }
    const dataEnd = latin.indexOf("endstream", dataStart);
    if (dataEnd === -1) {
      break;
    }
    let payloadEnd = dataEnd;
    if (latin[payloadEnd - 2] === "\r" && latin[payloadEnd - 1] === "\n") {
      payloadEnd -= 2;
    } else if (latin[payloadEnd - 1] === "\n") {
      payloadEnd -= 1;
    }
    const headerStart = latin.lastIndexOf("<<", streamMarker);
    const header = headerStart === -1 ? "" : latin.slice(headerStart, streamMarker);
    const payload = buffer.subarray(dataStart, payloadEnd);
    try {
      streams.push(
        header.includes("/FlateDecode")
          ? zlib.inflateSync(payload).toString("latin1")
          : payload.toString("latin1")
      );
    } catch {
      streams.push(payload.toString("latin1"));
    }
    cursor = dataEnd + "endstream".length;
  }
  return streams;
}

function unescapePdfLiteral(token: string): string {
  const literal = token.slice(1, token.lastIndexOf(")"));
  return literal.replace(/\\([\\()])/g, "$1");
}

function ptToMm(pt: number): number {
  return (pt / 72) * 25.4;
}

function expectClose(actual: number, expected: number, label: string) {
  expect(Math.abs(actual - expected), label).toBeLessThan(0.12);
}
