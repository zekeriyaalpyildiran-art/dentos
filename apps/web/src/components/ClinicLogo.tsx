import Image from "next/image";

// The clinic's logo (from the legacy stock app: wordmark + tooth, 374×200). It has dark lettering, so it always sits on
// its own light rounded panel (bg-brand-panel: white, softened in dark mode), as in the legacy apps, also in the navy
// sidebar.
export const CLINIC_NAME = "Klinik Prime Maltepe";
export const CLINIC_LOGO = { src: "/brand/klinik-prime-logo.svg", width: 374, height: 200 } as const;
/** Square tooth mark (app icons, mobile top bar). */
export const CLINIC_MARK = { src: "/brand/klinik-prime-mark.svg", width: 200, height: 200 } as const;

/** `className` sets the width (max-w-…); `compact` is the tighter padding of the sidebar header. */
export function ClinicLogo({
  className = "",
  compact,
  priority,
}: {
  className?: string;
  compact?: boolean;
  priority?: boolean;
}) {
  return (
    <div className={`rounded-[10px] bg-brand-panel ${compact ? "p-2" : "p-3"} ${className}`}>
      <Image
        src={CLINIC_LOGO.src}
        alt={CLINIC_NAME}
        width={CLINIC_LOGO.width}
        height={CLINIC_LOGO.height}
        priority={priority}
        className="block h-auto w-full"
      />
    </div>
  );
}

/** Above the fold on every phone page (top bar), so it loads eagerly instead of popping in. */
export function ClinicMark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-grid place-items-center rounded-lg bg-brand-panel p-1 ${className}`}>
      <Image
        src={CLINIC_MARK.src}
        alt={CLINIC_NAME}
        width={CLINIC_MARK.width}
        height={CLINIC_MARK.height}
        priority
        className="block h-full w-full"
      />
    </span>
  );
}
