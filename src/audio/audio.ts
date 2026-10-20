export interface Track {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  durationSec: number;
  path?: string;
  url?: string;
  sampleRate?: number;
  channels?: number;
}

export interface CapacityResult {
  totalSec: number;
  limitSec: number;
  ok: boolean;
  label: string;
}

export const CDDA_LIMIT_SEC = 79 * 60 + 57;

export function formatDuration(totalSec: number): string {
  const roundedSec = Number.isFinite(totalSec) ? Math.max(0, Math.round(totalSec)) : 0;
  const min = Math.floor(roundedSec / 60);
  const sec = roundedSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

export function capacityCheck(tracks: Track[], limitSec = CDDA_LIMIT_SEC): CapacityResult {
  // Persisted tracks may lack a duration; count them as 0 rather than poisoning the total with NaN.
  const totalSec = tracks.reduce((sum, track) => sum + (track.durationSec || 0), 0);
  return {
    totalSec,
    limitSec,
    ok: totalSec <= limitSec,
    label: `${formatDuration(totalSec)} / ${formatDuration(limitSec)}`
  };
}

export function moveTrack(tracks: Track[], from: number, to: number): Track[] {
  if (
    from === to ||
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < 0 ||
    from >= tracks.length ||
    to >= tracks.length
  ) {
    return tracks;
  }
  const copy = [...tracks];
  const [track] = copy.splice(from, 1);
  copy.splice(to, 0, track);
  return copy;
}

export const fixtureTracks: Track[] = [
  { id: "one-more-time", title: "One More Time", durationSec: 320, sampleRate: 44100, channels: 2 },
  { id: "aerodynamic", title: "Aerodynamic", durationSec: 212, sampleRate: 44100, channels: 2 },
  { id: "digital-love", title: "Digital Love", durationSec: 301, sampleRate: 44100, channels: 2 }
];
