# Quiet Lines: a calm learning app for young children

`AGENTS.md` is a symlink to this file; edit here. If `PRIVATE.md` exists (it's gitignored), read it
too: it holds the owner's deployment, family details and status, which stay out of the public repo.

Quiet Lines is an offline home-screen web app (PWA) for an iPad. It covers numbers, English letters
and Traditional Chinese characters, forgiving finger tracing, and free drawing. It's aimed at
children of about 2 to 4. It runs two ways from one codebase:
- **Hosted:** a static site (GitHub Pages) with a built-in, computer-generated voice pack.
- **Self-hosted:** the FastAPI server, with a family's own voices recorded on the `/record` page.

## Calm rules (every screen is checked against these)

1. Muted, warm palette on an off-white "paper" background. No neon, no flashing.
2. Motion only in direct response to the child's touch, at most 300 ms. No idle animation, bouncing,
   particles or confetti, and no shaking on mistakes.
3. Sound only when the child does something: the item's voice clip and at most one soft tone. A new
   clip stops the previous one; clips never overlap. No music and no per-tap effects.
4. No rewards economy: no stars, points, streaks, stickers, scores, timers or unlocks. When a trace is
   finished, the glyph fills in softly and the voice says its name once. Then the app waits.
5. Nothing autoplays or auto-advances. A screen offers at most 6 content choices; a Home button
   and, where needed, big prev/next arrows don't count toward that. Targets are at least 88 pt
   with wide spacing. The child never has to read text to get around, and can always leave or start
   over without an adult.
6. No fail states. Ink always appears, and ink off the path fades out. There is no "wrong" sound,
   and the child can make marks freely whether or not a trace completes.
7. No network calls during lessons, and no ads, external links, accounts or analytics. The only
   network use is installing and checking for updates.
8. The parent area sits behind a 3-second press-and-hold on a small corner icon. Use iPadOS Guided
   Access, which has its own time limit, to keep the child in the app and to end sessions. The app
   has no timer of its own.

Basis (inference from commonly cited OT pre-writing norms, Beery VMI): vertical line about 2 y,
horizontal about 2.5 y, circle about 3 y, cross about 4 y, square and triangle 4.5–5 y. Tracing is
big, very forgiving finger tracing. Letters and characters are exposure, not handwriting practice.

## Layout

- `app/`: the PWA. Static, no build step, ES modules. `content/catalog.json` is the contract between
  the app, the recorder and the server:
  - `clips`: clip id → `{lang: "en"|"zh", text, prompt}`. Ids match `^[a-z0-9][a-z0-9._-]{0,63}$`.
  - `items`: `{id, kind: shape|number|letter|hanzi, glyph: "latin:<name>"|"hanzi:<char>", label?,
    emoji?, word?, count_emoji? (numbers), strokes? (hanzi), clips: {en?, zh?, word?}, trace}`.
    Every item opens a card; tracing starts from the card.
  - `content/glyphs/latin.json` holds SVG path strokes in a 100-unit box, in stroke order, each
    drawn in its writing direction (M L H V C Q Z only, one M per stroke).
  - `content/glyphs/hanzi/<codepoint>.json` comes from `uv run scripts/vendor_hanzi.py`. The data is
    hanzi-writer-data@2.0.1 under the Arphic Public License, kept in that folder: filled outlines plus
    medians, in a 1024 box, y up. Cards, pickers and the trace guide all draw from this data
    (`app/js/glyph.js`), never a font.
- `app/debug/glyphs.html` is the contact sheet: every glyph with numbered starts and direction arrows.
  It isn't part of the offline release.
- `src/toddler_ipad/`: FastAPI. Serves `app/` at `/`, the release-stamped `/sw.js`, `/release.json`,
  `/audio/<clip>.m4a` (the active take), and the recorder API. The audio files live under
  `data/recordings/` (raw takes and processed `.m4a`), and `data/recordings.db` (SQLite) holds the
  takes' metadata and which take is active. Back up both together. Audio goes through ffmpeg.
- `voices/`: the hosted build's computer-generated voices.
  - **Packs:** one pack per voice per language: `voices/<pack-id>/` with `pack.json` (lang, label, Azure
    voice, default), `approved.json` (clip id → SHA-256 of the approved file: one a person heard, or
    an S0 regeneration that matched a heard one, see Voices),
    `source.json` (how each clip was made), optional `recipes.json` (per-word fixes, see
    `scripts/generate_voices.py`), and the `.m4a` files. `voices/voices.json` and `voices/CREDITS.md`
    are the shared disclosure and terms.
  - **Defaults:** Jenny (English) and HsiaoChen (中文). A parent can switch per language. A clip missing
    from the chosen voice plays in that language's default.
  - **Hosted audio:** published at `audio/<pack-id>/<clip>.m4a`.
- `voices-heard/` is gitignored: the free-tier files people listened to, kept so the paid-tier release
  can be matched against them.
- `data/` is gitignored: raw takes, processed audio and `recordings.db`. Recordings are personal and
  never go in git.
- `live/` is gitignored: `live/current` points at the snapshot the self-hosted server runs and serves
  (see Deploy).

## Content decisions

- v1 has 79 items and 113 clips: 11 shapes, 0–10, A–Z, and 31 characters. Characters with 6 or fewer
  strokes are traceable; 魚 鳥 馬 雨 are look-and-listen.
- 花 was replaced by 耳: the data has the mainland 7-stroke form (3-stroke 艹), and Taiwan's
  standard is 8 strokes. Picture words: I is 🍦 ice cream and V is 🚐 van ("insect" and "violin" were
  the draft's picks).
- Taiwan stroke check (web research against Ministry of Education sources): all 31 stroke counts
  match. 馬 is reordered by `TAIWAN_ORDER` in `scripts/vendor_hanzi.py`. Known small form differences
  are listed there: 四 and 日 lack Taiwan's tiny end hook, 雨's inner dots are mainland-style, and 耳's
  MoE sources disagree.
- Counting says the running count in the chosen language(s) ("both": English then 中文 on every
  tap); after the last object the number is said again. "Count again" resets the frame.
- Every item opens a card (shapes too, so a child can hear a shape's name without tracing it).
- Self-hosted copies play recorded voices only: a clip nobody has recorded plays nothing.

## Voices (2026-11-22/23)

- Azure Speech, generated once per clip. Microsoft grants use of prebuilt-voice output to paid-tier
  (S0) customers only, so the shipped files come from an S0 resource. A free (F0) resource is for
  listening samples. The voices are disclosed as computer-generated (parent area, README, CREDITS).
- **Standard neural voices** repeat their audio to rounding noise: same length, correlation 0.9998 or
  more, not byte for byte. Approve the F0 files people heard, then regenerate on S0 and run
  `scripts/carry_approvals.py`, which moves each approval to the S0 file if it matches the heard one.
  On 2026-11-23 this carried all of Jenny, HsiaoChen and YunJhe, and 71 of Guy's 72. Only 39 of
  Andrew's 72 carried. S0 itself repeated exactly (three regenerations identical), but 33 Andrew clips
  differ from the F0 files heard the day before: same length, correlation 0.83 to 0.999, level within
  4 dB. Guy's "nose" was 21 ms longer. Clips that don't carry need listening (`--direct`).
- **HD voices** (`…:DragonHDLatestNeural`) give a different take every request, sometimes with the
  wrong tone. Make several takes, keep the one `scripts/check_tones.py` passes, and approve the S0
  files themselves.
- **Taiwan Mandarin men's voices** are weak on lone syllables.
  - The cause: a lone syllable gets sentence-final intonation, so first tones fall and second tones go
    flat.
  - YunJhe (`zh-TW-YunJheNeural`, Azure's only zh-TW male voice) failed 13 of 33 by pitch.
  - What fixed most: a carrier word (say the syllable first in a two-character word, then cut it
    out), or an SSML pitch contour (十).
  - Phonetic markup, stand-in characters and slower or stretched versions didn't help.
  - No version of 一 魚 人 passed the listen (the first cuts sounded clipped; three gentler variants
    and five other carrier words each were still not good), so YunJhe skips them and they play in
    HsiaoChen's voice.
  - Also tried and dropped: four Azure multilingual voices and PrimeTTS (an open model; it clips lone
    syllables).
  - Yunfan HD (`zh-CN-Yunfan:DragonHDLatestNeural` speaking zh-TW) passed 7 of 8 by pitch, but its
    takes vary (above).

## Known limits (accepted)

- Apple Pencil palm rejection (`app/js/pen.js`) works by timing, because Safari gives a page no contact
  size. A touch is taken to be the child's hand if the Pencil is down, hovering, or was seen in the last 1.5 s,
  and a touch already down becomes a hand when the Pencil lands. Its mark is then removed, the trace
  follows the Pencil, and a tap or a parent-gear hold it makes does nothing (an exception to "ink
  always appears").
  - A hand that lands before the Pencil counts as a finger until the Pencil lands: its mark goes then,
    but trace progress it made stays (it could even finish a trace). One that touches and lifts first
    stays too.
  - A Draw stroke held across a rotation isn't removed if the Pencil lands afterwards.
  - A finger used within 1.5 s of putting the Pencil down does nothing.
  - Tested in Chromium with emulated pen and touch input, not yet on the iPad.

- Tracing is tested (`app/js/trace/glyphs.test.js`) at four iPad sizes with finger samples up to
  64 px apart. At 96 px apart, a swipe of about 5,000 px/s that is nothing like tracing, sharp
  shapes (star, 3, 9, B, W) can stall, because a chord cutting a sharp tip moves more than 105° off
  the stroke.
- If a release handover takes over 4 s and a lesson is opened meanwhile, that lesson keeps its old
  code. A clip it hasn't loaded yet may come from the new release (the newer recording of the same
  word, or silence). It reloads cleanly on the next visit to Home.
- Safari tabs and the Home Screen app keep separate storage. Only the Home Screen app's ✓ counts;
  a browser tab's tag says "(browser tab)".
- The update hand-over assumes one window (the Home Screen app). With two Safari tabs, a lesson in one
  can keep old code after Home in the other takes over.
- The release gate trusts the tier that the credentials file declares (`AZURE_SPEECH_TIER`);
  checking it would need Azure's management API. `check_tones.py` doesn't confirm that a reference
  folder is the same voice: it screens, and a listen decides.

## Commands

```sh
uv run toddler-ipad            # serves on $PORT (8019, from .envrc); set TODDLER_APP_DIR=app for dev
uv run pytest                  # server, catalog, and Playwright e2e (Chromium, iPad viewport): ~2 min
node --test 'app/js/**/*.test.js'   # engine and path unit tests, plus every traceable glyph traced 3 ways
scripts/deploy.sh              # tests, then snapshot and switch the self-hosted server (scripts/rollback.sh undoes)
uv run toddler-ipad-build site --voices voices [--preview]   # the static site for GitHub Pages
uv run --group voices python scripts/generate_voices.py voices/en-guy --env-file <azure env>
    # one pack: language and voice come from its pack.json; its recipes.json applies. The env file holds
    # AZURE_SPEECH_KEY, AZURE_SPEECH_REGION and AZURE_SPEECH_TIER (S0 for files that ship, F0 for samples)
uv run --group voices python scripts/check_tones.py voices/zh-yunjhe --male   # Mandarin tones by pitch
uv run --group voices python scripts/carry_approvals.py voices/en-guy        # after an S0 regeneration
    # reads the immutable heard approvals in voices-heard/<pack>/approved.json; refuses HD voices
scripts/privacy_check.sh [HEAD [site]]   # before any push: private patterns, data files, credentials
    # audio must be an approved S0 pack clip (audio-only MP4); only its tags are text-scanned (needs ffprobe)
```

The hosted build fails unless every clip in each pack matches that pack's `approved.json`. `--preview`
skips that check and adds `voices.html` (every pack, every clip, with its hash), for review only. The
Pages workflow also runs the release gate (`TODDLER_RELEASE=1`): every shipped clip must be approved and
come from the paid tier.

Playwright is pinned to 1.63.0, whose Chromium build is 1243.

## Deploy (self-hosted)

- `deploy/toddler-ipad.service` is a systemd user unit that runs the server on 127.0.0.1:8019. The
  origin allowed to write (the recorder's page address) comes from `~/.config/toddler-ipad/env`
  (`TODDLER_ORIGINS=https://<host>:8019`).
- **Keep the server private.** Its reads (`/api/clips`, `/audio/…`, `/api/takes/…`) are
  unauthenticated, and `TODDLER_ORIGINS` only stops other websites' pages from writing. Run it behind
  localhost or a private network such as a tailnet (`tailscale serve`, never `funnel`).
- **It runs from a whole-version snapshot, never the working tree.**
  - `scripts/deploy.sh` runs the tests (with `TODDLER_REQUIRE_ALL=1`), then copies the publishable
    tree (`git ls-files -co --exclude-standard`, minus `data/`, `live/`, the private files and the hosted `voices/`) into
    `live/<UTC stamp>/`.
  - It points `live/current` at the new snapshot, restarts the unit, and checks that the served
    release id matches the snapshot's.
  - The unit's WorkingDirectory is `live/current`. Server code, worker template and app always change
    together. A deploy copies the working tree as it stands; later edits reach the iPad only with the
    next deploy.
  - `scripts/rollback.sh` switches back to `live/previous` the same way. If the release check fails
    after a switch, the new snapshot stays selected; `scripts/rollback.sh` returns to the one before.
  - Recordings stay in the repo's `data/` (`TODDLER_DATA_DIR`), outside every snapshot.
  - The Python environment is the shared `live/.venv`.
  - Deploy keeps the three newest snapshots plus the current and previous ones.
- The iPad picks up any change (code, content or a kept recording) the next time it opens the app
  online. The update installs in the background (files it already has, by hash, are copied rather
  than downloaded; the rest come six at a time) and switches over on the Home screen. The corner tag
  on Home shows the release, a ✓ once that copy works offline, and "!" if a download stopped (the
  parent screen says why).

## How Claude and Codex share the work

Claude orchestrates and owns anything that needs looking: wireframes, screenshots, the glyph contact
sheet, interaction feel, and checks against the calm rules. Codex drafts self-contained parts and
reviews every non-mechanical diff. Codex runs
`codex exec -C <tree> -s workspace-write -o <scratch>/<name>.md - < <scratch>/<name>-brief.md`. There is
one writer per tree. A concurrent Codex job writes into its own copy of the tree, and Claude reviews
and copies its files back. Codex's sandbox has no network, so its copy gets `uv sync` beforehand and
it runs `uv run --frozen --offline …`.
