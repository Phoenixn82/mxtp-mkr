import { DiscFace, mm, SurfacePanel, type CaseSurfaces } from "./shared";

export function DvdCaseModel({ surfaces }: { surfaces?: CaseSurfaces }) {
  const s = surfaces ?? {};
  const w = mm(135);
  const h = mm(190);
  const t = mm(14);
  return (
    <group rotation={[0, 0.16, 0]}>
      <group position={[w / 2 + mm(34), 0, -t * 0.1]}>
        <DiscFace path={s.disc} radius={mm(60)} />
      </group>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[w, h, t]} />
        <meshStandardMaterial color="#101827" roughness={0.56} metalness={0.02} envMapIntensity={0.8} />
      </mesh>
      <SurfacePanel path={s.front} label="ADD COVER ART" big position={[0, 0, t / 2 + 0.004]} rotation={[0, 0, 0]} width={w - mm(10)} height={h - mm(14)} roughness={0.48} />
      <SurfacePanel path={s.back} label="BACK" position={[0, 0, -t / 2 - 0.004]} rotation={[0, Math.PI, 0]} width={w - mm(10)} height={h - mm(14)} roughness={0.48} />
      <SurfacePanel path={s.spine} label="SPINE" vertical position={[-w / 2 - 0.004, 0, 0]} rotation={[0, -Math.PI / 2, 0]} width={t} height={h - mm(8)} roughness={0.5} />
      <mesh position={[-w / 2 + mm(8), 0, t / 2 + 0.02]}>
        <boxGeometry args={[mm(3), h - mm(8), mm(2)]} />
        <meshStandardMaterial color="#05090f" roughness={0.52} metalness={0.04} />
      </mesh>
    </group>
  );
}
