import { DoubleSide } from "three";
import { mm, SurfacePanel, type CaseSurfaces } from "./shared";

export function CassetteModel({ surfaces }: { surfaces?: CaseSurfaces }) {
  const s = surfaces ?? {};
  const caseW = mm(109);
  const caseH = mm(69);
  const caseT = mm(15);
  const shellW = mm(100);
  const shellH = mm(64);
  const shellT = mm(12);
  return (
    <group rotation={[0, 0.14, 0]}>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[caseW, caseH, caseT]} />
        <meshPhysicalMaterial color="#b9d2da" transparent opacity={0.26} roughness={0.05} metalness={0.03} clearcoat={0.95} envMapIntensity={1.2} />
      </mesh>
      <SurfacePanel path={s.front} label="ADD COVER ART" big position={[0, 0, caseT / 2 + 0.004]} rotation={[0, 0, 0]} width={mm(100)} height={mm(64)} opacity={0.82} />
      <SurfacePanel path={s.spine} label="SPINE" vertical position={[-caseW / 2 - 0.003, 0, 0]} rotation={[0, -Math.PI / 2, 0]} width={caseT} height={caseH} opacity={0.78} />
      <group position={[0, 0, caseT / 2 + 0.036]}>
        <mesh castShadow>
          <boxGeometry args={[shellW, shellH, shellT * 0.08]} />
          <meshStandardMaterial color="#151a1e" roughness={0.62} metalness={0.04} />
        </mesh>
        <SurfacePanel path={s.label ?? s.disc} label="CASSETTE LABEL" position={[0, mm(9), shellT * 0.04 + 0.004]} rotation={[0, 0, 0]} width={mm(76)} height={mm(20)} />
        <mesh position={[0, -mm(7), shellT * 0.04 + 0.006]}>
          <boxGeometry args={[mm(58), mm(14), mm(1)]} />
          <meshPhysicalMaterial color="#8fa1a8" transparent opacity={0.35} roughness={0.1} metalness={0.02} clearcoat={0.7} />
        </mesh>
        {[-mm(24), mm(24)].map((x) => (
          <group key={x} position={[x, -mm(7), shellT * 0.04 + 0.012]}>
            <mesh>
              <ringGeometry args={[mm(6), mm(15), 64]} />
              <meshStandardMaterial color="#c3cbd1" roughness={0.42} metalness={0.18} side={DoubleSide} />
            </mesh>
            <mesh>
              <ringGeometry args={[mm(2.5), mm(5), 32]} />
              <meshStandardMaterial color="#0b0d10" roughness={0.5} side={DoubleSide} />
            </mesh>
          </group>
        ))}
        <mesh position={[0, -mm(7), shellT * 0.04 + 0.014]}>
          <boxGeometry args={[mm(24), mm(4), mm(1)]} />
          <meshStandardMaterial color="#37231b" roughness={0.76} metalness={0.02} />
        </mesh>
      </group>
    </group>
  );
}
