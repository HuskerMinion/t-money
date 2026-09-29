/** @type {import('tailwindcss').Config} */
// Color values here are POINTERS into src/branding/tm-tokens.css, which is the
// single source of truth (measured from Money screenshots). Do not put
// literal hex in this file.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        aero: {
          border: "var(--tm-ms-card-border)",
          headerTop: "var(--tm-ms-toolbar-top)",
          headerMid: "var(--tm-ms-tabstrip-top)",
          headerBot: "var(--tm-ms-tabstrip-bot)",
          subnav: "var(--tm-ms-subnav)",
          subnavSelected: "var(--tm-ms-subnav-selected)",
          // The rail is LIGHT in Money — these are no longer dark slate.
          railLeft: "var(--tm-ms-rail-left)",
          railRight: "var(--tm-ms-rail-right)",
          railDivider: "var(--tm-ms-rail-divider)",
          cardBody: "var(--tm-ms-card-body)",
          titleTop: "var(--tm-ms-card-hdr-top)",
          titleBot: "var(--tm-ms-card-hdr-bot)",
          link: "var(--tm-ms-text-link)",
          heading: "var(--tm-ms-text-heading)",
          negative: "var(--tm-negative)",
          positive: "var(--tm-positive)",
        },
      },
      fontFamily: {
        tahoma: ["Tahoma", "Segoe UI", "Verdana", "sans-serif"],
      },
      boxShadow: {
        aero: "0 1px 2px rgba(20, 50, 90, 0.25)",
        "aero-inset": "inset 0 1px 0 rgba(255,255,255,0.7)",
      },
    },
  },
  plugins: [],
};
