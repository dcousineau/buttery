---
ail: 4
title: schema.org/Recipe
sidebar_position: 2
description: The vocabulary that every recipe site on earth emits — where Recipe sits in the schema.org hierarchy, what each property holds, and what the markup looks like in the wild.
---

# schema.org/Recipe

When a recipe app takes a URL and returns a title, an ingredient list, a cook
time and a photo, [`schema.org/Recipe`](https://schema.org/Recipe) is usually
the source. It is the most widely deployed structured description of food on the
web, adopted at scale because the major search engines consume it.

This page is a reference for the type itself: its place in the hierarchy, every
property it defines, the inherited ones that appear on recipes, and what the
markup looks like in practice. For what Microdata, RDFa and JSON-LD _are_ as
syntaxes, and how schema.org came to exist at all, start with
[the introduction](./intro.md). For the older, HTML-class-based approach to the
same problem, see [hRecipe](./hrecipe.md).

## About this reference

|                                   |                                                                 |
| --------------------------------- | --------------------------------------------------------------- |
| **Canonical URL**                 | [`https://schema.org/Recipe`](https://schema.org/Recipe)        |
| **Hierarchy**                     | `Thing` → `CreativeWork` → `HowTo` → `Recipe`                   |
| **Published by**                  | [schema.org](https://schema.org) — Bing, Google, Yahoo!, Yandex |
| **Typical syntaxes**              | JSON-LD (dominant), Microdata, RDFa                             |
| **Reflects the vocabulary as of** | schema.org version 30.0                                         |

The property lists below were built from the schema.org vocabulary dump rather
than transcribed by hand, so the ranges are the ranges the vocabulary actually
declares — which is not always what the tutorials say.

---

## Where Recipe sits {#hierarchy}

A recipe, in schema.org's model, is **a kind of instruction set that happens to
produce food**. The full chain is:

| Level | Type           | What it contributes                                                 |
| ----- | -------------- | ------------------------------------------------------------------- |
| 1     | `Thing`        | `name`, `description`, `image`, `url`, `identifier`, `sameAs`.      |
| 2     | `CreativeWork` | Authorship, dates, licensing, ratings, video, keywords.             |
| 3     | `HowTo`        | Steps, supplies, tools, durations, yield, estimated cost.           |
| 4     | `Recipe`       | The food-specific narrowing: ingredients, cuisine, nutrition, diet. |

That ordering post-dates the types themselves. `Recipe` is the older type;
`HowTo` arrived later and was slotted in _above_ it. Schema.org's release notes
for **version 3.3 (14 August 2017)** describe adding "a `HowTo` type, building
upon and generalizing the existing `Recipe` vocabulary" — that release
introduced `estimatedCost`, `steps`, `supply` and `tool`, and generalized
`recipeYield` into `yield` and `cookTime` into `performTime`.

This is why several Recipe properties are formally _sub-properties_ of HowTo
ones, and why you will meet near-duplicate pairs:

| Recipe property      | Sub-property of | Meaning of the pair                  |
| -------------------- | --------------- | ------------------------------------ |
| `cookTime`           | `performTime`   | Time spent actually doing the thing. |
| `recipeYield`        | `yield`         | What comes out the other end.        |
| `recipeIngredient`   | `supply`        | Things consumed by the process.      |
| `recipeInstructions` | `step`          | The ordered procedure.               |

Both members of each pair are valid. In practice publishers use the `recipe*`
form and consumers should read both.

## How it is published {#publishing}

Two syntaxes carry essentially all Recipe markup in the wild. JSON-LD sits in a
`<script type="application/ld+json">` block in the document, structurally
independent of the visible HTML. Microdata annotates the visible HTML itself
with `itemscope` / `itemtype` / `itemprop` attributes. RDFa Lite is legal and
almost unused for recipes. All three are described in detail on the
[JSON-LD, Microdata and RDFa](./intro.md#syntaxes) section of the intro page.

JSON-LD decouples the markup from the template: a CMS plugin can emit the block
without a theme author touching a single `<div>`. The trade-off is that the
structured data and the human-visible page are separate documents, and the two
can differ.

---

## Properties defined on Recipe {#recipe-properties}

These nine are declared directly on `Recipe`. Everything else you see on a
recipe in the wild is inherited.

| Property             | Type                                | What it holds                                                                                                                          |
| -------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `recipeIngredient`   | `ItemList`, `PropertyValue`, `Text` | An ingredient, or an ordered list of them, with quantities. Free text like `"2 slices sourdough"` is the overwhelming norm.            |
| `recipeInstructions` | `CreativeWork`, `ItemList`, `Text`  | The procedure — a single item, or an ordered list of `HowToStep` and/or `HowToSection` items. See [the shapes it takes](#in-practice). |
| `recipeYield`        | `QuantitativeValue`, `Text`         | What the recipe produces: `"4 servings"`, `"one 9-inch loaf"`, `"12"`.                                                                 |
| `cookTime`           | `Duration`                          | Time the dish is actually cooking, as an ISO-8601 duration (`PT30M`).                                                                  |
| `recipeCategory`     | `Text`                              | The course or role — `"appetizer"`, `"entree"`, `"dessert"`. Uncontrolled vocabulary.                                                  |
| `recipeCuisine`      | `Text`                              | The culinary tradition — `"French"`, `"Ethiopian"`. Also uncontrolled.                                                                 |
| `cookingMethod`      | `Text`                              | How it is cooked — `"Frying"`, `"Steaming"`. Uncontrolled, and rarely emitted.                                                         |
| `nutrition`          | `NutritionInformation`              | A structured nutrition block. See [nutrition](#nutrition).                                                                             |
| `suitableForDiet`    | `RestrictedDiet`, `Diet`            | A dietary restriction the dish satisfies. `RestrictedDiet` is an enumeration; `Diet` comes from the health-lifesci extension.          |

### Superseded on Recipe {#superseded}

| Property      | Type   | Status                                                                                                    |
| ------------- | ------ | --------------------------------------------------------------------------------------------------------- |
| `ingredients` | `Text` | **Superseded by `recipeIngredient`.** Defined as a _single_ ingredient. Still emitted by aging templates. |

Superseded, in schema.org's model, does not mean removed. `ingredients` still
resolves, still validates, and still shows up in real documents served today. A
parser that ignores it will silently lose ingredient lists on older sites.

### The `RestrictedDiet` enumeration {#restricted-diet}

`suitableForDiet` is one of the few places `Recipe` reaches for a controlled
vocabulary rather than free text. The members are:

`DiabeticDiet`, `GlutenFreeDiet`, `HalalDiet`, `HinduDiet`, `KosherDiet`,
`LowCalorieDiet`, `LowFatDiet`, `LowLactoseDiet`, `LowSaltDiet`, `VeganDiet`,
`VegetarianDiet`.

Eleven values, expressed as URLs (`https://schema.org/VeganDiet`). Several
restrictions in common use are absent — dairy-free, nut-free, keto, pescatarian.
Schema.org's own note on `Recipe` directs publishers to `keywords` for dietary
detail the enumeration does not cover.

---

## Inherited from HowTo {#howto-properties}

These are declared on `HowTo` and available on every `Recipe`. Several of them
are the _general_ form of a Recipe-specific property; a few have no
Recipe-specific counterpart at all and are the only way to express the concept.

| Property        | Type                                                | What it holds                                                                            |
| --------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `prepTime`      | `Duration`                                          | Time to prepare the supplies before the cooking starts. ISO-8601.                        |
| `totalTime`     | `Duration`                                          | Total time, preparation included. ISO-8601.                                              |
| `performTime`   | `Duration`                                          | The general form of `cookTime` — time spent performing the instructions.                 |
| `yield`         | `QuantitativeValue`, `Text`                         | The general form of `recipeYield`.                                                       |
| `step`          | `CreativeWork`, `HowToSection`, `HowToStep`, `Text` | The general form of `recipeInstructions`.                                                |
| `supply`        | `HowToSupply`, `Text`                               | Something consumed by the process — the general form of `recipeIngredient`.              |
| `tool`          | `HowToTool`, `Text`                                 | Something _used but not consumed_: a skillet, a spatula. The nearest thing to equipment. |
| `estimatedCost` | `MonetaryAmount`, `Text`                            | Estimated cost of the supplies.                                                          |

| Superseded | Type                               | Status                                                                                                                                  |
| ---------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `steps`    | `CreativeWork`, `ItemList`, `Text` | **Superseded by `step`.** Introduced in v3.3 and renamed almost immediately — the vocabulary itself notes it was "originally misnamed". |

There is **no `recipeEquipment` property**. Equipment is expressed with the
inherited `tool`, which the vocabulary distinguishes from `supply` by
consumption: supplies are consumed by the process, tools are not.

### The step types {#step-types}

| Type           | What it holds                                                                               |
| -------------- | ------------------------------------------------------------------------------------------- |
| `HowToStep`    | One step. Simultaneously a `CreativeWork`, an `ItemList` and a `ListItem` — so it can nest. |
| `HowToSection` | A named group of steps, e.g. "For the crust" inside a pie recipe.                           |
| `HowToSupply`  | A structured supply, with a `requiredQuantity`.                                             |
| `HowToTool`    | A structured tool.                                                                          |

## Inherited from CreativeWork and Thing {#inherited}

`CreativeWork` alone contributes well over a hundred properties, most of which
have nothing to do with food. These are the ones that actually appear on
recipes.

| Property           | From           | Type                             | What it holds                                                    |
| ------------------ | -------------- | -------------------------------- | ---------------------------------------------------------------- |
| `name`             | `Thing`        | `Text`                           | The dish's name. Effectively mandatory in practice.              |
| `description`      | `Thing`        | `Text`, `TextObject`             | The headnote — the paragraph before the ingredients.             |
| `image`            | `Thing`        | `ImageObject`, `URL`             | A photo of the finished dish.                                    |
| `url`              | `Thing`        | `URL`                            | Canonical URL for the recipe.                                    |
| `sameAs`           | `Thing`        | `URL`                            | A URL unambiguously identifying the same thing elsewhere.        |
| `author`           | `CreativeWork` | `Person`, `Organization`         | Who wrote it.                                                    |
| `publisher`        | `CreativeWork` | `Person`, `Organization`         | Who published it.                                                |
| `datePublished`    | `CreativeWork` | `Date`, `DateTime`               | First publication date.                                          |
| `dateModified`     | `CreativeWork` | `Date`, `DateTime`               | Last revision date.                                              |
| `keywords`         | `CreativeWork` | `DefinedTerm`, `Text`, `URL`     | Free tags. Carries the load `suitableForDiet` cannot.            |
| `aggregateRating`  | `CreativeWork` | `AggregateRating`                | Average star rating plus a count.                                |
| `review`           | `CreativeWork` | `Review`                         | Individual reviews.                                              |
| `video`            | `CreativeWork` | `Clip`, `VideoObject`            | An embedded how-to video.                                        |
| `inLanguage`       | `CreativeWork` | `Language`, `Text`               | BCP 47 language tag.                                             |
| `license`          | `CreativeWork` | `CreativeWork`, `URL`            | The licence the recipe is published under. Almost never present. |
| `isBasedOn`        | `CreativeWork` | `CreativeWork`, `Product`, `URL` | Adapted-from: the work this recipe is derived from.              |
| `mainEntityOfPage` | `Thing`        | `CreativeWork`, `URL`            | Says this recipe is what the page is _about_.                    |

## Nutrition {#nutrition}

`nutrition` takes a `NutritionInformation` (`Thing` → `Intangible` →
`StructuredValue` → `NutritionInformation`), which declares twelve properties.

| Property                | Type     | What it holds                     |
| ----------------------- | -------- | --------------------------------- |
| `servingSize`           | `Text`   | The serving this block describes. |
| `calories`              | `Energy` | Calorie count.                    |
| `fatContent`            | `Mass`   | Grams of fat.                     |
| `saturatedFatContent`   | `Mass`   | Grams of saturated fat.           |
| `unsaturatedFatContent` | `Mass`   | Grams of unsaturated fat.         |
| `transFatContent`       | `Mass`   | Grams of trans fat.               |
| `cholesterolContent`    | `Mass`   | Milligrams of cholesterol.        |
| `carbohydrateContent`   | `Mass`   | Grams of carbohydrate.            |
| `fiberContent`          | `Mass`   | Grams of fibre.                   |
| `sugarContent`          | `Mass`   | Grams of sugar.                   |
| `proteinContent`        | `Mass`   | Grams of protein.                 |
| `sodiumContent`         | `Mass`   | Milligrams of sodium.             |

`Energy` and `Mass` are both quantity types serialised as text with a unit —
`"240 calories"`, `"9 g"`. The unit lives inside the string, which means every
consumer writes the same small unit-parsing routine.

---

## A grilled cheese, marked up {#example}

The minimum viable Recipe, as JSON-LD:

```html
<script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Recipe",
    "name": "Grilled Cheese",
    "recipeYield": "1 sandwich",
    "cookTime": "PT6M",
    "recipeIngredient": ["2 slices bread", "2 slices cheddar", "1 tbsp butter"],
    "recipeInstructions": [
      { "@type": "HowToStep", "text": "Butter one side of each slice of bread." },
      { "@type": "HowToStep", "text": "Sandwich the cheese between the unbuttered sides." },
      { "@type": "HowToStep", "text": "Griddle over medium heat until golden on both sides." }
    ]
  }
</script>
```

The same recipe as Microdata, annotating markup a human actually reads:

```html
<div itemscope itemtype="https://schema.org/Recipe">
  <h1 itemprop="name">Grilled Cheese</h1>
  <p>Makes <span itemprop="recipeYield">1 sandwich</span> in <meta itemprop="cookTime" content="PT6M" />6 minutes.</p>
  <ul>
    <li itemprop="recipeIngredient">2 slices bread</li>
    <li itemprop="recipeIngredient">2 slices cheddar</li>
    <li itemprop="recipeIngredient">1 tbsp butter</li>
  </ul>
  <ol itemprop="recipeInstructions">
    <li>Butter one side of each slice of bread.</li>
    <li>Sandwich the cheese between the unbuttered sides.</li>
    <li>Griddle over medium heat until golden on both sides.</li>
  </ol>
</div>
```

Note the `<meta>` element in the Microdata version. `cookTime` takes an ISO-8601
duration and the visible text reads "6 minutes", so the machine value is carried
in an empty element next to the human-readable one. JSON-LD does not have this
problem because it does not share the DOM with the rendered page.

---

## What the markup looks like in practice {#in-practice}

The vocabulary permits more variation than most publishers exercise, and real
documents diverge from the specification in consistent ways. What follows is
description of the deployed web, not of the standard.

**`recipeInstructions` arrives in four shapes.** Its declared range is `Text`,
`ItemList` or `CreativeWork`, and because `HowToStep` and `HowToSection` are
both subclasses of `CreativeWork`, a conforming parser has to handle all of: a
single string containing the whole method; an array of strings; an array of
`HowToStep` objects; and an array of `HowToSection` objects each wrapping its
own array of steps. All four are valid and all four are common. The
single-string case carries no step boundaries, so splitting it is heuristic.

**`recipeYield` is free text in practice.** `"4 servings"`, `"4-6"`,
`"Serves 4"`, `"12 cookies"`, `"1 loaf"` and bare `"4"` all appear. The
`QuantitativeValue` range is available and rarely used, so numeric scaling
requires parsing the string.

**Durations are frequently malformed.** `cookTime`, `prepTime` and `totalTime`
take ISO-8601 (`PT30M`). Production markup also contains `"30 min"`, `"PT30"`,
`"P30M"` (which parses as thirty _months_), `"0:30"` and bare `"30"`.

**Three descriptive properties are uncontrolled.** `recipeCategory`,
`recipeCuisine` and `cookingMethod` are plain `Text` with example values in the
documentation and no enumeration, so `"dessert"`, `"Dessert"`, `"Desserts"` and
`"Sweets"` are four distinct values to an aggregator. `suitableForDiet` is the
one property with a controlled list, and it has eleven members.

**Search-engine requirements shape what gets emitted.** Google's recipe
rich-result documentation lists two required properties — `name` and `image` —
with everything else recommended. Markup in the wild reflects those incentives:
`aggregateRating` and a hero image are near-universal, and the JSON-LD block and
the visible page can carry different values for the same field.

**Superseded properties remain in circulation.** Supersession in schema.org is
advisory, so `ingredients` and `steps` are still valid, still resolve, and are
still emitted by long-untouched templates. Parsers that drop them lose data on
older sites.

**Nutrition units are inside the strings.** `"9 g"`, `"240 calories"` — every
consumer parses the unit out of the value.

---

## Further reading {#further-reading}

- [`schema.org/Recipe`](https://schema.org/Recipe) — the canonical type page,
  with live examples in all three syntaxes.
- [`schema.org/HowTo`](https://schema.org/HowTo) — the parent type, and the
  source of the step, supply, tool and duration vocabulary.
- [schema.org](https://schema.org) itself, and its
  [release history](https://schema.org/docs/releases.html) — every version, with
  the types and properties each one added, changed or superseded.
- [hRecipe](./hrecipe.md) — the microformats recipe vocabulary, released in 2008
  and built on HTML class names instead of a parallel document.

> **Two vocabularies, one dish.** schema.org puts the description in a parallel
> data structure; microformats puts it in the HTML a person is already reading.
> Both are emitted on the web today, and Buttery reads both.
