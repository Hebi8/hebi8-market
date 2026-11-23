"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/** The dotted underline that marks a header with an explanation. */
export const HINT_LABEL = "underline decoration-dotted decoration-muted/60 underline-offset-[3px]";

const WIDTH = 288;

const under = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return { left: Math.max(8, Math.min(r.left, window.innerWidth - WIDTH - 8)), top: r.bottom };
};

/**
 * A table header's explanation: a card under the header while it is hovered or focused. Fixed to
 * the viewport, so it neither scrolls a table container nor gets clipped by one, and shifted left
 * when the header is near the right edge. `hover` goes on an element holding both the trigger and
 * the panel, so the pointer can move onto the card and read it.
 */
export function useHeaderHint(content: ReactNode) {
  const id = useId();
  const anchor = useRef<HTMLElement | null>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const shown = hovered || focused;
  const place = (el: HTMLElement) => {
    anchor.current = el;
    setAt(under(el));
  };

  // the header moves with the page; the card follows it
  useEffect(() => {
    if (!shown) return;
    const onMove = () => {
      if (anchor.current) setAt(under(anchor.current));
    };
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [shown]);

  return {
    dismiss: () => {
      setHovered(false);
      setFocused(false);
    },
    hover: {
      onMouseEnter: (e: { currentTarget: HTMLElement }) => {
        place(e.currentTarget);
        setHovered(true);
      },
      onMouseLeave: () => setHovered(false),
    },
    trigger: {
      "aria-describedby": id,
      onFocus: (e: { currentTarget: HTMLElement }) => {
        place(e.currentTarget);
        setFocused(true);
      },
      onBlur: () => setFocused(false),
    },
    panel: (
      <span
        id={id}
        role="tooltip"
        hidden={!shown}
        style={{ ...at, width: WIDTH }}
        className="pointer-events-none fixed z-30 flex flex-col gap-1.5 rounded-md border border-line bg-card p-3 text-left text-[11px] font-normal whitespace-pre-line text-fg shadow-lg"
      >
        {content}
      </span>
    ),
  };
}
