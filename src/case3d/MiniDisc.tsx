import { mm, SurfacePanel, type CaseSurfaces } from "./shared";

export function MiniDiscModel({ surfaces }: { surfaces?: CaseSurfaces }) {
  const s = surfaces ?? {};
  const caseW = mm(78);
  const caseH = mm(72);
  const caseT = mm(7);
  const cartW = mm(72);
  const cartH = mm(68);
  const cartT = mm(5);
  return (
    <group rotation={[0, 0.16, 0]}>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[caseW, caseH, caseT]} />
        <meshPhysicalMaterial color="#d7f3ff" transparent opacity={0.3} roughness={0.06} metalness={0.03} clearcoat={0.88} envMapIntensity={1.7} />
      </mesh>
      <group position={[0, 0, caseT / 2 + 0.03]}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[cartW, cartH, cartT * 0.12]} />
          <meshStandardMaterial color="#d8dde0" roughness={0.58} metalness={0.06} />
        </mesh>
        <SurfacePanel path={s.front ?? s.label} label="MD LABEL" position={[0, mm(13), cartT * 0.08]} rotation={[0, 0, 0]} width={mm(56)} height={mm(20)} />
        <SurfacePanel path={s.cartridge} label="CARTRIDGE" position={[0, -mm(13), cartT * 0.081]} rotation={[0, 0, 0]} width={mm(48)} height={mm(22)} />
        <mesh position={[mm(18), -mm(12), cartT * 0.09]}>
          <boxGeometry args={[mm(28), mm(20), mm(1.2)]} />
          <meshStandardMaterial color="#8e969b" roughness={0.26} metalness={0.6} envMapIntensity={1.3} />
        </mesh>
        <mesh position={[-mm(18), -mm(12), cartT * 0.095]}>
          <circleGeometry args={[mm(10), 64]} />
          <meshStandardMaterial color="#22272b" roughness={0.3} metalness={0.35} />
        </mesh>
      </group>
    </group>
  );
}
