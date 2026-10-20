import { DiscFace, mm, SurfacePanel, type CaseSurfaces } from "./shared";

export function DigipakModel({ surfaces }: { surfaces?: CaseSurfaces }) {
  const s = surfaces ?? {};
  const panelW = mm(125);
  const panelH = mm(138);
  const boardT = mm(2.2);
  return (
    <group rotation={[0, -0.1, 0]}>
      <group position={[-panelW / 2, 0, 0]} rotation={[0, 0.22, 0]}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[panelW, panelH, boardT]} />
          <meshStandardMaterial color="#2b2722" roughness={0.92} metalness={0} envMapIntensity={0.35} />
        </mesh>
        <SurfacePanel path={s.front} label="ADD COVER ART" big position={[0, 0, boardT / 2 + 0.003]} rotation={[0, 0, 0]} width={panelW} height={panelH} roughness={0.9} />
        <SurfacePanel path={s.back ?? s.inside} label="INSIDE" position={[0, 0, -boardT / 2 - 0.003]} rotation={[0, Math.PI, 0]} width={panelW} height={panelH} roughness={0.9} />
      </group>
      <group position={[panelW / 2, 0, 0]} rotation={[0, -0.18, 0]}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[panelW, panelH, boardT]} />
          <meshStandardMaterial color="#332d25" roughness={0.92} metalness={0} envMapIntensity={0.35} />
        </mesh>
        <SurfacePanel path={s.inside ?? s.back} label="TRAY PANEL" position={[0, 0, boardT / 2 + 0.003]} rotation={[0, 0, 0]} width={panelW} height={panelH} roughness={0.9} />
        <mesh position={[0, 0, boardT / 2 + 0.018]} castShadow>
          <cylinderGeometry args={[mm(63), mm(63), mm(2.3), 120]} />
          <meshPhysicalMaterial color="#d7dde0" transparent opacity={0.35} roughness={0.16} metalness={0.02} clearcoat={0.7} envMapIntensity={1.3} />
        </mesh>
        <group position={[0, 0, boardT / 2 + 0.04]}>
          <DiscFace path={s.disc} radius={mm(60)} />
        </group>
      </group>
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[mm(5), panelH, boardT * 1.25]} />
        <meshStandardMaterial color="#1f1a16" roughness={0.94} metalness={0} />
      </mesh>
    </group>
  );
}
