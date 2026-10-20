import { Canvas } from "@react-three/fiber";
import { Suspense, useMemo, useState } from "react";
import { Booklet3D, canUseWebgl } from "../case3d";
import { CanvasBoundary, CanvasFallbackNote } from "../case3d/CanvasBoundary";
import type { BookletPageData } from "../case3d/Booklet3D";
import type { ComposedBooklet } from "./bookletExport";

interface BookletModelPreviewProps {
  composed: ComposedBooklet;
  coverPreviewUrl?: string;
}

export function pageDataForBooklet(composed: ComposedBooklet, coverPreviewUrl?: string): BookletPageData[] {
  return composed.pages.map((page) => ({
    pageNumber: page.pageNumber,
    image: coverPreviewUrl && (page.kind === "cover" || page.kind === "art") ? coverPreviewUrl : undefined,
    text: [page.visual?.eyebrow, page.title, page.subtitle, ...(page.blocks ?? []).map((block) => block.text)]
      .filter(Boolean)
      .join("\n"),
    background: page.visual?.colors.paper,
    foreground: page.visual?.colors.ink
  }));
}

export function BookletModelPreview({ composed, coverPreviewUrl }: BookletModelPreviewProps) {
  const [readerPage, setReaderPage] = useState(1);
  const pageData = useMemo(
    () => pageDataForBooklet(composed, coverPreviewUrl),
    [composed, coverPreviewUrl]
  );
  const label = `${composed.pageCount}-page printed booklet model`;
  const webgl = canUseWebgl();
  const stack = (
    <div className="booklet-model-fallback" role="img" aria-label={label}>
      {Array.from({ length: Math.min(8, composed.pageCount / 2) }, (_, index) => (
        <i key={index} style={{ transform: `translate(${index * 2}px, ${index * -1}px)` }} />
      ))}
    </div>
  );

  return (
    <section className="booklet-model-preview" aria-label={label} data-testid="booklet-model-preview">
      <div className="booklet-model-head">
        <span>Printed-object preview</span>
        <output data-testid="booklet-model-page">Reader page {readerPage}</output>
      </div>
      <div className="booklet-model-stage" data-page-count={composed.pageCount}>
        {webgl ? (
          <CanvasBoundary
            resetKey={coverPreviewUrl ?? ""}
            fallback={
              <>
                {stack}
                <CanvasFallbackNote />
              </>
            }
          >
            <Canvas
              camera={{ position: [0, 0.4, 6.6], fov: 34 }}
              dpr={[1, 1.6]}
              shadows
              aria-label={label}
            >
              <ambientLight intensity={1.35} />
              <directionalLight position={[4, 6, 7]} intensity={2.1} castShadow />
              <directionalLight position={[-4, -2, 4]} intensity={0.75} color="#88dffc" />
              <Suspense fallback={null}>
                <group rotation={[-0.08, -0.18, -0.035]}>
                  <Booklet3D
                    pages={composed.pageCount}
                    pageData={pageData}
                    cover={coverPreviewUrl}
                    interactive
                    inspect
                    onPageChange={setReaderPage}
                  />
                </group>
              </Suspense>
            </Canvas>
          </CanvasBoundary>
        ) : (
          stack
        )}
      </div>
      <p>Click the paper model to turn each physical leaf.</p>
    </section>
  );
}
