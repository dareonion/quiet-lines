# Built-in voices

The voices are computer-generated with Microsoft Azure Speech. Quiet Lines uses clips from the
packs approved for each release.

- English packs use `en-US-JennyNeural`, `en-US-GuyNeural` and `en-US-AndrewNeural`.
- Taiwan Mandarin packs use `zh-TW-HsiaoChenNeural`, `zh-TW-YunJheNeural` and
  `zh-CN-Yunfan:DragonHDLatestNeural` speaking Taiwan Mandarin.

Each pack records its generation and listening review in two files.

- `source.json` lists each clip's text, SSML, voice, Azure pricing tier, date and SHA-256.
- `approved.json` lists the SHA-256 of each file a person listened to and approved. The hosted build
  refuses any other file.

These audio files are **not** covered by the repository's MIT licence. They are provided for
playback in this app. Please don't use them to create, train or improve speech synthesis or other
AI models.

To make your own, run `scripts/generate_voices.py` with your own Azure Speech resource. Microsoft
grants use of the output to customers of its paid tier.
