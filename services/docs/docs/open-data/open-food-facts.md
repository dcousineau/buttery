---
ail: 4
title: Open Food Facts
sidebar_position: 1
description: The open food database behind Buttery's shopping list — what Open Food Facts is, what data it publishes, and the one part of it we actually use.
---

# Open Food Facts

[Open Food Facts](https://world.openfoodfacts.org/) is a collaborative, open
database of food products, built the way Wikipedia is: volunteers photograph
labels and type in what they say, and the result belongs to everyone. It has
grown to cover several million products across more than a hundred countries,
and it is run by a small non-profit rather than a company — the data is free
because people chose to give it away, and it stays free because a handful of
staff and a lot of contributors keep it that way.

> **Support them.** If Buttery's shopping list is useful to you, some of the
> credit belongs upstream.
> **[Donate to Open Food Facts](https://world.openfoodfacts.org/donate-to-open-food-facts)** —
> they run on donations, and their data does real work in this app every time
> you add a recipe to your list.

## Links

|                      |                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| **Database**         | [world.openfoodfacts.org](https://world.openfoodfacts.org/)                                           |
| **Donate**           | [Support the project](https://world.openfoodfacts.org/donate-to-open-food-facts)                      |
| **Data & licensing** | [Exports, dumps, and terms](https://world.openfoodfacts.org/data)                                     |
| **Developer docs**   | [openfoodfacts.github.io](https://openfoodfacts.github.io/openfoodfacts-server/)                      |
| **Wiki**             | [wiki.openfoodfacts.org](https://wiki.openfoodfacts.org/)                                             |
| **Taxonomies**       | [`taxonomies/` on GitHub](https://github.com/openfoodfacts/openfoodfacts-server/tree/main/taxonomies) |

## What they publish

Most of Open Food Facts is **product data** — barcodes, brands, ingredient
lists, nutrition facts, allergens, packaging, Nutri-Score and NOVA
classifications, and label photographs. You can reach it through a JSON API for
single lookups, or as bulk exports (MongoDB dumps, JSONL, CSV, Parquet) for
anything larger.

Alongside the products they maintain a set of hierarchical **taxonomies**:
controlled vocabularies for ingredients, additives, allergens, categories,
labels and more, each one a tree of canonical terms with synonyms and
translations.

## What Buttery uses

Just one file: **`taxonomies/food/ingredients.txt`** — roughly 5,600 ingredient
entries, about 4,700 of which carry English names. None of the product data, no
nutrition, no barcodes.

We use it to answer a question the recipe itself cannot: _what food is this line
about, and which aisle is it in?_ At build time we generate a lexicon from the
taxonomy, hand-assign aisles to around 170 nodes, and let every other food
inherit from its nearest mapped ancestor. That is how "chicken breast" ends up
under **Meat & seafood** without anyone typing it. Their canonical ids also give
us a stable identity for a food, which is what lets "1 lb chicken breast" from
one recipe and "8 oz chicken breast" from another become a single line on your
list.

This all happens **when Buttery is built, not when you use it**. The running app
never calls Open Food Facts.

## The shape of the data

The taxonomy is a plain text file of blocks separated by blank lines. One entry
looks like this:

```text
< en: chicken meat
en: chicken breast, chicken breast meat
fr: blanc de poulet, blancs de poulet, poitrine de poulet
de: Hähnchenbrust, Hähnchenbrustfleisch
ciqual_proxy_food_name:en: Chicken, breast, without skin, raw
```

That is the whole format:

- `< en: chicken meat` — the **parent**, which is where the hierarchy comes from.
  An entry can have more than one.
- `en: chicken breast, chicken breast meat` — names in a language, canonical
  first, synonyms after. The first language line mints the entry's id, here
  `en:chicken-breast`.
- Other language lines add translations in 15+ languages.
- `ciqual_proxy_food_name:en:` and friends are **properties**, not names — links
  to other food databases, carbon-footprint figures, allergen flags. The colon
  inside the key is what tells a property apart from a language.

## Licensing

Open Food Facts data is published under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/),
with individual contents under the Database Contents License and product images
under CC BY-SA 3.0.

Buttery's generated lexicon is a **derived database** under the ODbL: it reuses
their identifiers, English names and hierarchy, and adds our own aisle
assignments on top. It is offered under the ODbL in turn, and it ships with a
notice recording the exact source revision it was generated from. Open Food
Facts is credited on Buttery's
[acknowledgements page](https://buttery.recipes/acknowledgements).
