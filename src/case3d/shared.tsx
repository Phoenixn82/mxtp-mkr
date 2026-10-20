import { Canvas, useLoader, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import {
  Box3,
  CanvasTexture,
  DoubleSide,
  EquirectangularReflectionMapping,
  PMREMGenerator,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  type Group
} from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";

// Auto-scales whatever it wraps so its largest on-screen dimension fits `target`
// scene units and re-centers it — so every format (a tiny MiniDisc or a giant
// gatefold) frames consistently under one fixed camera, regardless of real mm size.
export function FitToView({ children, resetKey, target = 4.2 }: { children: ReactNode; resetKey?: string; target?: number }) {
  const ref = useRef<Group>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    node.scale.setScalar(1);
    node.position.set(0, 0, 0);
    node.updateWorldMatrix(true, true);
    const box = new Box3().setFromObject(node);
    if (box.isEmpty()) {
      return;
    }
    const size = new Vector3();
    const center = new Vector3();
    box.getSize(size);
    box.getCenter(center);
    const maxXY = Math.max(size.x, size.y) || 1;
    const scale = target / maxXY;
    node.scale.setScalar(scale);
    node.position.set(-center.x * scale, -center.y * scale, 0);
  }, [resetKey, target]);
  return <group ref={ref}>{children}</group>;
}

export const MM = 0.0205;

export function mm(value: number): number {
  return value * MM;
}

export type Vec3 = [number, number, number];

export interface CaseSurfaces {
  front?: string;
  spine?: string;
  back?: string;
  disc?: string;
  inside?: string;
  insideLeft?: string;
  insideRight?: string;
  label?: string;
  top?: string;
  cartridge?: string;
}

let webglProbe: boolean | undefined;

/**
 * True only when a WebGL context can really be created. The constructor existing is
 * not enough: a blocklisted GPU or a lost driver fails inside the Canvas instead.
 * Probed once per page; the probe context is released straight away.
 */
export function canUseWebgl(): boolean {
  if (webglProbe !== undefined) return webglProbe;
  if (typeof window === "undefined" || !("WebGLRenderingContext" in window)) return (webglProbe = false);
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    webglProbe = Boolean(gl);
  } catch {
    webglProbe = false;
  }
  return webglProbe;
}

/** Test hook: forget the cached probe. */
export function resetWebglProbe() {
  webglProbe = undefined;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}

