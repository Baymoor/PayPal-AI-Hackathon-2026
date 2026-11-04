import { cn } from "./cn";

/** Navy-to-plum gradient band with coral glow, microphone line art and sparkles. Decorative. */
export function InvitationHero({ className, label = "KARAOKE" }: { className?: string; label?: string }) {
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
        {[...Array(9)].map((_, i) => (
          <rect key={i} x={20 + i * 22} y={0} width="8" height={70 + ((i * 37) % 50)} rx="4" fill="#fff" opacity="0.05" />
        ))}
        <g transform="translate(210 28) rotate(28 40 60)" stroke="#FBF6F1" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" fill="none">
          <rect x="22" y="0" width="36" height="58" rx="18" />
          <path d="M22 18h36M22 30h36M22 42h36" opacity="0.45" />
          <path d="M40 58v14M30 78h20" />
          <path d="M40 72l-8 66M40 72l8 66" opacity="0" />
        </g>
        <g stroke="#E8604C" strokeWidth="3.5" strokeLinecap="round" fill="none">
          <path d="M196 52l-18 -10M190 78l-22 -2M206 28l-10 -18" />
        </g>
        <g fill="#FBF6F1">
          <path d="M60 40l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" opacity="0.9" />
          <path d="M320 128l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" opacity="0.8" />
          <circle cx="110" cy="120" r="3" opacity="0.5" />
          <circle cx="340" cy="46" r="2.5" opacity="0.5" />
          <circle cx="150" cy="30" r="2" opacity="0.4" />
        </g>
        <text x="48" y="148" fill="#FBF6F1" opacity="0.9" fontFamily="Inter Variable, sans-serif" fontWeight="700" fontSize="16" letterSpacing="4">
          {label}
        </text>
      </svg>
    </div>
  );
}

/** Landing hero: an illustrated karaoke room with floating UI cards. No photos of people. */
export function HeroArt({ className }: { className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-card-lg", className)} aria-hidden>
      <svg viewBox="0 0 640 520" preserveAspectRatio="xMidYMid slice" className="block h-full w-full" focusable="false">
        <defs>
          <linearGradient id="ha-bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#14213D" />
            <stop offset="0.65" stopColor="#3B2455" />
            <stop offset="1" stopColor="#5A2A55" />
          </linearGradient>
          <radialGradient id="ha-glow" cx="0.7" cy="0.3" r="0.6">
            <stop offset="0" stopColor="#E8604C" stopOpacity="0.6" />
            <stop offset="1" stopColor="#E8604C" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="ha-glow2" cx="0.15" cy="0.9" r="0.5">
            <stop offset="0" stopColor="#F2B8A8" stopOpacity="0.35" />
            <stop offset="1" stopColor="#F2B8A8" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="640" height="520" fill="url(#ha-bg)" />
        <rect width="640" height="520" fill="url(#ha-glow)" />
        <rect width="640" height="520" fill="url(#ha-glow2)" />
        {/* wall slats */}
        {[...Array(14)].map((_, i) => (
          <rect key={i} x={30 + i * 44} y="0" width="12" height={150 + ((i * 53) % 90)} rx="6" fill="#fff" opacity="0.045" />
        ))}
        {/* screen */}
        <rect x="320" y="70" width="270" height="160" rx="16" fill="#1B1740" stroke="#FBF6F1" strokeOpacity="0.25" strokeWidth="2" />
        <circle cx="400" cy="130" r="26" fill="#E8604C" opacity="0.35" />
        <circle cx="520" cy="180" r="34" fill="#8F6BD6" opacity="0.35" />
        <circle cx="470" cy="110" r="18" fill="#F2B8A8" opacity="0.3" />
        <g transform="translate(440 108) rotate(24 20 30)" stroke="#FBF6F1" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" fill="none">
          <rect x="8" y="0" width="24" height="38" rx="12" />
          <path d="M8 12h24M8 22h24" opacity="0.45" />
          <path d="M20 38v10" />
        </g>
        <text x="455" y="210" textAnchor="middle" fill="#FBF6F1" fontFamily="Inter Variable, sans-serif" fontWeight="700" fontSize="14" letterSpacing="4">
          KARAOKE
        </text>
        {/* sofa */}
        <path d="M30 420 C30 360 60 330 120 330 H430 C490 330 520 360 520 420 V470 H30Z" fill="#B5503C" />
        <path d="M30 420 C30 395 50 380 75 380 H475 C500 380 520 395 520 420 V470 H30Z" fill="#C8624D" />
        <rect x="90" y="345" width="90" height="60" rx="14" fill="#F2D9C4" transform="rotate(-6 135 375)" />
        <rect x="360" y="345" width="90" height="60" rx="14" fill="#2A2F55" transform="rotate(5 405 375)" />
        {/* table */}
        <ellipse cx="300" cy="470" rx="150" ry="22" fill="#F5E8DC" opacity="0.95" />
        <rect x="288" y="470" width="24" height="50" fill="#D9CCBE" />
        {/* floating cards */}
        <g>
          <rect x="40" y="60" width="210" height="96" rx="18" fill="#FBF6F1" />
          <text x="62" y="92" fontFamily="Fraunces Variable, serif" fontWeight="600" fontSize="19" fill="#14213D">Friday karaoke</text>
          <rect x="62" y="108" width="166" height="9" rx="4.5" fill="#E8DED3" />
          <rect x="62" y="108" width="132" height="9" rx="4.5" fill="#C8402D" />
          <text x="62" y="140" fontFamily="Inter Variable, sans-serif" fontSize="13" fill="#5B6478">4 of 5 payers committed</text>
        </g>
        <g fill="#FBF6F1">
          <path d="M290 40l4 10 10 4-10 4-4 10-4-10-10-4 10-4z" opacity="0.9" />
          <path d="M600 300l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" opacity="0.8" />
          <circle cx="260" cy="300" r="3" opacity="0.5" />
          <circle cx="610" cy="60" r="3" opacity="0.5" />
        </g>
        {/* initials avatars */}
        {[
          { x: 90, c: "#F9E3DC", t: "M" },
          { x: 150, c: "#DDEBE0", t: "B" },
          { x: 210, c: "#E6E0F3", t: "P" },
        ].map((a) => (
          <g key={a.t}>
            <circle cx={a.x} cy="300" r="22" fill={a.c} />
            <text x={a.x} y="307" textAnchor="middle" fontFamily="Inter Variable, sans-serif" fontWeight="700" fontSize="18" fill="#14213D">
              {a.t}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
