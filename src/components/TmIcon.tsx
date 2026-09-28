// TmIcon — renders a T-Money brand icon from the inlined SVG sprite
// (src/assets/branding/tm-icons-sprite.svg). The sprite is injected once
// into <body>; icons inherit the --tm-icon-* CSS variables, so they can be
// re-tinted per context (e.g. the dark sidebar) without touching the SVG.
import spriteRaw from "../assets/branding/tm-icons-sprite.svg?raw";

const SPRITE_ID = "tm-icon-sprite";

function ensureSprite() {
  if (typeof document === "undefined") return;
  if (document.getElementById(SPRITE_ID)) return;
  const holder = document.createElement("div");
  holder.id = SPRITE_ID;
  holder.setAttribute("aria-hidden", "true");
  holder.innerHTML = spriteRaw;
  document.body.appendChild(holder);
}

interface TmIconProps {
  /** Icon name without the "tm-" prefix, e.g. "accounts", "search". */
  name: string;
  /** Rendered size in px (overrides the .tm-icon 1.5em default). */
  size?: number;
  className?: string;
  title?: string;
}

export default function TmIcon({ name, size = 18, className = "", title }: TmIconProps) {
  ensureSprite();
  return (
    <svg
      className={`tm-icon ${className}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={title ?? name}
    >
      <use href={`#tm-${name}`} />
    </svg>
  );
}
