import { chromium } from "@playwright/test";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
let page;
for (const context of browser.contexts()) {
  for (const candidate of context.pages()) {
    if ((await candidate.title().catch(() => "")) === "MXTP MKR") page = candidate;
  }
}
if (!page) throw new Error("MXTP MKR page not found");

await page.reload();
await page.getByTestId("apple-library").waitFor({ timeout: 60_000 });
const navigation = page.getByRole("navigation", { name: "Music library" });
await navigation.getByRole("button", { name: /Projects/ }).click();
const project = page.locator(".music-album-card", { hasText: "Some Rap Songs" }).first();
await project.waitFor();
await project.click();
await page.getByRole("button", { name: "Open cover + booklet studio" }).click();
await page.getByTestId("detail-view").waitFor({ timeout: 30_000 });

const summary = (await page.getByTestId("detail-entry-summary").innerText()).trim();
assert(summary.includes("Earl Sweatshirt") && summary.includes("Some Rap Songs"), `Wrong studio project: ${summary}`);
await page.getByTestId("case-scene").waitFor({ timeout: 30_000 });
await page.getByTestId("preview-hint").waitFor();
const scene = page.getByTestId("case-scene");
const sceneBox = await scene.boundingBox();
assert(sceneBox, "3D jewel-case scene has no interactive bounds");
await page.mouse.move(sceneBox.x + sceneBox.width * 0.35, sceneBox.y + sceneBox.height * 0.5);
await page.mouse.down();
await page.mouse.move(sceneBox.x + sceneBox.width * 0.65, sceneBox.y + sceneBox.height * 0.5, { steps: 8 });
await page.mouse.up();

const insertTypes = await page.getByTestId("insert-select").locator("option").allTextContents();
assert(insertTypes.length >= 3, "Studio insert editor did not load");
const booklet = page.getByTestId("booklet-preview");
await booklet.waitFor();
const pages = await booklet.locator(".bp-page").count();
assert(pages >= 4, `Booklet preview rendered only ${pages} pages`);
await page.getByTestId("booklet-model-preview").waitFor();

await page.getByTestId("detect-burners").click();
const burnerStatus = (await page.getByTestId("burner-status").innerText()).trim();
console.log(`STUDIO_PROJECT=${summary}`);
console.log(`INSERT_TYPES=${insertTypes.join(" | ")}`);
console.log(`BOOKLET_PAGES=${pages}`);
console.log(`BURNER_STATUS=${burnerStatus}`);
console.log("INSTALLED_STUDIO_LIVE_OK");
await browser.close();
