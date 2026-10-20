// WP7 on the real app: curator memory editing, mix requests that are not
// hijacked by help, one 'Add to burn list' decision per pending proposal, the
// help coach (Tab trap, spotlight click-through, above the sticky toolbar at
// 420 px), and the MXTP Light / Y2K Dark theme toggle. Offline: accepting a
// proposal still meets the yt-dlp stub until WP1 stops the download.
import assert from "node:assert/strict";
import { after, before, describe } from "node:test";
import { Key } from "selenium-webdriver";
import { SIZES, setTheme, setWindowSize, settle } from "../helpers.mjs";
import {
  By,
  LIBRARY_TRACKS,
  absent,
  assertNoPageErrors,
  byButton,
  byLabel,
  byTestId,
  click,
  failShots,
  find,
  findVisible,
  launchProj,
  makeSpotifySource,
  savedProjectsOnDisk,
  typeInto,
  waitAbsent,
  waitForCondition,
  writeLibraries
} from "../lib/proj.mjs";
import { tourWp7, uncoveredUnderCoach } from "../lib/wp7.mjs";

const PROMPT = byLabel("Ask the MXTP curator");
const COACH = By.css('.mxtp-coach section[role="dialog"]');
const DECISIONS = '[aria-label="Recommendation decision"]';
const memoryField = (label) => By.xpath(`//div[@data-testid='curator-memory']//label[contains(normalize-space(.), '${label}')]//textarea`);

async function closeCoach(driver) {
  if ((await driver.findElements(COACH)).length === 0) return;
  await click(driver, byLabel("Close guide"));
  await waitAbsent(driver, COACH);
}

async function openCurator(driver) {
  await closeCoach(driver);
  await click(driver, byButton("AI Curator"));
  await findVisible(driver, byTestId("curator-chat"));
}

async function ask(driver, prompt) {
  await typeInto(driver, PROMPT, prompt);
  await (await find(driver, PROMPT)).sendKeys(Key.ENTER);
}

async function decisionTexts(driver) {
  return driver.executeScript(`return [...document.querySelectorAll(${JSON.stringify(DECISIONS)})].map((node) => node.innerText.replace(/\\s+/g, " ").trim())`);
}

async function waitForProposal(driver) {
  await waitForCondition(async () => (await decisionTexts(driver)).length === 1, "no mix proposal was made", 15_000);
}

async function declineIfPending(driver) {
  if ((await decisionTexts(driver)).length === 0) return;
  await click(driver, byButton("No thanks"));
  await waitForCondition(async () => (await decisionTexts(driver)).length === 0, "proposal still pending");
}

async function coachOnTarget(driver) {
  await findVisible(driver, COACH);
  await waitForCondition(
    async () => (await (await find(driver, By.css(".mxtp-coach"))).getAttribute("data-target-found")) === "true",
    "the coach never found its target"
  );
  await driver.sleep(900); // smooth scrollIntoView of the target
  await settle(driver);
}

