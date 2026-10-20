import { insertSpecs } from "../geometry";

export interface LandingFormat {
  id: string;
  label: string;
}

const CASE_FORMATS: LandingFormat[] = [
  { id: "jewelcase", label: "Jewel case" },
  { id: "vinyl", label: "Vinyl" },
  { id: "gatefold", label: "Gatefold" },
  { id: "vinyl7", label: "7\" single" },
  { id: "digipak", label: "Digipak" },
  { id: "cassette", label: "Cassette" },
  { id: "dvdcase", label: "DVD case" },
  { id: "bluray", label: "Blu-ray" },
  { id: "slimcd", label: "Slim CD" },
  { id: "cardsleeve", label: "Card sleeve" },
  { id: "minidisc", label: "MiniDisc" },
  { id: "8track", label: "8-track" }
];

export function landingFormats(): LandingFormat[] {
  return CASE_FORMATS;
}

export function landingFormatLabel(id: string): string {
  const all = [...CASE_FORMATS, ...insertSpecs().map(({ id: pieceId, label }) => ({ id: pieceId, label }))];
  return all.find((format) => format.id === id)?.label ?? id;
}
