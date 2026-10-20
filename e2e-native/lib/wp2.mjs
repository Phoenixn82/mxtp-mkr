// WP2 helpers on top of lib/proj.mjs: the three required review modes and the
// landing -> studio path that exists without a music library.
import { SIZES, installErrorCollector, launchApp, screenshot, setTheme, setWindowSize, settle, waitForReady } from "../helpers.mjs";
import { By, applyTheme, byButton, byTestId, click, findVisible, horizontalOverflow, offlineEnv, typeInto } from "./proj.mjs";

/** launchProj with the shared loading-shell-safe ready check. */
export async function launchWp2({ seed, env, size = SIZES.desktop, theme = "light" } = {}) {
  const app = await launchApp({ seed, env: offlineEnv(env) });
  try {
    const { driver } = app;
    await waitForReady(driver, 60_000);
    await installErrorCollector(driver);
    await setWindowSize(driver, size);
    await setTheme(driver, theme);
  } catch (error) {
    await app.close();
    throw error;
  }
  return app;
}

export const WP2_MODES = [
  { name: "desktop-light", size: SIZES.desktop, theme: "light" },
  { name: "desktop-dark", size: SIZES.desktop, theme: "dark" },
  { name: "narrow-light", size: SIZES.narrow, theme: "light" }
];

/**
 * tour-wp2-<screen>-<mode>.png for every WP2 mode. `before(mode)` re-opens or
 * scrolls the state at the new size. Returns [{ file, mode, overflow }].
 */
export async function tourWp2(driver, screen, { before } = {}) {
  const shots = [];
  for (const mode of WP2_MODES) {
    await setWindowSize(driver, mode.size);
    await applyTheme(driver, mode.theme);
    if (before) await before(mode);
    await driver.executeScript("return document.fonts ? document.fonts.ready.then(() => true) : true");
    await settle(driver);
    const file = await screenshot(driver, `tour-wp2-${screen}-${mode.name}`);
    shots.push({ file, mode: mode.name, overflow: await horizontalOverflow(driver) });
  }
  await setWindowSize(driver, SIZES.desktop);
  await applyTheme(driver, "light");
  return shots;
}

export const landingInput = (label) =>
  By.xpath(`//main[@data-testid='landing-screen']//label[contains(normalize-space(.), '${label}')]//input`);

/** Landing form -> studio (fresh unsaved draft). */
export async function createFromLanding(driver, { artist = "", album = "" } = {}) {
  await findVisible(driver, byTestId("landing-screen"), 20_000);
  if (artist) await typeInto(driver, landingInput("Artist"), artist);
  if (album) await typeInto(driver, landingInput("Album"), album);
  await click(driver, byButton(artist && album ? "Create album CD" : "Start custom CD"));
  return findVisible(driver, byTestId("detail-view"), 20_000);
}

/** Scroll an element to the top of the viewport (for panel screenshots). */
export async function scrollToTop(driver, locator) {
  const element = await findVisible(driver, locator);
  // Vertical only: scrollIntoView would also scroll sideways while the studio
  // still overflows at 420 px (WP8 owns that CSS), hiding the left edge.
  await driver.executeScript("window.scrollTo(0, arguments[0].getBoundingClientRect().top + window.scrollY - 8)", element);
  await settle(driver);
  return element;
}

async function shownElement(driver, locator) {
  for (const element of await driver.findElements(locator)) {
    if (await element.isDisplayed().catch(() => false)) return element;
  }
  return null;
}

async function waitShown(driver, locator, timeout = 20_000) {
  let found = null;
  await driver.wait(async () => (found = await shownElement(driver, locator)), timeout, `never visible: ${locator}`);
  return found;
}

/**
 * Open a saved project's cover + booklet studio the way a person does now:
 * a Recent card (landing) or the library's Projects view opens the album
 * layout + tracklist first, and "Open cover + booklet studio" opens the
 * studio. `project` is an id or { id, name }. In the library, a name opens
 * the card in the Projects view ("Open <name>"); an id alone goes back to the
 * landing's Recent list first.
 * Needs WP1's initialProjectId/onOpenProjectStudio.
 */
export async function openProjectStudio(driver, project) {
  const id = typeof project === "string" ? project : project.id;
  const name = typeof project === "string" ? undefined : project.name || project.entry?.album;
  if (await shownElement(driver, byTestId("detail-view"))) {
    await (await waitShown(driver, byTestId("catalog-button"))).click();
    await driver.wait(async () => !(await shownElement(driver, byTestId("detail-view"))), 20_000, "studio never closed");
  }
  let landingCard = await shownElement(driver, byTestId(`project-card-${id}`));
  if (!landingCard && !name) {
    // In the library with only an id: the landing's Recent list knows ids.
    await startCustomFromLibrary(driver);
    landingCard = await waitShown(driver, byTestId(`project-card-${id}`));
  }
  if (landingCard) {
    await landingCard.click();
  } else {
    await (await waitShown(driver, By.xpath("//nav[@aria-label='Music library']/button[starts-with(normalize-space(.), 'Projects')]"))).click();
    await (await waitShown(driver, By.css(`.music-project-card button[aria-label=${JSON.stringify(`Open ${name}`)}]`))).click();
  }
  await waitShown(driver, byTestId("album-detail"));
  if (name) {
    await driver.wait(() => driver.executeScript("return document.querySelector('[data-testid=album-detail] h1')?.textContent === arguments[0]", name), 20_000, `album page never opened for ${name}`);
  }
  const studioButton = await waitShown(driver, By.xpath("//button[normalize-space(.)='Open cover + booklet studio']"));
  // Opening the album starts a smooth scroll; finish positioning before WebKit clicks.
  await driver.executeScript("arguments[0].scrollIntoView({behavior: 'instant', block: 'center', inline: 'nearest'})", studioButton);
  await settle(driver);
  await studioButton.click();
  try {
    await waitShown(driver, byTestId("detail-view"));
  } catch (error) {
    const state = await driver.executeScript(`
      const shown = (el) => el && el.getClientRects().length > 0;
      const dialogs = [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].filter(shown).map((el) => el.innerText.slice(0, 200));
      const detail = document.querySelector('[data-testid=album-detail]');
      return { dialogs, albumDetail: shown(detail) ? detail.innerText.slice(0, 200) : null };
    `);
    throw new Error(`studio never opened for ${id}: ${JSON.stringify(state)} (${error.message})`);
  }
  await settle(driver);
}

/** Return to the single-album create form, including when it is already open. */
export async function startCustomFromLibrary(driver) {
  if (await shownElement(driver, byTestId("landing-screen"))) return;
  await (await waitShown(driver, By.xpath("//nav[@aria-label='Music library']/button[starts-with(normalize-space(.), 'Projects')]"))).click();
  await (await waitShown(driver, By.xpath("//button[normalize-space(.)='Start a CD for one album']"))).click();
  await waitShown(driver, byTestId("landing-screen"));
}
