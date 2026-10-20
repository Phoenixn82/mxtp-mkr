import type { Track } from "../audio/audio";
import type { SlotArt } from "../art/editor";

export interface ProjectManifest {
  name: string;
  format: "jewelcase";
  metadata: { album: string; artist: string; year?: number };
  burn: { discType: "CD-DA"; gapSeconds: number; normalize: boolean };
  tracks: Track[];
  slots: Record<string, SlotArt>;
}

export function createProject(name = "Untitled MXTP"): ProjectManifest {
  return {
    name,
    format: "jewelcase",
    metadata: { album: "", artist: "" },
    burn: { discType: "CD-DA", gapSeconds: 2, normalize: true },
    tracks: [],
    slots: {}
  };
}

export function serializeProject(project: ProjectManifest): string {
  return JSON.stringify(project, null, 2);
}

export function parseProject(json: string): ProjectManifest {
  const parsed = JSON.parse(json) as ProjectManifest;
  if (parsed.format !== "jewelcase") {
    throw new Error("Only jewelcase projects are supported in P1.");
  }
  return parsed;
}
