// Themes (§63). Every color in the app is a --tm-* token from
// src/branding/tm-tokens.css; a theme is a set of overrides for the chrome
// and grid tokens, applied as inline custom properties on <html>. The
// default theme is Money Plus itself — the measured values in tm-tokens.css
// — so "money" clears every override rather than restating them.
//
// The Settings card previews each theme from the same map, so what the
// swatch shows is what applying it does.

export interface Theme {
  id: string;
  label: string;
  blurb: string;
  /** Token overrides, `--tm-…` keys without the leading dashes. */
  tokens: Record<string, string>;
  dark?: boolean;
}

const KEY = "tm.theme";

export const THEMES: readonly Theme[] = [
  { id: "money", label: "Money Plus", blurb: "The blue Money Plus shipped with — measured from the real thing.", tokens: {} },
  {
    id: "forest",
    label: "Forest",
    blurb: "Greens in place of the blues; everything else as Money laid it out.",
    tokens: {
      "ms-toolbar-top": "#7fc39a", "ms-toolbar-bot": "#6db58a",
      "ms-tabstrip-top": "#3f9a63", "ms-tabstrip-bot": "#358a55",
      "ms-tab-inactive-top": "#6f9a82", "ms-tab-inactive-bot": "#5f8a72",
      "ms-tab-active-top": "#4a8f66", "ms-tab-active-bot": "#2f6b48",
      "ms-subnav": "#2f6b48",
      "ms-rail-left": "#d5efdf", "ms-rail-right": "#e8f7ee", "ms-rail-divider": "#8fbf9f",
      "ms-card-border": "#9ccbaf", "ms-card-body": "#e6f5ec", "ms-card-hdr-top": "#9dcbb0", "ms-card-hdr-bot": "#adddc0",
      "ms-text-link": "#0b5a2a", "ms-text-heading": "#0f4f2a", "ms-text-cardhdr": "#0f4f2a", "ms-text-railhead": "#0d4a26",
      "ms-grid-header": "#d3ecdc", "ms-grid-header-rule": "#94c9a8", "ms-row-alt": "#f5faf7", "ms-group-header": "#dbeee3",
      "ms-content-bg": "#eef8f2", "ms-dialog-bg": "#f0faf4", "ms-dialog-field-border": "#7ab391",
      "ms-button-default": "#3f7a55",
      "sky-tint": "#dcf3e6",
    },
  },
  {
    id: "slate",
    label: "Slate",
    blurb: "Quiet grays and a navy accent, for a screen that stays out of the way.",
    tokens: {
      "ms-toolbar-top": "#a3adb8", "ms-toolbar-bot": "#95a0ac",
      "ms-tabstrip-top": "#6b7785", "ms-tabstrip-bot": "#5e6977",
      "ms-tab-inactive-top": "#8a929c", "ms-tab-inactive-bot": "#7a828c",
      "ms-tab-active-top": "#75818f", "ms-tab-active-bot": "#4f5a67",
      "ms-subnav": "#4f5a67", "ms-subnav-selected": "#ffd97a",
      "ms-rail-left": "#dfe4ea", "ms-rail-right": "#eef1f5", "ms-rail-divider": "#a6b0bc",
      "ms-card-border": "#b0bac6", "ms-card-body": "#eef1f5", "ms-card-hdr-top": "#b4bec9", "ms-card-hdr-bot": "#c3ccd6",
      "ms-text-link": "#24405e", "ms-text-heading": "#20344c", "ms-text-cardhdr": "#20344c", "ms-text-railhead": "#20344c",
      "ms-grid-header": "#dde3ea", "ms-grid-header-rule": "#a9b6c4", "ms-row-alt": "#f6f8fa", "ms-group-header": "#e4e9ef",
      "ms-content-bg": "#f2f4f7", "ms-dialog-bg": "#f4f6f9", "ms-dialog-field-border": "#8d9bab",
      "ms-button-default": "#4f5f78",
      "sky-tint": "#e6ebf1",
    },
  },
  {
    id: "plum",
    label: "Plum",
    blurb: "Purples, with the same light rail and white registers.",
    tokens: {
      "ms-toolbar-top": "#c69ad0", "ms-toolbar-bot": "#b98bc4",
      "ms-tabstrip-top": "#8f5aa0", "ms-tabstrip-bot": "#7d4a8e",
      "ms-tab-inactive-top": "#9a7ea4", "ms-tab-inactive-bot": "#8a6e94",
      "ms-tab-active-top": "#85539a", "ms-tab-active-bot": "#5c3470",
      "ms-subnav": "#5c3470",
      "ms-rail-left": "#ecdcf2", "ms-rail-right": "#f5ecf9", "ms-rail-divider": "#b995c4",
      "ms-card-border": "#c6a6d1", "ms-card-body": "#f3e9f7", "ms-card-hdr-top": "#c3a3ce", "ms-card-hdr-bot": "#d0b6da",
      "ms-text-link": "#5a1f75", "ms-text-heading": "#4a1a62", "ms-text-cardhdr": "#4a1a62", "ms-text-railhead": "#4a1a62",
      "ms-grid-header": "#e9dcee", "ms-grid-header-rule": "#c0a0cc", "ms-row-alt": "#faf6fc", "ms-group-header": "#efe4f3",
      "ms-content-bg": "#f7f1fa", "ms-dialog-bg": "#f9f3fb", "ms-dialog-field-border": "#a582b3",
      "ms-button-default": "#6f4283",
      "sky-tint": "#f1e4f6",
    },
  },
  {
    id: "evening",
    label: "Evening",
    blurb: "Dark chrome and dark registers for a dim room. Money never had one; this one does.",
    dark: true,
    tokens: {
      "ms-toolbar-top": "#3a4a60", "ms-toolbar-bot": "#2f3d52",
      "ms-tabstrip-top": "#26344a", "ms-tabstrip-bot": "#1f2b3d",
      "ms-tab-inactive-top": "#3b475a", "ms-tab-inactive-bot": "#323d4e",
      "ms-tab-active-top": "#34486a", "ms-tab-active-bot": "#1b2a45",
      "ms-subnav": "#1b2a45", "ms-subnav-selected": "#ffcf5c",
      "ms-rail-left": "#1f2a3a", "ms-rail-right": "#243141", "ms-rail-divider": "#40536d",
      "ms-page-bg": "#141b26", "ms-content-bg": "#121923",
      "ms-card-border": "#3e5270", "ms-card-body": "#1c2635", "ms-card-hdr-top": "#2b3d57", "ms-card-hdr-bot": "#324763",
      "ms-text": "#e6ecf5", "ms-text-link": "#8fb8ff", "ms-text-heading": "#b9d0ff", "ms-text-cardhdr": "#c7d8ff", "ms-text-railhead": "#a9c4ff", "ms-text-muted": "#9aa9bd",
      "ms-grid-header": "#263447", "ms-grid-header-rule": "#4a6280",
      "ms-row": "#161e2a", "ms-row-alt": "#1b2532", "ms-grid-line": "#2f3d50", "ms-row-active": "#4a3d1a",
      "ms-group-header": "#223046", "ms-group-header-rule": "#3b4c63",
      "ms-field-bg": "#0f1620", "ms-field-border-top": "#4a5a70", "ms-field-border-in": "#3a4a60", "ms-field-border-bot": "#26313f",
      "ms-button-face": "#2b3646", "ms-button-disabled": "#232c39", "ms-button-default": "#5b7fbf",
      "ms-dialog-bg": "#1c2635", "ms-dialog-title": "#151d28", "ms-dialog-rule": "#33435a", "ms-dialog-field-border": "#56708f",
      "chart-axis": "#a0adbf", "chart-grid": "#33404f",
      "positive": "#5fd08a", "negative": "#ff6b6b",
      "sky-tint": "#b9c7dc",
      "icon-knockout": "#e6ecf5",
      "ms-warn-bg": "#3d3416", "ms-warn-border": "#8a7430",
      "ms-error-bg": "#3a1d1b", "ms-error-border": "#8a3c36", "ms-error-text": "#ff9e97",
    },
  },
  {
    id: "copper",
    label: "Copper",
    blurb: "Warm terracotta and cream — an autumn take on the same layout.",
    tokens: {
      "ms-toolbar-top": "#d9a27a", "ms-toolbar-bot": "#cf9268",
      "ms-tabstrip-top": "#b8663a", "ms-tabstrip-bot": "#a55a30",
      "ms-tab-inactive-top": "#b08a75", "ms-tab-inactive-bot": "#a07a66",
      "ms-tab-active-top": "#ad6038", "ms-tab-active-bot": "#7d3f1f",
      "ms-subnav": "#7d3f1f", "ms-subnav-selected": "#ffe08a",
      "ms-rail-left": "#f6e3d3", "ms-rail-right": "#fbf0e6", "ms-rail-divider": "#cfa588",
      "ms-card-border": "#d4a98c", "ms-card-body": "#f9eee4", "ms-card-hdr-top": "#d9ad90", "ms-card-hdr-bot": "#e4bfa5",
      "ms-text-link": "#7a3a17", "ms-text-heading": "#6b3012", "ms-text-cardhdr": "#6b3012", "ms-text-railhead": "#6b3012",
      "ms-grid-header": "#f0dfd0", "ms-grid-header-rule": "#cfa588", "ms-row-alt": "#fcf7f2", "ms-group-header": "#f4e6da",
      "ms-content-bg": "#faf3ec", "ms-dialog-bg": "#fbf4ee", "ms-dialog-field-border": "#b98b6c",
      "ms-button-default": "#9a5231",
      "sky-tint": "#f7e4d4",
    },
  },
  {
    id: "ocean",
    label: "Ocean",
    blurb: "Teal and sea-glass, a cooler cousin of the Money blue.",
    tokens: {
      "ms-toolbar-top": "#7fc8c9", "ms-toolbar-bot": "#6cbbbd",
      "ms-tabstrip-top": "#2f8f94", "ms-tabstrip-bot": "#277d82",
      "ms-tab-inactive-top": "#6f9a9c", "ms-tab-inactive-bot": "#5f8a8c",
      "ms-tab-active-top": "#3a8a8f", "ms-tab-active-bot": "#1f5f63",
      "ms-subnav": "#1f5f63",
      "ms-rail-left": "#d3eeee", "ms-rail-right": "#e7f7f7", "ms-rail-divider": "#8bbfc1",
      "ms-card-border": "#9acccd", "ms-card-body": "#e4f5f5", "ms-card-hdr-top": "#9dcdce", "ms-card-hdr-bot": "#b0dcdd",
      "ms-text-link": "#0f5a5e", "ms-text-heading": "#0d4f53", "ms-text-cardhdr": "#0d4f53", "ms-text-railhead": "#0d4f53",
      "ms-grid-header": "#d4ecec", "ms-grid-header-rule": "#8fc6c8", "ms-row-alt": "#f4fafa", "ms-group-header": "#dcf0f0",
      "ms-content-bg": "#eef8f8", "ms-dialog-bg": "#f0fafa", "ms-dialog-field-border": "#6fa9ab",
      "ms-button-default": "#2c7276",
      "sky-tint": "#d7f0f0",
    },
  },
  {
    // §99 — a dark mode asked for as better than, and in addition to, Evening.
    // Evening is a gray-blue dusk and stays. This one goes properly dark and
    // buys back the contrast Evening spends on softness: near-black grounds,
    // brighter ink, and a grid line you can actually see, which is what a
    // register full of numbers needs at 11pm.
    id: "midnight",
    label: "Midnight",
    blurb: "Properly dark. Near-black grounds, brighter text and a grid you can still read.",
    dark: true,
    tokens: {
      "ms-toolbar-top": "#16202e", "ms-toolbar-bot": "#101823",
      "ms-tabstrip-top": "#0e151f", "ms-tabstrip-bot": "#0a1017",
      "ms-tab-inactive-top": "#1c2735", "ms-tab-inactive-bot": "#161f2b",
      "ms-tab-active-top": "#24425f", "ms-tab-active-bot": "#12283d",
      "ms-subnav": "#12283d", "ms-subnav-selected": "#ffd166",
      "ms-rail-left": "#0d131c", "ms-rail-right": "#111925", "ms-rail-divider": "#2b3a4d",
      "ms-page-bg": "#070b11", "ms-content-bg": "#070b11",
      "ms-card-border": "#2b3a4d", "ms-card-body": "#0f1620", "ms-card-hdr-top": "#182535", "ms-card-hdr-bot": "#1e2d40",
      "ms-text": "#f1f5fa", "ms-text-link": "#7db4ff", "ms-text-heading": "#cfe0ff",
      "ms-text-cardhdr": "#dbe8ff", "ms-text-railhead": "#a8c6ff", "ms-text-muted": "#9fb0c5",
      "ms-grid-header": "#182430", "ms-grid-header-rule": "#3d5570",
      "ms-row": "#0b1119", "ms-row-alt": "#101823", "ms-grid-line": "#26333f", "ms-row-active": "#4a3c12",
      "ms-group-header": "#16202c", "ms-group-header-rule": "#33465c",
      "ms-field-bg": "#080d13", "ms-field-border-top": "#43566d", "ms-field-border-in": "#33455a", "ms-field-border-bot": "#1d2836",
      "ms-button-face": "#1a2432", "ms-button-disabled": "#141c27", "ms-button-default": "#3f7bd0",
      "ms-dialog-bg": "#0f1620", "ms-dialog-title": "#0a1017", "ms-dialog-rule": "#2b3a4d", "ms-dialog-field-border": "#4b6a8c",
      "chart-axis": "#93a6bd", "chart-grid": "#26333f",
      "positive": "#4fd08a", "negative": "#ff7a7a",
      "sky-tint": "#c3d3e8",
      "icon-knockout": "#f1f5fa",
      "ms-warn-bg": "#3a3211", "ms-warn-border": "#8f7a28",
      "ms-error-bg": "#331615", "ms-error-border": "#83332f", "ms-error-text": "#ffa8a1",
    },
  },
  {
    // §99 — high contrast. Not a style: an accessibility mode. Pure black on
    // pure white, every rule at full strength, no gradients and no tints that
    // could drop a pair below 7:1. Red and green are darkened until they pass
    // as text, because a negative balance that is only distinguishable by hue
    // is not distinguishable at all.
    id: "contrast",
    label: "High contrast",
    blurb: "Black on white, full-strength rules, no tints. Every pairing clears WCAG AAA.",
    tokens: {
      "ms-toolbar-top": "#000000", "ms-toolbar-bot": "#000000",
      "ms-tabstrip-top": "#000000", "ms-tabstrip-bot": "#000000",
      "ms-tab-inactive-top": "#3a3a3a", "ms-tab-inactive-bot": "#3a3a3a",
      "ms-tab-active-top": "#ffffff", "ms-tab-active-bot": "#ffffff",
      // The active tab is white here, so the chrome's selection cannot be —
      // menu hover would be white on white (§102).
      "ms-chrome-sel": "#000000", "ms-chrome-sel-text": "#ffffff",
      "ms-tab-text": "#ffffff", "ms-tab-active-text": "#000000",
      "ms-subnav": "#000000", "ms-subnav-selected": "#ffe000",
      "ms-rail-left": "#ffffff", "ms-rail-right": "#ffffff", "ms-rail-divider": "#000000",
      "ms-page-bg": "#ffffff", "ms-content-bg": "#ffffff",
      "ms-card-border": "#000000", "ms-card-body": "#ffffff", "ms-card-hdr-top": "#000000", "ms-card-hdr-bot": "#000000",
      "ms-text": "#000000", "ms-text-link": "#0000cc", "ms-text-heading": "#000000",
      "ms-text-cardhdr": "#ffffff", "ms-text-railhead": "#000000", "ms-text-muted": "#3a3a3a",
      "ms-grid-header": "#ffffff", "ms-grid-header-rule": "#000000",
      "ms-row": "#ffffff", "ms-row-alt": "#ffffff", "ms-grid-line": "#000000", "ms-row-active": "#ffe000",
      "ms-group-header": "#ffffff", "ms-group-header-rule": "#000000",
      "ms-field-bg": "#ffffff", "ms-field-border-top": "#000000", "ms-field-border-in": "#000000", "ms-field-border-bot": "#000000",
      "ms-button-face": "#ffffff", "ms-button-disabled": "#e0e0e0", "ms-button-default": "#000000",
      "ms-dialog-bg": "#ffffff", "ms-dialog-title": "#000000", "ms-dialog-rule": "#000000", "ms-dialog-field-border": "#000000",
      "chart-axis": "#000000", "chart-grid": "#767676",
      "positive": "#005c1f", "negative": "#a80000",
      "sky-tint": "#ffffff",
      "icon-knockout": "#ffffff",
      "ms-warn-bg": "#ffe000", "ms-warn-border": "#000000",
    },
  },
  {
    // §99 — a calm neutral. Every other theme has a hue; this one has none,
    // which turns out to be the one people reach for when they are working
    // rather than admiring.
    id: "graphite",
    label: "Graphite",
    blurb: "Warm neutral gray with no hue at all. The quiet one.",
    tokens: {
      "ms-toolbar-top": "#8d8a85", "ms-toolbar-bot": "#7e7b76",
      "ms-tabstrip-top": "#5f5c58", "ms-tabstrip-bot": "#545150",
      "ms-tab-inactive-top": "#8a8783", "ms-tab-inactive-bot": "#7a7773",
      "ms-tab-active-top": "#6e6b67", "ms-tab-active-bot": "#484643",
      "ms-subnav": "#484643", "ms-subnav-selected": "#e8c37a",
      "ms-rail-left": "#e6e4e0", "ms-rail-right": "#f2f1ee", "ms-rail-divider": "#b8b5b0",
      "ms-page-bg": "#faf9f7", "ms-content-bg": "#f2f1ee",
      "ms-card-border": "#c3c0bb", "ms-card-body": "#f7f6f4", "ms-card-hdr-top": "#c9c6c1", "ms-card-hdr-bot": "#d5d2cd",
      "ms-text": "#22201e", "ms-text-link": "#4a4642", "ms-text-heading": "#33302d",
      "ms-text-cardhdr": "#33302d", "ms-text-railhead": "#33302d", "ms-text-muted": "#6d6a66",
      "ms-grid-header": "#e4e2de", "ms-grid-header-rule": "#b3b0ab",
      "ms-row-alt": "#f7f6f4", "ms-grid-line": "#cbc8c3", "ms-row-active": "#f1e4c4",
      "ms-group-header": "#e9e7e3", "ms-group-header-rule": "#c3c0bb",
      "ms-dialog-bg": "#f7f6f4", "ms-dialog-field-border": "#8f8c87",
      "ms-button-default": "#5f5c58",
      "positive": "#2f6b45", "negative": "#a33a2f",
      "sky-tint": "#ddd9d3",
    },
  },
  {
    // §102 — warm light. Money's blue is cool and a little clinical; this is
    // the same layout on paper-warm ground, which is what most people
    // actually want to look at for an afternoon.
    id: "sandstone",
    label: "Sandstone",
    blurb: "Warm sand and a rust accent. Money's shape, on paper rather than glass.",
    tokens: {
      "ms-toolbar-top": "#d3a976", "ms-toolbar-bot": "#c39a68",
      "ms-tabstrip-top": "#a97b4b", "ms-tabstrip-bot": "#95693e",
      "ms-tab-inactive-top": "#c09566", "ms-tab-inactive-bot": "#ac8354",
      "ms-tab-active-top": "#8a5f36", "ms-tab-active-bot": "#6d4826",
      "ms-subnav": "#6d4826", "ms-subnav-selected": "#ffd98a",
      "ms-rail-left": "#f3e6d4", "ms-rail-right": "#faf3e8", "ms-rail-divider": "#cbb193",
      "ms-page-bg": "#fdf9f3", "ms-content-bg": "#f7efe3",
      "ms-card-border": "#d5bb9b", "ms-card-body": "#fdf8f1", "ms-card-hdr-top": "#e0c8a9", "ms-card-hdr-bot": "#ebd8c0",
      "ms-text": "#2a211a", "ms-text-link": "#8a4b1c", "ms-text-heading": "#5c3a1c",
      "ms-text-cardhdr": "#5c3a1c", "ms-text-railhead": "#5c3a1c", "ms-text-muted": "#7a6552",
      "ms-grid-header": "#f0e2ce", "ms-grid-header-rule": "#c8ac89",
      "ms-row-alt": "#fbf5eb", "ms-grid-line": "#ddcbb2", "ms-row-active": "#ffe9b8",
      "ms-group-header": "#f2e6d5", "ms-group-header-rule": "#d5bb9b",
      "ms-dialog-bg": "#fdf8f1", "ms-dialog-field-border": "#b39871",
      "ms-button-default": "#8a5f36",
      "positive": "#2f6b45", "negative": "#b23a25",
      "sky-tint": "#f6e5cd",
    },
  },
  {
    // A cool light that is not blue. Reads as clean rather than corporate,
    // and the green is desaturated enough that the positive/negative colors
    // still stand out against it.
    id: "mint",
    label: "Mint",
    blurb: "Pale green-gray and a deep teal. Cool and clean without going blue.",
    tokens: {
      "ms-toolbar-top": "#8fc9bb", "ms-toolbar-bot": "#7bbcac",
      "ms-tabstrip-top": "#4e9384", "ms-tabstrip-bot": "#3f8073",
      "ms-tab-inactive-top": "#77b2a4", "ms-tab-inactive-bot": "#639d8f",
      "ms-tab-active-top": "#356e62", "ms-tab-active-bot": "#22514a",
      "ms-subnav": "#22514a", "ms-subnav-selected": "#ffe08a",
      "ms-rail-left": "#dcefe8", "ms-rail-right": "#f0f8f5", "ms-rail-divider": "#a3ccc0",
      "ms-page-bg": "#f7fcfa", "ms-content-bg": "#eaf5f1",
      "ms-card-border": "#a9cfc4", "ms-card-body": "#f6fcfa", "ms-card-hdr-top": "#bcdcd2", "ms-card-hdr-bot": "#cfe8e0",
      "ms-text": "#17251f", "ms-text-link": "#0f5f52", "ms-text-heading": "#1c4a41",
      "ms-text-cardhdr": "#1c4a41", "ms-text-railhead": "#1c4a41", "ms-text-muted": "#587068",
      "ms-grid-header": "#e0f0eb", "ms-grid-header-rule": "#9cc7bb",
      "ms-row-alt": "#f4fbf8", "ms-grid-line": "#c4ded6", "ms-row-active": "#ffeeb8",
      "ms-group-header": "#e6f3ef", "ms-group-header-rule": "#a9cfc4",
      "ms-dialog-bg": "#f6fcfa", "ms-dialog-field-border": "#84b6a8",
      "ms-button-default": "#356e62",
      "positive": "#0f6b3c", "negative": "#b3261e",
      "sky-tint": "#dff0ea",
    },
  },
  {
    // The third dark, and the warm one. Evening is dusk-blue and Midnight is
    // properly black; this sits between them on charcoal with amber, which is
    // the pairing that stays comfortable under a lamp at night.
    id: "ember",
    label: "Ember",
    blurb: "Warm charcoal and amber. A dark room's theme — softer than Midnight, darker than Evening.",
    dark: true,
    tokens: {
      "ms-toolbar-top": "#3a322c", "ms-toolbar-bot": "#2e2823",
      "ms-tabstrip-top": "#2a241f", "ms-tabstrip-bot": "#221d19",
      "ms-tab-inactive-top": "#3a322c", "ms-tab-inactive-bot": "#2e2823",
      "ms-tab-active-top": "#5a4a38", "ms-tab-active-bot": "#463829",
      "ms-subnav": "#463829", "ms-subnav-selected": "#ffb34d",
      "ms-rail-left": "#241f1b", "ms-rail-right": "#2b2521", "ms-rail-divider": "#463d35",
      "ms-page-bg": "#1b1714", "ms-content-bg": "#211c19",
      "ms-card-border": "#463d35", "ms-card-body": "#262019", "ms-card-hdr-top": "#332b24", "ms-card-hdr-bot": "#2a231d",
      "ms-text": "#efe6da", "ms-text-link": "#ffb34d", "ms-text-heading": "#f5c98a",
      "ms-text-cardhdr": "#f5c98a", "ms-text-railhead": "#f5c98a", "ms-text-muted": "#a2958a",
      "ms-grid-header": "#2b2521", "ms-grid-header-rule": "#4d4239",
      "ms-row": "#211c19", "ms-row-alt": "#262019", "ms-grid-line": "#3a322c", "ms-row-active": "#4a3a20",
      "ms-group-header": "#2b2521", "ms-group-header-rule": "#463d35",
      "ms-field-bg": "#171310", "ms-field-border-top": "#4d4239", "ms-field-border-in": "#4d4239", "ms-field-border-bot": "#4d4239",
      "ms-button-face": "#332b24", "ms-button-disabled": "#2a231d", "ms-button-default": "#8a6a3a",
      "ms-dialog-bg": "#211c19", "ms-dialog-title": "#f5c98a", "ms-dialog-rule": "#463d35", "ms-dialog-field-border": "#4d4239",
      "chart-axis": "#a2958a", "chart-grid": "#3a322c",
      "positive": "#78c48a", "negative": "#f0766a",
      "sky-tint": "#c8b8a4",
      "icon-knockout": "#efe6da",
      "ms-warn-bg": "#4a3a20", "ms-warn-border": "#8a6a3a",
      "ms-error-bg": "#42231c", "ms-error-border": "#8f4034", "ms-error-text": "#ffa593",
    },
  },
  {
    // Paper, and the natural partner for the Ledger look. Lower contrast than
    // white on purpose — the point is a page you can read for an hour, not a
    // page that wins a contrast test by being a lightbulb.
    id: "sepia",
    label: "Sepia",
    blurb: "Aged paper and brown ink. Low glare, for long sessions in daylight.",
    tokens: {
      "ms-toolbar-top": "#c9b394", "ms-toolbar-bot": "#bda684",
      "ms-tabstrip-top": "#8f7a5c", "ms-tabstrip-bot": "#7d6a4e",
      "ms-tab-inactive-top": "#b09877", "ms-tab-inactive-bot": "#9c8464",
      "ms-tab-active-top": "#6e5c42", "ms-tab-active-bot": "#544631",
      "ms-subnav": "#544631", "ms-subnav-selected": "#e8cd8e",
      "ms-rail-left": "#eee3cf", "ms-rail-right": "#f6eeda", "ms-rail-divider": "#c2b294",
      "ms-page-bg": "#f8f1e0", "ms-content-bg": "#f2e9d5",
      "ms-card-border": "#cbba9a", "ms-card-body": "#f9f3e4", "ms-card-hdr-top": "#ddccae", "ms-card-hdr-bot": "#e7d9bf",
      "ms-text": "#332a1d", "ms-text-link": "#6b4a1f", "ms-text-heading": "#4a3b26",
      "ms-text-cardhdr": "#4a3b26", "ms-text-railhead": "#4a3b26", "ms-text-muted": "#7a6a52",
      "ms-grid-header": "#ece0c8", "ms-grid-header-rule": "#c2b294",
      "ms-row": "#f9f3e4", "ms-row-alt": "#f4ecd9", "ms-grid-line": "#d8c9ab", "ms-row-active": "#f0dfa8",
      "ms-group-header": "#eee3cf", "ms-group-header-rule": "#cbba9a",
      "ms-dialog-bg": "#f9f3e4", "ms-dialog-field-border": "#ab9974",
      "ms-button-default": "#6e5c42",
      "positive": "#3c6b3f", "negative": "#9e3a26",
      "sky-tint": "#efe2c8",
    },
  },
];

