# MXTP MKR E2E Report

- Native Tauri/WebView2 shell via CDP: PASS
- Landing entry screen, format dropdown model swap, and prefilled detail handoff: PASS
- Audio import/reorder/pre-listen/capacity: PASS
- Research albums: Daft Punk Discovery, Radiohead OK Computer: PASS
- Generated album covers embedded in front.pdf: PASS (mock-cover-daft-punk-discovery-jewel-case-cover-style-dna-palette-elect.png, mock-cover-radiohead-ok-computer-jewel-case-cover-style-dna-palette-oxi.png)
- PDF text content: PASS (tray tracklist and saddle booklet lyrics extracted from content streams)
- 3D preview textured screenshots: PASS (front, tray, disc)
- GO export PDFs and burn simulate 100%: PASS

## PDF measurements
- front: PASS 126.35x126.35mm pages=1 image embedded: yes text content: n/a
- bifold: PASS 246.35x126.35mm pages=1 image embedded: yes text content: n/a
- trifold: PASS 366.35x126.35mm pages=1 image embedded: yes text content: n/a
- folder-8: PASS 486.35x126.35mm pages=1 image embedded: yes text content: n/a
- saddle-4: PASS 246.35x126.35mm pages=2 image embedded: yes text content: n/a
- saddle-8: PASS 246.35x126.35mm pages=4 image embedded: yes text content: n/a
- saddle-12: PASS 246.35x126.35mm pages=6 image embedded: yes text content: yes
- saddle-16: PASS 246.35x126.35mm pages=8 image embedded: yes text content: n/a
- saddle-20: PASS 246.35x126.35mm pages=10 image embedded: yes text content: n/a
- saddle-24: PASS 246.35x126.35mm pages=12 image embedded: yes text content: n/a
- saddle-28: PASS 246.35x126.35mm pages=14 image embedded: yes text content: n/a
- tray: PASS 156.35x124.35mm pages=1 image embedded: yes text content: yes
- disc: PASS 126.35x126.35mm pages=1 image embedded: yes text content: n/a

Human gates: G-BURN physical disc playback and G-NATIVE desktop-icon double-click remain owner-gated. IMAPI2 recorder enumeration on this run returned count=0.