export function CaseStage({
  children,
  cameraZ = 7.2,
  frameloop = "always"
}: {
  children: ReactNode;
  cameraZ?: number;
  frameloop?: "always" | "demand";
}) {
  return (
    <Canvas shadows camera={{ position: [0, 0.35, cameraZ], fov: 34 }} dpr={[1, 1.5]} gl={{ antialias: true, alpha: true }} frameloop={frameloop}>
      <StageCamera cameraZ={cameraZ} />
      <StudioEnvironment />
      <ambientLight intensity={0.22} />
      <directionalLight position={[0, 0.6, 6]} intensity={0.28} />
      <hemisphereLight args={["#dfe8ef", "#1c252b", 0.4]} />
      <directionalLight position={[2.5, 3.2, 4.2]} intensity={0.9} castShadow shadow-mapSize-width={1024} shadow-mapSize-height={1024} />
      <pointLight position={[-2.3, 1.2, 2.7]} intensity={0.4} color="#8ed7ff" />
      {children}
      {/* Oversized so its edge never enters the frame, and low enough that the cast
          shadow reads as distant grounding, not a floating smudge beside the model. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -4.6, -0.35]} receiveShadow>
        <planeGeometry args={[40, 24]} />
        <shadowMaterial transparent opacity={0.14} />
      </mesh>
    </Canvas>
  );
}

function StageCamera({ cameraZ }: { cameraZ: number }) {
  const { camera } = useThree();
  useEffect(() => {
    camera.position.set(0, 0.35, cameraZ);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
  }, [camera, cameraZ]);
  return null;
}

// Real studio HDRI (Poly Haven) → PMREM cube map → scene.environment. This is the single
// biggest photorealism lever: accurate reflections + the light that transmission refracts
// through the clear plastic. Background stays dark (set on the Canvas), HDRI is reflections only.
const HDRI_PATH = "/hdri/studio_small_03.hdr";
let hdriWarned = false;

export function StudioEnvironment() {
  const { gl, scene, invalidate } = useThree();
  useEffect(() => {
    let disposed = false;
    const pmrem = new PMREMGenerator(gl);
    pmrem.compileEquirectangularShader();
    new RGBELoader().load(HDRI_PATH, (hdr) => {
      if (disposed) {
        hdr.dispose();
        pmrem.dispose();
        return;
      }
      hdr.mapping = EquirectangularReflectionMapping;
      const envMap = pmrem.fromEquirectangular(hdr).texture;
      scene.environment = envMap;
      // Dim the studio HDRI's reflective contribution so the silver disc and the clear lid don't
      // mirror it to white (the wash-out). Direct lights still give the highlight sweep + sheen.
      scene.environmentIntensity = 0.5;
      hdr.dispose();
      pmrem.dispose();
      // Under frameloop "demand" (reduced motion) nothing else repaints to show the reflections.
      invalidate();
    }, undefined, (error) => {
      pmrem.dispose();
      // Direct lights still light the case; only the reflections are lost.
      if (!hdriWarned) {
        hdriWarned = true;
        console.warn(`Studio HDRI ${HDRI_PATH} failed to load; 3D cases render without environment reflections.`, error);
      }
    });
    return () => {
      disposed = true;
      scene.environment = null;
      scene.environmentIntensity = 1;
    };
  }, [gl, scene, invalidate]);
  return null;
}

export function SurfacePanel({
  path,
  label,
  position,
  rotation,
  width,
  height,
  big,
  vertical,
  roughness = 0.62,
  metalness = 0.04,
  opacity = 1,
  envMapIntensity = 0.75
}: {
  path?: string;
  label: string;
  position: Vec3;
  rotation: Vec3;
  width: number;
  height: number;
  big?: boolean;
  vertical?: boolean;
  roughness?: number;
  metalness?: number;
  opacity?: number;
  envMapIntensity?: number;
}) {
  const blank = useBlankSurfaceTexture(label, big ?? false, vertical ?? false);
  const transparent = opacity < 1;
  return (
    <mesh position={position} rotation={rotation} castShadow>
      <planeGeometry args={[width, height]} />
      {path ? (
        <TexturedMaterial path={path} roughness={roughness} metalness={metalness} envMapIntensity={envMapIntensity} />
      ) : (
        <meshStandardMaterial
          map={blank}
          roughness={roughness}
          metalness={metalness}
          transparent={transparent}
          opacity={opacity}
          side={DoubleSide}
          envMapIntensity={envMapIntensity}
        />
      )}
    </mesh>
  );
}

export function DiscFace({ path, radius = mm(60) }: { path?: string; radius?: number }) {
  return <MediaDisc path={path} radius={radius} labelRadius={mm(22)} holeRadius={mm(7.5)} label="LABEL" color="#c7ced3" />;
}

export function MediaDisc({
  path,
  radius,
  labelRadius,
  holeRadius,
  label = "LABEL",
  color = "#0b0b0c",
  thickness = mm(1.2),
  grooves = false,
  position = [0, 0, 0],
  rotation = [0, 0, 0]
}: {
  path?: string;
  radius: number;
  labelRadius: number;
  holeRadius: number;
  label?: string;
  color?: string;
  thickness?: number;
  grooves?: boolean;
  position?: Vec3;
  rotation?: Vec3;
}) {
  const blank = useBlankSurfaceTexture(label, false, false);
  const z = thickness / 2 + 0.002;
  const grooveRadii = grooves ? [0.34, 0.44, 0.54, 0.64, 0.74, 0.84, 0.92] : [0.58, 0.78];
  return (
    <group position={position} rotation={rotation}>
      <mesh rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[radius, radius, thickness, 128]} />
        <meshStandardMaterial color={color} roughness={grooves ? 0.28 : 0.22} metalness={grooves ? 0.18 : 0.55} envMapIntensity={1.4} />
      </mesh>
      <mesh position={[0, 0, z]}>
        <ringGeometry args={[holeRadius, radius, 160]} />
        <meshStandardMaterial color={color} roughness={grooves ? 0.28 : 0.18} metalness={grooves ? 0.22 : 0.7} envMapIntensity={1.65} side={DoubleSide} />
      </mesh>
      {grooveRadii.map((fraction) => (
        <mesh key={fraction} position={[0, 0, z + 0.002]}>
          <ringGeometry args={[radius * (fraction - 0.006), radius * fraction, 160]} />
          <meshStandardMaterial color={grooves ? "#232629" : "#eef4f6"} roughness={0.2} metalness={grooves ? 0.5 : 0.85} transparent opacity={grooves ? 0.34 : 0.5} side={DoubleSide} />
        </mesh>
      ))}
      <mesh position={[0, 0, z + 0.006]}>
        <circleGeometry args={[labelRadius, 96]} />
        {path ? <TexturedMaterial path={path} roughness={0.48} metalness={0.02} /> : <meshStandardMaterial map={blank} roughness={0.68} metalness={0.02} side={DoubleSide} />}
      </mesh>
      <mesh position={[0, 0, z + 0.012]}>
        <circleGeometry args={[holeRadius, 48]} />
        <meshStandardMaterial color="#050608" roughness={0.7} side={DoubleSide} />
      </mesh>
    </group>
  );
}

export function TexturedMaterial({
  path,
  roughness = 0.34,
  metalness = 0.02,
  envMapIntensity = 0.75
}: {
  path: string;
  roughness?: number;
  metalness?: number;
  envMapIntensity?: number;
}) {
  const texture = useLoader(TextureLoader, path);
  useMemo(() => {
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
  }, [texture]);
  return <meshStandardMaterial map={texture} roughness={roughness} metalness={metalness} side={DoubleSide} envMapIntensity={envMapIntensity} />;
}

export function useBlankSurfaceTexture(label: string, big: boolean, vertical: boolean) {
  return useMemo(() => {
    const canvas = document.createElement("canvas");
    const w = vertical ? 128 : 512;
    const h = 512;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const gradient = ctx.createLinearGradient(0, 0, w, h);
      gradient.addColorStop(0, "#181c23");
      gradient.addColorStop(1, "#0c0e13");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "rgba(214,226,234,0.22)";
      ctx.lineWidth = 4;
      ctx.setLineDash([12, 10]);
      ctx.strokeRect(12, 12, w - 24, h - 24);
      ctx.setLineDash([]);
      ctx.save();
      ctx.translate(w / 2, h / 2);
      if (vertical) {
        ctx.rotate(-Math.PI / 2);
      }
      ctx.textAlign = "center";
      if (big) {
        ctx.strokeStyle = "rgba(214,226,234,0.45)";
        ctx.lineWidth = 9;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(0, -58);
        ctx.lineTo(0, 42);
        ctx.moveTo(-50, -8);
        ctx.lineTo(50, -8);
        ctx.stroke();
        ctx.fillStyle = "rgba(220,230,238,0.6)";
        ctx.font = "600 30px 'Segoe UI', sans-serif";
        ctx.fillText(label, 0, 96);
      } else {
        ctx.fillStyle = "rgba(220,230,238,0.5)";
        ctx.font = "600 26px 'Segoe UI', sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText(label, 0, 0);
      }
      ctx.restore();
    }
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    return texture;
  }, [label, big, vertical]);
}
