import { MediaDisc, mm, SurfacePanel, type CaseSurfaces } from "./shared";

export function Vinyl7Model({ surfaces }: { surfaces?: CaseSurfaces }) {
  const s = surfaces ?? {};
  const w = mm(184);
  const h = mm(184);
  const t = mm(2);
  return (
    <group position={[-mm(54), 0, 0]} rotation={[0, 0.1, 0]}>
      <group position={[w / 2 + mm(34), 0, -t * 0.3]}>
        <MediaDisc path={s.disc} radius={mm(87.5)} labelRadius={mm(49)} holeRadius={mm(19)} label="LABEL" color="#070707" grooves />
      </group>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[w, h, t]} />
        <meshStandardMaterial color="#2a2622" roughness={0.9} metalness={0.01} />
      </mesh>
      <SurfacePanel path={s.front} label="ADD COVER ART" big position={[0, 0, t / 2 + 0.003]} rotation={[0, 0, 0]} width={w} height={h} roughness={0.88} />
      <SurfacePanel path={s.back} label="BACK" position={[0, 0, -t / 2 - 0.003]} rotation={[0, Math.PI, 0]} width={w} height={h} roughness={0.88} />
      <mesh position={[w / 2 + 0.01, 0, t / 2 + 0.014]}>
        <boxGeometry args={[mm(2.2), h - mm(12), mm(1)]} />
        <meshStandardMaterial color="#050608" roughness={0.76} />
      </mesh>
    </group>
  );
}
