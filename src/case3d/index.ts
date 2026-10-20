import type { ComponentType } from "react";
import { BluRayModel } from "./BluRay";
import { CardSleeveModel } from "./CardSleeve";
import { CassetteModel } from "./Cassette";
import { DigipakModel } from "./Digipak";
import { DvdCaseModel } from "./DvdCase";
import { EightTrackModel } from "./EightTrack";
import { GatefoldModel } from "./Gatefold";
import { MiniDiscModel } from "./MiniDisc";
import { SlimCdModel } from "./SlimCd";
import { Vinyl7Model } from "./Vinyl7";
import { VinylModel } from "./Vinyl";
import type { CaseSurfaces } from "./shared";

export { BluRayModel, CardSleeveModel, CassetteModel, DigipakModel, DvdCaseModel, EightTrackModel, GatefoldModel, MiniDiscModel, SlimCdModel, Vinyl7Model, VinylModel };
export { JewelCaseExact } from "./JewelCaseExact";
export { Booklet3D } from "./Booklet3D";
export { CaseStage, canUseWebgl, DiscFace, MediaDisc, mm, SurfacePanel, TexturedMaterial, useBlankSurfaceTexture, type CaseSurfaces } from "./shared";

type CaseModel = ComponentType<{ surfaces: CaseSurfaces }>;

const CASE_MODELS: Record<string, CaseModel> = {
  vinyl: VinylModel,
  gatefold: GatefoldModel,
  vinyl7: Vinyl7Model,
  digipak: DigipakModel,
  cassette: CassetteModel,
  dvdcase: DvdCaseModel,
  bluray: BluRayModel,
  slimcd: SlimCdModel,
  cardsleeve: CardSleeveModel,
  minidisc: MiniDiscModel,
  "8track": EightTrackModel
};

/**
 * Procedural model for a non-jewel format, rendered inside the shared CaseStage.
 * undefined for the jewel case and any unknown id: those render JewelCaseExact on its own canvas.
 */
export function caseModelFor(formatId: string): CaseModel | undefined {
  return Object.prototype.hasOwnProperty.call(CASE_MODELS, formatId) ? CASE_MODELS[formatId] : undefined;
}
