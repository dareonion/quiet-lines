# Hanzi stroke data

The outlines and medians in this directory come from `hanzi-writer-data@2.0.1`.
The packager attributes the underlying fonts to Arphic Technology Co., Ltd.
and says “You can redistribute and/or modify this data under the terms of the
Arphic Public License”. [Package README](https://github.com/chanind/hanzi-writer-data/tree/v2.0.1#license)

Make Me a Hanzi puts both outlines and medians in its Arphic-licensed
`graphics.txt`. Its separate `dictionary.txt` uses LGPL-3.0-or-later.
This directory contains only graphical data. [Make Me a Hanzi](https://github.com/skishore/makemeahanzi#format)
and [upstream license split](https://github.com/skishore/makemeahanzi/blob/master/COPYING).
We have not independently audited the original font provenance.

## Changes (Arphic Public License, section 2)

These files are modified versions of the package's per-character JSON. Each file
starts with a `notice` field saying how and when it was changed:
`scripts/vendor_hanzi.py` copied the outline strings and median coordinates and
added the character, source and display coordinates (2026-11-22). For 馬 it also
reordered both the outlines and the medians to Taiwan's stroke order.

The modified data is distributed under the Arphic Public License, whose text is
in `ARPHICPL.TXT` in this directory, unaltered. The rest of this project (code,
catalog, Latin glyphs) is under its own licence, as separate works aggregated
with this data (section 2 of the Arphic Public License).
