import { validBookletPageCounts } from "../geometry";

export type BookletBinding = "fold" | "saddle";

export function nextPageCount(binding: BookletBinding, current: number, direction: 1 | -1): number {
  const counts = validBookletPageCounts(binding);
  const index = counts.indexOf(current);
  if (index === -1) {
    return counts[0];
  }
  return counts[Math.min(Math.max(index + direction, 0), counts.length - 1)];
}

export function canUsePageCount(binding: BookletBinding, pages: number): boolean {
  return validBookletPageCounts(binding).includes(pages);
}
