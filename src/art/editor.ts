import { convertFileSrc } from "@tauri-apps/api/core";
import { boxes, mmToPx, type BoxSet } from "../geometry";

export interface Transform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

export interface TextContent {
  title: string;
  lines: string[];
}

export interface SlotArt {
  slotId: string;
  imageRef?: string;
  previewRef?: string;
  imageSource?: "manual" | "research" | "playlist";
  textContent?: TextContent;
  textSource?: "manual" | "research";
  transform: Transform;
}

/**
 * Resolve a slot's artwork to a URL the webview can actually render:
 * data-URI previews as-is, absolute file paths through Tauri's asset
 * protocol (a raw C:\... path in <img src> is a broken image), relative
 * fixture paths forward-slashed for the dev server.
 */
export function resolveArtSrc(art?: { imageRef?: string; previewRef?: string }): string | undefined {
  const ref = art?.previewRef ?? art?.imageRef;
  if (!ref) {
    return undefined;
  }
  if (ref.startsWith("data:image/")) {
    return ref;
  }
  if (/^[a-zA-Z]:[\\/]/.test(ref) || ref.startsWith("\\\\") || ref.startsWith("/")) {
    try {
      return convertFileSrc(ref);
    } catch {
      // Not running under Tauri (vitest/browser) — pass the path through.
      return ref.replaceAll("\\", "/");
    }
  }
  return ref.replaceAll("\\", "/");
}

export function guidePixels(trim: { x: number; y: number; w: number; h: number }, dpi: number): BoxSet {
  const set = boxes(trim);
  return {
    bleed: {
      x: mmToPx(set.bleed.x, dpi),
      y: mmToPx(set.bleed.y, dpi),
      w: mmToPx(set.bleed.w, dpi),
      h: mmToPx(set.bleed.h, dpi)
    },
    trim: {
      x: mmToPx(set.trim.x, dpi),
      y: mmToPx(set.trim.y, dpi),
      w: mmToPx(set.trim.w, dpi),
      h: mmToPx(set.trim.h, dpi)
    },
    safe: {
      x: mmToPx(set.safe.x, dpi),
      y: mmToPx(set.safe.y, dpi),
      w: mmToPx(set.safe.w, dpi),
      h: mmToPx(set.safe.h, dpi)
    }
  };
}

export function clampToSafe(transform: Transform, safe: { x: number; y: number; w: number; h: number }): Transform {
  return {
    ...transform,
    x: Math.min(Math.max(transform.x, safe.x), safe.x + safe.w),
    y: Math.min(Math.max(transform.y, safe.y), safe.y + safe.h)
  };
}
