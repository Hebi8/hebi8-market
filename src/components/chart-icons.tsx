/** Inline 18px stroke icons for the chart toolbars, drawn after TradingView's glyphs. */
import type { ReactNode, SVGProps } from "react";
import type { LineDash } from "./drawing-style";

function Svg({ children, size = 18, ...rest }: SVGProps<SVGSVGElement> & { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  );
}

type IconProps = { size?: number; className?: string };

export const IconCursor = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 2.5v13M2.5 9h13" />
  </Svg>
);

export const IconTrendLine = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.6 13.4 13.4 4.6" />
    <circle cx="3.5" cy="14.5" r="1.5" />
    <circle cx="14.5" cy="3.5" r="1.5" />
  </Svg>
);

export const IconRay = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.1 12.9 16 2" />
    <circle cx="4" cy="14" r="1.5" />
  </Svg>
);

export const IconExtendedLine = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.5 16.5 16.5 1.5" />
    <circle cx="6.5" cy="11.5" r="1.4" />
    <circle cx="11.5" cy="6.5" r="1.4" />
  </Svg>
);

export const IconHorizontalLine = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.5 9h5.5M11 9h5.5" />
    <circle cx="9" cy="9" r="1.6" />
  </Svg>
);

export const IconHorizontalRay = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.6 9h9.9" />
    <circle cx="5" cy="9" r="1.6" />
  </Svg>
);

export const IconVerticalLine = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 1.5V7M9 11v5.5" />
    <circle cx="9" cy="9" r="1.6" />
  </Svg>
);

export const IconFib = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 3.5h14M2 7.2h14M2 10.8h14M2 14.5h14" />
    <circle cx="4" cy="14.5" r="1.3" fill="currentColor" />
    <circle cx="14" cy="3.5" r="1.3" fill="currentColor" />
  </Svg>
);

export const IconText = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 4V2.8h11V4M9 2.8v12.4M6.8 15.2h4.4" />
  </Svg>
);

export const IconRuler = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11.5 2.5 15.5 6.5 6.5 15.5 2.5 11.5z" />
    <path d="M5 9l1.5 1.5M7 7l2 2M9 5l1.5 1.5" />
  </Svg>
);

export const IconMagnet = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 3v6a5 5 0 0 0 10 0V3h-3v6a2 2 0 0 1-4 0V3z" />
    <path d="M4 5.5h3M11 5.5h3" />
  </Svg>
);

export const IconLock = ({ open, ...p }: IconProps & { open?: boolean }) => (
  <Svg {...p}>
    <rect x="3.5" y="8" width="11" height="8" rx="1.5" />
    <path d={open ? "M6 8V5.5a3 3 0 0 1 5.8-1" : "M6 8V5.5a3 3 0 0 1 6 0V8"} />
  </Svg>
);

export const IconEye = ({ off, ...p }: IconProps & { off?: boolean }) => (
  <Svg {...p}>
    <path d="M1.5 9S4.2 4 9 4s7.5 5 7.5 5-2.7 5-7.5 5-7.5-5-7.5-5z" />
    <circle cx="9" cy="9" r="2.2" />
    {off && <path d="M2.5 15.5 15.5 2.5" />}
  </Svg>
);

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 4.5h13M7 4.5V2.8h4v1.7M4.2 4.5l.8 11h8l.8-11M7.3 7.5v5.5M10.7 7.5v5.5" />
  </Svg>
);

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7.8" cy="7.8" r="5" />
    <path d="m11.5 11.5 4.5 4.5" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="9" r="7" />
    <path d="M9 5.5v7M5.5 9h7" />
  </Svg>
);

export const IconCandles = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.5 2v3M5.5 13v3M12.5 1.5v3.5M12.5 11v3.5" />
    <rect x="3.5" y="5" width="4" height="8" rx=".5" fill="currentColor" />
    <rect x="10.5" y="5" width="4" height="6" rx=".5" />
  </Svg>
);

