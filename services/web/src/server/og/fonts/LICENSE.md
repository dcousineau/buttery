# Vendored OG fonts

`AlfaSlabOne-Regular.ttf`, `Rubik-Regular.ttf` and `Rubik-Bold.ttf` are the two
brand families from docs/BRAND.md, taken from [Google Fonts](https://fonts.google.com)
and licensed under the [SIL Open Font License 1.1](https://openfontlicense.org/) —
which permits bundling them with this app as long as the license travels with
them, which is what this file is for. They are committed as TrueType rather than
loaded at render time because Satori cannot read woff2 (all a modern user agent is
offered by the Google Fonts CSS API), and because an OG render must not depend on
a third-party network hop that can be slow, rate-limited or down.

To refresh them, ask the CSS API for the same families while pretending to be a
browser old enough that Google still serves TrueType — the UA string is the entire
trick — and download the `src: url(...)` it hands back:

```sh
curl -sH 'User-Agent: Mozilla/5.0 (Linux; U; Android 2.2; en-us; Nexus One Build/FRF91) AppleWebKit/533.1' \
  'https://fonts.googleapis.com/css2?family=Alfa+Slab+One&family=Rubik:wght@400;700'
```
