# lexicon.json / traits.json — license and provenance

Both `lexicon.json` and `traits.json` in this directory are **generated**.
Never hand-edit either; run `node scripts/build-food-lexicon.ts` from the repo
root instead. The aisle assignments `lexicon.json` encodes live in
`scripts/food-aisle-map.ts` and `scripts/food-staples.ts`; the vegan,
vegetarian, allergen and tag facts `traits.json` encodes live in
`scripts/food-allergens.ts` and `scripts/food-tags.ts` (diet properties come
straight from the taxonomy's own `vegan:en:` / `vegetarian:en:` values, with
no hand-authored map). Those are the files to edit.

`traits.json` is server-only (plan D9) — see `packages/food/src/traits.ts`.

## Source

Derived from the [Open Food Facts](https://world.openfoodfacts.org/) ingredients
taxonomy, `taxonomies/food/ingredients.txt` in
[`openfoodfacts/openfoodfacts-server`](https://github.com/openfoodfacts/openfoodfacts-server), at commit
`b48d721b5c196b0db607dab1f5ba031c123a8f2f` (sha256 of the source file:
`30345daaf23a314d43788417504f56ed58b078df8a03e4c5ddfb977cb3da31b3`).

See `docs/resources/OPENFOODFACTS.md` for what Open Food Facts is and where the
rest of its data lives.

## License

Open Food Facts data is published under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).

Both files are a **derived database** under that license: they reuse the
taxonomy's food identifiers, English names, hierarchy and (for `traits.json`)
its own diet and allergen properties, and add Buttery's own assignments on top
— aisle, staple and ignore for `lexicon.json`; allergen and tag seeds for
`traits.json`. As derived databases they are offered under the ODbL as well,
and the attribution above must travel with both.

Buttery credits Open Food Facts on its `/acknowledgements` page.