export const IconHollowCandles = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.5 2v3M5.5 13v3M12.5 1.5v3.5M12.5 11v3.5" />
    <rect x="3.5" y="5" width="4" height="8" rx=".5" />
    <rect x="10.5" y="5" width="4" height="6" rx=".5" fill="currentColor" />
  </Svg>
);

export const IconBars = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.5 2.5v12M3 6h2.5M5.5 11.5H8M12.5 3.5v12M10 13h2.5M12.5 6H15" />
  </Svg>
);

export const IconArea = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.5 14 6 8l3.5 3L16.5 3.5" />
    <path d="M1.5 14 6 8l3.5 3 7-7.5V16h-15z" fill="currentColor" fillOpacity=".18" stroke="none" />
  </Svg>
);

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 9a6 6 0 1 1-1.8-4.3" />
    <path d="M15 2.5v3.2h-3.2" />
  </Svg>
);

export const IconFullscreen = ({ exit, ...p }: IconProps & { exit?: boolean }) => (
  <Svg {...p}>
    {exit ? (
      <path d="M6.5 2v4.5H2M11.5 2v4.5H16M6.5 16v-4.5H2M11.5 16v-4.5H16" />
    ) : (
      <path d="M2 6.5V2h4.5M16 6.5V2h-4.5M2 11.5V16h4.5M16 11.5V16h-4.5" />
    )}
  </Svg>
);

export const IconWatchlist = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 4h10M6 9h10M6 14h10" />
    <circle cx="2.8" cy="4" r=".8" fill="currentColor" />
    <circle cx="2.8" cy="9" r=".8" fill="currentColor" />
    <circle cx="2.8" cy="14" r=".8" fill="currentColor" />
  </Svg>
);

export const IconNotes = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 2.5h8l3 3v10h-11z" />
    <path d="M11.5 2.5v3h3M6 9h6M6 12h4" />
  </Svg>
);

export const IconGear = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="9" r="2.3" />
    <path d="M9 1.8v2M9 14.2v2M1.8 9h2M14.2 9h2M3.9 3.9l1.4 1.4M12.7 12.7l1.4 1.4M3.9 14.1l1.4-1.4M12.7 5.3l1.4-1.4" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4.5 4.5 9 9M13.5 4.5l-9 9" />
  </Svg>
);

export const IconMore = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 9h.01M9 9h.01M13.5 9h.01" strokeWidth={2.2} />
  </Svg>
);

export const IconBack = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11 3.5 5.5 9l5.5 5.5" />
  </Svg>
);

export const IconPencil = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12.3 2.7a1.6 1.6 0 0 1 2.3 0l.7.7a1.6 1.6 0 0 1 0 2.3L6 15H3v-3z" />
    <path d="m10.8 4.2 3 3" />
  </Svg>
);

export const IconCaret = (p: IconProps) => (
  <Svg size={10} {...p}>
    <path d="m5 7 4 4 4-4" strokeWidth={1.6} />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="m3.5 9.5 3.5 3.5 7.5-8" />
  </Svg>
);

/** TradingView's 商品详情: a card with a heading and lines */
export const IconDetails = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="3" width="13" height="12" rx="1.5" />
    <path d="M5.5 6.5h3M5.5 9.5h7M5.5 12h5" />
    <circle cx="12" cy="6.5" r=".8" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconHelp = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="9" r="7" />
    <path d="M7 7.2a2 2 0 1 1 2.9 1.8c-.6.3-.9.8-.9 1.4v.4" />
    <circle cx="9" cy="12.9" r=".5" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconExternal = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.5 3.5h4v4M14.5 3.5 8 10M12.5 10.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
  </Svg>
);

/** TradingView's 警报 glyph: an alarm clock. */
/** TradingView's 拍快照 */
export const IconCamera = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 6a1 1 0 0 1 1-1h2.2l1.3-2h4l1.3 2h2.2a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
    <circle cx="9" cy="9.5" r="2.7" />
  </Svg>
);

