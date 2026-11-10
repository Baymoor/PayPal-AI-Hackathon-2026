import { cn } from "./cn";

/** "wine-tasting" -> "WINE TASTING": the activity named on the band. */
function activityLabel(category: string): string {
  return category.replace(/[-_]+/g, " ").trim().toUpperCase();
}

/**
 * Navy-to-plum gradient band with a coral glow, naming the activity. Decorative (the details are in the text
 * below), so it is hidden from assistive tech. The microphone line art appears only for karaoke, so a cinema
 * or padel outing never shows the wrong picture.
 */
export function InvitationHero({ className, category = "karaoke" }: { className?: string; category?: string }) {
  const showMicrophone = category === "karaoke";
  return (
    <div className={cn("relative overflow-hidden", className)} aria-hidden>
      <svg viewBox="0 0 390 180" preserveAspectRatio="xMidYMid slice" className="block h-full w-full" focusable="false">
        <defs>
          <linearGradient id="ih-bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#14213D" />
            <stop offset="1" stopColor="#4A2358" />
          </linearGradient>
          <radialGradient id="ih-glow" cx="0.72" cy="0.35" r="0.55">
            <stop offset="0" stopColor="#E8604C" stopOpacity="0.55" />
            <stop offset="1" stopColor="#E8604C" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="390" height="180" fill="url(#ih-bg)" />
        <rect width="390" height="180" fill="url(#ih-glow)" />
        {showMicrophone && (
          <>
            <g transform="translate(210 28) rotate(28 40 60)" stroke="#FBF6F1" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" fill="none">
              <rect x="22" y="0" width="36" height="58" rx="18" />
              <path d="M22 18h36M22 30h36M22 42h36" opacity="0.45" />
              <path d="M40 58v14M30 78h20" />
            </g>
            <g stroke="#E8604C" strokeWidth="3.5" strokeLinecap="round" fill="none">
              <path d="M196 52l-18 -10M190 78l-22 -2M206 28l-10 -18" />
            </g>
          </>
        )}
        <text x="48" y="148" fill="#FBF6F1" opacity="0.9" fontFamily="Inter Variable, sans-serif" fontWeight="700" fontSize="16" letterSpacing="4">
          {activityLabel(category)}
        </text>
      </svg>
    </div>
  );
}
