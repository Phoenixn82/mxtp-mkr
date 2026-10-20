# Extracted Layout Guide Map

Generated: 2026-07-01T14:40:22.346493+00:00

This report ignores ZIP files and Mac sidecar/resource-fork files. It groups duplicate authoring formats by component name, then scans the cheapest useful representative in that group.

## What Counts As Exact

- PDF page sizes and guide positions come from vector coordinates in the PDF itself, in points converted to inches by `points / 72`.
- PSD dimensions come only from the PSD header: pixel width/height and embedded PPI when present.
- EPS/AI dimensions come only from declared `%%BoundingBox` / `%%HiResBoundingBox` headers when a PDF representative was not available.
- Blank guide fields mean the cheap representative did not expose that guide type in a machine-readable way; no numbers were invented.
- Short dashed legend samples are filtered out of `fold_lines`; only production-scale fold guides are retained.

## Coverage

- Inventory rows/templates: 142
- Component groups analyzed: 332
- Extracted real files covered by those groups: 1117
- Components with machine-readable bleed/trim/safety/fold guide geometry: 165
- Components with production-scale fold lines: 114
- Components analyzed by PSD header only: 150
- Components with explicit caveats: 1
- Representative file types: .eps: 3, .pdf: 178, .psd: 150, .qxp: 1

## Components By Source Page

- Blu-ray Templates: 8 component groups
- CD Wallet Templates: 25 component groups
- DVD Templates: 98 component groups
- Digipak Templates: 76 component groups
- Folder Templates: 7 component groups
- Jacket Templates: 9 component groups
- Jewel Case Templates: 64 component groups
- Logo Font Templates: 3 component groups
- On-disc Printing Templates: 4 component groups
- Promotional Material Templates: 7 component groups
- USB Drive Templates: 19 component groups
- Vinyl Templates: 12 component groups

## Caveat

One standalone QuarkXPress support file, `USBD104_frontback.qxp`, has no cheap readable sibling. It is represented in the CSV, but no dimensions were inferred from it.

## Concrete Example: DVD100_in

- Template: `DVD Insert (DVD100)`
- Representative scanned: `05-dvd-templates/extracted/01-dvd100--dvd-insert-dvd100/DVD100_in/DVD100_in.pdf` (60742 bytes)
- Duplicate/covered extensions: `.ai .cdr .eps .indd .pdf .psd .qxd .qxp`
- Covered files: `05-dvd-templates/extracted/01-dvd100--dvd-insert-dvd100/DVD100_in/DVD100_in.ai | 05-dvd-templates/extracted/01-dvd100--dvd-insert-dvd100/DVD100_in/DVD100_in.cdr | 05-dvd-templates/extracted/01-dvd100--dvd-insert-dvd100/DVD100_in/z_Quark_guides/DVD100_in_guides.eps | 05-dvd-templates/extracted/01-dvd100--dvd-insert-dvd100/DVD100_in/DVD100_in.indd | 05-dvd-templates/extracted/01-dvd100--dvd-insert-dvd100/DVD100_in/DVD100_in.pdf | 05-dvd-templates/extracted/01-dvd100--dvd-insert-dvd100/DVD100_in/DVD100_in.psd | 05-dvd-templates/extracted/01-dvd100--dvd-insert-dvd100/DVD100_in/DVD100_in.qxd | 05-dvd-templates/extracted/01-dvd100--dvd-insert-dvd100/DVD100_in/DVD100_in.qxp`

- `page_media_boxes`:

```json
[
  {
    "page": 1,
    "width_pt": 445.499,
    "height_pt": 607.5,
    "width_in": 6.18749,
    "height_in": 8.4375
  }
]
```
- `bleed_boxes`:

```json
[
  {
    "x0_pt": 45.001,
    "y0_pt": 45.0,
    "x1_pt": 400.5,
    "y1_pt": 562.5,
    "width_pt": 355.499,
    "height_pt": 517.5,
    "x0_in": 0.62501,
    "y0_in": 0.625,
    "x1_in": 5.5625,
    "y1_in": 7.8125,
    "width_in": 4.93749,
    "height_in": 7.1875,
    "inset_left_in": 0.62501,
    "inset_right_in": 0.62499,
    "inset_bottom_in": 0.625,
    "inset_top_in": 0.625,
    "source": "page 1 rects"
  }
]
```
- `trim_boxes`:

```json
[
  {
    "x0_pt": 54.001,
    "y0_pt": 54.0,
    "x1_pt": 391.5,
    "y1_pt": 553.5,
    "width_pt": 337.499,
    "height_pt": 499.5,
    "x0_in": 0.75001,
    "y0_in": 0.75,
    "x1_in": 5.4375,
    "y1_in": 7.6875,
    "width_in": 4.68749,
    "height_in": 6.9375,
    "inset_left_in": 0.75001,
    "inset_right_in": 0.74999,
    "inset_bottom_in": 0.75,
    "inset_top_in": 0.75,
    "source": "page 1 rects"
  }
]
```
- `safety_boxes`:

```json
[
  {
    "x0_pt": 63.001,
    "y0_pt": 63.0,
    "x1_pt": 382.5,
    "y1_pt": 544.5,
    "width_pt": 319.499,
    "height_pt": 481.5,
    "x0_in": 0.87501,
    "y0_in": 0.875,
    "x1_in": 5.3125,
    "y1_in": 7.5625,
    "width_in": 4.43749,
    "height_in": 6.6875,
    "inset_left_in": 0.87501,
    "inset_right_in": 0.87499,
    "inset_bottom_in": 0.875,
    "inset_top_in": 0.875,
    "source": "page 1 rects"
  }
]
```
- `fold_lines`: none found

## How To Use The CSV

Open `extracted-layout-guide-map.csv` and filter by `template_name`, `component`, or `representative_file`. The JSON columns contain exact coordinate boxes. `x0/y0` are measured from the PDF page bottom-left. Insets report distance from each page edge.
