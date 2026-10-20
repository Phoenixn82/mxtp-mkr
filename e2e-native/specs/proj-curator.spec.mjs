import { installInvokeGuard, invokeLog } from "../lib/lib.mjs";
// AI Curator + Help: global personal-mix chat (propose, decline, accept into a
// new saved project), project chat (mode notice, memory saved with the
// project, exit to a new mix), curator memory editing, and the help coach
// opened from questions typed into the curator. Offline: the accept path's
// download step fails through the yt-dlp stub, as it would with no network.
import assert from "node:assert/strict";
import { after, before, describe } from "node:test";
import { Key } from "selenium-webdriver";
import { SIZES, domText, failShots, pageErrors, setWindowSize } from "../helpers.mjs";
import {
  By,
  LIBRARY_TRACKS,
  absent,
  assertNoPageErrors,
  byButton,
  byLabel,
  byTestId,
  click,
  find,
  findVisible,
  launchProj,
  makeSpotifySource,
  projectFiles,
  savedProjectsOnDisk,
  textOf,
  typeInto,
  waitAbsent,
  waitForCondition,
  waitForProjectOnDisk,
  waitTextContains,
  writeLibraries
} from "../lib/proj.mjs";

const QUEUE_STATUS = By.css('aside[aria-label="CD burn list"] .music-message');
const PROMPT = byLabel("Ask the MXTP curator");
const COACH = By.css('.mxtp-coach section[role="dialog"]');
const memoryField = (label) => By.xpath(`//div[@data-testid='curator-memory']//label[contains(normalize-space(.), '${label}')]//textarea`);

async function openCurator(driver) {
  await closeCoach(driver);
  await click(driver, byButton("AI Curator"));
  await findVisible(driver, byTestId("curator-chat"));
}

async function ask(driver, prompt) {
  await typeInto(driver, PROMPT, prompt);
  await (await find(driver, PROMPT)).sendKeys(Key.ENTER);
}

/** Decision blocks for a real pending proposal ("these N tracks"). */
async function pendingDecisions(driver) {
  return driver.executeScript(
    "return [...document.querySelectorAll('[aria-label=\"Recommendation decision\"]')].filter((node) => /these \\d+ tracks/.test(node.innerText)).length"
  );
}

/** The coach's screen-reader copy (visually hidden, so read textContent). */
async function liveText(driver) {
  return driver.executeScript("return document.getElementById('mxtp-coach-live').textContent");
}

async function closeCoach(driver) {
  if ((await driver.findElements(COACH)).length === 0) return;
  await click(driver, byLabel("Close guide"));
  await waitAbsent(driver, COACH);
}

