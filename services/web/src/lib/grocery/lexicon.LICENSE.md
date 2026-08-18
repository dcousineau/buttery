# lexicon.json — license and provenance

`lexicon.json` in this directory is **generated**. Never hand-edit it; run
`node scripts/build-food-lexicon.ts` from the repo root instead. The aisle
assignments it encodes live in `scripts/food-aisle-map.ts` and
`scripts/food-staples.ts`, which are the files to edit.

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

`lexicon.json` is a **derived database** under that license: it reuses the
taxonomy's food identifiers, English names, and hierarchy, and adds Buttery's own
aisle, staple, and ignore assignments on top. As a derived database it is offered
under the ODbL as well, and the attribution above must travel with it.

Buttery credits Open Food Facts on its `/acknowledgements` page.
