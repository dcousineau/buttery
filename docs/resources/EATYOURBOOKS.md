# Eat Your Books

Eat Your Books (EYB) indexes the recipes inside physical cookbooks, food
magazines, and a growing set of food blogs — they claim over 160,000
books/magazines and several million recipes indexed. It answers "which of the
cookbooks I own has a recipe for X"; it deliberately does not answer "what
does that recipe say." Showing full recipe text is the copyright line EYB has
drawn for itself, so a recipe entry gives you the book/magazine/blog, author,
page number or ISBN, an ingredient list with no quantities, and category tags
— never the method.

That is the ceiling on what this source could ever offer Buttery, API or no
API: for book- and magazine-sourced recipes EYB does not hold the
instructions to hand over, so no data-access route through them — official or
scraped — produces "type a book title, get the recipe." It can only ever
point at a page in a book we don't own.

## API / data access

There is no public API, no bulk export, and no self-serve licensing product.
Their Terms of Use prohibit "any robot, spider, scraper, crawler, or other
automated means to access, collect, copy, or monitor any portion of the
Service" without written permission, and `robots.txt` backs that up with
specific, named rules for `ClaudeBot` — a 50-second crawl delay and blocks on
`/library/`, `/account/`, `/signin`, `/signup`, `/membership`, `/gift`, and
any JSON path — on top of a long list of blocked scraper user agents.
Recipe URLs are opaque numeric IDs assigned by their own search
(`/library/recipes/1207290/rhubarb-sauce-khoreshe-rivas`), not derivable from
an ISBN or title, so there's no predictable-URL shortcut either — resolving a
title to an ID needs their own (login-gated, scraping-prohibited) search.

Institutional licensing exists in one form: public libraries subscribe so
patrons get EYB search against the library's own catalog. That implies a
commercial conversation is possible, just not a self-serve one — worth an
email to `info@eatyourbooks.com` if this is ever worth pursuing formally, but
nothing to build against today.

## For blog-sourced recipes, the real answer is to skip EYB

EYB does index food blogs and websites, and even its free tier covers
unlimited blog/online-recipe entries. But for those, the recipe text already
lives on the open web at the original post — EYB is just a pointer to it, and
a pointer we're not allowed to fetch programmatically. If we want the recipe
for a blog-sourced dish, the direct route is the blog's own URL, and Buttery
already has the pipeline for that: `packages/recipe-extract`'s
schema.org/microdata parser, the same one behind the
[Paprika importer](../plans/2026-08-09-paprika-import.md) and any URL-based
recipe add. Most food blogs already publish machine-readable recipe markup
for their own reasons (Google Rich Results, Pinterest), which is exactly what
that parser reads — no EYB in the loop at all.

## What this means for the "give us a book + recipe name" idea

- **Blog/website recipes** — reachable today. Resolve a title to a URL (by
  whatever means — web search, the user pasting a link) and run it through
  the existing extractor; attribution is whatever the source site requires,
  same as any other imported recipe.
- **Cookbook/magazine recipes** — no automated path exists, through EYB or
  anyone else. The instructions only exist in print or a purchased ebook.
  The honest feature here is photo/OCR capture of the user's own copy of the
  page — a capture tool, not a lookup — or the user typing the recipe in by
  hand with the book cited as the source.
- "Type a title, get the recipe" is really two features sharing one UI: a
  URL/blog resolver (buildable now, no new integration) and a book-page
  capture tool (a different problem, with no EYB shortcut through it).

No reader-facing version of this yet — there's nothing user-facing built on
Eat Your Books, so a page on `docs.buttery.recipes` would be premature. Write
one (following the [Open Food Facts](../../services/docs/docs/open-data/open-food-facts.md)
pattern) if and when that changes.

## Links

- **[Homepage](https://www.eatyourbooks.com/)** — the index itself.
- **[Quick tour](https://www.eatyourbooks.com/quick-tour)** — how the index
  and bookshelf model work.
- **[Support articles](https://support.eatyourbooks.com/collection/45-eat-your-books)**
  — the closest thing to documentation; covers export/print, bookmarklet,
  and membership, not an API (because there isn't one).
- **[Terms of Use](https://www.eatyourbooks.com/terms-and-conditions)** —
  the automated-access prohibition quoted above.

This document is AIL-4 — drafted by an LLM from Damien Cousineau's
direction, not yet reviewed by a human.
