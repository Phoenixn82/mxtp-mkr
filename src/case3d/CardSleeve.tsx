import { DiscFace, mm, SurfacePanel, type CaseSurfaces } from "./shared";

export function CardSleeveModel({ surfaces }: { surfaces?: CaseSurfaces }) {
  const s = surfaces ?? {};
  const w = mm(125);
  const h = mm(125);
  const t = mm(3);
  return (
    <group rotation={[0, 0.12, 0]}>
      <group position={[w / 2 + mm(22), 0, -t * 0.15]}>
        <DiscFace path={s.disc} radius={mm(60)} />
      </group>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[w, h, t]} />
        <meshStandardMaterial color="#312a22" roughness={0.91} metalness={0.01} />
      </mesh>
      <SurfacePanel path={s.front} label="ADD COVER ART" big position={[0, 0, t / 2 + 0.004]} rotation={[0, 0, 0]} width={w} height={h} roughness={0.9} />
      <SurfacePanel path={s.back} label="BACK" position={[0, 0, -t / 2 - 0.004]} rotation={[0, Math.PI, 0]} width={w} height={h} roughness={0.9} />
      <mesh position={[0, h / 2 - mm(6), t / 2 + 0.012]}>
        <circleGeometry args={[mm(18), 48, Math.PI, Math.PI]} />
        <meshStandardMaterial color="#050608" roughness={0.82} />
      </mesh>
      <mesh position={[w / 2 + 0.008, 0, t / 2 + 0.014]}>
        <boxGeometry args={[mm(2.4), h - mm(16), mm(1)]} />
        <meshStandardMaterial color="#070707" roughness={0.78} />
      </mesh>
    </group>
  );
}
