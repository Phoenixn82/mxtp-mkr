import { useFrame, useLoader, type ThreeEvent } from "@react-three/fiber";
import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import {
  CanvasTexture,
  FrontSide,
  PlaneGeometry,
  SRGBColorSpace,
  TextureLoader,
  type Group
} from "three";
import { mm } from "./shared";

const PAGE_WIDTH = mm(120);
const PAGE_HEIGHT = mm(120);
const PAPER_THICKNESS = mm(0.105);
const COVER_THICKNESS = mm(0.16);
const STACK_GAP = mm(0.035);
const STACK_STEP = PAPER_THICKNESS + STACK_GAP;
const EMPTY_TEXTURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

export interface BookletPageData {
  pageNumber?: number;
  image?: string;
  text?: string;
  background?: string;
  foreground?: string;
}

export interface BookletLeafData {
  recto: BookletPageData;
  verso: BookletPageData;
}

export interface Booklet3DProps {
  pages: number;
  cover?: string;
  pageData?: BookletPageData[];
  interactive?: boolean;
  inspect?: boolean;
  onPageChange?: (readerPage: number) => void;
}

export function buildBookletLeaves(
  pages: number,
  pageData: BookletPageData[] = [],
  cover?: string
): BookletLeafData[] {
  assertSaddlePageCount(pages);
  const readerPages = Array.from({ length: pages }, (_, index) => {
    const pageNumber = index + 1;
    const supplied = pageData[index] ?? {};
    return {
      pageNumber,
      text: supplied.text ?? (pageNumber === 1 ? "Cover" : `Page ${pageNumber}`),
      ...supplied,
      image: supplied.image ?? (pageNumber === 1 ? cover : undefined)
    };
  });
  return Array.from({ length: pages / 2 }, (_, index) => ({
    recto: readerPages[index * 2],
    verso: readerPages[index * 2 + 1]
  }));
}

export function assertSaddlePageCount(pages: number): void {
  if (!Number.isInteger(pages) || pages < 4 || pages > 28 || pages % 4 !== 0) {
    throw new RangeError("A saddle booklet requires 4-28 reader pages in multiples of four.");
  }
}

export function Booklet3D({
  pages,
  cover,
  pageData,
  interactive = false,
  inspect = false,
  onPageChange
}: Booklet3DProps) {
  const leaves = useMemo(() => buildBookletLeaves(pages, pageData, cover), [cover, pageData, pages]);
  const [turned, setTurned] = useState(0);
  const [out, setOut] = useState(false);
  const hinges = useRef<Array<Group | null>>([]);
  const root = useRef<Group>(null);
  const lifted = out || inspect;

  useEffect(() => {
    setTurned((value) => Math.min(value, leaves.length));
  }, [leaves.length]);

  useFrame((_, delta) => {
    const turnEase = Math.min(delta * 3.4, 1);
    const stackEase = Math.min(delta * 5, 1);
    hinges.current.forEach((hinge, index) => {
      if (!hinge) return;
      const isTurned = index < turned;
      const targetAngle = isTurned ? -Math.PI * 0.965 : 0;
      hinge.rotation.y += (targetAngle - hinge.rotation.y) * turnEase;
      const targetZ = (isTurned ? index + 1 : leaves.length - index) * STACK_STEP;
      hinge.position.z += (targetZ - hinge.position.z) * stackEase;
    });
    const node = root.current;
    if (node) {
      node.position.y += ((lifted ? mm(34) : 0) - node.position.y) * Math.min(delta * 4, 1);
      node.position.z += ((lifted ? mm(46) : 0) - node.position.z) * Math.min(delta * 4, 1);
    }
  });

  const onClick = (event: ThreeEvent<MouseEvent>) => {
    if (!interactive || event.delta > 5) return;
    event.stopPropagation();
    if (!lifted) {
      setOut(true);
      onPageChange?.(1);
      return;
    }
    setTurned((value) => {
      if (value >= leaves.length) {
        setOut(false);
        onPageChange?.(1);
        return 0;
      }
      const next = value + 1;
      onPageChange?.(Math.min(pages, next * 2 + 1));
      return next;
    });
  };

  const stapleZ = (leaves.length + 1) * STACK_STEP;
  return (
    <group
      ref={root}
      name="Saddle_Booklet"
      onClick={onClick}
      userData={{ pages, leafCount: leaves.length }}
    >
      <mesh position={[-PAGE_WIDTH / 2 + mm(0.35), 0, stapleZ * 0.45]}>
        <boxGeometry args={[mm(0.7), PAGE_HEIGHT, mm(0.22)]} />
        <meshStandardMaterial color="#c9c4b8" roughness={0.86} metalness={0} />
      </mesh>
      {[-PAGE_HEIGHT * 0.25, PAGE_HEIGHT * 0.25].map((y) => (
        <mesh key={y} position={[-PAGE_WIDTH / 2 + mm(0.7), y, stapleZ]}>
          <boxGeometry args={[mm(1.6), mm(8), mm(0.16)]} />
          <meshStandardMaterial color="#9ba1a5" roughness={0.3} metalness={0.72} />
        </mesh>
      ))}
      {leaves.map((leaf, index) => (
        <BookletLeaf
          key={`${leaf.recto.pageNumber}-${leaf.verso.pageNumber}`}
          ref={(group) => {
            hinges.current[index] = group;
          }}
          leaf={leaf}
          coverLeaf={index === 0}
          initialZ={(leaves.length - index) * STACK_STEP}
        />
      ))}
    </group>
  );
}

