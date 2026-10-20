# CD / Disc Packaging — Spec Reference

**Purpose:** Ground-truth physical dimensions + the full Disc Makers template catalog, to drive the artwork engine and print pipeline (exact trim / bleed / safe / resolution per format).

**Sources (scraped 2026-06-25):**
- Disc Makers template hub + 9 format pages (jewel case, digipak, jacket, eco-wallet, on-disc, DVD, Blu-ray, vinyl, USB/cassette) — `discmakers.com/templates/*`
- Disc Makers "Getting CD cover dimensions right" resource — authoritative trim/bleed text
- Disc Makers "Using our Templates with Adobe Illustrator" — production workflow + guideline-layer convention
- GD Print "Ultimate Size Guide for CDs, DVDs, and Vinyl" — cross-format corroboration

**Confidence key:** ✅ stated by Disc Makers / multi-source corroborated · ⚠️ industry-standard but confirm against the actual template file at build time.

> **Note on automated downloads:** Disc Makers' `.zip` template files (which contain the exact AI/INDD/PSD geometry) are bot-protected — they 403 every non-browser request, so we could not auto-extract their precise artboard geometry. The numbers below are their published text values + corroborated industry standards. At build time, the cleanest path is to **consume the actual free template files** (user downloads the relevant `.zip` once and drops it in) or hardcode the verified geometry table below.

---

## 1. Print production constants (apply to every printed component)

| Constant | Value | Conf |
|---|---|---|
| Resolution | **300 DPI** minimum (300 ppi at final size) | ✅ |
| Color mode | **CMYK** (not RGB) | ✅ |
| Preferred output | **PDF/X-4:2008**, fonts embedded | ✅ |
| Also accepted | AI, PSD, INDD natively; hi-res TIFF/JPEG for design-service jobs | ✅ |
| Bleed | **⅛″ (0.125″ / 3.175 mm) all sides** (some DM templates use 1⁄16″ / 1.5 mm) | ✅ |
| Safe area | Keep text/logos/critical art **≥ ⅛″ inside the trim line** | ⚠️ |
| Guideline convention (DM templates) | **Blue = bleed · Pink = trim/fold · Green = safety**; layers: Your Artwork / Template Guidelines / Registration / Internal Use / Template Tags | ✅ |

**Engine implication:** every format below has three nested rectangles (or circles) — **bleed box (outer) ⊃ trim box ⊃ safe box (inner)** — generated as `trim ± 0.125″`. The AI art must fill to the bleed box; text must stay inside the safe box.

---

## 2. CORE — CD jewel case (the v1 target)

| Component | Trim size | With ⅛″ bleed | Conf |
|---|---|---|---|
| **Front cover / booklet page** | 120 × 120 mm (**4.724 × 4.724″**, nominally "4.75″") | 126.35 × 126.35 mm (4.974 × 4.974″) | ✅ |
| **Tray card (back, w/ tracklist)** | 150 × 118 mm (**5.906 × 4.646″**) incl. two spine fold-panels | +bleed | ✅ |
| → spine fold panel (each side of tray) | ~6–6.5 mm (~0.25″) wide, runs full height | ⚠️ |
| **Jewel case (physical)** | 142 × 125 × 10 mm external (slim = 5 mm spine) | — | ✅ |
| **CD disc** | Ø 120 mm (4.724″); center hole Ø 15 mm; mini-CD Ø 80 mm | — | ✅ |

Booklets: 2 / 4 / 6 / 8 / 12 / 16 / 20 / 24 / 28 pages — every page is 120 × 120 mm. Tray card alt sources: 151 × 118 mm, or printable 5.9375 × 4.625″ (variance is within bleed tolerance).

### 2b. CD inserts & booklets — math-verified sizing

**Unit model (app-internal, unambiguous — sidesteps vendor "panel vs page" inconsistency):** every insert is built from **leaves**; one *leaf face* = one printable page = **120 × 120 mm** (4.724″; design at 4.75″) + **0.125″ bleed** all sides (file = 4.974″ sq) + **0.125″ safe** inset.

| Type | Pages (faces) | Binding | Flat sheet (no bleed) | Rule |
|---|---|---|---|---|
| Front insert (1 leaf) | 2 | none | 4.75 × 4.75″ | front + inside |
| Bi-fold | 4 | 1 fold | 9.5 × 4.75″ | 2 panels/side |
| Tri-fold / folder | 6 | 2 folds | 14.25 × 4.75″ | 3 panels/side |
| 4-panel folder | 8 | 3 folds | 19 × 4.75″ | 4 panels/side |
| **Saddle-stitch booklet** | 4·n → 4, 8, 12, 16, 20, 24, 28 | stapled | per sheet 9.5 × 4.75″ (sheets = pages ÷ 4) | **pages must be a multiple of 4** |

