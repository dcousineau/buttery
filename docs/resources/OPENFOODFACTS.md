# Open Food Facts

Open Food Facts is a collaborative, open database of food products. The data is published under the Open Database License (ODbL 1.0), with individual contents under the Database Contents License (DbCL) and product images under CC BY-SA 3.0, and it is reachable several ways: a JSON API for per-product lookups, full exports (MongoDB dumps, JSONL, CSV, and Parquet via Hugging Face) for bulk work, and SDKs for 20+ languages. Alongside the product data they maintain a set of hierarchical taxonomies in the `openfoodfacts/openfoodfacts-server` repo — notably `taxonomies/food/ingredients.txt`, which holds 4,715 entries under 206 roots, each with a canonical English name, English synonyms, translations into 15+ languages, and a parent chain (`en: chicken breast` sits under `< en: chicken meat`, for instance). Buttery uses that ingredients taxonomy as the source for its grocery-list food lexicon and aisle categorization.

## Links

- **[Homepage](https://world.openfoodfacts.org/)** — the product database itself.
- **[Documentation](https://openfoodfacts.github.io/openfoodfacts-server/)** — API reference, data model, and contributor docs.
- **[Data](https://world.openfoodfacts.org/data)** — exports, dumps, and licensing terms.
- **[Taxonomies](https://github.com/openfoodfacts/openfoodfacts-server/tree/main/taxonomies)** — the source files, including `food/ingredients.txt`.

This document is AIL-4 — drafted by Claude Opus 5, from my direction, and reviewed and edited by me before it landed.
