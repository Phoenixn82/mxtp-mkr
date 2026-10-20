import { DiscFace, mm, SurfacePanel, type CaseSurfaces } from "./shared";

export function BluRayModel({ surfaces }: { surfaces?: CaseSurfaces }) {
  const s = surfaces ?? {};
  const w = mm(129);
  const h = mm(148);
  const t = mm(11);
  return (
    <group rotation={[0, 0.15, 0]}>
      <group position={[w / 2 + mm(36), 0, -t * 0.15]}>
        <DiscFace path={s.disc} radius={mm(60)} />
      </group>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[w, h, t]} />
        <meshPhysicalMaterial color="#1164e8" transparent opacity={0.48} roughness={0.13} metalness={0.04} clearcoat={0.85} envMapIntensity={1.7} />
      </mesh>
      <mesh position={[0, h / 2 - mm(11), t / 2 + 0.012]}>
        <boxGeometry args={[w - mm(8), mm(12), mm(1.2)]} />
        <meshPhysicalMaterial color="#0b4ec7" transparent opacity={0.76} roughness={0.16} clearcoat={0.8} />
      </mesh>
      <SurfacePanel path={s.front} label="ADD COVER ART" big position={[0, -mm(6), t / 2 + 0.018]} rotation={[0, 0, 0]} width={w - mm(12)} height={h - mm(31)} roughness={0.42} />
      <SurfacePanel path={s.back} label="BACK" position={[0, -mm(6), -t / 2 - 0.004]} rotation={[0, Math.PI, 0]} width={w - mm(12)} height={h - mm(31)} roughness={0.42} />
      <SurfacePanel path={s.spine} label="SPINE" vertical position={[-w / 2 - 0.004, -mm(2), 0]} rotation={[0, -Math.PI / 2, 0]} width={t} height={h - mm(12)} roughness={0.38} />
    </group>
  );
}