- **Folders** = one sheet with parallel/accordion/gate folds → pages = 2 × (panels per side); **6-page is valid** (tri-fold).
- **Saddle-stitch booklets** = nested folded sheets → **pages always a multiple of 4** (4-page = 1 sheet; +4 per added sheet). A 6-page *booklet* is impossible — use a folder. ✅ multi-source.
- **Practical max in a standard jewel case ≈ 28 pages** on 80–100 lb text stock (heavier/more strains the locking tabs); slim cases hold fewer. ✅
- **Imposition (must be exact):** for a P-page saddle-stitch booklet, sheets = P ÷ 4. Reading pages 1…P, sheet *s* (0-indexed, outer→inner) carries on its **outer** face the pair `(P − 2s , 1 + 2s)` and on its **inner** face `(2 + 2s , P − 1 − 2s)`. App composes 2 finished faces side-by-side per printed sheet face at 9.5 × 4.75″ + bleed, fold line centered.

**Tray card (back):** **5.906 × 4.625″** (≈150 × 117.5 mm). Two **spine strips, 0.394″ (≈6.5 mm) each**, folded at the outer edges and **included in the 5.906″ width** → visible back panel ≈ **5.118″ (130 mm)** wide. Spine text ≥ 6 pt, centered. (Disc Makers states 150 × 118 mm / 5.906 × 4.646″ — height variance within bleed tolerance.)

**Sources (corroborated ≥3):** Disc Makers; ChilliPrinting "CD insert sizes"; PrintingForLess "CD cover specs"; Formax/ColorVision (saddle-stitch multiple-of-4 rule).

---

## 3. CORE — On-disc (disc face) printing

| Spec | Value | Conf |
|---|---|---|
| Outer printable Ø | **118 mm** (safe to 116 mm) | ⚠️ |
| Center hole Ø | 15 mm | ✅ |
| Inner printable Ø — **standard hub** disc | ~38 mm (no-print clamping/stacking ring inside that) | ⚠️ |
| Inner printable Ø — **full-face / print-to-hub** disc (DM "Print to Center", UD100) | ~22–24 mm | ⚠️ |
| Mirror/stacking-ring band | ~17–35 mm region, varies by disc stock | ⚠️ |
| DM templates | **UD100** = Print to Center · **VCD200** = "Vinyl Look" (500+ qty only) | ✅ |

**Engine implication:** disc face = annulus (ring) mask — outer Ø 118 mm, inner cut Ø = 22 mm (full-face) or 38 mm (standard hub). This is the piece meant to be **printed directly onto the disc top** (needs printable-surface discs + an inkjet that prints CDs, e.g. Epson; or a LightScribe variant — see open question in design).

---

## 4. Digipak (CD)

Glued paperboard, folds out into panels; one or more plastic/paper trays hold the disc(s).
- **Panel grid:** each panel ≈ jewel booklet footprint (~5 × 4.75″) ⚠️; total flat size = panels × width + fold gutters.
- DM catalog (20 variants): 4-panel (`4PAN1T`, `4PAN1TAPK` diag pocket, `4PAN2T`, `4PAN1TSTC` tube pkt, `4PAN1TSPB` slit pkt), 6-panel (`6PAN1TC`/`6PAN1TR`/`6PAN1T1S`/`6PAN2T`/`6PAN3T` + pocket/sleeve variants), 8-panel (`8PAN1T-R`/`8PAN1T-CR`/`8PAN2T`/`8PAN3T` + tube-pkt variants), Hub Packs (`SFT401`).
- Inserts reuse the CD booklet/folder codes (CD100/400/600/800 + CD800R…CD2400R booklets).

---

## 5. CD wallet / eco-wallet (paperboard, no plastic)

20 DM variants, all 120 mm disc footprint. Key: `W138` (4-panel, jewel-box size, no spine), `W139` (4-panel + spine, jewel-box size), `W119` (4-panel + pocket), `W121` (glue strip), `W201` (2 CDs), `W166`/`W167` (6-panel jewel-box / 2 CDs), plus many pocket/thumb-cut variants (`W142/W203/W204/W209/W169-W175`). `F102` = DVD wallet.

## 6. Jacket (CD/DVD, slim cardboard sleeve)

`J100` (jacket), `J103` (tuck flap), `J120` (glue strip). USPS-compliant mailers: `M100` (2-panel), `M120` (2-panel w/ tearstrip). ⚠️ jacket trim ≈ 5″ square + flap; confirm from template.

---

## 7. DVD

