import { describe, expect, it } from "vitest";
import { assertSaddlePageCount, buildBookletLeaves, type BookletPageData } from "./Booklet3D";

describe("physical 3D saddle booklet mapping", () => {
  it.each([8, 12, 16, 20, 24])("maps %i reader pages to distinct recto/verso leaves", (pages) => {
    const pageData: BookletPageData[] = Array.from({ length: pages }, (_, index) => ({
      text: `Reader page ${index + 1}`,
      image: `/page-${index + 1}.png`
    }));
    const leaves = buildBookletLeaves(pages, pageData);
    expect(leaves).toHaveLength(pages / 2);
    expect(leaves[0].recto).toMatchObject({ pageNumber: 1, image: "/page-1.png" });
    expect(leaves[0].verso).toMatchObject({ pageNumber: 2, image: "/page-2.png" });
    expect(leaves.at(-1)?.recto.pageNumber).toBe(pages - 1);
    expect(leaves.at(-1)?.verso.pageNumber).toBe(pages);
    expect(leaves.every((leaf) => leaf.recto.image !== leaf.verso.image)).toBe(true);
  });

  it("uses the supplied cover only for reader page one", () => {
    const leaves = buildBookletLeaves(8, [], "/album-cover.png");
    expect(leaves[0].recto.image).toBe("/album-cover.png");
    expect(leaves[0].verso.image).toBeUndefined();
    expect(leaves[1].recto.image).toBeUndefined();
  });

  it("does not overwrite explicit page-one artwork with the fallback cover", () => {
    const leaves = buildBookletLeaves(8, [{ image: "/custom-cover.png" }], "/fallback.png");
    expect(leaves[0].recto.image).toBe("/custom-cover.png");
  });

  it.each([0, 6, 10, 30, 8.5])("rejects impossible saddle count %s", (pages) => {
    expect(() => assertSaddlePageCount(pages)).toThrow(RangeError);
  });
});
