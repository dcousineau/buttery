---
ail: 4
title: hRecipe
sidebar_position: 3
description: The microformats recipe vocabulary — hRecipe and its microformats2 form h-recipe, built entirely out of HTML class names, property by property.
---

# hRecipe

Most structured-data formats describe a page twice: once for humans, then again
for machines — a JSON-LD block in the `<head>`, `itemprop` attributes layered
over the markup, an RDFa vocabulary bolted on. The description lives beside the
document rather than in it.

Microformats take the other approach: **the markup itself carries the data.** No
new attributes and no parallel block — the HTML that would be published anyway
gains a few `class` names. A recipe marked up as an hRecipe is, in view-source,
an ordinary recipe page.

This page is the reference for that vocabulary in both of its generations: the
original **`hrecipe`** and its microformats2 form **`h-recipe`**. For where
microformats came from and how they sit next to Microdata, RDFa, and JSON-LD,
see [the introduction](./intro.md#microformats) and
[the syntaxes](./intro.md#syntaxes).

## About this reference

|                    |                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------- |
| **Published by**   | [microformats.org](https://microformats.org), a community wiki — no standards body, no vendor |
| **mf1 vocabulary** | [`hrecipe`](https://microformats.org/wiki/hrecipe), version 0.22                              |
| **mf2 vocabulary** | [`h-recipe`](https://microformats.org/wiki/h-recipe)                                          |
| **Status**         | Both are **draft specifications** — see [status](#status)                                     |
| **Carrier**        | HTML `class` attributes. Nothing else.                                                        |
| **Reflects**       | the wiki as read on 2026-08-09                                                                |

---

## Two generations, one vocabulary {#status}

**hRecipe** is the first-generation format. Its wiki page carries version 0.22
and the standard microformats draft disclaimer: drafts are "somewhat mature in
the development process," but "the stability of this document cannot be
guaranteed." It credits Frances Berriman, Ben Ward, and Toby Inkster as primary
authors, with Thomas Lörtsch as editor, and was released into the public domain
on 14 November 2008. It reached its shape through the microformats community
process — collect real examples first, name the patterns that recur, only then
write a draft — which the [introduction](./intro.md#microformats) covers.

**h-recipe** is the same vocabulary re-expressed in
[microformats2](https://microformats.org/wiki/microformats2) — the [syntax
overhaul](./intro.md#microformats) that replaced ad-hoc per-format class names
with one uniform, prefixed naming scheme. Its wiki page states plainly:
"h-recipe is a microformats.org draft specification," and that it is "ready to
use and implemented in the wild, but for backwards compatibility you should
also mark h-recipes up with classic hRecipe classnames."

That last clause is the practical reality. Neither vocabulary was ever ratified
by the W3C, the IETF, or anyone else. Both are drafts, indefinitely, and both
are meant to be published together — mf2 parsers are specified to recognize the
old class names and map them forward.

The mf1 version history: 0.2 renamed `hRecipe-title` to `fn` and
`preparation-time` to `duration` for consistency with other microformats, 0.21
marked the ingredient sub-properties experimental, and 0.22 moved date encoding
from the `datetime-design-pattern` to the `value-class-pattern` for
accessibility.

---

## The mf2 prefixes {#prefixes}

microformats2 names carry their parsing rules in the class name itself. Five
prefixes, and once you know them you can read any mf2 vocabulary — h-card,
h-entry, h-event, h-recipe — without consulting its spec:

| Prefix | Means                 | A parser produces                                    |
| ------ | --------------------- | ---------------------------------------------------- |
| `h-`   | Root — a thing        | A new object, e.g. `h-recipe`, `h-card`              |
| `p-`   | Plain text property   | The element's text content                           |
| `u-`   | URL property          | A resolved absolute URL (from `href`, `src`, etc.)   |
| `dt-`  | Date/time property    | A parsed ISO-8601 date, time, or duration            |
| `e-`   | Element/embedded HTML | Both the inner HTML **and** its plain-text rendering |

The prefixes are syntax, independent of vocabulary. A parser needs no knowledge
of what a recipe is: it sees `h-` and opens an object, sees `e-instructions` and
captures inner HTML. A vocabulary added later is handled by existing mf2 parsers
without changes. mf1 had no such uniformity — each format defined its own class
names, and parsers needed per-format knowledge.
[The syntaxes](./intro.md#syntaxes) page sets this alongside the alternatives.

---

## The properties {#properties}

The two generations are near-parallel: mf2 was a renaming, not a redesign. This
table gives both:

| mf1 `hrecipe`  | mf2 `h-recipe`   | Required?    | What it holds                                                            |
| -------------- | ---------------- | ------------ | ------------------------------------------------------------------------ |
| `hrecipe`      | `h-recipe`       | Root         | The container element. Everything below lives inside it.                 |
| `fn`           | `p-name`         | Required     | The name of the recipe.                                                  |
| `ingredient`   | `p-ingredient`   | Required, 1+ | One ingredient. Repeat the class once per ingredient; markup is allowed. |
| `yield`        | `p-yield`        | Optional     | The quantity produced — servings, pieces, a volume.                      |
| `instructions` | `e-instructions` | Optional     | The method. Markup is preserved, so lists and emphasis survive.          |
| `duration`     | `dt-duration`    | Optional, 1+ | Time to prepare. May be encoded in ISO-8601 (`PT10M`).                   |
| `photo`        | `u-photo`        | Optional, 1+ | An accompanying image.                                                   |
| `summary`      | `p-summary`      | Optional     | A short introduction or blurb.                                           |
| `author`       | `p-author`       | Optional, 1+ | Who wrote it. In mf2, optionally an embedded [`h-card`](#nesting).       |
| `published`    | `dt-published`   | Optional     | Publication date.                                                        |
| `nutrition`    | `p-nutrition`    | Optional, 1+ | Nutritional information, as text.                                        |
| `tag`          | `p-category`     | Optional, 1+ | Subject keywords. See [rel-based properties](#rel-properties).           |
| `license`      | —                | Optional     | Licensing, via the `rel-license` microformat.                            |
| —              | `u-remix-of`     | Proposed     | A URL this recipe is a remix of. Awaiting real-world implementations.    |

**On "required."** The Required? column reflects **hRecipe's** designations —
`fn` and at least one `ingredient` are the only two the mf1 draft demands.
The h-recipe page does not formally designate required versus optional at all,
which is characteristic of mf2: parsers emit whatever properties they find and
consumers decide what they need.

**On "experimental."** hRecipe marks `photo`, `summary`, `author`, `published`,
`nutrition`, and `tag` experimental — added because publishers were visibly
using them, not because the core needed them. h-recipe carries the distinction
forward, grouping `p-summary`, `p-author`, `dt-published`, `p-nutrition`, and
`p-category` as experimental-but-widely-adopted. Both sets entered the
vocabulary by observation of published pages rather than by design.

### Ingredient sub-properties {#ingredient-parts}

hRecipe experimented with splitting an ingredient into `value` (the quantity)
and `type` (the substance) — so that "2 slices sourdough" could be machine-read
as an amount and a thing. Version 0.21 marked both experimental, and the wiki
records ongoing discussion about replacing them with `num` and `unit` borrowed
from the measure format. **Neither resolution has landed.** schema.org/Recipe
does not decompose quantities either.

### rel-based properties {#rel-properties}

Two hRecipe properties aren't `class` values at all — they reuse standalone
microformats built on the `rel` attribute. `rel-tag` links supply the recipe's
tags, and `rel-license` its license. mf2 parsers are specified to look for
`rel=tag` hyperlinks inside an `hrecipe` and take **the last path segment of the
href** as a `p-category` value, which keeps existing tagged recipes readable
under mf2 parsing.

---

## Marking up a grilled cheese {#example}

Deliberately minimal — enough to make the shape legible, not a complete recipe.
The mf2 version:

```html
<article class="h-recipe">
  <h1 class="p-name">Grilled Cheese</h1>
  <p class="p-summary">Bread, cheese, heat. The whole argument.</p>
  <p><span class="dt-duration">PT10M</span> · <span class="p-yield">1 sandwich</span></p>

  <ul>
    <li class="p-ingredient">2 slices bread</li>
    <li class="p-ingredient">2 slices cheddar</li>
    <li class="p-ingredient">1 tbsp butter</li>
  </ul>

  <ol class="e-instructions">
    <li>Butter one side of each slice of bread.</li>
    <li>Sandwich the cheddar between the unbuttered sides.</li>
    <li>Griddle over medium heat until both sides are golden.</li>
  </ol>
</article>
```

And the same thing in classic mf1, for contrast — the markup is identical, only
the class names differ:

```html
<article class="hrecipe">
  <h1 class="fn">Grilled Cheese</h1>
  <ul>
    <li class="ingredient">2 slices bread</li>
    <li class="ingredient">2 slices cheddar</li>
    <li class="ingredient">1 tbsp butter</li>
  </ul>
  <ol class="instructions">
    <li>Butter the bread, cheese in the middle, griddle until golden.</li>
  </ol>
</article>
```

There is no `<script>` block, no `itemscope`, no `vocab` and no `typeof`.
Removing every class name leaves a valid recipe page; adding them makes it
machine-readable.

### Nesting {#nesting}

An mf2 property whose element also carries a root class becomes a nested
object — `<a class="p-author h-card" href="...">Dan</a>` yields an author that
is a structured card rather than a string. The sub-object has to be an element
that sits in the right place in the visible document, so nesting depth is bound
by the page's own structure.

---

## Next to schema.org/Recipe {#versus}

The two vocabularies cover much of the same ground with different names and
wildly different sizes. A handful of equivalents, for orientation — the full
schema.org property list lives on [its own page](./schema-org-recipe.md):

| Concept    | mf2 `h-recipe`   | schema.org/Recipe                     |
| ---------- | ---------------- | ------------------------------------- |
| Name       | `p-name`         | `name`                                |
| Ingredient | `p-ingredient`   | `recipeIngredient`                    |
| Method     | `e-instructions` | `recipeInstructions`                  |
| Yield      | `p-yield`        | `recipeYield`                         |
| Duration   | `dt-duration`    | `prepTime` / `cookTime` / `totalTime` |

That last row reflects the difference in scope. hRecipe has _one_ repeatable
`duration`; schema.org has three named ones, inherited from a type hierarchy
that also brings ratings, video objects, cuisines, diets and several dozen more
properties. hRecipe was assembled from observed publishing practice; schema.org
was specified top-down.

---

## Consequences of the design {#consequences}

Carrying the data in the visible markup, rather than beside it, has a set of
direct effects.

- **One representation.** A JSON-LD block can state "serves 4" while the visible
  page states "serves 6", since they are separate documents. In microformats the
  property and the rendered text are the same node, so the two cannot disagree.
- **Readable in view-source.** The semantics annotate the content in place
  rather than duplicating it elsewhere in the document.
- **Unknown class names are inert.** An unrecognised microformat class produces
  no parse error, no invalid attribute and no validator warning.
- **One parser per generation, not per vocabulary.** In mf2 the prefixes carry
  the parsing rules, so a parser handles vocabularies it has never seen.
- **`class` is shared with presentation and behaviour.** The same attribute is
  the CSS hook and the JavaScript hook. Utility-class frameworks and BEM naming
  occupy the same namespace, and a restyling can remove vocabulary classes.
  Microdata's dedicated `itemprop` attribute avoids this overlap.
- **Nesting is bound to document structure.** A sub-object must be an element
  that is both in the right place visually and carrying two class names. JSON-LD
  nests without that constraint because it is not attached to the document.
- **The vocabulary is small.** hRecipe defines roughly a dozen properties;
  `schema.org/Recipe` defines nine of its own plus everything inherited from
  `HowTo`, `CreativeWork` and `Thing`.

## Consumer support {#support}

Google's structured-data documentation lists three supported formats — JSON-LD
(recommended), Microdata and RDFa. Microformats are not among them, so hRecipe
markup does not feed search rich results.
[schema.org/Recipe](./schema-org-recipe.md) is the vocabulary search engines
consume.

Neither hRecipe nor h-recipe was ratified by a standards body, and the mf1 page
still recommends dual-publishing with the classic class names.

---

## The living context: the IndieWeb {#indieweb}

Microformats2 did not die — it moved. It is the data layer of the
[IndieWeb](https://indieweb.org), the community around publishing on your own
domain and syndicating outward. `h-entry` marks up posts, `h-card` marks up
people, and **Webmention** — a W3C Recommendation — uses them to turn a link
between two independent sites into a comment, a like, or a reply. Micropub and
IndieAuth build on the same foundation.

That ecosystem is small next to the search-engine web, and it is where the
maintained mf2 parsers come from, in several languages. There, marking up a
recipe serves syndication between independent sites rather than search
visibility. Buttery reads both generations
when importing from a page.

> **A note on where to go for the vocabularies themselves.** The
> [hrecipe](https://microformats.org/wiki/hrecipe) and
> [h-recipe](https://microformats.org/wiki/h-recipe) wiki pages are the
> specifications, editable in public and occasionally still edited. Both are
> drafts and are likely to remain so. If this page disagrees with the wiki, the
> wiki wins.