/** Every token any theme touches — cleared before a theme is applied so
 *  switching back to Money leaves nothing behind. */
const ALL_KEYS: string[] = Array.from(new Set(THEMES.flatMap((t) => Object.keys(t.tokens))));

export function readTheme(): string {
  try {
    const id = window.localStorage.getItem(KEY);
    return THEMES.some((t) => t.id === id) ? (id as string) : "money";
  } catch {
    return "money";
  }
}

export function saveTheme(id: string): void {
  try {
    window.localStorage.setItem(KEY, id);
  } catch {
    /* not remembered, still applied */
  }
}

const LIGHT_KEY = "tm.lightTheme";

/** §87: the header's sun/moon. Dark → the light theme last used (Money
 *  Plus if none); light → Evening, remembering which light one to come
 *  back to. Returns the id now applied. */
export function toggleDark(): string {
  const current = THEMES.find((t) => t.id === readTheme()) ?? THEMES[0];
  let next: string;
  if (current.dark) {
    let light = "money";
    try {
      const l = window.localStorage.getItem(LIGHT_KEY);
      if (THEMES.some((t) => t.id === l && !t.dark)) light = l as string;
    } catch {
      /* default */
    }
    next = light;
  } else {
    try {
      window.localStorage.setItem(LIGHT_KEY, current.id);
    } catch {
      /* not remembered */
    }
    next = THEMES.find((t) => t.dark)?.id ?? "money";
  }
  applyTheme(next);
  saveTheme(next);
  return next;
}

