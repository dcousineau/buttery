import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  title: "Buttery Docs",
  tagline: "Documentation for Buttery",
  favicon: "img/favicon.ico",

  // Future flags, see https://docusaurus.io/docs/api/docusaurus-config#future
  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  // Production URL and base path for GitHub Pages (project site).
  url: "https://dcousineau.github.io",
  baseUrl: "/buttery/",

  // GitHub pages deployment config.
  organizationName: "dcousineau", // GitHub org/user name.
  projectName: "buttery", // Repo name.

  onBrokenLinks: "throw",

  markdown: {
    // Parse .md as CommonMark (only .mdx is treated as MDX). Keeps literal
    // braces like `{ images: ... }` and `{#heading-id}` anchors from being
    // parsed as JSX expressions.
    format: "detect",
  },

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          // Serve docs at the site root; this is a docs-only site.
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
          editUrl: "https://github.com/dcousineau/buttery/tree/main/services/docs/",
        },
        // No blog for this site.
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    [
      "docusaurus-plugin-llms",
      {
        // Generate llms.txt and llms-full.txt from the docs content.
        generateLLMsTxt: true,
        generateLLMsFullTxt: true,
        docsDir: "docs",
      },
    ],
  ],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: "Buttery",
      logo: {
        alt: "Buttery Logo",
        src: "img/logo.svg",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "docsSidebar",
          position: "left",
          label: "Docs",
        },
        {
          href: "https://buttery.recipes",
          label: "Open Buttery",
          position: "right",
        },
        {
          href: "https://github.com/dcousineau/buttery",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "light",
      links: [
        {
          title: "Docs",
          items: [
            {
              label: "Introduction",
              to: "/",
            },
          ],
        },
        {
          title: "Buttery",
          items: [
            {
              label: "Open Buttery",
              href: "https://buttery.recipes",
            },
            {
              label: "GitHub",
              href: "https://github.com/dcousineau/buttery",
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Buttery — the pantry where the good stuff is kept.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