export const IconAlarm = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="10" r="5.5" />
    <path d="M9 7v3l2 1.5M3 4.5 5 2.8M15 4.5 13 2.8M5.2 14.6 4 16M12.8 14.6 14 16" />
  </Svg>
);

// ---------------------------------------------------------------------------- drawing tools

const Dot = ({ x, y }: { x: number; y: number }) => <circle cx={x} cy={y} r="1.4" />;

export const IconInfoLine = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 14.5 9.5 8.5" />
    <Dot x={3.5} y={14.5} />
    <Dot x={10.5} y={7.5} />
    <rect x="11" y="2" width="5.5" height="4" rx=".8" />
  </Svg>
);

export const IconTrendAngle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 14.5 14 4M3 14.5h13" />
    <path d="M9 14.5a6 6 0 0 0-1.6-4" />
  </Svg>
);

export const IconCrossLine = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 1.5V7M9 11v5.5M1.5 9H7M11 9h5.5" />
    <circle cx="9" cy="9" r="1.6" />
  </Svg>
);

export const IconParallelChannel = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 11.5 11.5 2M6.5 16 16 6.5" />
    <path d="M4 13.8 13.8 4" strokeDasharray="1.5 1.8" />
  </Svg>
);

export const IconRegression = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 10 16 2M2 16 16 8" />
    <path d="M2 13 16 5" strokeDasharray="1.5 1.8" />
  </Svg>
);

export const IconPriceChannel = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 9.5 16 3.5M2 15.5 16 9.5" />
    <Dot x={5} y={8.2} />
    <Dot x={13} y={4.8} />
    <Dot x={9} y={12.5} />
  </Svg>
);

export const IconPitchfork = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 14.5 7.5 9.5M9 4.5l7-2M7.5 9.5l8.5-.5M9.5 13.5l6.5 2M9 4.5l.5 9" />
    <Dot x={2} y={14.5} />
  </Svg>
);

export const IconFibExtension = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 3h9.5M7 7h9.5M7 11h9.5M7 15h9.5" />
    <path d="M1.5 15 4 7l1.8 4" strokeDasharray="1.5 1.5" />
  </Svg>
);

export const IconFibChannel = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.5 9 9 1.5M1.5 13 13 1.5M1.5 16.5 16.5 1.5M5 16.5 16.5 5" />
  </Svg>
);

export const IconFibTimeZone = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 2v14M4.5 2v14M7 2v14M10.5 2v14M16 2v14" />
  </Svg>
);

export const IconFibFan = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 16 16 2M2 16l14-5M2 16l14-8.5M2 16h14" />
  </Svg>
);

export const IconFibCircles = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="9" r="2.5" />
    <circle cx="9" cy="9" r="5" />
    <circle cx="9" cy="9" r="7.5" />
  </Svg>
);

export const IconFibSpiral = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 9.5a1 1 0 0 1 1.6-.8 2 2 0 0 1-.6 3.2 3.4 3.4 0 0 1-4-2.8 5 5 0 0 1 4.2-5.6 6.5 6.5 0 0 1 6.8 5.6" />
  </Svg>
);

export const IconFibArcs = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 15a6 6 0 0 1 12 0M6 15a3 3 0 0 1 6 0" />
    <path d="M1.5 15h15" />
  </Svg>
);

export const IconGannBox = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="2.5" width="14" height="13" />
    <path d="M6.5 2.5v13M11.5 2.5v13M2 7h14M2 11h14" />
  </Svg>
);

export const IconGannFan = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 16 5 2M2 16l7-14M2 16 16 2M2 16 16 9M2 16l14-3" />
  </Svg>
);

export const IconXabcd = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.5 14 5 4l4 7 3.5-5.5 4 9.5" />
    <path d="M1.5 14 9 11" strokeDasharray="1.5 1.5" />
  </Svg>
);

