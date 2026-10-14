// ==========================================
// DASHBOARD ILLUSTRATIONS
// Lightweight, locally-defined inline SVGs for the redesigned
// Employee Dashboard (no external image URLs). Purely decorative --
// none of these render real data, so they carry no "is this value
// real" risk the way a fabricated chart/number would.
// ==========================================

export function WelcomeDeskIllustration() {
  return (
    <svg viewBox="0 0 420 220" className="dash-desk-illustration" aria-hidden="true">
      <defs>
        <linearGradient id="deskTop" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#CFEFDD" />
          <stop offset="100%" stopColor="#A9E2C4" />
        </linearGradient>
        <linearGradient id="laptopLid" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1F2A24" />
          <stop offset="100%" stopColor="#0E744A" />
        </linearGradient>
      </defs>

      <ellipse cx="300" cy="195" rx="170" ry="18" fill="#BFE9D4" opacity="0.5" />

      {/* desk surface */}
      <rect x="40" y="150" width="380" height="22" rx="8" fill="url(#deskTop)" />
      <rect x="40" y="168" width="380" height="10" rx="4" fill="#16A66A" opacity="0.35" />

      {/* laptop */}
      <g transform="translate(205,70)">
        <rect x="0" y="0" width="118" height="78" rx="8" fill="url(#laptopLid)" />
        <rect x="8" y="8" width="102" height="62" rx="4" fill="#0B3B27" />
        <rect x="-10" y="78" width="138" height="10" rx="4" fill="#163B2B" />
      </g>

      {/* monitor glow lines */}
      <rect x="221" y="18" width="80" height="4" rx="2" fill="#2FD88B" opacity="0.6" />
      <rect x="221" y="28" width="56" height="4" rx="2" fill="#2FD88B" opacity="0.4" />

      {/* plant */}
      <g transform="translate(70,90)">
        <rect x="18" y="42" width="34" height="30" rx="6" fill="#E9F6EE" stroke="#16A66A" strokeWidth="2" />
        <path d="M35 42 C20 20 15 0 35 -6 C40 10 40 28 35 42 Z" fill="#16A66A" />
        <path d="M35 42 C50 24 58 6 40 -10 C33 6 30 26 35 42 Z" fill="#0E744A" />
      </g>

      {/* mug */}
      <g transform="translate(130,118)">
        <rect x="0" y="0" width="26" height="28" rx="6" fill="#FFFFFF" stroke="#16A66A" strokeWidth="2" />
        <path d="M26 6 h8 a6 6 0 0 1 0 16 h-8" fill="none" stroke="#16A66A" strokeWidth="2" />
      </g>

      {/* window light wedge */}
      <polygon points="330,10 420,0 420,160 330,150" fill="#E6F7EE" opacity="0.6" />
    </svg>
  );
}

export function EmptyWorkIllustration() {
  return (
    <svg viewBox="0 0 160 140" className="dash-empty-illustration" aria-hidden="true">
      <ellipse cx="80" cy="128" rx="58" ry="8" fill="#E6F3EB" />

      {/* leaves */}
      <path d="M30 95 C15 85 15 65 30 55 C35 75 35 85 30 95 Z" fill="#CDEBDA" />
      <path d="M130 95 C145 85 145 65 130 55 C125 75 125 85 130 95 Z" fill="#CDEBDA" />

      {/* clipboard */}
      <rect x="48" y="18" width="64" height="88" rx="10" fill="#FFFFFF" stroke="#D9E9E0" strokeWidth="3" />
      <rect x="64" y="10" width="32" height="14" rx="6" fill="#B6E3C9" />

      <g stroke="#9FD6B9" strokeWidth="3" strokeLinecap="round">
        <line x1="60" y1="40" x2="100" y2="40" />
        <line x1="60" y1="56" x2="100" y2="56" />
        <line x1="60" y1="72" x2="88" y2="72" />
      </g>

      <g stroke="#16A66A" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M54 40 l4 4 l6 -7" />
        <path d="M54 56 l4 4 l6 -7" />
        <path d="M54 72 l4 4 l6 -7" />
      </g>

      {/* success badge */}
      <circle cx="104" cy="98" r="16" fill="#16A66A" />
      <path d="M97 98 l5 5 l10 -11" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function QuoteMountainIllustration() {
  return (
    <svg viewBox="0 0 80 48" className="dash-quote-illustration" aria-hidden="true">
      <path d="M0 48 L18 20 L30 36 L44 12 L64 40 L80 48 Z" fill="#D7EFE1" />
      <path d="M44 12 L54 28 L64 22 L80 48 L44 48 Z" fill="#C3E7D4" />
      <path d="M44 12 L38 24 L50 24 Z" fill="#16A66A" />
      <line x1="44" y1="12" x2="44" y2="2" stroke="#0E744A" strokeWidth="2" />
    </svg>
  );
}
