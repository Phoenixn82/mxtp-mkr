export interface ImposedSpread {
  sheet: number;
  face: "outer" | "inner";
  left: number;
  right: number;
}

export function impose(pages: number): ImposedSpread[] {
  if (pages < 4 || pages % 4 !== 0) {
    throw new Error("Saddle-stitch page counts must be a multiple of 4.");
  }

  const spreads: ImposedSpread[] = [];
  for (let sheet = 0; sheet < pages / 4; sheet += 1) {
    spreads.push({
      sheet,
      face: "outer",
      left: pages - 2 * sheet,
      right: 1 + 2 * sheet
    });
    spreads.push({
      sheet,
      face: "inner",
      left: 2 + 2 * sheet,
      right: pages - 1 - 2 * sheet
    });
  }
  return spreads;
}
