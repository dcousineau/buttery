# Sounds

Static audio assets served from `/sounds/*`. Not bundled — referenced by URL, so
they are fetched only when code requests them (never on initial page load).

## `alarm-default.mp3` — the default cook-mode / timer alarm

- **Role:** default timer alarm sound (see `docs/plans/05-cook-mode.md` §7.1).
  Loaded lazily on the first timer start, looped until the timer is acked.
- **Source:** BigSoundBank — "Electronic alarm (buzzer) #2"
  (https://bigsoundbank.com/detail-0089-electronic-alarm-buzzer-2.html),
  file https://bigsoundbank.com/UPLOAD/mp3/0089.mp3
- **License:** CC0 / public domain — free, royalty-free, no attribution required,
  redistribution permitted. (Recorded here for provenance only.)
- **Format:** MPEG layer III, ~5s, mono, 48 kHz.

To swap the default alarm, replace this file (keep the name) or point the timer
alarm config at a different `/sounds/*` file.