export const IconAbcd = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 14 6.5 4l4 6 5.5-7" />
  </Svg>
);

export const IconTrianglePattern = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.5 3 5 15l4-9 3 6.5 2.5-4" />
    <path d="M1.5 3 16 9.5M5 15l11-6" strokeDasharray="1.5 1.5" />
  </Svg>
);

export const IconHeadShoulders = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1 15 4 8l2.5 4L9 3l2.5 9L14 8l3 7" />
    <path d="M1 12h16" strokeDasharray="1.5 1.5" />
  </Svg>
);

export const IconElliott = (p: IconProps) => (
  <Svg {...p}>
    <path d="m1.5 15 3-6 2.5 3 4-9 2 4 3.5-4" />
  </Svg>
);

export const IconElliottCorrection = (p: IconProps) => (
  <Svg {...p}>
    <path d="m2 4 5 7 3-3.5 6 7" />
  </Svg>
);

export const IconElliottTriangle = (p: IconProps) => (
  <Svg {...p}>
    <path d="m1.5 3 3 12 3-9 2.5 6.5 2-4.5 2 3 2-1.5" />
  </Svg>
);

export const IconElliottCombo = (p: IconProps) => (
  <Svg {...p}>
    <path d="m2 3 4 7 4-4 6 9" />
    <Dot x={6} y={10} />
    <Dot x={10} y={6} />
  </Svg>
);

export const IconLongPosition = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="2.5" width="13" height="7" fill="currentColor" fillOpacity=".15" />
    <rect x="2.5" y="9.5" width="13" height="5" />
    <path d="m6 7 3-3 3 3" />
  </Svg>
);

export const IconShortPosition = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="3.5" width="13" height="5" />
    <rect x="2.5" y="8.5" width="13" height="7" fill="currentColor" fillOpacity=".15" />
    <path d="m6 11 3 3 3-3" />
  </Svg>
);

export const IconPriceRange = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 2.5h12M3 15.5h12M9 15.5V3" />
    <path d="M6.5 5.5 9 3l2.5 2.5" />
  </Svg>
);

export const IconDateRange = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 3v12M15.5 3v12M2.5 9H15" />
    <path d="M12.5 6.5 15 9l-2.5 2.5" />
  </Svg>
);

export const IconDatePriceRange = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="2.5" width="13" height="13" />
    <path d="M9 13V5M5 9h8" />
    <path d="M7.2 6.8 9 5l1.8 1.8M11.2 7.2 13 9l-1.8 1.8" />
  </Svg>
);

export const IconBrush = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 13c2-3 3.5-1 5-3s1-5 4-6 4.5 2.5 2.5 4.5-4 .5-5.5 3-1 4.5-3.5 4.5S2 15 2 13z" />
  </Svg>
);

export const IconRect = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="4" width="13" height="10" />
    <Dot x={2.5} y={4} />
    <Dot x={15.5} y={14} />
  </Svg>
);

export const IconPath = (p: IconProps) => (
  <Svg {...p}>
    <path d="m2 14 4-8 4 5 5.5-7" />
    <path d="m12.8 4 2.7 0 .2 2.7" />
  </Svg>
);

export const IconCircle = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="9" r="6.5" />
    <Dot x={9} y={9} />
  </Svg>
);

export const IconEllipse = (p: IconProps) => (
  <Svg {...p}>
    <ellipse cx="9" cy="9" rx="7.5" ry="4.5" />
  </Svg>
);

export const IconPolyline = (p: IconProps) => (
  <Svg {...p}>
    <path d="m2 13 3.5-8 5 6L16 4" />
    <Dot x={5.5} y={5} />
    <Dot x={10.5} y={11} />
  </Svg>
);

export const IconTriangle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 2.5 16 15H2z" />
  </Svg>
);

export const IconArc = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 14C4 4 14 4 16 14" />
    <path d="M2 14h14" strokeDasharray="1.5 1.5" />
  </Svg>
);

