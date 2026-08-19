---
ail: 4
title: Eat Your Books
sidebar_position: 2
description: Why the largest index of cookbook recipes on the web can't power a "type a title, get the recipe" feature — and what can.
---

# Eat Your Books

[Eat Your Books](https://www.eatyourbooks.com/) (EYB) is a searchable index of
the recipes inside physical cookbooks, food magazines, and a growing set of
food blogs — over 160,000 books and magazines and several million recipes,
by their own count. Members build a "Bookshelf" out of the cookbooks they
actually own, and EYB tells them which one has a recipe for what they're
craving.

It's a natural thing to look into for Buttery: it's the biggest map of
"which book has this recipe" that exists. It turns out that map can't power
what people usually picture — pasting in a book title and a recipe name and
getting the recipe back — and the reason is worth understanding rather than
just noting.

## Links

|                     |                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------- |
| **Homepage**        | [eatyourbooks.com](https://www.eatyourbooks.com/)                                        |
| **Quick tour**      | [How the index works](https://www.eatyourbooks.com/quick-tour)                           |
| **Support**         | [support.eatyourbooks.com](https://support.eatyourbooks.com/collection/45-eat-your-books) |
| **Terms of Use**    | [eatyourbooks.com/terms-and-conditions](https://www.eatyourbooks.com/terms-and-conditions) |

There is no developer documentation to link to, because there is no API.

## What they actually index

An EYB recipe entry is metadata, not content: the book (or magazine, or
blog), its author, a page number or ISBN, an ingredient list with no
quantities, and category/cuisine tags. It never includes the method — no
steps, no amounts, no headnote. That's a deliberate line EYB drew for itself:
publishing the actual text of a recipe from a book they don't own the rights
to would be the copyright problem their whole index exists to avoid, so they
built a product that answers "which book" instead of "what does it say."

Which means the ceiling on this source isn't an access problem — it's a
data problem. Even a hypothetical official API handing over every field EYB
has would still not include instructions for anything sourced from a book or
magazine, because EYB itself doesn't have them. It can tell you *where* a
recipe lives. It was never going to be able to tell you what's in it.

## Access

There is no public API, no bulk export, and no self-serve data licensing.
Their Terms of Use prohibit automated access — scraping, crawling, or any
robotic collection of the site — without written permission, and their
`robots.txt` enforces it with per-bot rules (including specific limits on AI
crawlers) on top of a long blocklist of known scrapers. Recipe pages sit
behind opaque, database-assigned URLs rather than anything derived from an
ISBN or title, so there's no predictable-URL trick to reach for either — you
would need their own search, gated behind a login, to turn a title into a
page in the first place.

The one door left ajar is that libraries license EYB search for their
patrons, which means EYB does sell access in some form. A commercial
conversation is at least plausible; nothing about it is available today.

## The part that *is* buildable

EYB also indexes food blogs and standalone recipe sites — and for those, the
actual recipe already lives on the open web, at the blog's own URL. EYB is
just a pointer to it there too, but unlike the cookbook case, the thing being
pointed at is public and machine-readable: most recipe blogs publish
schema.org/Recipe markup on their pages already, for Google's and Pinterest's
benefit as much as anyone's.

Buttery already has a pipeline for exactly that shape of data — the same
structured-data parser that powers importing a recipe by URL. Given a link to
a blog post, it reads the page's own markup and produces a normal Buttery
recipe, with attribution to the original site. That covers the "type a title"
idea for anything published on the web; it just doesn't go through EYB to get
there, and arguably shouldn't — going straight to the source is both simpler
and the only version that's unambiguously fine to do.

What's left uncovered is the cookbook case: a recipe that only exists on
paper, or in a purchased ebook. No index of any kind changes that — someone
still has to type it in or photograph the page. That's a capture problem, not
a lookup problem, and it's a different feature.
