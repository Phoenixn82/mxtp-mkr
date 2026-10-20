// Studio Audio panel, capacity meter, GO (simulated burn + print PDFs) and the
// burn band's drive / confirm paths, driven on the real release app.
// Burns are simulated: GO never writes media, and the "real" burn path only
// ever meets the cdrskin stand-in, which reports no blank disc and refuses any
// write flag.
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { By, Key, until } from "selenium-webdriver";
import { SIZES, domText, clickWhenEnabled, pageErrors, setWindowSize, settle } from "../helpers.mjs";
import {
  byAria,
  byTestId,
  cdrskinCalls,
  dialogCalls,
  horizontalOverflow,
  inspectPdf,
  launchStudio,
  makeProject,
  makeTrack,
  mxtpDir,
  openProjectFromLanding,
  projectsDir,
  resourceFailures,
  seedArt,
  seedProject,
  setDriveMode,
  slotArt,
  stubDialogs,
  tour,
  trackDurations,
  trackRow,
  trackTitles,
  typeInto,
  waitForProjectFile,
  waitForText,
  writeWav
} from "../lib/audio.mjs";

const WRITE_FLAGS = ["-sao", "-tao", "-raw", "-dao"];
const wroteMedia = (calls) => calls.some((call) => call.argv.some((arg) => WRITE_FLAGS.includes(arg) || arg.startsWith("blank=")));

