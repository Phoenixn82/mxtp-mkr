import { DiscFace, mm, SurfacePanel, type CaseSurfaces } from "./shared";

export function SlimCdModel({ surfaces }: { surfaces?: CaseSurfaces }) {
  const s = surfaces ?? {};
  const w = mm(142);
  const h = mm(125);
  const t = mm(5);
  return (
    <group rotation={[0, 0.14, 0]}>
      <group position={[w / 2 + mm(34), 0, -t * 0.25]}>
        <DiscFace path={s.disc} radius={mm(60)} />
      </group>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[w, h, t]} />
        <meshPhysicalMaterial color="#e5fbff" transparent opacity={0.34} roughness={0.05} metalness={0.04} clearcoat={0.9} envMapIntensity={1.8} />
      </mesh>
      <SurfacePanel path={s.front} label="ADD COVER ART" big position={[0, 0, t / 2 + 0.004]} rotation={[0, 0, 0]} width={mm(121)} height={mm(120)} opacity={0.86} />
      <SurfacePanel path={s.back} label="BACK" position={[0, 0, -t / 2 - 0.004]} rotation={[0, Math.PI, 0]} width={mm(121)} height={mm(120)} opacity={0.8} />
      <SurfacePanel path={s.spine} label="SPINE" vertical position={[-w / 2 - 0.003, 0, 0]} rotation={[0, -Math.PI / 2, 0]} width={t} height={h} opacity={0.76} />
      <mesh position={[0, h / 2 - mm(4), t / 2 + 0.018]}>
        <boxGeometry args={[w - mm(14), mm(2.2), mm(1)]} />
        <meshPhysicalMaterial color="#ffffff" transparent opacity={0.52} roughness={0.05} clearcoat={0.9} />
      </mesh>
    </group>
  );
}
