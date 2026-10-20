import { DoubleSide } from "three";
import { mm, SurfacePanel, type CaseSurfaces } from "./shared";

export function EightTrackModel({ surfaces }: { surfaces?: CaseSurfaces }) {
  const s = surfaces ?? {};
  const w = mm(135);
  const h = mm(102);
  const t = mm(21);
  return (
    <group rotation={[0, 0.16, 0]}>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[w, h, t]} />
        <meshStandardMaterial color="#1e2529" roughness={0.68} metalness={0.04} envMapIntensity={0.8} />
      </mesh>
      <SurfacePanel path={s.front ?? s.label} label="8-TRACK LABEL" big position={[0, mm(12), t / 2 + 0.004]} rotation={[0, 0, 0]} width={w - mm(18)} height={mm(50)} roughness={0.62} />
      <SurfacePanel path={s.top} label="TOP" position={[0, h / 2 + 0.004, 0]} rotation={[-Math.PI / 2, 0, 0]} width={w - mm(10)} height={t} roughness={0.62} />
      <mesh position={[0, -h / 2 + mm(20), t / 2 + 0.01]}>
        <boxGeometry args={[w - mm(28), mm(16), mm(2)]} />
        <meshStandardMaterial color="#101417" roughness={0.74} metalness={0.02} />
      </mesh>
      {[-mm(34), mm(34)].map((x) => (
        <mesh key={x} position={[x, -h / 2 + mm(20), t / 2 + 0.024]}>
          <ringGeometry args={[mm(5), mm(11), 48]} />
          <meshStandardMaterial color="#c5ccd0" roughness={0.3} metalness={0.34} side={DoubleSide} />
        </mesh>
      ))}
      <mesh position={[0, h / 2 - mm(8), t / 2 + 0.012]}>
        <boxGeometry args={[w - mm(18), mm(5), mm(1.5)]} />
        <meshStandardMaterial color="#313a40" roughness={0.54} metalness={0.08} />
      </mesh>
    </group>
  );
}
