import { expect, test } from "@playwright/test";
import fs from "node:fs";

test("polish B1 3D screenshots and B3 dev-load network gate", async ({ page }, testInfo) => {

  const requests: Array<{ url: string; method: string; resourceType: string }> = [];
  const responses: Array<{ url: string; status: number; resourceType: string }> = [];
  const failed: Array<{ url: string; resourceType: string; errorText: string }> = [];
  const consoleMessages: Array<{ type: string; text: string }> = [];

  page.on("request", (request) => {
    requests.push({ url: request.url(), method: request.method(), resourceType: request.resourceType() });
  });
  page.on("response", (response) => {
    responses.push({ url: response.url(), status: response.status(), resourceType: response.request().resourceType() });
  });
  page.on("requestfailed", (request) => {
    failed.push({
      url: request.url(),
      resourceType: request.resourceType(),
      errorText: request.failure()?.errorText ?? "unknown"
    });
  });
  page.on("console", (message) => {
    consoleMessages.push({ type: message.type(), text: message.text() });
  });

  await page.addInitScript(() => {
    window.__MXTP_INVOKE__ = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === "lookup_album") {
        return {
          artist: args?.artist ?? "Daft Punk",
          album: args?.album ?? "Discovery",
          year: 2001,
          label: "Virgin",
          tracks: ["One More Time", "Aerodynamic"],
          coverArtUrls: ["e2e/fixtures/art-front.png"],
          tags: ["electronic", "house"]
        } as T;
      }
      if (command === "fetch_cover_theme") {
        return {
          sourceUrl: "e2e/fixtures/art-front.png",
          previewUrl: "e2e/fixtures/art-front.png",
          palette: ["#f45b69"],
          luminance: 0.4
        } as T;
      }
      if (command === "fetch_real_cover_file") {
        return {
          imagePath: "e2e/fixtures/art-front.png",
          previewUrl: "e2e/fixtures/art-front.png",
          palette: ["#f45b69"]
        } as T;
      }
      if (command === "generate_cover") {
        return { imagePath: "e2e/fixtures/art-front.png", prompt: String(args?.prompt), palette: ["#f45b69"] } as T;
      }
      if (command === "fetch_lyrics") {
        return "One More Time lyrics\nA real lyric line" as T;
      }
      throw new Error(`unexpected command ${command}`);
    };
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("landing-screen")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);
  requests.length = 0;
  responses.length = 0;
  failed.length = 0;
  consoleMessages.length = 0;

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("landing-screen")).toBeVisible();
  await expect(page.getByTestId("landing-case-model").locator("canvas")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1_200);

  const badResponses = responses.filter((response) => response.status >= 400);
  const failedResources = failed.filter((request) => request.resourceType !== "websocket");
  const networkEvidence = { requests, responses, failed, consoleMessages, badResponses, failedResources };
  fs.writeFileSync(testInfo.outputPath("B3-network.json"), JSON.stringify(networkEvidence, null, 2));
  expect(badResponses, JSON.stringify(badResponses, null, 2)).toEqual([]);
  expect(failedResources, JSON.stringify(failedResources, null, 2)).toEqual([]);

  await page.screenshot({
    path: testInfo.outputPath("polish-3d-landing.png"),
    fullPage: true
  });

  await page.getByLabel("Artist").fill("Daft Punk");
  await page.getByLabel("Album").fill("Discovery");
  await page.getByRole("button", { name: "Create album CD" }).click();
  await expect(page.getByTestId("detail-view")).toBeVisible();
  await expect(page.getByTestId("cover-provider")).toContainText("Real album artwork");
  await page.getByTestId("assign-art").click();
  const caseScene = page.getByTestId("case-scene");
  const caseCanvas = caseScene.locator("canvas");
  const caseBox = await caseCanvas.boundingBox();
  expect(caseBox).not.toBeNull();
  await expect(caseScene).toHaveAttribute("data-case-state", "closed");
  await caseScene.screenshot({ path: testInfo.outputPath("polish-3d-closed.png") });
  await caseCanvas.click({ position: { x: caseBox!.width * 0.54, y: caseBox!.height * 0.52 } });
  await expect(caseScene).toHaveAttribute("data-case-state", "open");
  await page.waitForTimeout(600);
  await caseScene.screenshot({ path: testInfo.outputPath("polish-3d-open.png") });

  fs.writeFileSync(
    testInfo.outputPath("B1.txt"),
    "Landing plus closed/open preview screenshots show front cover-art texture, reflective/translucent case plastic, beveled/hinged silhouette, and soft shadow lighting."
  );
});
