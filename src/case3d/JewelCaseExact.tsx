import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import { prefersReducedMotion } from "./shared";

// =====================================================================================
// Port of scratchpad/jewelcase_pro.html — the approved 1:1 jewel case (PRO pass).
// Photo-referenced materials (polycarbonate clearcoat lid, satin micro-rough tray,
// anisotropic champagne-silver CD), real per-component thickness, a real hinge (pin +
// knuckles) driven by spring-damper physics, and the CD's subtle centre stacking-ring
// indent. Runs on its own R3F canvas so this studio rig never leaks into the other
// formats' shared CaseStage.
// =====================================================================================

// dimensions (cm; 1 unit = 1 cm) — real standard jewel case 142 x 125 x ~10.4 mm
const W = 14.2,
  H = 12.5;
const TRAY_D = 0.62;
const LID_D = 0.42;
const WALL = 0.14;
const DISC_R = 6.0,
  HOLE_R = 0.75,
  DISC_T = 0.12;
const WELL_R = 6.12;
const PIVOT_X = -W / 2 + 0.3; // hinge pin axis (left spine)
const OPEN_ANGLE = -1.92; // book-style, hinges left ~110°

const DISC_SEATED = new THREE.Vector3(0, 0, -0.16);
const DISC_FWD = new THREE.Vector3(0, 0, 1.9);
const DISC_RIGHT = new THREE.Vector3(9.2, 0, 1.7);

// hinge spring-damper (near-critically damped: firm, tiny settle)
const HINGE_K = 118;
const HINGE_C = 21;

function roundedBox(w: number, h: number, d: number) {
  return new THREE.BoxGeometry(w, h, d, 1, 1, 1);
}

