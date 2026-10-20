export function mmToIn(mm: number): number {
  return mm / 25.4;
}

export function inToMm(inches: number): number {
  return inches * 25.4;
}

export function mmToPt(mm: number): number {
  return mmToIn(mm) * 72;
}

export function ptToMm(pt: number): number {
  return inToMm(pt / 72);
}

export function mmToPx(mm: number, dpi: number): number {
  return mmToIn(mm) * dpi;
}

export function pxToMm(px: number, dpi: number): number {
  return inToMm(px / dpi);
}