describe("studio audio panel, capacity, GO and burn band", () => {
  let app;
  let driver;
  const projects = {};
  let importSources = [];
  let goExports = [];
  let openedScrollY;

  before(async () => {
    app = await launchStudio({
      tools: { cdrskin: "none" },
      seed(dirs, home) {
        const audio = path.join(mxtpDir(dirs), "e2e-audio");
        const art = seedArt(dirs);
        const allArt = [slotArt("front", art.front), slotArt("tray", art.tray), slotArt("disc", art.disc)];
        projects.panel = seedProject(dirs, makeProject({
          id: "e2e-panel",
          tracks: [
            makeTrack(audio, { title: "Alpha Tone", seconds: 5, freq: 440 }),
            makeTrack(audio, { title: "Beta Tone", seconds: 6, freq: 550 }),
            makeTrack(audio, { title: "Gamma Tone", seconds: 7, freq: 660 })
          ],
          art: allArt
        }));
        // Declared durations (what the project file records) over 79:57; the
        // files themselves stay tiny.
        projects.overcap = seedProject(dirs, makeProject({
          id: "e2e-overcap",
          album: "Too Long For One Disc",
          tracks: [
            makeTrack(audio, { title: "Long Drone A", seconds: 5, durationSec: 2400 }),
            makeTrack(audio, { title: "Long Drone B", seconds: 5, durationSec: 2421 })
          ],
          art: allArt
        }));
        projects.empty = seedProject(dirs, makeProject({ id: "e2e-empty", album: "Blank Slate", tracks: [], art: [] }));
        projects.missing = seedProject(dirs, makeProject({
          id: "e2e-missing",
          album: "Lost Files",
          tracks: [{ id: path.join(audio, "gone.wav"), title: "Lost Tone", durationSec: 5, path: path.join(audio, "gone.wav") }],
          art: allArt
        }));
        importSources = [
          writeWav(path.join(home, "imports", "Delta Tone.wav"), { seconds: 5, freq: 770 }),
          writeWav(path.join(home, "imports", "Epsilon Tone.wav"), { seconds: 6, freq: 880 })
        ];
      }
    });
    driver = app.driver;
  });

  after(async () => {
    // Remove only PDFs this isolated run produced.
    for (const file of goExports) rmSync(file, { force: true });
    await app?.close();
  });

  async function openProject(project) {
    await openProjectFromLanding(driver, project);
    await stubDialogs(driver, { confirmBurn: false });
  }

  // ---------- populated project ----------

  it("opens a saved project through its album tracklist into the studio", async () => {
    await openProject(projects.panel);
    openedScrollY = await driver.executeScript("return window.scrollY");
    assert.equal(await (await driver.findElement(byTestId("detail-entry-summary"))).getText(), "Test Ensemble · Sine Studies · Jewel case");
    await driver.findElement(By.css("details.status-band > summary")).click();
    const chips = await driver.executeScript(
      "return [...document.querySelectorAll('[data-testid=assigned-strip] .assigned-chip')].map((chip) => chip.textContent + ':' + chip.dataset.filled)"
    );
    assert.deepEqual(chips, ["Front:true", "Tray:true", "Disc:true"]);
    assert.equal(await (await driver.findElement(byTestId("save-project-button"))).getText(), "Saved automatically");
    await tour(driver, "studio", { focus: By.css("[aria-labelledby=preview-heading]") });
  });

  it("opens the studio at the top of the page", async () => {
    assert.equal(openedScrollY, 0, `studio opened scrolled ${openedScrollY}px down`);
  });

  it("fits the studio into a narrow 420px window without horizontal scrolling", async () => {
    await setWindowSize(driver, SIZES.narrow);
    const overflow = await horizontalOverflow(driver);
    await setWindowSize(driver, SIZES.desktop);
    assert.ok(overflow <= 0, `page is ${overflow}px wider than the 420px window`);
  });

  it("lists the project's tracks with durations and an 80-minute capacity meter", async () => {
    assert.deepEqual(await trackTitles(driver), ["Alpha Tone", "Beta Tone", "Gamma Tone"]);
    assert.deepEqual(await trackDurations(driver), ["0:05", "0:06", "0:07"]);
    const meter = await driver.findElement(byTestId("capacity-meter"));
    assert.match(await meter.getText(), /^0:18 \/ 79:57/);
    assert.match(await meter.getAttribute("class"), /\bok\b/);
    const width = await driver.executeScript("return document.querySelector('[data-testid=capacity-meter] .capacity-fill').style.width");
    assert.ok(Math.abs(parseFloat(width) - (18 / 4797) * 100) < 0.01, `fill width ${width}`);
    await tour(driver, "audio-panel", { focus: By.css("[aria-labelledby=audio-heading]") });
  });

  it("renames a track and saves the new title to the project file", async () => {
    const input = await driver.findElement(byAria("Edit title for track 2"));
    await typeInto(driver, input, "Beta Renamed");
    assert.equal(await input.getAttribute("value"), "Beta Renamed");
    await waitForProjectFile(app.dirs, "e2e-panel", (saved) => saved.burnQueue[1]?.title === "Beta Renamed");
  });

  it("moves a track up and saves the exact order", async () => {
    assert.equal((await driver.findElements(By.xpath("//*[@data-testid='track-list']//button[normalize-space(.)='Up']"))).length, 0, "no Up buttons");
    await driver.findElement(byAria("Reorder Gamma Tone")).sendKeys(Key.ARROW_UP);
    await driver.wait(async () => (await trackTitles(driver)).join() === "Alpha Tone,Gamma Tone,Beta Renamed", 5_000, "ArrowUp did not move the track");
    assert.deepEqual(await trackTitles(driver), ["Alpha Tone", "Gamma Tone", "Beta Renamed"]);
    const saved = await waitForProjectFile(app.dirs, "e2e-panel", (project) => project.burnQueue.map((track) => track.title).join() === "Alpha Tone,Gamma Tone,Beta Renamed");
    assert.ok(saved.tracks.every((track) => existsSync(track.path)), "reordered tracks keep their audio paths");
  });

  it("reorders studio tracks by keyboard and drag like the burn list", async () => {
    const handles = await driver.findElements(By.css("[data-testid=track-list] [aria-label^='Reorder']"));
    assert.equal(handles.length, 3, "each studio track needs a drag/keyboard reorder handle");
    await handles[0].sendKeys(Key.ARROW_DOWN);
    await driver.wait(async () => (await trackTitles(driver)).join() === "Gamma Tone,Alpha Tone,Beta Renamed", 5_000, "ArrowDown did not move the track");
    await driver.findElement(byAria("Reorder Alpha Tone")).sendKeys(Key.ARROW_UP);
    await driver.wait(async () => (await trackTitles(driver)).join() === "Alpha Tone,Gamma Tone,Beta Renamed", 5_000, "ArrowUp did not restore the order");
    await waitForProjectFile(app.dirs, "e2e-panel", (saved) => saved.burnQueue.map((track) => track.title).join() === "Alpha Tone,Gamma Tone,Beta Renamed");
  });

  it("pre-listens to a track", async () => {
    const row = await trackRow(driver, "Beta Renamed");
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'})", row);
    await row.findElement(By.xpath(".//button[normalize-space(.)='Play']")).click();
    await waitForText(driver, byTestId("prelisten"), "Now playing: Beta Renamed");
    await driver.wait(
      () => driver.executeScript("const a = document.querySelector('[data-testid=audio-player]'); return Boolean(a && a.src.startsWith('blob:') && !a.paused && a.currentTime > 0.2)"),
      15_000,
      "the pre-listen player never started playing"
    );
    assert.equal((await driver.findElements(By.css("[aria-labelledby=audio-heading] [role=alert]"))).length, 0);
    await tour(driver, "audio-panel-prelisten", { focus: byTestId("prelisten") });
    await driver.executeScript("document.querySelector('[data-testid=audio-player]').pause()");
  });

  it("GO simulates the burn and exports parseable print PDFs", async () => {
    await clickWhenEnabled(driver, byTestId("go-button"));
    await waitForText(driver, byTestId("burn-progress"), "Test burn: 100%", 120_000);
    assert.equal(await driver.executeScript("return document.querySelector('[data-testid=go-error]')?.textContent ?? null"), null, "GO reported no error");
    const listed = (await domText(driver, await driver.findElement(byTestId("export-list")))).replace(/^Exports:\s*/, "");
    goExports = listed.split(" | ").map((item) => item.trim()).filter(Boolean);
    assert.equal(goExports.length, 3, `one PDF per assigned piece: ${listed}`);
    for (const file of goExports) {
      assert.ok(existsSync(file), `${file} was listed but not written`);
      const pdf = inspectPdf(file);
      assert.ok(pdf.pages >= 1, `${file} has no pages`);
      assert.ok(pdf.mediaBoxes.length >= 1 && pdf.mediaBoxes.every((box) => box.wMm > 50 && box.hMm > 50), `${file} media boxes ${JSON.stringify(pdf.mediaBoxes)}`);
      assert.ok(pdf.hasImage, `${file} should embed its assigned artwork`);
    }
    assert.equal(wroteMedia(cdrskinCalls(app.home)), false, "GO must never ask cdrskin to write");
    await waitForProjectFile(app.dirs, "e2e-panel", (saved) => saved.burnProgress === 100 && saved.exports.length === 3);
    await tour(driver, "status-go-simulated", { focus: By.css("details.status-band") });
  });

  it("GO writes its PDFs inside the person's data, not the build checkout", () => {
    assert.equal(goExports.length, 3, "GO must produce three PDFs before their locations are checked");
    for (const file of goExports) assert.ok(file.startsWith(app.home), `${file} is outside the user's HOME`);
  });

  it("GO cleans up its scratch CD audio", () => {
    const leftovers = readdirSync(path.join(app.home, "tmp")).filter((name) => /^mxtp_mkr_track_.*\.wav$/.test(name));
    assert.deepEqual(leftovers, []);
  });

  // ---------- burn band ----------

  it("shows that no burner is connected", async () => {
    await waitForText(driver, byTestId("burner-status"), "No CD writer found. Plug one in with a blank CD-R, then click Detect drives.");
    assert.equal(await (await driver.findElement(byTestId("burn-cd-button"))).isEnabled(), false);
    assert.equal((await driver.findElements(byTestId("reburn-button"))).length, 0, "there is one Burn CD action");
    await clickWhenEnabled(driver, byTestId("detect-burners"));
    await waitForText(driver, byTestId("burn-message"), "No CD writer found.");
    await tour(driver, "burn-band-no-burner", { focus: byTestId("print-burn") });
  });

  it("lists a drive once it is plugged in and Detect drives is clicked", async () => {
    setDriveMode(app.home, "drive");
    await clickWhenEnabled(driver, byTestId("detect-burners"));
    const select = await driver.wait(until.elementLocated(byTestId("burner-select")), 15_000);
    assert.equal(await select.getText(), "MOCK BURNER");
    assert.equal(await select.getAttribute("value"), "/dev/sr9");
    assert.equal(await (await driver.findElement(byTestId("burn-cd-button"))).getText(), "Burn CD");
    assert.equal(await (await driver.findElement(byTestId("burn-cd-button"))).isEnabled(), true);
    await tour(driver, "burn-band-drive", { focus: byTestId("print-burn") });
  });

  it("clears the stale no-burner message once a drive is found", async () => {
    const messages = await driver.findElements(byTestId("burn-message"));
    if (messages.length > 0) assert.doesNotMatch(await messages[0].getText(), /No CD writer found/);
  });

  it("cancelling the burn confirmation burns nothing", async () => {
    const before = cdrskinCalls(app.home).length;
    await stubDialogs(driver, { confirmBurn: false });
    await clickWhenEnabled(driver, byTestId("burn-cd-button"));
    await waitForText(driver, byTestId("burn-message"), "Burn canceled.");
    const [confirm] = (await dialogCalls(driver)).slice(-1);
    assert.equal(confirm.title, "Burn CD?");
    assert.match(confirm.message, /Burn “Sine Studies” — 3 tracks — to the disc in MOCK BURNER\?/);
    assert.match(confirm.message, /cannot be undone/);
    assert.deepEqual(cdrskinCalls(app.home).slice(before), [], "nothing reached cdrskin after Cancel");
  });

  it("a confirmed burn stops before writing when the drive has no blank disc", async () => {
    setDriveMode(app.home, "nomedia");
    const before = cdrskinCalls(app.home).length;
    await stubDialogs(driver, { confirmBurn: true });
    await clickWhenEnabled(driver, byTestId("burn-cd-button"));
    const message = await waitForText(driver, byTestId("burn-message"), /^Burn failed:/, 90_000);
    assert.match(message, /cdrskin reports unwritable media/);
    const calls = cdrskinCalls(app.home).slice(before);
    assert.ok(calls.some((call) => call.argv.includes("-minfo")), "the media probe ran");
    assert.equal(wroteMedia(calls), false, "no write was attempted");
    assert.equal(await (await driver.findElement(byTestId("burn-cd-button"))).getText(), "Burn CD");
    const saved = await waitForProjectFile(app.dirs, "e2e-panel", () => true);
    assert.equal(saved.lastBurnedAt, undefined, "a failed burn is not recorded as burned");
    await stubDialogs(driver, { confirmBurn: false });
    setDriveMode(app.home, "drive");
    await tour(driver, "burn-band-failed", { focus: byTestId("print-burn") });
  });

  it("imports audio through the native file chooser into the project's audio folder", async () => {
    await stubDialogs(driver, { openPaths: importSources });
    const audioSection = await driver.findElement(By.css("[aria-labelledby=audio-heading]"));
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'})", audioSection);
    await audioSection.findElement(By.xpath(".//button[normalize-space(.)='Add audio files…']")).click();
    await driver.wait(async () => (await trackTitles(driver)).includes("Epsilon Tone"), 15_000, "imported tracks never appeared");
    const opened = (await dialogCalls(driver)).filter((call) => call.cmd === "plugin:dialog|open").pop();
    assert.deepEqual(opened.options.filters, [{ name: "Audio", extensions: ["wav", "flac", "mp3"] }]);
    assert.equal(opened.options.multiple, true);
    const audioDir = path.join(projectsDir(app.dirs), "e2e-panel", "audio");
    for (const name of ["Delta Tone.wav", "Epsilon Tone.wav"]) assert.ok(existsSync(path.join(audioDir, name)), `${name} was not copied into ${audioDir}`);
    await waitForProjectFile(app.dirs, "e2e-panel", (saved) => saved.tracks.some((track) => track.path === path.join(audioDir, "Delta Tone.wav")));
    await tour(driver, "audio-panel-imported", { focus: audioSection });
  });

  it("keeps the existing tracks when more audio is imported", async () => {
    assert.deepEqual(await trackTitles(driver), ["Alpha Tone", "Gamma Tone", "Beta Renamed", "Delta Tone", "Epsilon Tone"]);
  });

  it("shows real durations for imported files and counts them toward capacity", async () => {
    const durations = await trackDurations(driver);
    assert.ok(durations.every((value) => value !== "0:00"), `durations ${durations}`);
    assert.doesNotMatch(await (await driver.findElement(byTestId("capacity-meter"))).getText(), /^0:00/);
  });

  // ---------- over capacity ----------

  it("turns the capacity meter red past 79:57", async () => {
    await openProject(projects.overcap);
    const meter = await driver.findElement(byTestId("capacity-meter"));
    assert.match(await meter.getText(), /^80:21 \/ 79:57/);
    assert.match(await meter.getAttribute("class"), /\bbad\b/);
    const fill = await driver.executeScript("const f = document.querySelector('[data-testid=capacity-meter] .capacity-fill'); return f.className + '|' + f.style.width");
    assert.equal(fill, "capacity-fill bad|100%");
    await tour(driver, "audio-panel-overcap", { focus: byTestId("capacity-meter") });
  });

  it("blocks a burn that will not fit on an 80-minute CD before asking to burn", async () => {
    await driver.wait(until.elementLocated(byTestId("burn-cd-button")), 15_000);
    const before = (await dialogCalls(driver)).length;
    await clickWhenEnabled(driver, byTestId("burn-cd-button"));
    await settle(driver);
    const message = await waitForText(driver, byTestId("burn-message"), /./);
    assert.equal((await dialogCalls(driver)).length, before, "no burn confirmation for a mix that cannot fit");
    assert.match(message, /80-minute|does not fit|will not fit|too long/i);
  });

  // ---------- playback error ----------

  it("explains when a track's audio file is missing", async () => {
    await openProject(projects.missing);
    const row = await trackRow(driver, "Lost Tone");
    await row.findElement(By.xpath(".//button[normalize-space(.)='Play']")).click();
    await waitForText(driver, By.css("[aria-labelledby=audio-heading] [role=alert]"), /^Could not load Lost Tone: /);
    await tour(driver, "audio-panel-playback-error", { focus: By.css("[aria-labelledby=audio-heading]") });
  });

  // ---------- empty project ----------

  it("shows an empty audio panel and an honest GO error", async () => {
    await openProject(projects.empty);
    assert.deepEqual(await trackTitles(driver), []);
    assert.match(await (await driver.findElement(byTestId("capacity-meter"))).getText(), /^0:00 \/ 79:57/);
    assert.equal(await (await driver.findElement(byTestId("burn-cd-button"))).isEnabled(), false);
    await tour(driver, "audio-panel-empty", { focus: By.css("[aria-labelledby=audio-heading]") });
    await clickWhenEnabled(driver, byTestId("go-button"));
    await waitForText(driver, byTestId("go-error"), "Add audio first (step 2, Audio). Add front, tray and disc art (step 3, Artwork).");
    assert.equal(await (await driver.findElement(byTestId("burn-progress"))).getText(), "Test burn: not run yet");
    await tour(driver, "status-go-error", { focus: byTestId("go-error") });
  });

  // ---------- page health ----------

  it("raised no page errors other than the pre-listen player's empty-src load", async () => {
    const errors = (await pageErrors(driver)) ?? [];
    const failures = await resourceFailures(driver);
    const unexplained = errors.filter((error) => !(error.type === "resource" && error.message === "failed to load tauri://localhost"));
    assert.deepEqual(unexplained, []);
    assert.ok(failures.every((failure) => failure.tag === "audio" && failure.src === ""), `unexpected resource failures ${JSON.stringify(failures)}`);
  });

  it("raised no page errors at all", async () => {
    assert.deepEqual(await pageErrors(driver), []);
  });
});
