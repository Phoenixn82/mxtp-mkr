import { Suspense, useRef, useState, type ComponentType, type KeyboardEvent } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group } from "three";
import { resolveArtSrc, type SlotArt } from "../art/editor";
import { CaseStage, JewelCaseExact, canUseWebgl, caseModelFor, type CaseSurfaces } from "../case3d";
import { CanvasBoundary, CanvasFallbackNote } from "../case3d/CanvasBoundary";
import type { JewelCaseControls, JewelCaseState } from "../case3d/JewelCaseExact";
import { FitToView } from "../case3d/shared";

interface Preview3DProps {
  art: SlotArt[];
  formatId: string;
}

// Detail-page 3D preview: the same per-surface case the landing renders, fed with
// the artwork assigned in the editor. Rotate/Flip turn non-jewel cases to any side.
export function Preview3D({ art, formatId }: Preview3DProps) {
  const [yaw, setYaw] = useState(0);
  const [jewelState, setJewelState] = useState<JewelCaseState>("closed");
  const jewelControls = useRef<JewelCaseControls | null>(null);
  const front = textureFor(art, "front");
  const back = textureFor(art, "tray");
  const disc = textureFor(art, "disc");
  const surfaces: CaseSurfaces = { front, back, disc };
  // The jewel case (and any unknown format) is the exact ported model on its own studio
  // canvas: drag-orbit, click or keyboard to open/eject, no button row.
  const Model = caseModelFor(formatId);
  const isJewel = !Model;
  const [failed, setFailed] = useState(false);
  // 3D-only controls go away with the 3D scene: no WebGL, or the CanvasBoundary fell back.
  const webgl = canUseWebgl();
  const live3d = webgl && !failed;
  const keyboard = isJewel && live3d;
  const fallback = (
    <>
      {front ? (
        <img
          className="case-scene-cover"
          src={front}
          alt=""
          data-testid="case-front-cover"
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
        />
      ) : null}
      <CanvasFallbackNote />
    </>
  );

  function onSceneKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      jewelControls.current?.toggleOpen();
    } else if (event.key === "e" || event.key === "E") {
      event.preventDefault();
      jewelControls.current?.toggleEject();
    }
  }

  return (
    <section className="panel preview-panel" aria-labelledby="preview-heading">
      <div className="panel-head">
        <h2 id="preview-heading">Preview</h2>
        {keyboard ? (
          <span className="preview-hint" data-testid="preview-hint">
            drag to orbit · click or press Enter to open · click the disc or press E to eject
          </span>
        ) : isJewel || !live3d ? null : (
          <div className="preview-actions">
            <button type="button" onClick={() => setYaw((value) => value + 35)} data-testid="rotate-preview" title="Rotate the case 35°">
              Rotate
            </button>
            <button type="button" onClick={() => setYaw((value) => value + 180)} data-testid="flip-booklet" title="Flip to the back / tray side">
              Flip
            </button>
          </div>
        )}
      </div>
      <div
        className="case-scene"
        data-testid="case-scene"
        data-open={isJewel && jewelState !== "closed" ? "true" : "false"}
        data-ejected={isJewel && jewelState === "ejected" ? "true" : "false"}
        data-case-state={isJewel ? jewelState : "closed"}
        data-front={front ?? ""}
        data-back={back ?? ""}
        data-disc={disc ?? ""}
        {...(keyboard
          ? {
              tabIndex: 0,
              role: "group",
              "aria-label": "Jewel case 3D preview. Press Enter to open or close it, E to eject the disc.",
              onKeyDown: onSceneKey
            }
          : {})}
      >
        {!webgl ? (
          fallback
        ) : (
          <CanvasBoundary resetKey={[formatId, front, back, disc].join("|")} fallback={fallback} onFailedChange={setFailed}>
            {Model ? (
              <CaseStage cameraZ={7}>
                <Suspense fallback={null}>
                  <RotatingCase Model={Model} modelId={formatId} surfaces={surfaces} yawDeg={yaw} />
                </Suspense>
              </CaseStage>
            ) : (
              <JewelCaseExact
                interactive
                frontArtUrl={front}
                backArtUrl={back}
                discArtUrl={disc}
                onStateChange={setJewelState}
                controls={jewelControls}
              />
            )}
          </CanvasBoundary>
        )}
      </div>
    </section>
  );
}

function RotatingCase({
  Model,
  modelId,
  surfaces,
  yawDeg
}: {
  Model: ComponentType<{ surfaces: CaseSurfaces }>;
  modelId: string;
  surfaces: CaseSurfaces;
  yawDeg: number;
}) {
  const group = useRef<Group>(null);
  const target = (yawDeg * Math.PI) / 180;
  useFrame(() => {
    const node = group.current;
    if (node) {
      node.rotation.y += (target - node.rotation.y) * 0.14;
    }
  });
  return (
    <group ref={group}>
      <FitToView resetKey={modelId} target={3.6}>
        <Model surfaces={surfaces} />
      </FitToView>
    </group>
  );
}

function textureFor(art: SlotArt[], slotId: string): string | undefined {
  const item = art.find((item) => item.slotId === slotId && isImagePath(item.imageRef));
  return resolveArtSrc(item);
}

function isImagePath(path: string | undefined): path is string {
  return Boolean(path && /\.(png|jpe?g)$/i.test(path));
}
