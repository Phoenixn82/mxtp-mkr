import { generateCover, type GeneratedCover } from "../research/research";
import { getDimension, type BoxDims, type ComponentDim } from "./dimensions";

export interface ArtworkTarget {
  componentId: string;
  component: ComponentDim;
  bleed: BoxDims;
  safety: BoxDims;
  widthPx: number;
  heightPx: number;
  safetyPx: { w: number; h: number };
}

export interface FittedArtwork {
  componentId: string;
  imagePath: string;
  previewUrl?: string;
  prompt: string;
  widthPx: number;
  heightPx: number;
  safetyPx: { w: number; h: number };
  palette: string[];
  mock: boolean;
}

export interface GenerateFittedArtworkInput {
  prompt: string;
  targetComponentId: string;
  styleRefs?: string[];
}

export type CoverGenerator = (prompt: string, styleRefs?: string[]) => Promise<GeneratedCover>;

export function resolveArtworkTarget(componentId: string): ArtworkTarget {
  const component = getDimension(componentId);
  if (!component?.machineReadable) {
    throw new Error(`No machine-readable print geometry for ${componentId}.`);
  }
  const bleed = component.kind === "saddle-booklet" && component.pageBleed ? component.pageBleed : component.bleed;
  const safety = component.kind === "saddle-booklet" && component.pageSafety ? component.pageSafety : component.safety;
  if (!bleed || !safety) {
    throw new Error(`No bleed/safety geometry for ${componentId}.`);
  }

  return {
    componentId: component.id,
    component,
    bleed,
    safety,
    widthPx: bleed.px300.w,
    heightPx: bleed.px300.h,
    safetyPx: safety.px300
  };
}

export async function generateFittedArtwork(
  input: GenerateFittedArtworkInput,
  generator: CoverGenerator = generateCover
): Promise<FittedArtwork> {
  const target = resolveArtworkTarget(input.targetComponentId);
  const sizedPrompt = `${input.prompt}. Output exactly ${target.widthPx}x${target.heightPx}px at 300 DPI for ${target.componentId}; keep text and logos inside ${target.safetyPx.w}x${target.safetyPx.h}px safety.`;

  if (imageGenMode() === "mock") {
    return {
      componentId: target.componentId,
      imagePath: `mock://${target.componentId}/${target.widthPx}x${target.heightPx}.png`,
      previewUrl: `mock://${target.componentId}/preview`,
      prompt: sizedPrompt,
      widthPx: target.widthPx,
      heightPx: target.heightPx,
      safetyPx: target.safetyPx,
      palette: ["#111111", "#eeeeee"],
      mock: true
    };
  }

  const cover = await generator(sizedPrompt, input.styleRefs ?? []);
  return {
    componentId: target.componentId,
    imagePath: cover.imagePath,
    previewUrl: cover.previewUrl,
    prompt: cover.prompt,
    widthPx: target.widthPx,
    heightPx: target.heightPx,
    safetyPx: target.safetyPx,
    palette: cover.palette,
    mock: false
  };
}

function imageGenMode(): string {
  if (typeof process !== "undefined" && process.env?.MXTP_MKR_IMAGEGEN) {
    return process.env.MXTP_MKR_IMAGEGEN;
  }
  return "codex";
}
