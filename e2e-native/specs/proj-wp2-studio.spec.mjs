// WP2 studio on the real app (landing -> Create album CD, offline): header
// (← Library, title, summary, chip, Save/Saved automatically, Exit project,
// ⋯ menu with Delete), scroll to top on open, audio source actions, the
// Print + burn panel with plain GO errors, and the leave-draft dialog.
// Burns never run: the cdrskin stub finds no writer and no audio exists.
import assert from "node:assert/strict";
import { after, before, describe } from "node:test";
import {
  By,
  Key,
  assertNoPageErrors,
  byButton,
  byTestId,
  click,
  failShots,
  findVisible,
  savedProjectsOnDisk,
  textOf,
  waitAbsent,
  waitForCondition,
  waitTextContains
} from "../lib/proj.mjs";
import { createFromLanding, launchWp2, scrollToTop, tourWp2 } from "../lib/wp2.mjs";

const dialog = By.css('[role="alertdialog"]');

describe("wp2 studio", () => {
  let app;
  let narrowHeaderHeight;
  const it = failShots(() => app?.driver, "wp2-studio");

  before(async () => {
    app = await launchWp2({ theme: "light" });
    // The e2e flag shows SlotEditor's "Assign art" fixture button (no native
    // file picker under WebDriver).
    await app.driver.executeScript("window.__MXTP_MKR_E2E__ = true");
  });

  after(async () => {
    await app?.close();
  });

  it("opens a new album CD at the top with the studio header", async () => {
    const { driver } = app;
    await driver.executeScript("window.scrollTo(0, 400)");
    await createFromLanding(driver, { artist: "Iron Meridian", album: "Forge Lines" });
    assert.equal(await textOf(driver, By.css("h1.studio-title")), "Forge Lines");
    assert.equal(await textOf(driver, byTestId("detail-entry-summary")), "Iron Meridian · Forge Lines · Jewel case");
    assert.equal(await textOf(driver, By.css(".studio-project-chip")), "Unsaved draft");
    assert.equal(await textOf(driver, byTestId("catalog-button")), "← Library");
    assert.equal(await textOf(driver, byTestId("save-project-button")), "Save as project");
    assert.equal(await driver.executeScript("return window.scrollY"), 0);
    // The automatic YouTube lookup runs once after Create; offline it fails plainly.
    await waitTextContains(driver, byTestId("burn-message"), "Automatic YouTube match failed", 30_000);
    await tourWp2(driver, "studio", {
      before: async (mode) => {
        await driver.executeScript("window.scrollTo(0, 0)");
        // Measured during the tour: a second resize here has crashed WebKitWebDriver.
        if (mode.name === "narrow-light") narrowHeaderHeight = await driver.executeScript("return document.querySelector('.studio-header').getBoundingClientRect().height");
      }
    });
    await assertNoPageErrors(driver);
  });

  it("the studio header stays under 120 px tall at 420 px", async () => {
    assert.ok(narrowHeaderHeight < 120, `studio header is ${Math.round(narrowHeaderHeight)} px tall at 420 px`);
  });

  it("groups Find album audio and the playlist link in the audio source actions", async () => {
    const { driver } = app;
    const group = await scrollToTop(driver, By.css(".audio-source-actions"));
    assert.equal(await textOf(driver, byTestId("find-album-burn-button")), "Find album audio");
    await click(driver, By.xpath("//div[contains(@class,'audio-source-actions')]//summary"));
    await findVisible(driver, byTestId("playlist-url"));
    assert.equal(await textOf(driver, byTestId("playlist-burn-button")), "Download playlist");
    assert.ok(await group.findElement(byTestId("playlist-url")));
    await tourWp2(driver, "audio-actions", { before: () => scrollToTop(driver, By.css(".audio-source-actions")) });
  });

  it("Print + burn explains what is missing in plain words and keeps Burn CD off without audio", async () => {
    const { driver } = app;
    await scrollToTop(driver, byTestId("print-burn"));
    assert.equal(await textOf(driver, byTestId("go-button")), "Export print files + test burn");
    await waitTextContains(driver, byTestId("burn-progress"), "Test burn: not run yet");
    assert.equal(await (await findVisible(driver, byTestId("burn-cd-button"))).isEnabled(), false);
    await click(driver, byTestId("go-button"));
    await waitTextContains(driver, byTestId("go-error"), "Add audio first (step 2, Audio).");
    await waitTextContains(driver, byTestId("go-error"), "Add front, tray and disc art (step 3, Artwork).");
    assert.equal(await (await findVisible(driver, By.css("details.status-band"))).getAttribute("open"), null);
    await tourWp2(driver, "print-burn", { before: () => scrollToTop(driver, byTestId("print-burn")) });
    await assertNoPageErrors(driver);
  });

  it("asks before leaving a draft with content; Cancel stays in the studio", async () => {
    const { driver } = app;
    await click(driver, byTestId("assign-art"));
    await driver.executeScript("window.scrollTo(0, 0)");
    await click(driver, byTestId("catalog-button"));
    await waitTextContains(driver, dialog, "Save this CD as a project?");
    await tourWp2(driver, "leave-dialog");
    await click(driver, byButton("Cancel"));
    await waitAbsent(driver, dialog);
    await findVisible(driver, byTestId("detail-view"));
    assert.deepEqual(savedProjectsOnDisk(app.dirs), [], "Cancel saves nothing");
  });

  it("Save as project switches the header to Saved automatically, Exit project and the ⋯ menu", async () => {
    const { driver } = app;
    await click(driver, byTestId("save-project-button"));
    await waitTextContains(driver, byTestId("save-project-button"), "Saved automatically");
    assert.equal(await textOf(driver, By.css(".studio-project-chip")), "Editing project");
    await findVisible(driver, byButton("Exit project"));
    await waitForCondition(() => savedProjectsOnDisk(app.dirs).length === 1, "saved project never reached disk");
    await click(driver, By.css('button[aria-label="Project actions"]'));
    await findVisible(driver, byTestId("delete-project-button"));
    await tourWp2(driver, "studio-saved-menu", {
      before: async () => {
        await driver.executeScript("window.scrollTo(0, 0)");
        if ((await driver.findElements(byTestId("delete-project-button"))).length === 0) {
          await click(driver, By.css('button[aria-label="Project actions"]'));
        }
      }
    });
    await driver.actions().sendKeys(Key.ESCAPE).perform();
    await waitAbsent(driver, byTestId("delete-project-button"));
  });

  it("Exit project returns to the landing with the project listed", async () => {
    const { driver } = app;
    await click(driver, byButton("Exit project"));
    await findVisible(driver, byTestId("landing-screen"));
    await waitTextContains(driver, By.css(".landing-projects-link"), "Your projects (1)");
    await assertNoPageErrors(driver);
  });
});
