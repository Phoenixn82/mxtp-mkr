# MXTP multi-library data sources

Verified against official service documentation on 2026-08-26. MXTP uses local exports/history first: they are richer for long-term listening analysis, need no permanent account authorization, work offline after import, and do not introduce paid API credits.

## Metric matrix

| Source | Preferred MXTP input | Can provide | Cannot reliably provide |
|---|---|---|---|
| Apple Music | The locally synced `Apple Music Library.musiclibrary/Library.musicdb` already on this PC | Tracks, releases, artists, genre, duration, track/disc number, rating/love state, lifetime play count, last played, date added, playlists, cached artwork | Dated lifetime play events; cloud-only changes that have not synced into the Windows Music database; usable subscription audio |
| Spotify | Privacy download: **Extended Streaming History** JSON, optionally `YourLibrary.json` and playlist JSON | Lifetime dated streams, milliseconds played, track/artist/album, Spotify track URI, saved tracks, exported playlists | Genre, artwork, release year, and track number in streaming-history JSON; audio files |
| SoundCloud | SoundCloud account-data JSON files | Likes, playlists, uploads, track/artist metadata, genre and duration where present | Complete personal play counts/history. The official API exposes only the last 25 recently played tracks; public `playback_count` is a global track metric and MXTP does not mislabel it as personal listening |
| YouTube Music | Google Takeout: YouTube/YouTube Music watch-history JSON and playlist/liked-song CSV files | Dated music plays, video/title/channel/URL, likes and playlists when present | Album, genre, duration, track number, a complete music-only discriminator for every generic YouTube event, or subscription audio |

MXTP counts a Spotify history entry as a play only when `ms_played >= 30,000`; shorter events remain represented by total milliseconds but do not inflate the play count. YouTube Music history entries count as plays only when the export marks them as YouTube Music or the URL/file is music-specific. Ambiguous general YouTube viewing is skipped. SoundCloud public popularity is never combined with personal plays.

## Official access options considered

### Apple Music

- [Apple: understand and control the personal information stored with Apple](https://support.apple.com/en-us/102283) documents requesting a copy of Apple Account data and transferring Apple Music playlists.
- [Apple Music API overview](https://developer.apple.com/documentation/applemusicapi) provides library/catalog metadata and recently played content with user authorization and developer tokens.
- [Recently Played Resources](https://developer.apple.com/documentation/applemusicapi/get-recently-played-resources) is authenticated and is recent-history oriented. MXTP keeps the richer local lifetime counters already available on this PC and avoids an auth wall.

The **Update Apple Music** button re-reads the local database and recomputes the combined library. Open the Apple Music app and allow it to sync first when cloud changes are not yet local.

### Spotify

- [Spotify: Understanding your data](https://support.spotify.com/article/understanding-your-data/) documents Extended Streaming History as lifetime audio/video/podcast events with UTC time, milliseconds played, track, artist, album, and URI.
- [Spotify Web API: recently played](https://developer.spotify.com/documentation/web-api/reference/get-recently-played) requires OAuth and returns at most 50 items per request. It is not used for this phase because the privacy export is substantially richer for historical curation.

Request Extended Streaming History from Spotify's privacy/download-data settings. Import every `Streaming_History_Audio_*.json` file together. Add `YourLibrary.json` and playlist JSON when supplied so liked/saved and playlist signals are retained.

### SoundCloud

- [SoundCloud Public API specification](https://developers.soundcloud.com/docs/api/explorer/) documents authenticated likes, playlists, and the last 25 recently played tracks.
- [SoundCloud API guide](https://developers.soundcloud.com/docs/api/) requires OAuth for account resources and documents likes/playlists/track metadata. MXTP does not add that account dependency in this phase.
- [SoundCloud user-data requests](https://help.soundcloud.com/hc/en-us/articles/115003566428-User-data-requests) is the official data-request route.

Supply the JSON files SoundCloud returns for likes, playlists, tracks, and recent activity. Export schemas vary by account/region; MXTP accepts the documented API-style track objects and fails clearly when no recognizable music records exist.

### YouTube Music

- [Google: download your data](https://support.google.com/accounts/answer/3024190) documents Google Takeout and export archive formats.
- [Google: copy YouTube Music playlists](https://support.google.com/accounts/answer/14792019) documents playlist transfer and its limits; it is not a full listening-history export.

In Google Takeout, select YouTube and YouTube Music data, then import `watch-history.json` plus any playlist/liked-song CSV files. Generic YouTube entries without a music-specific product marker or Music URL are deliberately excluded.

## Provenance and deduplication

Every normalized track retains one or more source records: service, source track ID/URL, play counts, per-year counts when the export contains dated events, liked state, first/last played time, and source limitations. Source toggles filter before combined counts are computed.

Cross-service records merge only on normalized exact artist + title + album. When album is absent, duration evidence is required; otherwise records remain separate. This deliberately favors false negatives over silently merging different recordings. Counts are summed only after provenance records are retained.

## On-device curator decision

The phase evaluated a general local LLM runtime and a bounded local intent/ranking engine:

| Option | License / size | Accuracy and reliability finding |
|---|---|---|
| `llama.cpp` + Phi-3.5 Mini | llama.cpp and Phi-3.5 are MIT; the original Phi model is about 7.6 GB and common quantized delivery still adds multiple GB | Flexible language, but substantial installer/RAM/startup cost and nondeterministic structured edits on unknown Windows hardware |
| Small 1–2B GGUF model | Common permissive models/quantizations are roughly 0.7–1.2 GB | Smaller, but materially weaker instruction accuracy; still needs a native inference runtime and another large update surface |
| MXTP local curator engine (selected) | Project code only; no added model/runtime payload | Deterministic support for mixtape intent, year/genre/favorite ranking, artist dislikes and replacement follow-ups. Exact evidence and memory are inspectable, editable, testable, offline, and Windows-stable |

The selected engine is an equivalently self-contained on-device approach rather than a chatbot facade over a paid service. It ranks only imported evidence, cites that evidence, records project-scoped messages/preferences in the existing atomic project JSON, and never sends prompts or library data over the network. The only network step is the existing explicit high-confidence YouTube release matcher/downloader used to prepare the chosen burn list; it never accesses or copies subscription-service audio.
