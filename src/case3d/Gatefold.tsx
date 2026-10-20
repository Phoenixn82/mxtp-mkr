import { MediaDisc, mm, SurfacePanel, type CaseSurfaces } from "./shared";

export function GatefoldModel({ surfaces }: { surfaces?: CaseSurfaces }) {
  const s = surfaces ?? {};
  const panelW = mm(314);
  const h = mm(314);
  const t = mm(3);
  return (
    <group rotation={[0, 0.04, 0]}>
      <group position={[-panelW * 0.86, 0, -0.08]}>
        <MediaDisc path={s.disc} radius={mm(151)} labelRadius={mm(50)} holeRadius={mm(3.5)} label="LP 1" color="#070707" grooves />
      </group>
      <group position={[panelW * 0.86, 0, -0.1]}>
        <MediaDisc path={s.disc} radius={mm(151)} labelRadius={mm(50)} holeRadius={mm(3.5)} label="LP 2" color="#080808" grooves />
      </group>
      <group position={[-panelW / 2, 0, 0]} rotation={[0, -0.16, 0]}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[panelW, h, t]} />
          <meshStandardMaterial color="#28231f" roughness={0.9} metalness={0.01} />
        </mesh>
        <SurfacePanel path={s.insideLeft} label="INSIDE LEFT" position={[0, 0, t / 2 + 0.004]} rotation={[0, 0, 0]} width={panelW} height={h} roughness={0.88} />
        <SurfacePanel path={s.front} label="FRONT" position={[0, 0, -t / 2 - 0.004]} rotation={[0, Math.PI, 0]} width={panelW} height={h} roughness={0.88} />
      </group>
      <group position={[panelW / 2, 0, 0]} rotation={[0, 0.16, 0]}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[panelW, h, t]} />
          <meshStandardMaterial color="#2f2924" roughness={0.9} metalness={0.01} />
        </mesh>
        <SurfacePanel path={s.insideRight} label="INSIDE RIGHT" position={[0, 0, t / 2 + 0.004]} rotation={[0, 0, 0]} width={panelW} height={h} roughness={0.88} />
        <SurfacePanel path={s.back} label="BACK" position={[0, 0, -t / 2 - 0.004]} rotation={[0, Math.PI, 0]} width={panelW} height={h} roughness={0.88} />
      </group>
      <mesh position={[0, 0, 0.01]}>
        <boxGeometry args={[mm(7), h, t * 1.4]} />
        <meshStandardMaterial color="#171412" roughness={0.92} metalness={0.01} />
      </mesh>
    </group>
  );
}
