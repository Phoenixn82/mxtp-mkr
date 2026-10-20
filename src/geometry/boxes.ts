export type Mm = number;

export interface Box {
  x: Mm;
  y: Mm;
  w: Mm;
  h: Mm;
}

export interface BoxSet {
  bleed: Box;
  trim: Box;
  safe: Box;
}

export const BLEED_SAFE_MM = 3.175;

export function boxes(trim: Box): BoxSet {
  return {
    bleed: {
      x: trim.x - BLEED_SAFE_MM,
      y: trim.y - BLEED_SAFE_MM,
      w: trim.w + BLEED_SAFE_MM * 2,
      h: trim.h + BLEED_SAFE_MM * 2
    },
    trim,
    safe: {
      x: trim.x + BLEED_SAFE_MM,
      y: trim.y + BLEED_SAFE_MM,
      w: trim.w - BLEED_SAFE_MM * 2,
      h: trim.h - BLEED_SAFE_MM * 2
    }
  };
}