describe("AI Curator + Help", () => {
  let app;
  const it = failShots(() => app?.driver, "curator");

  before(async () => {
    app = await launchProj({ seed: (dirs) => writeLibraries(dirs, [makeSpotifySource(LIBRARY_TRACKS)]) });
    await findVisible(app.driver, byTestId("apple-library"), 20_000);
    await installInvokeGuard(app.driver);
  });

  after(async () => {
    await app?.close();
  });

  it("the global curator says it creates a new personal mix and offers starters", async () => {
    const { driver } = app;
    await openCurator(driver);
    const section = await find(driver, By.css(".curator-workspace"));
    assert.equal(await section.getAttribute("data-mode"), "global");
    assert.ok(await absent(driver, By.css(".curator-mode-notice")), "a new custom CD has no existing-project notice");
    assert.equal(await domText(driver, await find(driver, By.css(".curator-head span"))), "Curator · new custom CD");
    assert.equal(await textOf(driver, By.id("curator-heading")), "New custom CD");
    assert.match(await textOf(driver, byTestId("curator-context")), /^Runs on this PC\. Nothing you type and none of your listening history leaves MXTP\.$/);
    for (const starter of ["My favorites from 2026", "Ultimate heavy metal", "How do I download a full album?"]) {
      await findVisible(driver, byButton(starter));
    }
    assert.ok(await absent(driver, byTestId("exit-project-button")));
    assert.equal(await (await find(driver, byButton("Send"))).isEnabled(), false, "Send is disabled with an empty prompt");
  });

  it("Edit memory reveals the memory fields; Notes accepts free text", async () => {
    const { driver } = app;
    const toggle = await find(driver, byButton("Edit memory"));
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    await click(driver, byButton("Edit memory"));
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    await findVisible(driver, byTestId("curator-memory"));
    await typeInto(driver, memoryField("Notes"), "Late night drive, keep it loud");
    assert.equal(await (await find(driver, memoryField("Notes"))).getAttribute("value"), "Late night drive, keep it loud");
  });

  it(
    "Artists to avoid accepts a multi-word artist and a second line",
    async () => {
      const { driver } = app;
      await typeInto(driver, memoryField("Artists to avoid"), "Pink Floyd");
      const value = await (await find(driver, memoryField("Artists to avoid"))).getAttribute("value");
      // Reset the field so later tests start from an empty memory either way.
      await typeInto(driver, memoryField("Artists to avoid"), "");
      assert.equal(value, "Pink Floyd");
    }
  );

  it("a mix request returns a ranked proposal that adds and downloads nothing yet", async () => {
    const { driver, dirs } = app;
    await click(driver, byButton("Edit memory"));
    await ask(driver, "Give me the ultimate heavy metal mixtape");
    const decision = await findVisible(driver, By.css('[aria-label="Recommendation decision"]'), 15_000);
    assert.match(await decision.getText(), /Add these 2 tracks to the burn list\? Nothing downloads yet\./);
    assert.equal(await pendingDecisions(driver), 1);
    const transcript = await textOf(driver, By.css(".curator-transcript"));
    assert.match(transcript, /Give me the ultimate heavy metal mixtape/);
    assert.match(transcript, /Here's a mix with 2 tracks/);
    const choices = await driver.executeScript("return [...document.querySelectorAll('.curator-choices li span')].map((n) => n.textContent)");
    assert.equal(choices.length, 2);
    assert.ok(choices.every((choice) => choice.endsWith("— Iron Meridian")), `unexpected picks ${choices}`);
    await waitTextContains(driver, QUEUE_STATUS, "Curator proposal ready: 2 tracks. Decide in AI Curator.");
    assert.ok(await absent(driver, By.css(".music-queue-item")), "a proposal must not touch the burn list");
    assert.deepEqual(projectFiles(dirs), [], "a proposal must not create a project");
  });

  it("No thanks declines: nothing added, nothing saved", async () => {
    const { driver, dirs } = app;
    await click(driver, byButton("No thanks"));
    await waitTextContains(driver, By.css(".curator-transcript"), "No problem. I left the proposed tracks out of the burn list and did not download anything.");
    await waitTextContains(driver, QUEUE_STATUS, "Proposal dismissed. Nothing was downloaded or added.");
    assert.equal(await pendingDecisions(driver), 0, "the declined proposal is still offered");
    assert.ok(await absent(driver, By.css(".music-queue-item")));
    assert.deepEqual(projectFiles(dirs), []);
  });

  it(
    "after a decision no stray 'Add to burn list' prompts remain on other messages",
    async () => {
      const { driver } = app;
      const texts = await driver.executeScript(
        "return [...document.querySelectorAll('[aria-label=\"Recommendation decision\"]')].map((node) => node.innerText.split('\\n')[0])"
      );
      assert.deepEqual(texts, [], `stray decision blocks: ${JSON.stringify(texts)}`);
    }
  );

  it("typing 'no' declines a pending proposal too", async () => {
    const { driver } = app;
    await ask(driver, "Give me the ultimate heavy metal mixtape");
    await waitForCondition(async () => (await pendingDecisions(driver)) === 1, "no pending proposal", 15_000);
    await ask(driver, "no");
    await waitTextContains(driver, QUEUE_STATUS, "Proposal dismissed.");
    assert.equal(await pendingDecisions(driver), 0);
  });

  it("Add to burn list creates a separate saved project and enters project mode", async () => {
    const { driver, dirs } = app;
    await ask(driver, "Make a mixtape of my favorite stuff from 2026");
    await waitForCondition(async () => (await pendingDecisions(driver)) === 1, "no pending proposal", 15_000);
    const count = await driver.executeScript(`
      const block = [...document.querySelectorAll('[aria-label="Recommendation decision"]')].find((node) => /these \\d+ tracks/.test(node.innerText));
      return Number(/these (\\d+) tracks/.exec(block.innerText)[1]);
    `);
    assert.ok(count >= 2, `expected a multi-track proposal, got ${count}`);
    await driver.executeScript(`
      const block = [...document.querySelectorAll('[aria-label="Recommendation decision"]')].find((node) => /these \\d+ tracks/.test(node.innerText));
      block.querySelector("button.primary").scrollIntoView({ block: "center" });
      block.setAttribute("data-e2e-pending", "true");
    `);
    assert.ok(await driver.executeScript("return document.querySelector('[data-e2e-pending] button.primary').getBoundingClientRect().height >= 34"));
    await click(driver, By.css('[data-e2e-pending="true"] button.primary'));
    const project = await waitForCondition(() => savedProjectsOnDisk(dirs)[0], "accepting did not save a project", 15_000);
    assert.equal(project.saved, true);
    assert.equal(project.name, "2026 MXTP");
    assert.equal(project.burnQueue.length, count);
    assert.ok(project.curator.messages.some((message) => /^Confirmed\./.test(message.content)), "confirmation saved in the project chat");
    await waitTextContains(driver, By.css(".music-project-mode-banner"), "Editing project: 2026 MXTP");
    await waitTextContains(driver, QUEUE_STATUS, `Added ${count} tracks to 2026 MXTP. Click Download in the burn list when you want the audio.`, 60_000);
    assert.equal((await driver.findElements(By.css(".music-queue-item"))).length, count);
    assert.equal((await invokeLog(driver)).some((call) => call.command === "download_playlist_best"), false, "accepting a proposal never downloads audio");
  });

  it("project chat names the project it modifies", async () => {
    const { driver } = app;
    await openCurator(driver);
    assert.equal(await (await find(driver, By.css(".curator-workspace"))).getAttribute("data-mode"), "project");
    await waitTextContains(driver, By.css(".curator-mode-notice"), "Requests here change 2026 MXTP. Use Exit project to start a new mix.");
    assert.equal(await textOf(driver, By.id("curator-heading")), "2026 MXTP");
    assert.equal(await domText(driver, await find(driver, By.css(".curator-head span"))), "Curator · editing this project");
  });

  it(
    "project memory keeps every typed character and saves it with the project",
    async () => {
      const { driver, dirs } = app;
      const id = savedProjectsOnDisk(dirs)[0].id;
      await click(driver, byButton("Edit memory"));
      await typeInto(driver, memoryField("Notes"), "Road trip");
      await waitForProjectOnDisk(dirs, id, (project) => project.curator?.memory?.notes === "Road trip", "memory notes never reached disk");
      const shown = await (await find(driver, memoryField("Notes"))).getAttribute("value");
      const onDisk = savedProjectsOnDisk(dirs).find((project) => project.id === id)?.curator?.memory?.notes;
      await click(driver, byButton("Edit memory"));
      assert.deepEqual({ shown, onDisk }, { shown: "Road trip", onDisk: "Road trip" });
    }
  );

  it("Help: 'How do I exit a project?' with a project open spotlights Exit project", async () => {
    const { driver } = app;
    await ask(driver, "How do I exit a project?");
    const coach = await findVisible(driver, COACH);
    assert.equal(await textOf(driver, By.id("mxtp-coach-title")), "Exit the current project");
    assert.match(await coach.getText(), /MXTP GUIDE · 1\/1/);
    await waitForCondition(
      async () => (await (await find(driver, By.css(".mxtp-coach"))).getAttribute("data-target-found")) === "true",
      "spotlight never found the Exit project button"
    );
    const target = await driver.executeScript(`
      const spot = document.querySelector(".mxtp-coach-spotlight").getBoundingClientRect();
      const button = document.querySelector('[data-testid="exit-project-button"]').getBoundingClientRect();
      return spot.left <= button.left && spot.top <= button.top && spot.right >= button.right && spot.bottom >= button.bottom;
    `);
    assert.ok(target, "spotlight does not cover the Exit project button");
    // Enter reveals the full text, Enter again closes.
    await driver.actions().sendKeys(Key.ENTER).perform();
    await waitTextContains(driver, By.css(".mxtp-coach footer"), "to close");
    await driver.actions().sendKeys(Key.ENTER).perform();
    await waitAbsent(driver, COACH);
  });

  it("Exit project to create a new mix returns the curator to a fresh global chat", async () => {
    const { driver } = app;
    await click(driver, byTestId("exit-project-button"));
    await waitTextContains(driver, QUEUE_STATUS, "The burn list is empty and ready for a new mix.");
    assert.equal(await (await find(driver, By.css(".curator-workspace"))).getAttribute("data-mode"), "global");
    assert.equal(await textOf(driver, By.id("curator-heading")), "New custom CD");
    await findVisible(driver, byButton("My favorites from 2026"));
  });

  it("Help: 'How do I exit a project?' with no project open points to Projects", async () => {
    const { driver } = app;
    await ask(driver, "How do I exit a project?");
    try {
      await findVisible(driver, COACH);
      assert.match(await liveText(driver), /^No project is open right now\./);
      // The guide spotlights the Projects button (it does not switch views).
      await waitForCondition(
        async () => (await (await find(driver, By.css(".mxtp-coach"))).getAttribute("data-target-found")) === "true",
        "spotlight never found the Projects button"
      );
      await driver.actions().sendKeys(Key.ESCAPE).perform();
      await waitAbsent(driver, COACH);
    } finally {
      await closeCoach(driver);
    }
  });

  it("Help: the 'How do I download a full album?' starter opens the Download audio guide", async () => {
    const { driver } = app;
    await openCurator(driver);
    await click(driver, byButton("How do I download a full album?"));
    await findVisible(driver, COACH);
    assert.equal(await textOf(driver, By.id("mxtp-coach-title")), "Download audio");
    assert.match(await liveText(driver), /Start here by finding and opening the album you want\.$/);
    await waitForCondition(
      async () => (await (await find(driver, By.css(".mxtp-coach"))).getAttribute("data-target-found")) === "true",
      "spotlight never found Search library"
    );
    await closeCoach(driver);
  });

  it(
    "a mix request that mentions favorite songs is curated, not hijacked by the help coach",
    async () => {
      const { driver } = app;
      await openCurator(driver);
      await ask(driver, "Show my favorite songs from 2026");
      try {
        await waitForCondition(async () => (await pendingDecisions(driver)) === 1, "no mix proposal was made", 5_000);
        assert.ok(await absent(driver, COACH), "the help coach opened instead");
      } finally {
        await closeCoach(driver);
      }
    }
  );

  it(
    "'Write me a heavy metal mixtape' is curated, not routed to the Burn a CD help",
    async () => {
      const { driver } = app;
      await openCurator(driver);
      await ask(driver, "Write me a heavy metal mixtape");
      try {
        await waitForCondition(async () => (await pendingDecisions(driver)) === 1, "no mix proposal was made", 5_000);
        assert.ok(await absent(driver, COACH), "the help coach opened instead");
      } finally {
        await closeCoach(driver);
      }
    }
  );

  it("at the narrow 420 px layout the help coach and its spotlight are on screen", async () => {
    const { driver } = app;
    await closeCoach(driver);
    await setWindowSize(driver, SIZES.narrow);
    try {
      await click(driver, By.xpath("//nav[@aria-label='Music library']/button[starts-with(normalize-space(.), 'Projects')]"));
      await click(driver, byLabel("Open 2026 MXTP"));
      await findVisible(driver, By.css(".music-project-mode-banner button"));
      await openCurator(driver);
      await ask(driver, "How do I exit a project?");
      await findVisible(driver, COACH);
      await findVisible(driver, byTestId("exit-project-button"));
      await waitForCondition(async () => (await driver.findElement(By.css(".mxtp-coach")).getAttribute("data-target-found")) === "true", "guide never reveals its Exit project target");
      const boxes = await driver.executeScript(`
        const box = (node) => { const r = node.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom), Math.round(r.left), Math.round(r.right)]; };
        return {
          dialog: box(document.querySelector(".mxtp-coach-dialog")),
          spotlight: box(document.querySelector(".mxtp-coach-spotlight")),
          target: box(document.querySelector('[data-testid="exit-project-button"]')),
          viewport: [innerHeight, innerWidth]
        };
      `);
      const inView = ([top, bottom, left, right]) => top >= 0 && left >= 0 && bottom <= boxes.viewport[0] && right <= boxes.viewport[1];
      assert.ok(inView(boxes.dialog), `coach dialog off screen: ${JSON.stringify(boxes)}`);
      assert.ok(inView(boxes.target), `spotlit Exit project off screen: ${JSON.stringify(boxes)}`);
      await closeCoach(driver);
      // The guide opened the narrow burn list; use the Exit project it pointed at.
      await click(driver, byTestId("exit-project-button"));
    } finally {
      await closeCoach(driver);
      await setWindowSize(driver, SIZES.desktop);
      if ((await driver.findElements(By.css(".music-project-mode-banner button"))).length) {
        await click(driver, By.css(".music-project-mode-banner button"));
      }
    }
  });

  it("raised no page errors", async () => {
    await assertNoPageErrors(app.driver);
  });

  it(
    "a stray 'Add to burn list' on a non-proposal message is harmless",
    async () => {
      const { driver } = app;
      await openCurator(driver);
      await ask(driver, "Give me the ultimate heavy metal mixtape");
      await waitForCondition(async () => (await pendingDecisions(driver)) === 1, "no pending proposal", 15_000);
      await click(driver, byButton("No thanks"));
      await waitTextContains(driver, QUEUE_STATUS, "Proposal dismissed.");
      const stray = await driver.executeScript(`
        const block = [...document.querySelectorAll('[aria-label="Recommendation decision"]')].find((node) => !/these \\d+ tracks/.test(node.innerText));
        if (!block) return false;
        block.setAttribute("data-e2e-stray", "true");
        return true;
      `);
      if (stray) {
        // The bug path: press the stray primary button and record what happens.
        await click(driver, By.css('[data-e2e-stray="true"] button.primary'));
        await driver.sleep(500);
      }
      const errors = await pageErrors(driver);
      assert.deepEqual({ stray, errors }, { stray: false, errors: [] });
    }
  );
});
