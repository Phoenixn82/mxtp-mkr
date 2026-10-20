#!/usr/bin/env node
// gen-dimensions.mjs — Phase A of the MXTP MKR print system.
//
// Parses the Disc Makers extracted layout guide map (332 component rows) ONCE
// at build time and emits a committed, typed registry that the browser bundle
// imports directly. No CSV parsing ever ships to the client.
//
// Contract owner: Claude (the dimension registry contract). This generator
// implements that contract faithfully and NEVER invents missing numbers — a
// row that exposed no real bleed/trim/safety geometry is carried with whatever
// IS present and flagged machineReadable:false + a caveat.
//
// Run:  node scripts/gen-dimensions.mjs
// It validates against hard anchors (CD100, CDT100, CD1600R, UD100) and THROWS
// if any is off by > 0.01in, printing one PASS line per anchor.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const CSV_PATH = path.join(
  REPO,
  "docs/reference/discmakers-templates/extracted-layout-guide-map.csv"
);
const OUT_PATH = path.join(REPO, "src/print/dimensions.generated.ts");

const TOL = 0.01; // inches
const MM_PER_IN = 25.4;
const MIN_BOX_IN = 0.5; // ignore legend/curve/registration boxes smaller than this
const MIN_FOLD_IN = 1.0; // ignore fold guides shorter than production scale

