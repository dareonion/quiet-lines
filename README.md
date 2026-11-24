# Quiet Lines

A calm, offline iPad app for young children (about 2 to 4): numbers, English letters, Traditional
Chinese characters (Taiwan Mandarin), forgiving finger tracing, and free drawing.

**Use it:** open **https://dareonion.github.io/quiet-lines/** in Safari on the iPad, tap
Share → **Add to Home Screen**, and open the new icon once while online. When the small tag in the
Home screen's corner shows ✓, it works with no connection at all.

## What it is like

- **Five areas:** Draw, Shapes, 123, ABC and 中文. Each screen offers at most six big choices.
- **Item cards:** every item has a card. Tapping the glyph says its name, and tapping the picture
  says its word.
- **Counting:** number cards have a ten-frame that counts out loud as the child taps. The last one
  says what was counted: "five turtles", or 五隻烏龜.
- **Tracing:** every shape, digit, letter and character can be traced with a finger. Tracing is
  very forgiving: either direction, wobbly is fine, and progress stays when the finger lifts.
  Shapes have no set order: their lines go in any order, and a closed shape (circle, square,
  triangle, star) can start anywhere on it. Ink off the path fades. There is no wrong sound.
- **Drawing:** five muted crayons and a new page. Apple Pencil works too, with pressure.
- **Apple Pencil palm rejection:** while the Pencil is in use, a hand resting on the screen draws
  nothing, doesn't count toward a trace, and doesn't press buttons.
- **Calm by design:** sound plays only when the child taps. Nothing autoplays, and motion follows
  the child's touch. There are no rewards, scores, timers, ads, accounts or analytics. The full calm
  rules are in [CLAUDE.md](CLAUDE.md).
- **For parents:** a press-and-hold of 3 seconds on the small corner icon opens the parent area. It
  shows the offline status and the settings: the language for numbers and shapes (English, 中文 or
  both), how strict tracing is, and which voice speaks each language (tap one to hear it). Use iPadOS **Guided Access** (Settings → Accessibility) to keep
  your child in the app and to end sessions after a set time.

## Voices

The hosted app's voices are **computer-generated** with Microsoft Azure Speech, and every clip was
listened to before release.

- **English:** Jenny (the default), Guy or Andrew.
- **Taiwan Mandarin:** HsiaoChen (the default), Yunfan or YunJhe. YunJhe can't say three of the words
  (一, 魚, 人) cleanly on their own, so those play in HsiaoChen's voice (the parent screen says so).
  Yunfan is an HD voice: each clip is the take that passed a pitch check of its tones, then a listen.

See [voices/CREDITS.md](voices/CREDITS.md). These audio files are not under the code's MIT licence.

To use your own family's voices, self-host it (below) and record each word on its `/record` page
from a phone or computer. A self-hosted copy plays only your recordings.

## Privacy

Lessons run entirely on the iPad once it's installed. The app contacts its website only to install
and to check for updates when it opens. Settings stay in the iPad's browser storage. Nothing about
the child is collected or sent anywhere. GitHub Pages hosts the files and, like any web host, sees
the requests for them.

## Self-hosting, with your own recorded voices

You need Linux or macOS with [uv](https://docs.astral.sh/uv/), ffmpeg, and a private HTTPS address
that the iPad can reach. [Tailscale](https://tailscale.com/) `serve` is one; service workers and
the microphone both need HTTPS.

```sh
uv run toddler-ipad                 # serves app/ and the recorder on 127.0.0.1:8019
tailscale serve --bg --https=8019 http://127.0.0.1:8019
```

Set `TODDLER_ORIGINS=https://<your-machine>.<tailnet>.ts.net:8019` so the recorder page may save.
`deploy/toddler-ipad.service` is a systemd user unit for running it permanently.

**Keep it private.** Anyone who can reach the server can hear your recordings: its reads are
unauthenticated, and `TODDLER_ORIGINS` only stops other websites from writing. Use localhost or a
private network such as a tailnet, never a public address (no `tailscale funnel`). Recordings are
stored in `data/`, which git ignores. Back them up yourself.

## Development

```sh
uv run pytest                       # server, catalog, and Playwright end-to-end tests
node --test 'app/js/**/*.test.js'   # tracing engine, paths, and every traceable glyph
uv run toddler-ipad-build site --voices voices            # the static site, as GitHub Pages serves it
```

The app is plain ES modules with no build step. `app/content/catalog.json` lists every item and
voice clip. [CLAUDE.md](CLAUDE.md) explains the layout, the content decisions and the known limits.

## Licences

- **Code, catalog and Latin glyphs:** MIT ([LICENSE](LICENSE)).
- **Chinese character stroke data** (`app/content/glyphs/hanzi/`): from hanzi-writer-data, modified,
  under the Arphic Public License. See `ARPHICPL.TXT` and `NOTICE.md` there.
- **Built-in voice files** (`voices/`): see `voices/CREDITS.md`.
- **Emoji:** drawn by the iPad's own emoji font. The app ships no emoji images.
