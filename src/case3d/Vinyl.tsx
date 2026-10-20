import { MediaDisc, mm, SurfacePanel, type CaseSurfaces } from "./shared";

export function VinylModel({ surfaces }: { surfaces?: CaseSurfaces }) {
  const s = surfaces ?? {};
  const w = mm(314);
  const h = mm(314);
  const t = mm(3);
  return (
    <group position={[-mm(60), 0, 0]} rotation={[0, 0.08, 0]}>
      <group position={[w / 2 + mm(54), 0, -t * 0.25]}>
        <MediaDisc path={s.disc} radius={mm(151)} labelRadius={mm(50)} holeRadius={mm(3.5)} label="LABEL" color="#070707" grooves />
      </group>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[w, h, t]} />
        <meshStandardMaterial color="#26231f" roughness={0.88} metalness={0.01} envMapIntensity={0.45} />
      </mesh>
      <SurfacePanel path={s.front} label="ADD COVER ART" big position={[0, 0, t / 2 + 0.003]} rotation={[0, 0, 0]} width={w} height={h} roughness={0.86} />
      <SurfacePanel path={s.back} label="BACK" position={[0, 0, -t / 2 - 0.003]} rotation={[0, Math.PI, 0]} width={w} height={h} roughness={0.86} />
      <SurfacePanel path={s.spine} label="SPINE" vertical position={[-w / 2 - 0.003, 0, 0]} rotation={[0, -Math.PI / 2, 0]} width={t} height={h} roughness={0.9} />
      <mesh position={[w / 2 + 0.01, 0, t / 2 + 0.015]}>
        <boxGeometry args={[mm(3), h - mm(18), mm(1.2)]} />
        <meshStandardMaterial color="#050608" roughness={0.72} metalness={0.02} />
      </mesh>
      <mesh position={[0, -h / 2 + mm(7), t / 2 + 0.012]}>
        <boxGeometry args={[w - mm(18), mm(1.2), mm(1)]} />
        <meshStandardMaterial color="#d7d0c6" roughness={0.78} metalness={0.01} />
      </mesh>
    </group>
  );
}