// ---------------------------------------------------------------------------
// RFC-4180 CSV parser (dependency-free). Handles quoted fields containing
// commas and embedded JSON; "" inside a quoted field is an escaped quote.
// ---------------------------------------------------------------------------
function parseCSV(text) {
  const rows = [];
  let field = "";
  let row = [];
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseJSONArray(s) {
  if (!s || !s.trim()) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

// Build a BoxDims triple ({in, mm, px300, insets?}) from a raw box object.
function boxDims(b) {
  const w = b.width_in;
  const h = b.height_in;
  const out = {
    in: { w: round3(w), h: round3(h) },
    mm: { w: round3(w * MM_PER_IN), h: round3(h * MM_PER_IN) },
    px300: { w: Math.round(w * 300), h: Math.round(h * 300) }
  };
  const hasInsets =
    b.inset_left_in != null ||
    b.inset_right_in != null ||
    b.inset_top_in != null ||
    b.inset_bottom_in != null;
  if (hasInsets) {
    out.insets = {
      left: b.inset_left_in != null ? round3(b.inset_left_in) : null,
      right: b.inset_right_in != null ? round3(b.inset_right_in) : null,
      top: b.inset_top_in != null ? round3(b.inset_top_in) : null,
      bottom: b.inset_bottom_in != null ? round3(b.inset_bottom_in) : null
    };
  }
  return out;
}

function dimsFromWH(width_in, height_in) {
  return boxDims({ width_in, height_in });
}

function isRects(b) {
  return String(b.source || "").endsWith("rects");
}
function pageOf(b) {
  const m = String(b.source || "").match(/page\s+(\d+)/i);
  return m ? Number(m[1]) : 999;
}
function bigEnough(b) {
  return b.width_in >= MIN_BOX_IN && b.height_in >= MIN_BOX_IN;
}

// Pick the production representative rect for bleed/trim/safety:
// prefer a "rects" source on the lowest page number, ignore tiny boxes.
// Falls back to the largest big-enough box (curves) — needed for disc labels
// whose guides come from curves, not rects.
function pickProductionBox(arr) {
  const big = arr.filter(bigEnough);
  if (big.length === 0) return null;
  const rects = big.filter(isRects).sort((a, b) => pageOf(a) - pageOf(b));
  if (rects.length) return rects[0];
  // no rects: take the largest-area big box (deterministic on ties by page)
  return big
    .slice()
    .sort(
      (a, b) =>
        b.width_in * b.height_in - a.width_in * a.height_in ||
        pageOf(a) - pageOf(b)
    )[0];
}

// Fold guides: keep only production-scale lines (longer than ~1in), record
// position as inset_left_in rounded to 3 decimals, dedupe identical positions.
function foldPositions(arr) {
  const seen = new Set();
  const out = [];
  for (const f of arr) {
    const len = Math.max(f.width_in || 0, f.height_in || 0);
    if (len <= MIN_FOLD_IN) continue;
    const pos = round3(f.inset_left_in ?? 0);
    if (seen.has(pos)) continue;
    seen.add(pos);
    out.push(pos);
  }
  return out.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------
function deriveFormatId(sourcePage) {
  const p = sourcePage.toLowerCase();
  if (p.includes("jewel")) return "jewel";
  if (p.includes("digipak")) return "digipak";
  if (p.includes("dvd")) return "dvd";
  if (p.includes("blu")) return "bluray";
  if (p.includes("vinyl")) return "vinyl";
  if (p.includes("usb")) return "usb";
  if (p.includes("wallet")) return "wallet";
  if (p.includes("jacket")) return "jacket";
  if (p.includes("folder")) return "folder";
  if (p.includes("promo")) return "promo";
  if (p.includes("logo") || p.includes("font")) return "logofont";
  if (p.includes("on-disc") || p.includes("ondisc") || p.includes("on disc"))
    return "ondisc";
  return "other";
}

function baseComponent(id) {
  // Strip inside/outside print-face suffix for anchor / alias resolution.
  return id.replace(/_(in|out)$/i, "");
}

function classifyKind(row, media, folds) {
  const tmpl = row.template_name || "";
  const comp = row.component || "";
  const src = row.source_page || "";
  // disc
  if (
    /disc label|on-disc|on disc|print to center/i.test(tmpl) ||
    /on-disc|ondisc/i.test(src) ||
    /^UD100|^VCD200|^_UD100/.test(comp)
  ) {
    return "disc";
  }
  // saddle-stitch booklet: a CD####R / DVD####R code printed 2-up (media width
  // ~= 2x a single ~4.75-5in page => >= ~9in). A "Booklet" in the template name
  // alone is NOT sufficient — the dataset has header-only per-page booklet tiles
  // (Booklet_CD_2_3 …) and a wallet whose name says "thick booklet"; neither is
  // a true 2-up saddle spread, so we gate strictly on the R-code + 2-up media.
  const isBookletCode = /^(CD|DVD)\d+R$/.test(comp);
  const mediaW = media ? media.in.w : 0;
  if (isBookletCode && mediaW >= 9.0) {
    return "saddle-booklet";
  }
  if (folds.length > 0) return "folded-panel";
  return "single";
}

// Derive booklet page count. The component code encodes it in hundreds
// (CD1600R -> 16, CD800R -> 8, CD2400R -> 24), i.e. digits / 100. We
// cross-check against media page_count * 2 (2 pages per printed spread face)
// and prefer the media-derived count when both are present, since it reflects
// the actually-measured sheet stack.
function bookletPages(comp, pageCount) {
  const m = comp.match(/^(?:CD|DVD)(\d+)R$/);
  const fromCode = m ? Number(m[1]) / 100 : null;
  const fromMedia = pageCount ? pageCount * 2 : null;
  if (fromMedia != null) return fromMedia;
  if (fromCode != null) return fromCode;
  return null;
}

// ---------------------------------------------------------------------------
// Build one ComponentDim from a CSV row (record form: keyed by header name).
// ---------------------------------------------------------------------------
function buildDim(row) {
  const mediaArr = parseJSONArray(row.page_media_boxes);
  const bleedArr = parseJSONArray(row.bleed_boxes);
  const trimArr = parseJSONArray(row.trim_boxes);
  const safeArr = parseJSONArray(row.safety_boxes);
  const foldArr = parseJSONArray(row.fold_lines);

  const media = mediaArr.length
    ? dimsFromWH(mediaArr[0].width_in, mediaArr[0].height_in)
    : null;

  const bleedBox = pickProductionBox(bleedArr);
  const trimBox = pickProductionBox(trimArr);
  const safeBox = pickProductionBox(safeArr);

  const bleed = bleedBox ? boxDims(bleedBox) : null;
  const trim = trimBox ? boxDims(trimBox) : null;
  const safety = safeBox ? boxDims(safeBox) : null;

  const folds = foldPositions(foldArr);
  const formatId = deriveFormatId(row.source_page);
  const kind = classifyKind(row, media, folds);

  // machineReadable: real bleed/trim/safety geometry was exposed.
  const machineReadable = Boolean(bleed || trim || safety);

  const dim = {
    id: row.component,
    formatId,
    kind,
    template: row.template_name,
    representative: row.representative_file,
    analysisMethod: row.analysis_method,
    media,
    bleed,
    trim,
    safety,
    foldLines: folds,
    machineReadable,
    notes: row.notes || ""
  };

  // pages
  if (kind === "saddle-booklet") {
    const pc = Number(row.page_count) || 0;
    const pages = bookletPages(row.component, pc);
    if (pages != null) dim.pages = pages;
    dim.upCount = 2;
    // Derived per-page boxes: width halves (2-up spread), height unchanged.
    // The inner spine edge has no bleed — we do NOT fabricate an inner bleed;
    // pageBleed width is simply the spread bleed halved and the caveat records
    // that the derived page is nominal (outer-edge bleed only).
    if (trim) dim.pageTrim = dimsFromWH(trim.in.w / 2, trim.in.h);
    if (bleed) dim.pageBleed = dimsFromWH(bleed.in.w / 2, bleed.in.h);
    // Templates draw safety guides PER PAGE: when the recorded safety already
    // fits within half the spread trim it IS the page safety verbatim —
    // halving it again squeezed booklet text into a quarter-spread column.
    if (safety) {
      const alreadyPerPage = trim && safety.in.w <= trim.in.w / 2 + 1e-6;
      dim.pageSafety = alreadyPerPage
        ? dimsFromWH(safety.in.w, safety.in.h)
        : dimsFromWH(safety.in.w / 2, safety.in.h);
    }
  } else if (kind === "folder") {
    // (folders are classified folded-panel by fold presence; explicit code
    // parse left as a no-op hook — no folder in this dataset encodes a page
    // count in its component id.)
    dim.upCount = 1;
  } else {
    dim.upCount = 1;
  }

  // Disc: expose outer printable (largest bleed/trim box) + center hole.
  // The hole is the smallest "curves" box on the disc (~0.5906in = 15mm).
  if (kind === "disc") {
    const holeCandidates = [...bleedArr, ...trimArr, ...safeArr]
      .filter(
        (b) =>
          b.width_in > 0.3 &&
          b.width_in < 1.0 &&
          Math.abs(b.width_in - b.height_in) < 0.05
      )
      .sort((a, b) => a.width_in - b.width_in);
    if (holeCandidates.length) {
      dim.hole = round3(holeCandidates[0].width_in);
    }
  }

  // caveat when we could not expose real geometry.
  if (!machineReadable) {
    const method = /psd header/i.test(row.analysis_method)
      ? "PSD-header-only (pixel canvas / PPI); no vector bleed/trim/safety guides"
      : /eps/i.test(row.analysis_method)
        ? "EPS BoundingBox-only; no bleed/trim/safety guides"
        : /metadata only/i.test(row.analysis_method)
          ? "metadata-only source; no extractable guides"
          : "no bleed/trim/safety geometry present in source";
    dim.caveat = method;
  } else if (kind === "saddle-booklet") {
    dim.caveat =
      "Per-page boxes derived by halving the 2-up spread width; the inner " +
      "spine edge carries no bleed (not fabricated).";
  }

  return dim;
}

// ---------------------------------------------------------------------------
// Dedupe: group by component id (the SAME id appears under multiple
// source_pages / template names). Prefer the row with machineReadable geometry
// and a .pdf representative; on a true dims conflict keep the first + note it.
// ---------------------------------------------------------------------------
function dedupe(dims) {
  const byId = new Map();
  for (const d of dims) {
    if (!byId.has(d.id)) {
      byId.set(d.id, d);
      continue;
    }
    const cur = byId.get(d.id);
    const better = preferred(cur, d);
    const loser = better === cur ? d : cur;
    // detect a genuine trim-dims conflict between the two rows
    if (
      cur.trim &&
      d.trim &&
      (Math.abs(cur.trim.in.w - d.trim.in.w) > TOL ||
        Math.abs(cur.trim.in.h - d.trim.in.h) > TOL)
    ) {
      const note =
        `dim conflict for ${d.id}: kept ${better.template} trim ` +
        `${better.trim.in.w}x${better.trim.in.h}, dropped ${loser.template} ` +
        `trim ${loser.trim.in.w}x${loser.trim.in.h}`;
      better.notes = better.notes ? `${better.notes} | ${note}` : note;
    }
    byId.set(d.id, better);
  }
  return byId;
}

function preferred(a, b) {
  const score = (d) =>
    (d.machineReadable ? 2 : 0) +
    (/\.pdf$/i.test(d.representative || "") ? 1 : 0);
  return score(b) > score(a) ? b : a;
}

// ---------------------------------------------------------------------------
// Anchor validation
// ---------------------------------------------------------------------------
function near(a, b) {
  return Math.abs(a - b) <= TOL;
}

function resolveAnchor(byId, anchorKey) {
  if (byId.has(anchorKey)) return byId.get(anchorKey);
  if (byId.has(`${anchorKey}_in`)) return byId.get(`${anchorKey}_in`);
  if (byId.has(`${anchorKey}_out`)) return byId.get(`${anchorKey}_out`);
  for (const d of byId.values()) {
    if (baseComponent(d.id) === anchorKey) return d;
  }
  return null;
}

function assertAnchor(name, cond, detail) {
  if (!cond) {
    throw new Error(`ANCHOR FAIL: ${name} — ${detail}`);
  }
}

function validateAnchors(byId) {
  // CD100 — single jewel front insert
  {
    const d = resolveAnchor(byId, "CD100");
    assertAnchor("CD100", d, "not found in registry");
    assertAnchor("CD100 kind", d.kind === "single", `kind=${d.kind}`);
    assertAnchor("CD100 format", d.formatId === "jewel", `format=${d.formatId}`);
    assertAnchor(
      "CD100 media",
      near(d.media.in.w, 6.25) && near(d.media.in.h, 6.25),
      `media ${d.media.in.w}x${d.media.in.h}`
    );
    assertAnchor(
      "CD100 bleed",
      near(d.bleed.in.w, 5.0) && near(d.bleed.in.h, 5.0),
      `bleed ${d.bleed.in.w}x${d.bleed.in.h}`
    );
    assertAnchor(
      "CD100 trim",
      near(d.trim.in.w, 4.75) && near(d.trim.in.h, 4.75),
      `trim ${d.trim.in.w}x${d.trim.in.h}`
    );
    assertAnchor(
      "CD100 safety",
      near(d.safety.in.w, 4.5) && near(d.safety.in.h, 4.5),
      `safety ${d.safety.in.w}x${d.safety.in.h}`
    );
    assertAnchor(
      "CD100 folds",
      d.foldLines.length === 0,
      `folds ${JSON.stringify(d.foldLines)}`
    );
    console.log(
      `PASS CD100 (single/jewel): media 6.25x6.25 bleed 5x5 trim 4.75x4.75 safety 4.5x4.5 folds []`
    );
  }

  // CDT100 — folded-panel jewel traycard
  {
    const d = resolveAnchor(byId, "CDT100");
    assertAnchor("CDT100", d, "not found in registry");
    assertAnchor(
      "CDT100 kind",
      d.kind === "folded-panel",
      `kind=${d.kind}`
    );
    assertAnchor(
      "CDT100 trim",
      near(d.trim.in.w, 5.906) && near(d.trim.in.h, 4.625),
      `trim ${d.trim.in.w}x${d.trim.in.h}`
    );
    assertAnchor(
      "CDT100 bleed",
      near(d.bleed.in.w, 6.156) && near(d.bleed.in.h, 4.875),
      `bleed ${d.bleed.in.w}x${d.bleed.in.h}`
    );
    assertAnchor(
      "CDT100 safety",
      near(d.safety.in.w, 5.1875) && near(d.safety.in.h, 4.375),
      `safety ${d.safety.in.w}x${d.safety.in.h}`
    );
    const hasFolds =
      d.foldLines.some((f) => near(f, 1.0)) &&
      d.foldLines.some((f) => near(f, 6.406));
    assertAnchor(
      "CDT100 folds",
      hasFolds,
      `folds ${JSON.stringify(d.foldLines)}`
    );
    console.log(
      `PASS CDT100 (folded-panel/jewel): trim 5.906x4.625 bleed 6.156x4.875 safety 5.1875x4.375 folds [1.0, 6.406]`
    );
  }

  // CD1600R — saddle-stitch 16-page booklet
  {
    const d = resolveAnchor(byId, "CD1600R");
    assertAnchor("CD1600R", d, "not found in registry");
    assertAnchor(
      "CD1600R kind",
      d.kind === "saddle-booklet",
      `kind=${d.kind}`
    );
    assertAnchor("CD1600R pages", d.pages === 16, `pages=${d.pages}`);
    assertAnchor(
      "CD1600R media",
      near(d.media.in.w, 11.0) && near(d.media.in.h, 6.25),
      `media ${d.media.in.w}x${d.media.in.h}`
    );
    assertAnchor(
      "CD1600R spreadTrim",
      near(d.trim.in.w, 9.5) && near(d.trim.in.h, 4.75),
      `spreadTrim ${d.trim.in.w}x${d.trim.in.h}`
    );
    assertAnchor(
      "CD1600R spreadBleed",
      near(d.bleed.in.w, 9.75) && near(d.bleed.in.h, 5.0),
      `spreadBleed ${d.bleed.in.w}x${d.bleed.in.h}`
    );
    assertAnchor(
      "CD1600R folds",
      d.foldLines.length === 1 && near(d.foldLines[0], 5.5),
      `folds ${JSON.stringify(d.foldLines)}`
    );
    assertAnchor(
      "CD1600R pageTrim",
      near(d.pageTrim.in.w, 4.75) && near(d.pageTrim.in.h, 4.75),
      `pageTrim ${d.pageTrim.in.w}x${d.pageTrim.in.h}`
    );
    console.log(
      `PASS CD1600R (saddle-booklet/jewel, 16pp): media 11x6.25 spreadTrim 9.5x4.75 spreadBleed 9.75x5 folds [5.5] pageTrim 4.75x4.75`
    );
  }

  // UD100 — disc label, print to center
  {
    const d = resolveAnchor(byId, "UD100");
    assertAnchor("UD100", d, "not found in registry");
    assertAnchor("UD100 kind", d.kind === "disc", `kind=${d.kind}`);
    assertAnchor(
      "UD100 media",
      near(d.media.in.w, 7.323) && near(d.media.in.h, 7.323),
      `media ${d.media.in.w}x${d.media.in.h}`
    );
    assertAnchor(
      "UD100 outer",
      near(d.bleed.in.w, 4.803),
      `outer(bleed) ${d.bleed.in.w}`
    );
    assertAnchor(
      "UD100 hole",
      d.hole != null && near(d.hole, 0.5906),
      `hole ${d.hole}`
    );
    console.log(
      `PASS UD100 (disc/${d.formatId}): media 7.323x7.323 outer 4.803 hole 0.5906 (15mm)`
    );
  }
}

// ---------------------------------------------------------------------------
// Emit the typed TS data file.
// ---------------------------------------------------------------------------
function emit(byId, machineReadableCount) {
  const entries = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const header = `// AUTO-GENERATED by scripts/gen-dimensions.mjs — DO NOT EDIT BY HAND.
// Source of truth: docs/reference/discmakers-templates/extracted-layout-guide-map.csv
// Regenerate with: node scripts/gen-dimensions.mjs
// This file carries measured Disc Makers template geometry only — no fabricated
// numbers. Rows without real bleed/trim/safety guides are machineReadable:false.
// Components: ${entries.length} | machineReadable: ${machineReadableCount}
`;
  const body = `import type { DimensionRegistry } from "./dimensions";

export const REGISTRY: DimensionRegistry = ${serialize(entries)};
`;
  fs.writeFileSync(OUT_PATH, header + "\n" + body, "utf8");
}

// Deterministic, compact-ish JSON with stable key order for clean diffs.
function serialize(entries) {
  const obj = {};
  for (const e of entries) obj[e.id] = e;
  return JSON.stringify(obj, null, 2);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const raw = fs.readFileSync(CSV_PATH, "utf8");
  const rows = parseCSV(raw);
  const header = rows[0];
  const hidx = Object.fromEntries(header.map((h, k) => [h, k]));
  const dataRows = rows
    .slice(1)
    .filter((r) => r.length > 1 && (r[hidx.component] || "").trim());

  const asRecord = (r) => {
    const o = {};
    for (const h of header) o[h] = r[hidx[h]];
    return o;
  };

  const dims = dataRows.map((r) => buildDim(asRecord(r)));
  const byId = dedupe(dims);

  const machineReadableCount = [...byId.values()].filter(
    (d) => d.machineReadable
  ).length;

  validateAnchors(byId);

  emit(byId, machineReadableCount);

  console.log(
    `WROTE ${path.relative(REPO, OUT_PATH)} — ${byId.size} components, ${machineReadableCount} machineReadable`
  );
}

main();