// procedural fine grain so the black tray reads as satin polystyrene, not flat matte
function makeMicroRoughness(): THREE.CanvasTexture {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(s, s);
  for (let i = 0; i < s * s; i++) {
    const n = 176 + Math.floor((Math.random() * 0.5 + Math.random() * 0.5) * 46);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = n;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(5, 5);
  return t;
}

type ArtMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

export interface CaseParts {
  root: THREE.Group;
  tray: THREE.Group;
  lidPivot: THREE.Group;
  discPivot: THREE.Group;
  /** Booklet insert plane inside the clear lid — carries the front cover art. */
  insert: ArtMesh;
  /** Tray card on the back of the tray — carries the back/tray art. */
  trayCard: ArtMesh;
  /** Printed label face of the disc — carries the disc art and travels with the disc. */
  discLabel: ArtMesh;
  disposables: Array<{ dispose: () => void }>;
}

export function buildCase(): CaseParts {
  const root = new THREE.Group();
  const disposables: Array<{ dispose: () => void }> = [];
  const track = <T extends { dispose: () => void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  // ---------- materials ----------
  const microRough = track(makeMicroRoughness());
  const matTray = track(
    new THREE.MeshStandardMaterial({ color: 0x131417, roughness: 0.62, metalness: 0.0, roughnessMap: microRough, envMapIntensity: 0.55 })
  );
  const matRosette = track(new THREE.MeshStandardMaterial({ color: 0x202227, roughness: 0.5, metalness: 0.0, envMapIntensity: 0.7 }));
  const matClear = track(
    new THREE.MeshPhysicalMaterial({
      color: 0xf1fbff,
      metalness: 0.0,
      roughness: 0.045,
      transmission: 1.0,
      ior: 1.585,
      thickness: 0.35,
      attenuationColor: new THREE.Color(0xe4f3fa),
      attenuationDistance: 5.0,
      clearcoat: 0.7,
      clearcoatRoughness: 0.04,
      transparent: true,
      opacity: 1.0,
      envMapIntensity: 1.1,
      specularIntensity: 1.0
    })
  );
  const matSilver = track(
    new THREE.MeshPhysicalMaterial({
      color: 0xe3e5e0,
      metalness: 1.0,
      roughness: 0.12,
      clearcoat: 1.0,
      clearcoatRoughness: 0.07,
      anisotropy: 0.55,
      anisotropyRotation: Math.PI / 2,
      envMapIntensity: 1.55
    })
  );
  const matSilverClamp = track(
    new THREE.MeshPhysicalMaterial({ color: 0xd7dade, metalness: 1.0, roughness: 0.16, clearcoat: 1.0, clearcoatRoughness: 0.1, envMapIntensity: 1.3 })
  );

  // ===== TRAY (Case Back): matte black + left hinge comb + rosette =====
  const tray = new THREE.Group();
  {
    const back = new THREE.Mesh(track(roundedBox(W, H, 0.12)), matTray);
    back.position.z = -TRAY_D + 0.06;
    back.castShadow = back.receiveShadow = true;
    tray.add(back);

    const mkWall = (w: number, h: number, d: number, x: number, y: number) => {
      const m = new THREE.Mesh(track(roundedBox(w, h, d)), matTray);
      m.position.set(x, y, -TRAY_D / 2);
      m.castShadow = m.receiveShadow = true;
      tray.add(m);
    };
    mkWall(W, WALL, TRAY_D, 0, H / 2 - WALL / 2);
    mkWall(W, WALL, TRAY_D, 0, -H / 2 + WALL / 2);
    mkWall(WALL, H, TRAY_D, W / 2 - WALL / 2, 0);
    mkWall(WALL, H, TRAY_D, -W / 2 + WALL / 2, 0);

    const wellRim = new THREE.Mesh(track(new THREE.TorusGeometry(WELL_R, 0.09, 12, 100)), matTray);
    wellRim.position.z = -0.12;
    wellRim.castShadow = true;
    tray.add(wellRim);

    // HINGE RIDGE COMB on the LEFT spine (8 vertical ribs)
    const ribCount = 8,
      ribR = 0.055,
      gap = 0.135,
      x0 = -W / 2 + 0.3;
    const stripW = (ribCount - 1) * gap;
    const ribGeo = track(new THREE.CylinderGeometry(ribR, ribR, H - 0.5, 10));
    for (let i = 0; i < ribCount; i++) {
      const rib = new THREE.Mesh(ribGeo, matTray);
      rib.position.set(x0 + i * gap, 0, -0.02);
      rib.castShadow = true;
      tray.add(rib);
    }
    const strip = new THREE.Mesh(track(roundedBox(stripW + 0.4, H - 0.4, 0.14)), matTray);
    strip.position.set(x0 + stripW / 2, 0, -0.1);
    tray.add(strip);

    // ROSETTE gripper (black; radial fingers + centre button)
    const rosette = new THREE.Group();
    const ring = new THREE.Mesh(track(new THREE.TorusGeometry(0.92, 0.1, 12, 36)), matRosette);
    rosette.add(ring);
    const fingers = 14;
    const fingerGeo = track(roundedBox(0.09, 0.8, 0.15));
    for (let i = 0; i < fingers; i++) {
      const f = new THREE.Mesh(fingerGeo, matRosette);
      const a = (i / fingers) * Math.PI * 2;
      f.position.set(Math.cos(a) * 0.46, Math.sin(a) * 0.46, 0.02);
      f.rotation.z = a;
      rosette.add(f);
    }
    const button = new THREE.Mesh(track(new THREE.CylinderGeometry(0.2, 0.2, 0.24, 20)), matRosette);
    button.rotation.x = Math.PI / 2;
    button.position.z = 0.06;
    rosette.add(button);
    rosette.position.z = -0.2;
    rosette.children.forEach((c) => (c.castShadow = true));
    tray.add(rosette);
  }
  // Tray card: the printed back insert, read from behind the case. Hidden until art loads.
  const trayCard: ArtMesh = new THREE.Mesh(
    track(new THREE.PlaneGeometry(W - 0.4, H - 0.4)),
    track(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.02, envMapIntensity: 0.5 }))
  );
  trayCard.position.z = -TRAY_D - 0.004;
  trayCard.rotation.y = Math.PI;
  trayCard.visible = false;
  tray.add(trayCard);
  root.add(tray);

  // ===== CD DISC: champagne silver + subtle centre stacking-ring indent =====
  const discPivot = new THREE.Group();
  {
    const t = DISC_T / 2;
    const P: Array<[number, number]> = [
      [0.75, 0.05],
      [0.8, 0.062], // hole lip
      [1.28, 0.046], // recessed clamping band
      [1.46, 0.076], // raised stacking ring (the subtle bump)
      [1.78, 0.05], // groove
      [2.1, 0.06],
      [2.4, 0.062], // mirror band -> data start
      [5.8, 0.062], // program/data area
      [5.95, 0.052],
      [6.0, 0.018], // outer bevel
      [6.0, -0.018],
      [5.95, -0.052],
      [5.8, -0.062],
      [2.4, -0.062],
      [2.1, -0.06],
      [1.78, -0.05],
      [1.46, -0.076],
      [1.28, -0.046],
      [0.8, -0.062],
      [0.75, -0.05],
      [0.75, 0.05]
    ];
    const pts = P.map((p) => new THREE.Vector2(p[0], p[1] * (t / 0.062)));
    const discGeo = track(new THREE.LatheGeometry(pts, 160));
    try {
      discGeo.computeVertexNormals();
      discGeo.computeTangents();
    } catch {
      /* tangents optional; anisotropy still degrades gracefully */
    }
    const disc = new THREE.Mesh(discGeo, matSilver);
    disc.rotation.x = Math.PI / 2;
    disc.castShadow = true;
    discPivot.add(disc);

    // mirror clamping band around the hub
    const clamp = new THREE.Mesh(track(new THREE.RingGeometry(0.8, 1.3, 96)), matSilverClamp);
    clamp.position.z = DISC_T / 2 + 0.002;
    discPivot.add(clamp);
    const clampB = clamp.clone();
    clampB.position.z = -DISC_T / 2 - 0.002;
    clampB.rotation.y = Math.PI;
    discPivot.add(clampB);

    // very subtle concentric delineations (mirror-band edge + data start)
    for (const r of [1.78, 2.4, 5.85]) {
      const gm = track(new THREE.MeshStandardMaterial({ color: 0x8f959d, metalness: 1, roughness: 0.5, transparent: true, opacity: 0.35 }));
      const g = new THREE.Mesh(track(new THREE.TorusGeometry(r, 0.006, 6, 140)), gm);
      g.position.z = DISC_T / 2;
      discPivot.add(g);
      const gb = g.clone();
      gb.position.z = -DISC_T / 2;
      discPivot.add(gb);
    }
  }
  // Disc label: the printed face, above the clamp band and the concentric rings. RingGeometry's
  // UVs span its outer diameter, so a square disc-art image lands centred on the disc.
  const discLabel: ArtMesh = new THREE.Mesh(
    track(new THREE.RingGeometry(1.3, 5.85, 160)),
    track(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.05, envMapIntensity: 0.6 }))
  );
  discLabel.position.z = DISC_T / 2 + 0.008;
  discLabel.visible = false;
  discPivot.add(discLabel);
  discPivot.position.copy(DISC_SEATED);
  root.add(discPivot);

  // ===== LID (clear): shell + hinge knuckles, pivots on the pin axis =====
  const lidPivot = new THREE.Group();
  lidPivot.position.set(PIVOT_X, 0, 0);
  let insert!: ArtMesh;
  {
    const lid = new THREE.Group();
    lid.position.x = -PIVOT_X; // so the lid spans the footprint (centred at x=0) when closed

    const front = new THREE.Mesh(track(roundedBox(W, H, 0.11)), matClear);
    front.position.z = LID_D - 0.055;
    lid.add(front);

    const mkLidWall = (w: number, h: number, d: number, x: number, y: number) => {
      const m = new THREE.Mesh(track(roundedBox(w, h, d)), matClear);
      m.position.set(x, y, LID_D / 2);
      lid.add(m);
    };
    mkLidWall(W, WALL, LID_D, 0, H / 2 - WALL / 2);
    mkLidWall(W, WALL, LID_D, 0, -H / 2 + WALL / 2);
    mkLidWall(WALL, H, LID_D, W / 2 - WALL / 2, 0);

    // Booklet insert: the printed front page sits just inside the clear lid.
    // Hidden until cover art is assigned (Scene sets material.map + visible).
    insert = new THREE.Mesh(
      track(new THREE.PlaneGeometry(W - 0.5, H - 0.5)),
      track(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.02, envMapIntensity: 0.5 }))
    );
    insert.position.z = LID_D - 0.18;
    insert.visible = false;
    lid.add(insert);
    lidPivot.add(lid);

    // lid hinge knuckles at the pin axis (rotate with the lid)
    const knuckleGeo = track(new THREE.CylinderGeometry(0.13, 0.13, 2.4, 16));
    for (const y of [-4.6, 0, 4.6]) {
      const k = new THREE.Mesh(knuckleGeo, matTray);
      k.position.set(0, y, 0);
      lidPivot.add(k);
    }
  }
  root.add(lidPivot);

  // fixed hinge pin (the axis the lid turns on)
  const pin = new THREE.Mesh(track(new THREE.CylinderGeometry(0.05, 0.05, H, 12)), matRosette);
  pin.position.set(PIVOT_X, 0, 0);
  root.add(pin);

  return { root, tray, lidPivot, discPivot, insert, trayCard, discLabel, disposables };
}