export function isDark(id: string): boolean {
  return THEMES.find((t) => t.id === id)?.dark === true;
}

/** Apply a theme to the document (or any element, for a preview). */
export function applyTheme(id: string, el: HTMLElement = document.documentElement): void {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0];
  for (const k of ALL_KEYS) el.style.removeProperty(`--tm-${k}`);
  for (const [k, v] of Object.entries(theme.tokens)) el.style.setProperty(`--tm-${k}`, v);
  if (theme.dark) el.setAttribute("data-theme", "dark");
  else el.removeAttribute("data-theme");
  if (el === document.documentElement) el.style.colorScheme = theme.dark ? "dark" : "light";
}

/** Money's values for the tokens the Settings preview draws with (copied
 *  from tm-tokens.css so a preview never depends on the live page). */
export const PREVIEW_DEFAULTS: Record<string, string> = {
  "ms-toolbar-top": "#80b4e6", "ms-tabstrip-top": "#4a8fd2", "ms-tab-active-bot": "#315599", "ms-tab-inactive-top": "#6c86b2",
  "ms-subnav": "#315599", "ms-subnav-selected": "#ffdd80",
  "ms-rail-left": "#cbe4fc", "ms-rail-divider": "#8caad0", "ms-content-bg": "#eef4fb",
  "ms-card-border": "#9cbde9", "ms-card-body": "#e3f1fe", "ms-card-hdr-top": "#99bae7",
  "ms-text": "#1a1a1a", "ms-text-link": "#0a2ea0", "ms-text-cardhdr": "#102f8b",
  "ms-grid-header": "#cfddf0", "ms-grid-header-rule": "#94b8e6", "ms-row": "#ffffff", "ms-row-alt": "#f6fafd", "ms-grid-line": "#cbcbcb", "ms-row-active": "#fff0c2",
  "series-1": "#a2497a", "series-2": "#6b8a5a", "series-4": "#4e9c96", "series-7": "#ef9d4a",
  "negative": "#d52b2b",
  // §142 — the error box, so a theme that does not override it is still
  // measured against Money's own values rather than against "#000".
  "ms-error-bg": "#fdecea", "ms-error-border": "#e6b0aa", "ms-error-text": "#c0392b",
};

/** The value a theme gives a token, or Money's. */
export function themeToken(theme: Theme, key: string): string {
  return theme.tokens[key] ?? PREVIEW_DEFAULTS[key] ?? "#000";
}