describe("WP7: curator, help coach, theme toggle", () => {
  let app;
  const it = failShots(() => app?.driver, "wp7");

  before(async () => {
    app = await launchProj({ seed: (dirs) => writeLibraries(dirs, [makeSpotifySource(LIBRARY_TRACKS)]) });
    await findVisible(app.driver, byTestId("apple-library"), 20_000);
  });

  after(async () => {
    await app?.close();
  });

  it("the theme toggle reads MXTP Light / Y2K Dark and setTheme still drives every toggle", async () => {
    const { driver } = app;
    const labels = await driver.executeScript(`
      return [...document.querySelectorAll('[aria-label="Color theme"]')]
        .filter((group) => group.offsetParent !== null)
        .map((group) => [...group.querySelectorAll("button")].map((button) => [button.textContent, button.title]));
    `);
    assert.ok(labels.length >= 1, "no visible theme toggle");
    assert.deepEqual(labels[0], [["MXTP Light", "Use light mode"], ["Y2K Dark", "Use dark mode"]]);
    for (const theme of ["dark", "light"]) {
      await setTheme(driver, theme);
      const outOfSync = await driver.executeScript(`
        const theme = document.documentElement.dataset.theme;
        return [...document.querySelectorAll('[aria-label="Color theme"]')]
          .filter((group) => group.querySelector('button[aria-pressed="true"]')?.title !== "Use " + theme + " mode").length;
      `);
      assert.equal(outOfSync, 0, `a theme toggle disagrees with ${theme}`);
    }
    await tourWp7(driver, "theme-toggle");
  });

  it("Artists to avoid keeps 'Pink Floyd' and a second line, and Done saves both", async () => {
    const { driver } = app;
    await openCurator(driver);
    await click(driver, byButton("Edit memory"));
    await typeInto(driver, memoryField("Artists to avoid"), "Pink Floyd");
    await (await find(driver, memoryField("Artists to avoid"))).sendKeys(Key.ENTER, "Yes");
    assert.equal(await (await find(driver, memoryField("Artists to avoid"))).getAttribute("value"), "Pink Floyd\nYes");
    await typeInto(driver, memoryField("Notes"), "Late night drive, keep it loud");
    await tourWp7(driver, "curator-memory");
    await click(driver, byButton("Done"));
    assert.ok(await absent(driver, byTestId("curator-memory")), "Done did not close the memory editor");
    await click(driver, byButton("Edit memory"));
    assert.equal(await (await find(driver, memoryField("Artists to avoid"))).getAttribute("value"), "Pink Floyd\nYes");
    assert.equal(await (await find(driver, memoryField("Notes"))).getAttribute("value"), "Late night drive, keep it loud");
    // Leave memory empty for the mixes below.
    await typeInto(driver, memoryField("Artists to avoid"), "");
    await typeInto(driver, memoryField("Notes"), "");
    await click(driver, byButton("Done"));
  });

  it("an artist the curator learns while Edit memory is open shows up and survives Done", async () => {
    const { driver } = app;
    await click(driver, byButton("Edit memory"));
    assert.equal(await (await find(driver, memoryField("Artists to avoid"))).getAttribute("value"), "");
    await ask(driver, "avoid Nickelback");
    await waitForCondition(
      async () => (await (await find(driver, memoryField("Artists to avoid"))).getAttribute("value")) === "Nickelback",
      "the open editor never showed the learned artist",
      15_000
    );
    await declineIfPending(driver);
    await click(driver, byButton("Done"));
    await click(driver, byButton("Edit memory"));
    assert.equal(await (await find(driver, memoryField("Artists to avoid"))).getAttribute("value"), "Nickelback", "Done erased the learned artist");
    await typeInto(driver, memoryField("Artists to avoid"), "");
    await click(driver, byButton("Done"));
  });

  it("the global curator names a new custom CD and keeps the intro short", async () => {
    const { driver } = app;
    assert.equal(await (await find(driver, By.id("curator-heading"))).getText(), "New custom CD");
    assert.equal(
      await (await find(driver, byTestId("curator-context"))).getText(),
      "Runs on this PC. Nothing you type and none of your listening history leaves MXTP."
    );
  });

  it("'Show my favorite songs from 2026' is curated, not hijacked by the help coach", async () => {
    const { driver } = app;
    await ask(driver, "Show my favorite songs from 2026");
    await waitForProposal(driver);
    assert.ok(await absent(driver, COACH), "the help coach opened instead");
    await declineIfPending(driver);
  });

  it("'Write me a heavy metal mixtape' gets one 'Add to burn list' decision", async () => {
    const { driver } = app;
    await ask(driver, "Write me a heavy metal mixtape");
    await waitForProposal(driver);
    assert.ok(await absent(driver, COACH), "the help coach opened instead");
    assert.deepEqual(await decisionTexts(driver), ["Add these 2 tracks to the burn list? Nothing downloads yet. Add to burn list No thanks"]);
    const transcript = await (await find(driver, By.css(".curator-transcript"))).getText();
    assert.match(transcript, /Here's a mix with 2 tracks\./);
    assert.match(transcript, /See Sources and evidence below\./);
    assert.doesNotMatch(transcript, /source badges|ranked mix/);
    await tourWp7(driver, "curator-proposal", {
      before: async () => {
        await driver.executeScript(`document.querySelector(${JSON.stringify(DECISIONS)}).scrollIntoView({ block: "center" })`);
      }
    });
  });

  it("after No thanks no decision block remains on any message", async () => {
    const { driver } = app;
    await click(driver, byButton("No thanks"));
    await waitForCondition(async () => (await decisionTexts(driver)).length === 0, "decision blocks remain");
    assert.ok(await absent(driver, byButton("Add to burn list")));
  });

  it("at 420 px the coach covers the sticky toolbar, leaves the composer it points at uncovered, traps Tab and lets the spotlight click through", async () => {
    const { driver } = app;
    await setWindowSize(driver, SIZES.narrow);
    try {
      await ask(driver, "How do I use the AI curator?");
      await coachOnTarget(driver);
      const composer = await uncoveredUnderCoach(driver, '[data-help-target="curator-prompt"]');
      assert.ok(composer.inView && composer.uncovered, `composer hidden under ${composer.beneath}: ${JSON.stringify(composer)}`);
      const topEdge = await driver.executeScript(`
        const coach = document.querySelector(".mxtp-coach");
        return [8, 60, 120].every((y) => coach.contains(document.elementFromPoint(innerWidth / 2, y)));
      `);
      assert.ok(topEdge, "something at the top of the screen sits above the coach overlay");

      for (let press = 0; press < 3; press += 1) {
        await driver.actions().sendKeys(Key.TAB).perform();
        const inside = await driver.executeScript("return document.querySelector('.mxtp-coach-dialog').contains(document.activeElement)");
        assert.ok(inside, `Tab ${press + 1} left the coach`);
      }

      const point = await driver.executeScript(`
        const rect = document.querySelector(".mxtp-coach-spotlight").getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      `);
      await driver.actions().move({ x: point.x, y: point.y, origin: "viewport" }).click().perform();
      await waitAbsent(driver, COACH);
      const focused = await driver.executeScript("return document.activeElement?.getAttribute('aria-label')");
      assert.equal(focused, "Ask the MXTP curator", "the click on the spotlight did not reach the composer");
    } finally {
      await closeCoach(driver);
      await setWindowSize(driver, SIZES.desktop);
    }
  });

  it("help coach screenshots: desktop light, desktop dark, narrow light", async () => {
    const { driver } = app;
    await tourWp7(driver, "help-coach", {
      reset: () => closeCoach(driver),
      before: async () => {
        await ask(driver, "How do I use the AI curator?");
        await coachOnTarget(driver);
      }
    });
    await closeCoach(driver);
  });

  it("project memory keeps every typed character and saves it with the project", async () => {
    const { driver, dirs } = app;
    await ask(driver, "Give me the ultimate heavy metal mixtape");
    await waitForProposal(driver);
    await click(driver, byButton("Add to burn list"));
    const project = await waitForCondition(() => savedProjectsOnDisk(dirs)[0], "accepting did not save a project", 15_000);
    await openCurator(driver);
    assert.equal(await (await find(driver, By.id("curator-heading"))).getText(), project.name);
    await click(driver, byButton("Edit memory"));
    await typeInto(driver, memoryField("Notes"), "Road trip");
    await driver.sleep(1_500);
    const shown = await (await find(driver, memoryField("Notes"))).getAttribute("value");
    const onDisk = savedProjectsOnDisk(dirs).find((saved) => saved.id === project.id)?.curator?.memory?.notes;
    await click(driver, byButton("Done"));
    assert.deepEqual({ shown, onDisk }, { shown: "Road trip", onDisk: "Road trip" });
  });

  it("raised no page errors", async () => {
    await assertNoPageErrors(app.driver);
  });
});
