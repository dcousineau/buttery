---
ail: 4
title: Ecosystem
sidebar_position: 2
description: Other recipe apps living on the AT Protocol — who's building what, and how each one relates to the exchange.recipe lexicon Buttery reads and writes.
---

# Ecosystem

Buttery isn't the only recipe app on the AT Protocol. This page tracks the others —
apps that store or share recipes as records in your own atproto account, the same
way Buttery does. It's scoped to atproto; for inspiration from outside the network,
see [`docs/ECOSYSTEM.md`](https://github.com/dcousineau/buttery/blob/main/docs/ECOSYSTEM.md)
in the repo.

## recipe.exchange

[recipe.exchange](https://recipe.exchange/) is a community recipe-sharing site built
directly on atproto records. Buttery reads and writes recipes using its
`exchange.recipe.*` lexicons — see the [lexicon reference](./lexicons.md) for the
full schema, field by field.

## pantryhost.app

[Pantry Host](https://pantryhost.app/) is a self-hosted, privacy-first kitchen
manager — recipes, menus, ingredients, and grocery lists run entirely on your own
hardware — that can browse and import recipes and menus shared via the
`exchange.recipe.recipe` and `collection` lexicons, and publish your own back to
the network. It's created and maintained by
[@jpdevries.bsky.social](https://bsky.app/profile/jpdevries.bsky.social).

## arecipe.app

[arecipe](https://arecipe.app/) is a recipe app that reads and writes recipes
living in atproto accounts, with no backend of its own.

## kich.io

[kich.io](https://kich.io/) is a pantry and recipe app built on atproto, by
[@hipstersmoothie.com](https://bsky.app/profile/hipstersmoothie.com). It
predates the publication of the `exchange.recipe` lexicon, so it doesn't use it —
it's on our radar as a fellow atproto recipe app, not as an `exchange.recipe`
interop target.

## AtChef

[AtChef](https://atchef.eu/) is a recipe-sharing app built on atproto — recipes
live under each user's own handle (`atchef.eu/profile/<handle>/recipe/<id>`).
It defines its own `eu.atchef.recipe` lexicon rather than using `exchange.recipe`.

## Flour Blend Calculator

[Flour Blend Calculator](https://bakery.minomobi.com/) is a narrower tool for
bakers — it composes custom flour ratios, hydration, and dough settings — but it
saves those blends as `exchange.recipe.recipe` records on your PDS, the same
lexicon Buttery reads and writes.

## Defluffit!

[Defluffit!](https://defluffit.duplicake.fyi/) strips the life-story preamble out
of recipe blog posts, leaving just the ingredients and steps, and saves the result
to your PDS for sharing on Bluesky. Built by
[@duplicake.fyi](https://bsky.app/profile/duplicake.fyi).
