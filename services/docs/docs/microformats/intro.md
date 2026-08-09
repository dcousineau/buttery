---
ail: 4
title: The semantic web, briefly
sidebar_position: 1
description: Two answers to the same question — how a web page tells a machine what it means — and why schema.org and microformats both ended up existing.
---

# The semantic web, briefly

A web page is a strange artifact. To you it is obviously a recipe: there's a
title, a list of things to buy, a set of numbered steps, a note that it takes
forty minutes. To a program it is a tree of `<div>`s. Every bit of meaning you
read off the page effortlessly — _this number is a cook time, that list is
ingredients_ — is inferred from typography, position and habit, none of which
survive the trip into a parser.

The **semantic web** is the long-running project to fix that: pages that carry
their own meaning, so a machine can read them without guessing. Two very
different traditions grew up around that goal, and this section is about both —
[schema.org](https://schema.org) and [microformats.org](https://microformats.org).
They solve the same problem with opposite instincts, and it's worth knowing
which is which before you look at how either one describes a
[recipe](./schema-org-recipe.md).

## About this page

|                     |                                                                           |
| ------------------- | ------------------------------------------------------------------------- |
| **What it covers**  | History, philosophy, and the three syntaxes schema.org travels in         |
| **What it doesn't** | Property-by-property references — those live on the two pages that follow |
| **Who it's for**    | Anyone curious how the web tries to explain itself to machines            |
| **Prerequisites**   | You know what an HTML attribute is. That's it.                            |

The two sibling pages are the reference material: **[schema.org's
`Recipe`](./schema-org-recipe.md)** and **[hRecipe](./hrecipe.md)**. Both of
them will send you back here for the syntax
explanations, so this page defines those [once](#syntaxes) and properly.

---

## The problem, as originally stated {#problem}

Tim Berners-Lee coined the term _Semantic Web_ and spent years arguing for it
from inside the W3C. The canonical statement is
[_The Semantic Web_](https://www.scientificamerican.com/article/the-semantic-web/),
the May 2001 _Scientific American_ article he wrote with James Hendler and Ora
Lassila: an extension of the existing web where data is machine-processable and
software agents can act on it — book your appointments, reconcile your records,
answer questions that span a dozen sites. The idea was never really
controversial. The disagreement was always about _how much machinery_ it should
take.

The W3C's answer was a stack of standards, sometimes drawn as a layer cake:

| Layer                                                  | What it does                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| **[RDF](https://www.w3.org/RDF/)**                     | A universal data model — everything is a subject-predicate-object triple. |
| **[RDF Schema](https://www.w3.org/TR/rdf-schema/)**    | Lets you say a `Recipe` is a kind of `CreativeWork`.                      |
| **[OWL](https://www.w3.org/OWL/)**                     | A full ontology language, with inference and formal logic.                |
| **[SPARQL](https://www.w3.org/TR/sparql11-overview/)** | A query language for triples.                                             |
| **[RDFa](https://www.w3.org/TR/rdfa-core/)**           | A way to embed triples inside ordinary HTML attributes.                   |

It is a genuinely impressive body of work, and almost none of it reached the
average person publishing a page. By 2006 Berners-Lee was co-authoring
[_The Semantic Web Revisited_](https://eprints.soton.ac.uk/262614/) with Nigel
Shadbolt and Wendy Hall, whose abstract concedes that "this simple idea,
however, remains largely unrealized". Formalising knowledge is
hard, ontologies are expensive to agree on, and — as Cory Doctorow's
["metacrap" essay](https://people.well.com/user/doctorow/metacrap.htm) put it,
memorably and unkindly — people lie in metadata they think nobody reads.

---

## Pave the cowpaths: microformats {#microformats}

The counter-movement started from the opposite end. Instead of designing a
knowledge representation language and hoping the web adopted it, look at what
publishers were **already** doing and standardise that.

The phrase for this comes from the W3C's
[_HTML Design Principles_](https://www.w3.org/TR/2007/WD-html-design-principles-20071126/#pave-the-cowpaths)
(a Working Draft dated 26 November 2007), which names it outright:

> **Pave the Cowpaths.** When a practice is already widespread among authors,
> consider adopting it rather than forbidding it or inventing something new.

Microformats got there first and expressed the same idea in their own principles:
_design for humans first, machines second_; _visible data beats invisible
metadata_; _reuse building blocks from widely adopted standards_.

The mechanism is almost aggressively unglamorous — the HTML `class` attribute,
which was sitting there unused by anything but CSS. No new elements, no new
files, no namespace declarations. You mark up the content you were publishing
anyway.

### The prior art

The first pieces predate the name. **XFN** — a vocabulary of `rel` values for
describing relationships between people you link to — launched on 15 December
2003, from Tantek Çelik, Eric Meyer and Matthew Mullenweg. **hCard** and
**hCalendar** were both conceived at FOO Camp in September 2004, and their
design tells you everything about the movement's taste: rather than invent
vocabularies, they lifted existing IETF ones wholesale. hCard is, in its own
words, "a 1:1 representation of vCard (RFC 2426) properties and values in HTML."
hCalendar does the same for iCalendar (RFC 2445) events.

**microformats.org** itself went live on 20 June 2005, as the community hub for
a movement centred on Tantek Çelik, Rohit Khare and CommerceNet Labs.

### mf1 and mf2

The original formats — retroactively called **microformats1** — each invented
their own class names, borrowed from whatever standard they mirrored. Every new
format therefore needed a new parser, and generic class names like `summary` or
`url` collided with everyone's CSS.

**microformats2** was proposed and worked out at FOO East on 2 May 2010, and
fixed both problems with a prefix convention. A parser no longer needs to know
your vocabulary; it reads the shape of the data straight off the class names.

| Prefix | Means                                                                   | Example     |
| ------ | ----------------------------------------------------------------------- | ----------- |
| `h-*`  | A root — this thing is a…                                               | `h-recipe`  |
| `p-*`  | A plain-text property                                                   | `p-name`    |
| `u-*`  | A URL property                                                          | `u-photo`   |
| `dt-*` | A date or time property                                                 | `dt-bday`   |
| `e-*`  | An element property — the property's value is the marked-up HTML inside | `e-content` |

The prefixes are deliberately **syntax-independent from the vocabularies**,
which are developed separately. That's the whole trick: one parsing algorithm,
many vocabularies, and new vocabularies cost nothing to invent.

The mf1 formats map onto mf2 roots:

| microformats1 | microformats2 | Describes                |
| ------------- | ------------- | ------------------------ |
| hCard         | `h-card`      | People and organisations |
| hCalendar     | `h-event`     | Events                   |
| hAtom         | `h-entry`     | Syndicatable posts       |
| hReview       | `h-review`    | Reviews                  |
| hRecipe       | `h-recipe`    | [Recipes](./hrecipe.md)  |

---

## Microdata, and the search engines' vocabulary {#schema-org}

Meanwhile, HTML5 grew a structured-data mechanism of its own. **Microdata** adds
five global attributes — `itemscope`, `itemtype`, `itemprop`, `itemid` and
`itemref` — that let you attach a vocabulary URL to a chunk of markup and name
its properties. It gave the web a syntax, but not a vocabulary; `itemtype`
points at a URL, and somebody has to publish something at the other end.

On **2 June 2011**, Bing, Google and Yahoo! jointly launched
[schema.org](https://schema.org) to be that something. **Yandex joined in
November 2011.** For the first time there was one shared vocabulary, published
at a stable URL, endorsed by the companies whose crawlers actually read your
page.

That endorsement is the entire reason schema.org won the open web. It answered
the question every publisher asks about metadata — _who is going to read this?_
— with a concrete, commercially interesting answer: the search engines, and
they'll show your page differently if you do it. Rich results were the carrot,
and it worked at a scale nothing before it had managed; schema.org's own figures
put usage as of 2024 at over 45 million domains and more than 450 billion
marked-up objects.

Schema.org is careful to say it is **not a formal standards body**. It's run by
a steering group drawn from the founding companies plus outside experts, with the
W3C Schema.org Community Group as the main public forum for proposing changes.
The vocabulary ships versioned releases and has grown enormous — over 800 types
by 2026, most recently version 30.0 in March of that year.

---

## Three syntaxes, one vocabulary {#syntaxes}

Here is the point that confuses people most, so it's worth stating plainly:
**schema.org is a vocabulary, not a syntax.** It tells you there is a type
called `Recipe` with a property called `cookTime`. It does not tell you how to
write that in a file. Three different syntaxes can carry it, and all three are
officially supported.

| Syntax        | Lives in           | Standardised by                           | Feel                             |
| ------------- | ------------------ | ----------------------------------------- | -------------------------------- |
| **Microdata** | HTML attributes    | WHATWG HTML; a W3C spec ran alongside it  | Wraps the visible content        |
| **RDFa Lite** | HTML attributes    | W3C Recommendation, June 2012             | Wraps the visible content        |
| **JSON-LD**   | A `<script>` block | W3C Recommendation (1.0, 16 January 2014) | A separate data blob in the page |

**Microdata** hangs the data off the elements you were already rendering:

```html
<div itemscope itemtype="https://schema.org/Recipe">
  <h1 itemprop="name">Sourdough</h1>
</div>
```

Its standards story is bumpier than it looks: Microdata lives in the WHATWG HTML
living standard, but the parallel W3C spec stalled in 2013 when the HTML Working
Group couldn't find an editor and published it as a Note. Editing later resumed,
producing further Working Drafts, the most recent dated 26 April 2018.

**RDFa** does the same job with a different attribute set and real RDF semantics
underneath. RDFa 1.0 became a W3C Recommendation in October 2008; RDFa 1.1
followed in June 2012, dropping the XML namespace machinery so it could be used
in plain HTML. Alongside it came **RDFa Lite 1.1** — a minimal subset of five
attributes (`vocab`, `typeof`, `property`, `resource`, `prefix`), which is what
almost everyone means by "RDFa" today:

```html
<div vocab="https://schema.org/" typeof="Recipe">
  <h1 property="name">Sourdough</h1>
</div>
```

**JSON-LD** takes the opposite approach: don't annotate the markup at all, ship
a parallel description of the page as JSON. Work began in 2010; JSON-LD 1.0
became a W3C Recommendation on 16 January 2014, and 1.1 is the current
Recommendation. Underneath it's RDF — the `@context` maps plain JSON keys onto
vocabulary terms — but you can use it competently without ever learning that.

```json
{ "@context": "https://schema.org", "@type": "Recipe", "name": "Sourdough" }
```

### Why JSON-LD won

Attribute-based syntaxes have one lovely property — the data _is_ the content,
so it can't drift out of sync with what the reader sees — and one fatal
practical one: they couple your data to your DOM. Restyle the page, move the
cook time into a sidebar, hand the template to a framework that re-renders
everything, and your markup breaks in ways nobody notices for months.

JSON-LD decouples them completely. It's a single block you can generate on the
server, inject with a tag manager, or emit from a CMS plugin without touching a
template. Google has recommended it as the preferred format since 2017, which
settled the argument for most of the web.

The cost is real, though, and it's exactly the thing microformats warned about:
**invisible metadata can lie.** Nothing forces the JSON-LD block to agree with
the page around it, and nobody proofreads a `<script>` tag.

---

## Where things stand {#today}

Both traditions are alive. They are not the same size, and they are not aimed at
the same audience.

|                   | schema.org                                           | microformats2                                        |
| ----------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| **Scale**         | 800+ types, versioned releases                       | A couple of dozen vocabularies                       |
| **Governed by**   | A search-engine steering group + W3C community group | An open wiki community                               |
| **Written in**    | Microdata, RDFa or JSON-LD                           | HTML `class` attributes                              |
| **Read by**       | Search engines, aggregators, LLM crawlers            | IndieWeb readers, feed parsers, Webmention endpoints |
| **Optimises for** | Coverage and machine consumption                     | Simplicity and human authoring                       |

Microformats never became the web's structured-data format, but they did become
the substrate of the **IndieWeb** — the loose movement around owning your own
site and syndicating out from it. `h-entry` and `h-card` are how an IndieWeb
post identifies itself and its author, and **Webmention**, the protocol for
telling another site you've linked to it, became a W3C Recommendation on 12
January 2017 with microformats as its payload format. It's a small web, but it's
a working one, and it runs on markup a person can read.

## The tension worth naming {#tension}

These two vocabularies were designed for different readers, and it shows in
every decision they make.

Schema.org is designed to be **consumed**. Its shape is driven by what a crawler
can index and what a search result can display — which is why it is vast,
tolerant of duplication, and dominated by a syntax that bolts a data blob onto a
page rather than marking up the page itself. It is very good at its job. It is
also, structurally, a vocabulary you fill in for someone else's benefit.

Microformats are designed to be **published**. The constraint that data must be
visible on the page isn't a limitation, it's the point: the markup can't rot
silently, and the person writing the page is the person maintaining the
metadata. That keeps the vocabularies small and honest — and caps how much they
can ever express.

Neither is wrong. But if you've ever wondered why a recipe site emits a
two-kilobyte JSON-LD block describing a dish whose actual instructions are
eleven paragraphs down past four ads — that's the tension, in the wild.

Buttery reads both, which is how this section of the docs came to exist. What
each one actually says about a recipe is the subject of the next two pages.

---

## Further reading

| Source                                                                  | What it is                                    |
| ----------------------------------------------------------------------- | --------------------------------------------- |
| [schema.org](https://schema.org)                                        | The vocabulary itself, browsable type by type |
| [microformats.org](https://microformats.org)                            | The community wiki, specs and parsers         |
| [Semantic Web](https://en.wikipedia.org/wiki/Semantic_Web)              | The overall project and its critics           |
| [Microformats](https://en.wikipedia.org/wiki/Microformat)               | History and format list                       |
| [Schema.org](https://en.wikipedia.org/wiki/Schema.org)                  | Launch, sponsors, governance                  |
| [Microdata (HTML)](https://en.wikipedia.org/wiki/Microdata_%28HTML%29)  | The attribute syntax and its spec history     |
| [RDFa](https://en.wikipedia.org/wiki/RDFa)                              | RDFa, RDFa 1.1 and RDFa Lite                  |
| [JSON-LD](https://en.wikipedia.org/wiki/JSON-LD)                        | The dominant schema.org syntax                |
| [Webmention](https://en.wikipedia.org/wiki/Webmention)                  | Where microformats are load-bearing today     |
| [HTML Design Principles](https://www.w3.org/TR/html-design-principles/) | Source of "pave the cowpaths"                 |

**Next:** [schema.org's `Recipe`](./schema-org-recipe.md) — the large,
search-driven vocabulary — and [hRecipe](./hrecipe.md), the smaller one built
out of HTML class names.