export const IconCurve = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 14C4 2 12 2 16 9" />
    <Dot x={2} y={14} />
    <Dot x={16} y={9} />
  </Svg>
);

export const IconNote = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="2.5" width="13" height="8" rx="1.2" />
    <path d="M9 10.5v5" strokeDasharray="1.5 1.5" />
    <path d="M5.5 5.5h7M5.5 7.8h4" />
  </Svg>
);

export const IconPriceLabel = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 4.5h13v7H11L9 14l-2-2.5H2.5z" />
    <path d="M5.5 8h7" />
  </Svg>
);

export const IconFlag = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 16V2.5" />
    <path d="M4 3h10l-2.5 3.5L14 10H4" />
  </Svg>
);

export const IconArrow = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 15 15 3M8.5 3H15v6.5" />
  </Svg>
);

export const IconArrowUp = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 2.5 14.5 8H11v7.5H7V8H3.5z" />
  </Svg>
);

export const IconArrowDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 15.5 14.5 10H11V2.5H7V10H3.5z" />
  </Svg>
);

/** Width and dash pickers of the floating drawing toolbar. */
export const IconLineWidth = ({ width = 1, ...p }: IconProps & { width?: number }) => (
  <Svg {...p}>
    <path d="M2.5 9h13" strokeWidth={width} />
  </Svg>
);

export const IconLineDash = ({ dash = "solid", ...p }: IconProps & { dash?: LineDash }) => (
  <Svg {...p}>
    <path d="M2.5 9h13" strokeDasharray={dash === "dashed" ? "3.5 2.5" : dash === "dotted" ? "0.5 2.5" : undefined} strokeWidth={1.6} />
  </Svg>
);

type Icon = (p: IconProps) => ReactNode;

/** One icon per drawing tool, by KLineChart overlay name. */
export const DRAW_ICONS: Record<string, Icon> = {
  segment: IconTrendLine,
  rayLine: IconRay,
  infoLine: IconInfoLine,
  straightLine: IconExtendedLine,
  trendAngle: IconTrendAngle,
  horizontalStraightLine: IconHorizontalLine,
  horizontalRayLine: IconHorizontalRay,
  verticalStraightLine: IconVerticalLine,
  crossLine: IconCrossLine,
  parallelChannel: IconParallelChannel,
  regressionTrend: IconRegression,
  priceChannelLine: IconPriceChannel,
  pitchfork: IconPitchfork,
  fibonacciLine: IconFib,
  fibExtension: IconFibExtension,
  fibChannel: IconFibChannel,
  fibTimeZone: IconFibTimeZone,
  fibFan: IconFibFan,
  fibCircles: IconFibCircles,
  fibSpiral: IconFibSpiral,
  fibArcs: IconFibArcs,
  gannBox: IconGannBox,
  gannFan: IconGannFan,
  xabcd: IconXabcd,
  abcd: IconAbcd,
  trianglePattern: IconTrianglePattern,
  headShoulders: IconHeadShoulders,
  elliottImpulse: IconElliott,
  elliottCorrection: IconElliottCorrection,
  elliottTriangle: IconElliottTriangle,
  elliottDoubleCombo: IconElliottCombo,
  longPosition: IconLongPosition,
  shortPosition: IconShortPosition,
  priceRange: IconPriceRange,
  dateRange: IconDateRange,
  datePriceRange: IconDatePriceRange,
  brush: IconBrush,
  rect: IconRect,
  path: IconPath,
  circle: IconCircle,
  ellipse: IconEllipse,
  polyline: IconPolyline,
  triangle: IconTriangle,
  arc: IconArc,
  curve: IconCurve,
  text: IconText,
  simpleAnnotation: IconNote,
  priceLabel: IconPriceLabel,
  flag: IconFlag,
  arrow: IconArrow,
  arrowMarkUp: IconArrowUp,
  arrowMarkDown: IconArrowDown,
};
