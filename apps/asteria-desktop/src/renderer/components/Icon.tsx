import type { JSX } from "react";

export type IconName =
  | "alert"
  | "book"
  | "bolt"
  | "chart"
  | "check"
  | "compass"
  | "folder"
  | "loader"
  | "moon"
  | "package"
  | "search"
  | "settings"
  | "stack"
  | "sun";

interface IconProps {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  title?: string;
  className?: string;
}

const iconPaths: Record<IconName, JSX.Element> = {
  alert: (
    <>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
  book: (
    <>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5Z" />
      <path d="M4 5.5V21" />
      <path d="M20 3v16" />
    </>
  ),
  bolt: <path d="M13 2 3 14h7l-1 8 10-12h-7Z" />,
  chart: (
    <>
      <path d="M4 20V6" />
      <path d="M10 20V10" />
      <path d="M16 20V4" />
      <path d="M2 20h20" />
    </>
  ),
  check: <path d="M5 13l4 4L19 7" />,
  compass: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m14.5 9.5-3 7 7-3-4-4Z" />
    </>
  ),
  folder: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M3 9h20" />
    </>
  ),
  loader: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />,
  package: (
    <>
      <path d="m12 2 9 5-9 5-9-5 9-5Z" />
      <path d="M3 7v10l9 5 9-5V7" />
      <path d="M12 12v10" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  settings: (
    <>
      <path d="M4 6h10" />
      <path d="M4 12h16" />
      <path d="M4 18h8" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="10" cy="18" r="2" />
    </>
  ),
  stack: (
    <>
      <path d="m12 2 9 5-9 5-9-5 9-5Z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 17 9 5 9-5" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.9 4.9 1.4 1.4" />
      <path d="m17.7 17.7 1.4 1.4" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m4.9 19.1 1.4-1.4" />
      <path d="m17.7 6.3 1.4-1.4" />
    </>
  ),
};

export function Icon({
  name,
  size = 20,
  strokeWidth = 1.8,
  title,
  className,
}: Readonly<IconProps>): JSX.Element {
  const ariaHidden = title ? undefined : true;
  return (
    <svg
      role={title ? "img" : "presentation"}
      aria-hidden={ariaHidden}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {title ? <title>{title}</title> : null}
      {iconPaths[name]}
    </svg>
  );
}