| Component | Standard size | Conf |
|---|---|---|
| Disc | Ø 120 mm | ✅ |
| Case (physical) | 190 × 135 mm, **14 mm spine** (slim = 7 mm) | ✅ |
| **Full wrap cover** (unfolded, incl. spine) | **273 × 183 mm (≈ 10.75 × 7.205″)** | ✅ |
| Insert / booklet | 184 × 120 mm | ✅ |

DM catalog: `DVD100` insert, `DVDB101` case wrap, `DVD400(+BP)`, `DVD600`, booklets `DVD800R…DVD3200R` (8–32pp), DVDigipaks `4PAN1TDVD(-L)`/`4PANDVD2T`/`6PAN1TDVD(-C/-R)`/`8PAN1TDVD`/`8PAN2TDVD`, `DVDBM101` (8-disc case), `DVDBS101` (slim safe box sleeve).

## 8. Blu-ray

DM catalog: `BD100` (2-panel insert), `BD101` (wraparound insert), `BD400` (4-panel insert). ⚠️ Standard BD case ≈ 148 × 129 mm, ~13 mm spine; wrap ≈ 272 × 149 mm — confirm from template.

---

## 9. Vinyl

| Component | Standard size | Conf |
|---|---|---|
| 12″ disc | Ø 305 mm · 10″ = 254 mm · 7″ = 178 mm | ✅ |
| **12″ LP jacket / cover** | **312 × 312 mm (≈ 12.28″)** (US jackets often 12.375″ / 314 mm) | ✅ |
| Inner sleeve | 308 × 308 mm | ✅ |
| LP label | Ø ~100 mm (3.94″); spindle hole 7.24 mm (0.286″) | ⚠️ |
| Gatefold board thickness | ~6 mm | ✅ |

DM catalog: jackets `LPJ700` (7″), `LPJ701` (7″ gatefold), `LPJ1200` (12″ Euro no-spine), `LPJ1200S` (12″ + spine), `LPJ1211` (12″ gatefold), `LPJ1212`/`LPJ1200WS` (2-LP), sleeve `LPS1200`, labels `LPL700`/`LPL1200`, inserts `LPI1200_Out`/`_In`.

## 10. USB / cassette (DM "music data storage")

- **Music/Business-card USB** (`USBDCard`): credit-card format ≈ 85.6 × 54 mm ⚠️; front/back art.
- Shaped USB drives: `USBD100` (swing), `USBTOPHAT01`, `USBD104` (biscuit), `USBD105` (key), `USBDWOOD-02` (bamboo), `USBCASSETTE`.
- **Cassette J-card** (`JCard001_In`/`_Out`): standard audio-cassette insert (front 2.5625 × 4″, spine 0.5 × 4″ panels) ⚠️ confirm from template.

---

## 11. Full template-code → download index

All free; URL pattern `discmakers.com/templates/downloads/<code>/templatedownload/<file>.zip`. Each zip = AI + INDD + PSD + guideline PDF. Preview diagram (with dimension callouts) = `discmakers.com/images/templates/popup/<code>.gif`.

- **Jewel/insert:** CDT100 (traycard), CD100 (2pg front), CD400/CD600/CD800P/CD800D/CD1200 (folders), S100 (o-card), CD800R/CD1200R/CD1600R/CD2000R/CD2400R (booklets)
- **On-disc:** UD100, VCD200
- **Digipak:** 4PAN1T, 4PAN1TAPK, 4PAN2T.e1, 4PAN1TSTC, 4PAN1TSPB, 6PAN1T-C, 6PAN1T-R, 6PAN1T1S, 6PAN1TCAPK, 6PAN1TDGSLV-R/-C, 6PAN1TLTPK-C, 6PAN2T, 6PAN3T, 8PAN1T-R, 8PAN1T-CR, 8PAN2T, 8PAN3T, 8PAN1THKSLV-R/-CR, SFT401
- **Wallet:** W119, W121, W138, W139, W201, W142, W203, W204, W209, W166, W167, W168, W169, W170, W171, W172, W173, W174, W175, F102
- **Jacket:** J100, J103, J120, M100, M120
- **DVD:** DVD100, DVDB101, DVD400, DVD600, 4PAN1TDVD(-L), 4PANDVD2T, 4PAN1TPKTDVD, 6PAN1TDVD(-C/-R), 8PAN1TDVD, 8PAN2TDVD, DVD800R–DVD3200R, DVDBM101, DVDBS101
- **Blu-ray:** BD100, BD101, BD400
- **Vinyl:** LPJ700, LPJ701, LPJ1200, LPJ1200S, LPJ1211, LPJ1212, LPJ1200WS, LPS1200, LPL700, LPL1200, LPI1200_Out/_In
- **USB/cassette:** USBD100, USBDCard, USBTOPHAT01, USBD104, USBD105, USBDWOOD-02, USBCASSETTE, JCard001_In/_Out