export interface JewelCaseArt {
  /** Resolved URLs (data URI or asset URL) of the printed pieces. */
  frontArtUrl?: string;
  backArtUrl?: string;
  discArtUrl?: string;
}

/** Which printed piece paints which mesh. */
export function artSlots(parts: CaseParts, art: JewelCaseArt): Array<[ArtMesh, string | undefined]> {
  return [
    [parts.insert, art.frontArtUrl],
    [parts.trayCard, art.backArtUrl],
    [parts.discLabel, art.discArtUrl]
  ];
}

/**
 * Paint `url` onto the mesh once it loads (hidden until then, and hidden when unset).
 * A missing or unreadable file leaves the bare case. Returns a cancel for stale loads.
 */
export function loadArt(mesh: ArtMesh, url: string | undefined, loader: Pick<THREE.TextureLoader, "load"> = new THREE.TextureLoader()) {
  const material = mesh.material;
  if (!url) {
    mesh.visible = false;
    material.map?.dispose();
    material.map = null;
    material.needsUpdate = true;
    return () => undefined;
  }
  let cancelled = false;
  loader.load(
    url,
    (texture) => {
      if (cancelled) {
        texture.dispose();
        return;
      }
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 8;
      material.map?.dispose();
      material.map = texture;
      material.needsUpdate = true;
      mesh.visible = true;
    },
    undefined,
    () => undefined
  );
  return () => {
    cancelled = true;
  };
}

