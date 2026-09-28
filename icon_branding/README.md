# T-Money — Icon & Branding Kit

Concept 3, classic financial blue & silver. Every icon here is hand-drawn vector on a
24×24 grid — nothing was cropped out of the branding sheet, so all of it stays sharp at
any size and can be recolored without re-exporting.

```
icon_branding/
├─ index.html                 ← open this first: live preview, click an icon to copy its snippet
├─ svg/                       20 icons, one file each (tm-<name>.svg)
├─ sprite/tm-icons-sprite.svg one file containing all 20 as <symbol>s
├─ png/{24,48,96,192,512}/    raster fallbacks at 5 sizes (100 files)
├─ logo/
│   ├─ tm-logo-mark.svg               full detail, 3D beveled disc
│   ├─ tm-logo-mark-compact.svg       simplified, for 16–64 px
│   ├─ tm-logo-mark-transparent.svg   no disc behind it
│   ├─ tm-logo-horizontal.svg         lockup with wordmark
│   └─ png/                           128 / 256 / 512 / 1024 exports
├─ app-icons/
│   ├─ ios/                   AppIcon-20 … AppIcon-1024, opaque, no alpha
│   ├─ android/               ic_launcher mdpi→xxxhdpi, adaptive foreground, Play 512
│   └─ web/                   favicon.ico + 16/32/48, apple-touch-icon, PWA 192/512
│                             + maskable 512 + manifest.webmanifest
└─ tokens/
    ├─ tm-tokens.css          CSS custom properties (palette, type, radius, shadow, dark theme)
    ├─ tm-tokens.json         same values for JS / React Native / Tailwind config
    └─ tm-icons.css           .tm-icon helper classes
```

## The icons

**Core (from the branding sheet)** — accounts, transactions, payments, budgeting,
reports, investments, goals, taxes

**Interface (added)** — home, search, settings, notifications, profile, calendar, add,
filter, export, sync, alerts, logout

## Using them on a web page

The sprite is the best option: one HTTP request, and the icons inherit your theme.

```html
<link rel="stylesheet" href="tokens/tm-tokens.css">
<link rel="stylesheet" href="tokens/tm-icons.css">

<!-- paste the contents of sprite/tm-icons-sprite.svg once, just after <body> -->

<svg class="tm-icon"><use href="#tm-accounts"/></svg>
```

Paste the sprite inline rather than linking to it — an external `<use href="sprite.svg#id">`
is blocked when the page is opened straight off disk with `file://`.

Single files work too:

```html
<img src="svg/tm-accounts.svg" width="24" height="24" alt="">
```

## Recoloring

Every icon reads four CSS variables and falls back to the brand colors when they are absent,
so a single SVG serves light mode, dark mode, and any accent you want:

| variable | default | what it paints |
|---|---|---|
| `--tm-icon-primary` | `#1B4B9C` | the main shape |
| `--tm-icon-secondary` | `#7FB2EE` | the lighter duotone shape |
| `--tm-icon-accent` | `#A9B4C0` | silver details |
| `--tm-icon-knockout` | `#FFFFFF` | shapes cut out of the primary |

```css
.sidebar { --tm-icon-primary: #fff; --tm-icon-secondary: #9CC7F7; }
```

`tm-tokens.css` already flips these for `prefers-color-scheme: dark` and for
`[data-theme="dark"]`, so dark mode needs no extra work.

## Mobile app

- **React Native / Expo** — `react-native-svg` + `SvgXml`, or run `svg/` through
  `react-native-svg-transformer` and import the files as components.
- **Flutter** — `flutter_svg` reads the `svg/` files directly.
- **Native** — use `png/48`, `png/96` and `png/192` as @1x/@2x/@3x, or import the SVGs into
  an Xcode asset catalog / Android vector drawables.
- **Launcher icons** — the iOS set is opaque and square (the App Store rejects an alpha
  channel); Android has both the pre-baked `ic_launcher` sizes and
  `ic_launcher_foreground-432.png` for adaptive icons.

## The mark

`tm-logo-mark.svg` is the full-detail version: beveled disc, slab **T**, rising bars and the
breakout arrow. Below about 64 px that detail turns to mush, so `tm-logo-mark-compact.svg`
carries the same idea with two bars and heavier strokes — the favicons and the small iOS
sizes are generated from it automatically. Use the detailed mark at 64 px and above.

The horizontal lockup uses live text, so Montserrat and Open Sans need to be loaded for it to
render correctly in a browser; `logo/png/tm-logo-horizontal-1200.png` is a safe fallback.

## Type

Montserrat Bold for headings, balances and numerals; Open Sans Regular for body copy.
For any column of currency, turn on tabular figures: `font-feature-settings: 'tnum';`

## Color rules

Blue and silver carry the brand. The green and red in `tm-tokens.json` are semantic only —
gains and losses in data — and should never be used as brand or chrome colors.