interface BookletLeafProps {
  leaf: BookletLeafData;
  coverLeaf: boolean;
  initialZ: number;
}

const BookletLeaf = forwardRef<Group, BookletLeafProps>(function BookletLeaf(
  { leaf, coverLeaf, initialZ },
  ref
) {
  const thickness = coverLeaf ? COVER_THICKNESS : PAPER_THICKNESS;
  const curl = coverLeaf ? mm(0.42) : mm(0.24);
  const pageGeometry = useMemo(() => makeCurledPageGeometry(curl), [curl]);
  useEffect(() => () => pageGeometry.dispose(), [pageGeometry]);
  return (
    <group ref={ref} position={[-PAGE_WIDTH / 2, 0, initialZ]}>
      <mesh position={[PAGE_WIDTH / 2, 0, 0]} castShadow>
        <boxGeometry args={[PAGE_WIDTH, PAGE_HEIGHT, thickness]} />
        <meshStandardMaterial color={coverLeaf ? "#ded9cd" : "#f2efe7"} roughness={0.88} metalness={0} />
      </mesh>
      <mesh geometry={pageGeometry} position={[PAGE_WIDTH / 2, 0, thickness / 2 + mm(0.01)]}>
        <PageFaceMaterial face={leaf.recto} cover={coverLeaf} />
      </mesh>
      <mesh
        geometry={pageGeometry}
        position={[PAGE_WIDTH / 2, 0, -thickness / 2 - mm(0.01)]}
        rotation={[0, Math.PI, 0]}
      >
        <PageFaceMaterial face={leaf.verso} />
      </mesh>
      <mesh position={[mm(0.35), 0, thickness / 2 + mm(0.015)]}>
        <boxGeometry args={[mm(0.7), PAGE_HEIGHT, mm(0.045)]} />
        <meshStandardMaterial color="#9f998d" roughness={0.94} metalness={0} />
      </mesh>
    </group>
  );
});

function PageFaceMaterial({ face, cover = false }: { face: BookletPageData; cover?: boolean }) {
  const loaded = useLoader(TextureLoader, face.image ?? EMPTY_TEXTURE);
  const fallback = useMemo(() => (face.image ? undefined : pageTexture(face, cover)), [cover, face]);
  useEffect(() => () => fallback?.dispose(), [fallback]);
  useEffect(() => {
    loaded.colorSpace = SRGBColorSpace;
    loaded.anisotropy = 8;
    loaded.needsUpdate = true;
  }, [loaded]);
  return (
    <meshStandardMaterial
      map={face.image ? loaded : fallback}
      roughness={cover ? 0.66 : 0.78}
      metalness={0.01}
      side={FrontSide}
      envMapIntensity={0.42}
    />
  );
}

function makeCurledPageGeometry(amplitude: number): PlaneGeometry {
  const geometry = new PlaneGeometry(PAGE_WIDTH, PAGE_HEIGHT, 16, 2);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index++) {
    const normalizedX = (positions.getX(index) + PAGE_WIDTH / 2) / PAGE_WIDTH;
    positions.setZ(index, Math.pow(normalizedX, 3) * amplitude);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function pageTexture(face: BookletPageData, cover: boolean): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = face.background ?? (cover ? "#111722" : "#f3f0e8");
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = cover ? "rgba(220,230,238,0.22)" : "rgba(30,32,36,0.13)";
    context.lineWidth = 5;
    context.strokeRect(16, 16, canvas.width - 32, canvas.height - 32);
    context.fillStyle = face.foreground ?? (cover ? "#e5edf2" : "#2b2e32");
    context.font = cover ? "600 36px 'Segoe UI', sans-serif" : "500 24px 'Segoe UI', sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    drawWrappedText(context, face.text ?? `Page ${face.pageNumber ?? ""}`, canvas.width / 2, canvas.height / 2, 420, 32);
    context.font = "500 16px 'Segoe UI', sans-serif";
    context.textAlign = "right";
    context.fillText(String(face.pageNumber ?? ""), canvas.width - 28, canvas.height - 24);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function drawWrappedText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number
) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && context.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  const startY = y - ((lines.length - 1) * lineHeight) / 2;
  lines.slice(0, 10).forEach((value, index) => context.fillText(value, x, startY + index * lineHeight));
}
