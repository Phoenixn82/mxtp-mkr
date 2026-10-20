# DiscForge / MXTP MKR - project rules

Tauri v2 desktop app (React+Vite+TS UI, react-three-fiber 3D, Rust backend) that authors + burns
custom CDs: import audio → arrange → assign/AI-generate cover art onto print-accurate inserts →
interactive 3D case preview → burn a real CD-DA disc + export print PDFs. Personal use, not a
product. Package name is `mxtp-mkr` (`package.json`); the folder is still `discforge/` - a
rename to `mxtp-mkr/` is deferred, cosmetic only, don't do it unprompted.

## Branch state
Active development happens on `main`. `claude/e2e-ux` is the integration branch for the e2e +
UX work packages; they merge there first, then to `main`.

## 3D case models are procedural
The studio and landing jewel case is `src/case3d/JewelCaseExact.tsx` (built in code; front,
tray and disc art map onto its insert, tray card and disc label). Other formats are the
procedural models in `src/case3d/` behind `caseModelFor()`. No third-party `.glb` ships: the
old CAD rig (`JewelCaseGltf`) and `public/models/` were removed. Every Canvas sits in a
`CanvasBoundary`, so a 3D failure shows the 2D fallback instead of crashing the app.

## Print geometry is the source of truth - don't hand-derive it
`src/print/dimensions.ts` exposes typed accessors over `src/print/dimensions.generated.ts`, which
is generated at build time by `scripts/gen-dimensions.mjs` from the Disc Makers CSV/layout guides
(`docs/reference/discmakers-templates/`, the distilled top-level CSV/MD files - the multi-GB raw
template payloads are gitignored and re-downloadable, don't try to commit them). Never hardcode a
bleed/trim/safety/media number in a component - look it up via `getDimension(componentId)`.
Verified example: `CD100` (2-page front insert) media = 6.25in / 1875px@300dpi, bleed = 5.0in /
1500px@300dpi - bleed is smaller than media, not the other way around; don't invert this pair.
Saddle-stitch booklets store safety **per page** (`pageSafety`), not per spread - halving it again
in a consumer is the bug that produced a real half-width lyric-column regression (fixed, see git
history for `bookletPdf.ts` / `dimensions.generated.ts` gen rule).

## AI cover-art adapter is env-selected - default is Pollinations, not Codex
`generate_cover()` in `src-tauri/src/research.rs` picks the image backend from
`MXTP_MKR_IMAGEGEN`, defaulting to `"pollinations"` (free, no key required) when unset. Valid
values: `pollinations` (default), `cloudflare` (needs `CLOUDFLARE_ACCOUNT_ID` +
`CLOUDFLARE_API_TOKEN` in the app's env), `codex`, `mock`. The `codex` adapter is currently
non-functional: codex-cli 0.141+ removed the image-generation tool from `exec` mode entirely, and
`generate_cover` fails loudly with an actionable error rather than faking success - don't route
cover-gen through `codex` and don't "fix" it by suppressing that error. If you change the default
adapter, update this file - it has drifted at least once already (an earlier build auto-selected
`cloudflare` when credentials were present; that logic is gone).

## Verify on the real desktop app, not just the browser
This is a Tauri app - Vite/browser behavior can diverge from the packaged webview. The repo has a
whole family of `scripts/*-live.mjs` drivers (e.g. `verify-booklet-live.mjs`,
`verify-cad-model-live.mjs`, `probe-production-live.mjs`) that attach over CDP
(`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>`) to drive the actual
native window. Prefer one of these (or write a new one on the same pattern) over trusting a
browser-only check for anything touching burn, native file dialogs, or the 3D case.

## Burn is real but gated on hardware
`burn_cda(image, drive, simulate: bool)` (`src-tauri/src/commands.rs` → `burn::burn_cda`) is a
real write path, not a stub. On Windows it uses IMAPI2 (DAO-96 raw CD); one real audio CD was
written and finalized through it on 2026-08-24. On Linux it shells out to `cdrskin -sao` with a
generated cue sheet and CD-Text pack file; that path is covered by tests but has no recorded
hardware burn yet. Recorder enumeration returns `count=0` when no drive is attached. Don't claim
"burn works" on a platform from tests alone.

## Docs of record
- Spec: `docs/superpowers/specs/2026-06-25-discforge-design.md`
- Implementation plan: `docs/superpowers/plans/2026-06-25-mxtp-mkr-implementation-plan.md`
- Geometry/print reference: `specs/cd-packaging-spec-reference.md`
