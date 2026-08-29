---
ail: 4
title: Lexicons
sidebar_position: 1
description: The recipe.exchange lexicons behind Buttery — the shape of your recipe data on atproto, field by field, plus how the network reality differs from the published schema.
---

# recipe.exchange lexicons

Your recipes don't live inside Buttery. They live on the open [AT Protocol](https://atproto.com)
network, in your own account, as portable records under the **`recipe.exchange`**
namespace. Buttery reads and writes those records — but so can any other app that
speaks the same lexicons. Leave Buttery whenever you like and your recipes come
with you.

This page is the reference for those record types: what fields exist, what they
mean, and — the part worth reading twice — where the **published schema and the
data you'll actually see on the network diverge**. Buttery isn't the only app in
this part of the atproto ecosystem — see the [ecosystem page](./ecosystem.md) for
others, and which lexicons each one speaks.

## About this reference

|                               |                                                                      |
| ----------------------------- | -------------------------------------------------------------------- |
| **Namespace**                 | `exchange.recipe.*`                                                  |
| **Published by**              | `did:plc:4cx7ts7lqgjtsfquo53qo3sz`                                   |
| **Upstream reference**        | [recipe.exchange/lexicons](https://recipe.exchange/lexicons)         |
| **Discover it**               | the `_lexicon.recipe.exchange` DNS TXT record resolves the publisher |
| **Reflects the schema as of** | 2026-08-01                                                           |

`recipe.exchange` is an open, third-party lexicon — Buttery didn't author it and
doesn't own it. Its authors publish their own human-readable reference at
[recipe.exchange/lexicons](https://recipe.exchange/lexicons); read that for the
canonical schema, and this page for how it behaves in practice. The tables below
describe the schema as published on the network on the date above. Lexicons
evolve, so treat this as a snapshot; the network is always the source of truth.

### It borrows its vocabulary from schema.org {#schema-org-lineage}

The field names on `exchange.recipe.recipe` are
[schema.org `Recipe`](../microformats/schema-org-recipe.md) property names, not
new ones. `name`, `text`, `keywords`, `cookTime`, `prepTime`, `totalTime`,
`recipeYield`, `nutrition`, `cookingMethod`, `recipeCuisine`, `recipeCategory`
and `suitableForDiet` all carry the same meanings they have there, and the
[`#nutrition`](#nutrition) shape takes its property names from schema.org's
`NutritionInformation`. If you already
know how to read a recipe out of a web page, you already know most of this
lexicon.

Two names diverge. `ingredients` and `instructions` are schema.org's
**superseded** spellings — the current vocabulary calls them `recipeIngredient`
and `recipeInstructions`. And `instructions` here is a flat `string[]`, where
schema.org permits [four different shapes](../microformats/schema-org-recipe.md#in-practice)
for the same property. The lexicon picks one and requires it, which is why a
schema.org page needs coercing before it fits.

## The record types

| Lexicon                                     | Kind               | One per…   | Read by Buttery today |
| ------------------------------------------- | ------------------ | ---------- | --------------------- |
| [`exchange.recipe.recipe`](#recipe)         | record             | recipe     | Yes                   |
| [`exchange.recipe.collection`](#collection) | record             | collection | Not yet               |
| [`exchange.recipe.profile`](#profile)       | record             | account    | Not yet               |
| [`exchange.recipe.defs`](#defs)             | shared definitions | —          | Indirectly            |

Three of these are records that live in your account; the fourth is a shared
vocabulary the records draw on. Buttery reads recipes today — collections and
profiles are part of the schema and coming later.

---

## `exchange.recipe.recipe` {#recipe}

> A single recipe. One record per recipe.

**Always present:** `name`, `text`, `ingredients`, `instructions`, `createdAt`, `updatedAt`.

| Field             | Type                               | Required | What it holds                                                   |
| ----------------- | ---------------------------------- | -------- | --------------------------------------------------------------- |
| `name`            | string                             | Yes      | Recipe name, up to 255 characters.                              |
| `text`            | string                             | Yes      | Description, up to 3000 characters.                             |
| `ingredients`     | string[]                           | Yes      | Each item up to 500 characters.                                 |
| `instructions`    | string[]                           | Yes      | Step-by-step, each step up to 1000 characters.                  |
| `createdAt`       | datetime                           | Yes      | ISO-8601 timestamp.                                             |
| `updatedAt`       | datetime                           | Yes      | ISO-8601 timestamp.                                             |
| `embed`           | [`#imagesEmbed`](#images-embed)    |          | Up to 4 photos.                                                 |
| `keywords`        | string[]                           |          | Free-form tags, each up to 64 characters.                       |
| `cookTime`        | string                             |          | ISO-8601 duration, e.g. `"PT30M"` (see [wire notes](#network)). |
| `prepTime`        | string                             |          | ISO-8601 duration.                                              |
| `totalTime`       | string                             |          | ISO-8601 duration.                                              |
| `recipeYield`     | string                             |          | Servings or yield, free text (e.g. `"4 servings"`).             |
| `nutrition`       | [`#nutrition`](#nutrition)         |          | Per-serving nutrition.                                          |
| `attribution`     | one of [attribution](#attribution) |          | Where the recipe came from.                                     |
| `cookingMethod`   | string                             |          | An open enum — see [`cookingMethod*`](#tokens).                 |
| `recipeCuisine`   | string                             |          | An open enum — see [`cuisine*`](#tokens).                       |
| `recipeCategory`  | string                             |          | An open enum — see [`category*`](#tokens).                      |
| `suitableForDiet` | string[]                           |          | Open enum values — see [`diet*`](#tokens).                      |

### Nested shapes

#### `#nutrition` {#nutrition}

Per-serving nutrition. All fields optional:

| Field                 | Type    | Notes                                    |
| --------------------- | ------- | ---------------------------------------- |
| `calories`            | integer | A whole number.                          |
| `fatContent`          | string  | A decimal carried as text, e.g. `"5.0"`. |
| `proteinContent`      | string  | Decimal as text.                         |
| `carbohydrateContent` | string  | Decimal as text.                         |

#### `#image` {#image}

What you send when adding a photo:

| Field         | Type                                                                                  | Required | Notes                        |
| ------------- | ------------------------------------------------------------------------------------- | -------- | ---------------------------- |
| `image`       | blob                                                                                  | Yes      | Any `image/*`, up to 1 MB.   |
| `alt`         | string                                                                                | Yes      | Alt text, for accessibility. |
| `aspectRatio` | [`app.bsky.embed.defs#aspectRatio`](https://atproto.com/lexicons/app-bsky-embed-defs) |          | A shared atproto shape.      |

#### `#imagesEmbed` {#images-embed}

A set of up to 4 [`#image`](#image) uploads — this is what
[`recipe.embed`](#recipe) holds.

#### `#viewImage` / `#view` {#view-image}

The _hydrated_ form the network hands back when you read a recipe: each photo
comes as a `thumb` and `fullsize` URL (served from a CDN) plus `alt` text and an
optional aspect ratio. Worth noting the asymmetry — **you upload photos as blobs
([`#image`](#image)); you read them back as URLs.**

---

## `exchange.recipe.collection` {#collection}

> A named, ordered list of recipes. One record per collection.

**Always present:** `name`, `createdAt`, `updatedAt`.

| Field       | Type                                                           | Required | What it holds                                 |
| ----------- | -------------------------------------------------------------- | -------- | --------------------------------------------- |
| `name`      | string                                                         | Yes      | Up to 100 characters.                         |
| `createdAt` | datetime                                                       | Yes      | ISO-8601 timestamp.                           |
| `updatedAt` | datetime                                                       | Yes      | ISO-8601 timestamp.                           |
| `text`      | string                                                         |          | Description, up to 1000 characters.           |
| `recipes`   | [`strongRef`](https://atproto.com/lexicons/com-atproto-repo)[] |          | References (`uri` + `cid`) to recipe records. |

---

## `exchange.recipe.profile` {#profile}

> Public profile for a recipe.exchange account. One per account (record key `self`).

**Always present:** `createdAt`, `profileType`.

| Field          | Type                   | Required | What it holds                                       |
| -------------- | ---------------------- | -------- | --------------------------------------------------- |
| `profileType`  | string                 | Yes      | [`profileType*`](#tokens) — personal or business.   |
| `createdAt`    | datetime               | Yes      | ISO-8601 timestamp.                                 |
| `updatedAt`    | datetime               |          | ISO-8601 timestamp.                                 |
| `about`        | string                 |          | Bio, up to 2000 characters.                         |
| `email`        | string                 |          | Up to 255 characters.                               |
| `phone`        | string                 |          | Up to 20 characters.                                |
| `links`        | [`#link`](#link)[]     |          | Up to 5 links.                                      |
| `address`      | [`#address`](#address) |          | Postal address.                                     |
| `businessType` | string                 |          | [`businessType*`](#tokens) — for business profiles. |

#### `#link` {#link}

`title` (up to 100 chars) and `url` — both required.

#### `#address` {#address}

Optional `city`, `state`, `country`, `street1`, `street2`, `postalCode`, plus
`latitude` / `longitude` carried as text (see [network notes](#network) — the
exact encoding is unconfirmed, since no live profiles exist yet).

---

## `exchange.recipe.defs` {#defs}

The shared vocabulary the records above draw on: open enums (tokens) and the
attribution shapes.

### Tokens {#tokens}

These are **open** enums — a record may carry a value outside the published list,
so treat unknown values gracefully:

| Group             | Prefix             | Roughly   | Used by                             |
| ----------------- | ------------------ | --------- | ----------------------------------- |
| Cuisines          | `cuisine*`         | 45 values | [`recipe.recipeCuisine`](#recipe)   |
| Categories        | `category*`        | 20 values | [`recipe.recipeCategory`](#recipe)  |
| Cooking methods   | `cookingMethod*`   | 13 values | [`recipe.cookingMethod`](#recipe)   |
| Diets             | `diet*`            | 14 values | [`recipe.suitableForDiet`](#recipe) |
| Licenses          | `license*`         | 6 values  | [attribution](#attribution)         |
| Business types    | `businessType*`    | 21 values | [`profile.businessType`](#profile)  |
| Profile types     | `profileType*`     | 2 values  | [`profile.profileType`](#profile)   |
| Publication types | `publicationType*` | 2 values  | attribution                         |

### Attribution {#attribution}

A recipe's `attribution` is exactly one of these six shapes, describing where it
came from:

| Shape                     | Required           | For                                                      |
| ------------------------- | ------------------ | -------------------------------------------------------- |
| `#attributionOriginal`    | `license`          | Your own original recipe (with a [`license*`](#tokens)). |
| `#attributionPerson`      | `name`             | Something a person shared (family, a friend).            |
| `#attributionWebsite`     | `name`, `url`      | A website or blog.                                       |
| `#attributionPublication` | `title`, `author`  | A book or magazine (plus `isbn`, `page`, `publisher`).   |
| `#attributionShow`        | `title`, `network` | A TV or streaming show (plus `airDate`, `episode`).      |
| `#attributionProduct`     | `brand`, `name`    | A product package or label (plus `upc`).                 |

---

## The schema vs. the network {#network}

The single most useful thing to know if you're reading this data yourself: **the
published schema and the bytes on the wire don't always agree.** A few of these
gaps exist because the schema predates today's stricter Lexicon validators. Here's
what to actually expect:

- **Durations are text.** `cookTime`, `prepTime`, and `totalTime` are ISO-8601
  durations (`"PT30M"`), but they travel as plain strings — parse them yourself.
- **Decimals are text.** Every non-whole number rides the wire as a string:
  nutrition macros (`"5.0"`) and profile latitude/longitude. `calories` is the
  only genuine integer.
- **Photos go out as blobs, come back as URLs.** You upload an
  [`#image`](#image) blob; a read gives you [`#viewImage`](#view-image) CDN URLs
  (`thumb` + `fullsize`).
- **A handful of fields are looser than they look.** Some fields the schema once
  marked as an email, a date, or a numeric type are, on the network, just
  strings. Validate defensively.
- **Open enums stay open.** Cuisine, category, cooking method, and diet values can
  legitimately be things not in the published token list. Don't reject a recipe
  for using one.

## How Buttery reads your recipes

Buttery reads your `exchange.recipe.recipe` records straight from your account's
public data — no special access, nothing you have to grant. When it shows a
recipe, it validates it against the schema above and reads photos from the URLs
the network provides. Because the records are public and portable, the same
recipes are readable by any recipe.exchange-aware app — Buttery is just one door
into a database you own.

> **A living document.** This reference reflects the `recipe.exchange` schema as
> of 2026-08-01. Open lexicons change over time; if something here disagrees with
> what you see on the network, the network wins. For the publishers' own
> human-readable reference, see
> [recipe.exchange/lexicons](https://recipe.exchange/lexicons).
