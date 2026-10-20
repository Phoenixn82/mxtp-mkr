import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, type ComponentType } from "react";
import type { Group, Object3D } from "three";
import { CaseStage, JewelCaseExact, canUseWebgl, caseModelFor, type CaseSurfaces } from "../case3d";
import { CanvasBoundary, CanvasFallbackNote } from "../case3d/CanvasBoundary";
import { FitToView, prefersReducedMotion } from "../case3d/shared";
import { resolveArtSrc } from "../art/editor";
import { landingFormatLabel } from "./formats";

interface CaseModelCanvasProps {
  modelId: string;
  coverArtPath?: string;
}

export function CaseModelCanvas({ modelId, coverArtPath }: CaseModelCanvasProps) {
  const Model = caseModelFor(modelId);
  const reduceMotion = useMemo(prefersReducedMotion, []);
  const fallback = <CanvasFallbackNote>{landingFormatLabel(modelId)}: 3D preview unavailable</CanvasFallbackNote>;
  return (
    <div className="landing-case-model" data-testid="landing-case-model" data-model-id={modelId}>
      {!canUseWebgl() ? (
        fallback
      ) : (
        <CanvasBoundary resetKey={`${modelId}|${coverArtPath ?? ""}`} fallback={fallback}>
          {Model ? (
            <CaseStage cameraZ={7} frameloop={reduceMotion ? "demand" : "always"}>
              <FloatingCase Model={Model} modelId={modelId} coverArtPath={coverArtPath} reduceMotion={reduceMotion} />
            </CaseStage>
          ) : (
            // the jewel case (and any unknown id) is the exact ported model on its own canvas (auto-rotating showcase)
            <JewelCaseExact autoOpen frontArtUrl={coverArtPath ? resolveArtSrc({ imageRef: coverArtPath }) : undefined} />
          )}
        </CanvasBoundary>
      )}
    </div>
  );
}

/** One frame of the landing sway and bob; a still pose when the person asked for reduced motion. */
export function floatFrame(node: Object3D | null, elapsed: number, reduceMotion: boolean) {
  if (!node || reduceMotion) {
    return;
  }
  node.rotation.y = Math.sin(elapsed * 0.45) * 0.22;
  node.rotation.x = -0.12 + Math.sin(elapsed * 0.35) * 0.035;
  node.position.y = Math.sin(elapsed * 0.75) * 0.08;
}

function FloatingCase({
  Model,
  modelId,
  coverArtPath,
  reduceMotion
}: CaseModelCanvasProps & { Model: ComponentType<{ surfaces: CaseSurfaces }>; reduceMotion: boolean }) {
  const group = useRef<Group>(null);
  useFrame(({ clock }) => floatFrame(group.current, clock.getElapsedTime(), reduceMotion));

  return (
    <group ref={group} rotation={[-0.12, -0.16, 0]}>
      <FitToView resetKey={modelId} target={3.8}>
        <Model surfaces={coverArtPath ? { front: coverArtPath } : {}} />
      </FitToView>
    </group>
  );
}