export type JewelCaseState = "closed" | "open" | "ejected";

/** Imperative handles for keyboard control (the case itself has no buttons). */
export interface JewelCaseControls {
  toggleOpen: () => void;
  toggleEject: () => void;
}

interface Props extends JewelCaseArt {
  interactive?: boolean;
  autoOpen?: boolean;
  onStateChange?: (state: JewelCaseState) => void;
  /** Filled with open/eject toggles while the case is mounted. */
  controls?: MutableRefObject<JewelCaseControls | null>;
}

export function resolveJewelCaseExactClickTarget(
  open: boolean,
  discHit: boolean,
  caseHit: boolean
): "disc" | "case" | null {
  if (open && discHit) return "disc";
  if (caseHit) return "case";
  return null;
}

function Scene({ interactive = false, autoOpen = false, frontArtUrl, backArtUrl, discArtUrl, onStateChange, controls }: Props) {
  const { gl, scene, camera } = useThree();
  const parts = useMemo(() => buildCase(), []);
  const controlsRef = useRef<OrbitControls | null>(null);

  const reduceMotion = useMemo(prefersReducedMotion, []);

  // ---------- printed art: front insert, tray card, disc label ----------
  useEffect(() => {
    const cancels = artSlots(parts, { frontArtUrl, backArtUrl, discArtUrl }).map(([mesh, url]) => loadArt(mesh, url));
    return () => cancels.forEach((cancel) => cancel());
  }, [frontArtUrl, backArtUrl, discArtUrl, parts]);

  // imperative interaction state (no React re-render needed)
  const stateRef = useRef({ open: autoOpen, ejected: false });
  const lidRef = useRef({ angle: autoOpen ? OPEN_ANGLE : 0, vel: 0, target: autoOpen ? OPEN_ANGLE : 0 });
  const discQueueRef = useRef<THREE.Vector3[]>([]);

  const setOpen = (v: boolean) => {
    stateRef.current.open = v;
    lidRef.current.target = v ? OPEN_ANGLE : 0;
    onStateChange?.(v ? "open" : "closed");
  };
  const setEject = (v: boolean) => {
    stateRef.current.ejected = v;
    if (v && !stateRef.current.open) setOpen(true); // open first so the disc never passes through the lid
    discQueueRef.current = v ? [DISC_FWD.clone(), DISC_RIGHT.clone()] : [DISC_FWD.clone(), DISC_SEATED.clone()];
    onStateChange?.(v ? "ejected" : stateRef.current.open ? "open" : "closed");
  };

  // keyboard control (the studio's focusable case-scene drives these)
  useEffect(() => {
    if (!controls) return;
    controls.current = {
      toggleOpen: () => setOpen(!stateRef.current.open),
      toggleEject: () => setEject(!stateRef.current.ejected)
    };
    return () => {
      controls.current = null;
    };
  });

  // ---------- environment + background + tone-mapping ----------
  useEffect(() => {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.02;
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFSoftShadowMap;

    // Transparent canvas: no scene.background, so the case floats in the site's own
    // background (the void) with no framed rectangle. The environment map still drives
    // reflections/transmission without ever being drawn as a visible backdrop.
    scene.background = null;

    const pmrem = new THREE.PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 1.15;

    return () => {
      scene.environment = null;
      env.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);

  // ---------- lights ----------
  useEffect(() => {
    RectAreaLightUniformsLib.init();
    const lights: THREE.Object3D[] = [];

    const key = new THREE.DirectionalLight(0xffffff, 2.3);
    key.position.set(9, 14, 12);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 80;
    key.shadow.camera.left = -14;
    key.shadow.camera.right = 14;
    key.shadow.camera.top = 14;
    key.shadow.camera.bottom = -14;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    lights.push(key);

    const rim = new THREE.DirectionalLight(0x9fc4cc, 0.8);
    rim.position.set(-12, 4, -8);
    lights.push(rim);

    lights.push(new THREE.HemisphereLight(0x4a5560, 0x070809, 0.32));

    const fill = new THREE.DirectionalLight(0xffffff, 0.9);
    fill.position.set(3, 5, 24);
    lights.push(fill);

    // soft "softbox" the metal CD reflects as a broad silver sheen
    const soft = new THREE.RectAreaLight(0xffffff, 3.4, 30, 22);
    soft.position.set(-3, 11, 21);
    soft.lookAt(0, 0, 0);
    lights.push(soft);

    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(42, 42), new THREE.ShadowMaterial({ opacity: 0.33 }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -H / 2 - 1.7;
    shadow.receiveShadow = true;
    lights.push(shadow);

    lights.forEach((l) => scene.add(l));
    return () => {
      lights.forEach((l) => {
        scene.remove(l);
        const mesh = l as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
          (mesh.material as THREE.Material)?.dispose();
        }
      });
    };
  }, [scene]);

  // Interactive default pose: a three-quarter yaw so opening the lid reads with
  // perspective instead of spreading the full double-width flat across (and off)
  // the panel. The user can still drag-orbit anywhere from here.
  useEffect(() => {
    if (interactive) {
      parts.root.rotation.y = 0.85;
    }
  }, [interactive, parts]);

  // ---------- orbit controls ----------
  useEffect(() => {
    const controls = new OrbitControls(camera, gl.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 0);
    controls.minDistance = 8;
    controls.maxDistance = 60;
    controls.enabled = interactive;
    controlsRef.current = controls;
    return () => controls.dispose();
  }, [camera, gl, interactive]);

  // ---------- click: case → open, disc → eject ----------
  useEffect(() => {
    if (!interactive) return;
    const el = gl.domElement;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let downXY: [number, number] | null = null;
    const onDown = (e: PointerEvent) => (downXY = [e.clientX, e.clientY]);
    const onUp = (e: PointerEvent) => {
      if (!downXY) return;
      const moved = Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]);
      downXY = null;
      if (moved > 5) return;
      const rect = el.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      ray.setFromCamera(ndc, camera);
      const target = resolveJewelCaseExactClickTarget(
        stateRef.current.open,
        ray.intersectObject(parts.discPivot, true).length > 0,
        ray.intersectObjects([parts.tray, parts.lidPivot], true).length > 0
      );
      if (target === "disc") {
        setEject(!stateRef.current.ejected);
        return;
      }
      if (target === "case") {
        setOpen(!stateRef.current.open);
      }
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
    };
  }, [interactive, gl, camera, parts]);

  // ---------- animation loop: spring-damper hinge + disc travel ----------
  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.033);

    const lid = lidRef.current;
    const steps = 2,
      h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = (lid.target - lid.angle) * HINGE_K - lid.vel * HINGE_C;
      lid.vel += a * h;
      lid.angle += lid.vel * h;
    }
    parts.lidPivot.rotation.y = lid.angle;

    const q = discQueueRef.current;
    if (q.length) {
      const tgt = q[0];
      parts.discPivot.position.lerp(tgt, 1 - Math.pow(0.001, dt));
      if (parts.discPivot.position.distanceTo(tgt) < 0.06) q.shift();
    }

    if (autoOpen && !interactive) {
      // Pendulum sweep across front three-quarter angles. A full spin reads as a
      // flat gray slab whenever the camera faces the case's back — the showcase
      // must always show the open lid + disc.
      parts.root.rotation.y = 1.0 + (reduceMotion ? 0 : Math.sin(state.clock.getElapsedTime() * 0.3) * 0.35);
    }
    controlsRef.current?.update();
  });

  useEffect(() => () => parts.disposables.forEach((d) => d.dispose()), [parts]);

  return <primitive object={parts.root} />;
}

export function JewelCaseExact({ interactive = false, autoOpen = false, frontArtUrl, backArtUrl, discArtUrl, onStateChange, controls }: Props) {
  // Landing showcase (autoOpen) frames the whole open + spinning case with air around it,
  // so it never touches the (full-bleed) canvas edge; the detail preview needs enough
  // pull-back that the case still fits its boxed panel with the lid OPEN.
  const camPos: [number, number, number] = autoOpen ? [15, 10, 36] : [15, 10, 35.5];
  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{ fov: 34, near: 0.1, far: 500, position: camPos }}
      gl={{ antialias: true, alpha: true }}
      style={{ width: "100%", height: "100%" }}
    >
      <Scene
        interactive={interactive}
        autoOpen={autoOpen}
        frontArtUrl={frontArtUrl}
        backArtUrl={backArtUrl}
        discArtUrl={discArtUrl}
        onStateChange={onStateChange}
        controls={controls}
      />
    </Canvas>
  );
}
