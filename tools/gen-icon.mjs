/**
 * @file gen-icon.mjs
 * Generates the chlauncher brand icons (SVG + 1024x1024 PNG via Tauri's
 * built-in resvg rasterizer, plus full platform icon bundle):
 *   - tools/icon-src.png                      (1024x1024 app squircle source)
 *   - branding/chlauncher-app-icon.png        (1024x1024 app icon attachment)
 *   - branding/chlauncher-tg-avatar.png       (1024x1024 Telegram channel avatar)
 *   - apps/launcher/src-tauri/icons/*         (.ico, .icns, 32x32, 128x128, etc.)
 *   - apps/launcher/public/logo.svg           (crisp vector mark for in-app UI)
 *
 * Usage: `node tools/gen-icon.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRANDING_DIR = path.join(ROOT, 'branding');
const LAUNCHER_DIR = path.join(ROOT, 'apps', 'launcher');
const PUBLIC_DIR = path.join(LAUNCHER_DIR, 'public');

fs.mkdirSync(BRANDING_DIR, { recursive: true });

/**
 * Symmetric DualSense/Xbox-proportioned controller silhouette around (512, 535).
 * Bridge y = 362, belly y = 616, grip tips y = 780, width = 684 (170..854).
 */
const CONTROLLER_PATH = [
  'M 512 362',
  'L 666 362',
  'C 696 362, 718 346, 752 364',
  'C 808 390, 840 456, 854 560',
  'C 866 654, 840 758, 770 780',
  'C 712 796, 674 736, 630 658',
  'C 608 622, 578 616, 512 616',
  'C 446 616, 416 622, 394 658',
  'C 350 736, 312 796, 254 780',
  'C 184 758, 158 654, 170 560',
  'C 184 456, 216 390, 272 364',
  'C 306 346, 328 362, 358 362',
  'Z',
].join(' ');

/** Rounded Play triangle optically centered at (cx, cy). */
function roundedPlayPath(cx, cy, r) {
  const x1 = cx - r * 0.44;
  const y1 = cy - r * 0.58;
  const x2 = cx + r * 0.68;
  const y2 = cy;
  const x3 = cx - r * 0.44;
  const y3 = cy + r * 0.58;
  const cr = r * 0.15;

  function lerpPt(ax, ay, bx, by, dist) {
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    return [ax + (dx / len) * dist, ay + (dy / len) * dist];
  }

  const [p1aX, p1aY] = lerpPt(x1, y1, x3, y3, cr);
  const [p1bX, p1bY] = lerpPt(x1, y1, x2, y2, cr);
  const [p2aX, p2aY] = lerpPt(x2, y2, x1, y1, cr);
  const [p2bX, p2bY] = lerpPt(x2, y2, x3, y3, cr);
  const [p3aX, p3aY] = lerpPt(x3, y3, x2, y2, cr);
  const [p3bX, p3bY] = lerpPt(x3, y3, x1, y1, cr);

  const f = (n) => n.toFixed(1);
  return [
    `M ${f(p1bX)} ${f(p1bY)}`,
    `L ${f(p2aX)} ${f(p2aY)}`,
    `Q ${f(x2)} ${f(y2)} ${f(p2bX)} ${f(p2bY)}`,
    `L ${f(p3aX)} ${f(p3aY)}`,
    `Q ${f(x3)} ${f(y3)} ${f(p3bX)} ${f(p3bY)}`,
    `L ${f(p1aX)} ${f(p1aY)}`,
    `Q ${f(x1)} ${f(y1)} ${f(p1bX)} ${f(p1bY)}`,
    'Z',
  ].join(' ');
}

/** Polar arc helper. */
function arcPath(cx, cy, r, degStart, degEnd) {
  const rad = (d) => (d * Math.PI) / 180;
  const x1 = cx + r * Math.cos(rad(degStart));
  const y1 = cy + r * Math.sin(rad(degStart));
  const x2 = cx + r * Math.cos(rad(degEnd));
  const y2 = cy + r * Math.sin(rad(degEnd));
  const large = Math.abs(degEnd - degStart) > 180 ? 1 : 0;
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

/** Crisp 4-point star sparkle path. */
function sparkPath(cx, cy, outerR, innerR = outerR * 0.24) {
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = (i * Math.PI) / 4 - Math.PI / 2;
    pts.push(`${i === 0 ? 'M' : 'L'} ${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(' ') + ' Z';
}

/**
 * Builds the shared SVG artwork.
 * @param {'app' | 'telegram' | 'ui'} variant
 */
function buildSvg(variant) {
  const isTg = variant === 'telegram';
  const isUi = variant === 'ui';
  const playD = roundedPlayPath(512, 488, 78);

  // Portal energy arcs for Telegram circular avatar (safe inside r=512 circle)
  const tgArcCyan = arcPath(512, 512, 454, 148, 308);
  const tgArcPink = arcPath(512, 512, 454, -32, 128);

  // Transform: bold scale + dynamic -6.5 deg gaming tilt
  const glyphTransform = isTg
    ? 'translate(512 508) rotate(-6.5) scale(0.95) translate(-512 -555)'
    : isUi
      ? 'translate(512 512) rotate(-6.5) scale(1.14) translate(-512 -555)'
      : 'translate(512 510) rotate(-6.5) scale(1.08) translate(-512 -555)';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <!-- Deep high-contrast cosmos background -->
    <linearGradient id="bgBase" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#070914"/>
      <stop offset="48%" stop-color="#130E2B"/>
      <stop offset="100%" stop-color="#220B30"/>
    </linearGradient>

    <!-- Vivid diagonal energy beam -->
    <linearGradient id="energyBeam" x1="10%" y1="15%" x2="90%" y2="85%">
      <stop offset="0%" stop-color="#06B6D4" stop-opacity="0.28"/>
      <stop offset="50%" stop-color="#7C3AED" stop-opacity="0.34"/>
      <stop offset="100%" stop-color="#F43F8E" stop-opacity="0.32"/>
    </linearGradient>

    <!-- Center radial glow behind controller -->
    <radialGradient id="centerGlow" cx="50%" cy="50%" r="48%">
      <stop offset="0%" stop-color="#9333EA" stop-opacity="0.62"/>
      <stop offset="52%" stop-color="#EC4899" stop-opacity="0.26"/>
      <stop offset="100%" stop-color="#070914" stop-opacity="0"/>
    </radialGradient>

    <!-- Rim border gradient -->
    <linearGradient id="rimGrad" x1="6%" y1="6%" x2="94%" y2="94%">
      <stop offset="0%" stop-color="#22D3EE"/>
      <stop offset="50%" stop-color="#A855F7"/>
      <stop offset="100%" stop-color="#FF2E88"/>
    </linearGradient>

    <!-- Main controller shell gradient -->
    <linearGradient id="padShell" x1="12%" y1="10%" x2="90%" y2="88%">
      <stop offset="0%" stop-color="#4F46E5"/>
      <stop offset="36%" stop-color="#8B5CF6"/>
      <stop offset="72%" stop-color="#D946EF"/>
      <stop offset="100%" stop-color="#F43F8E"/>
    </linearGradient>

    <!-- Controller 3D top specular highlight -->
    <radialGradient id="padHighlight" cx="38%" cy="18%" r="56%">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.38"/>
      <stop offset="45%" stop-color="#E879F9" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>

    <!-- Controller bottom grip depth shade -->
    <linearGradient id="padShade" x1="50%" y1="36%" x2="50%" y2="100%">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#120624" stop-opacity="0.52"/>
    </linearGradient>

    <!-- Controller edge bevel -->
    <linearGradient id="padEdge" x1="12%" y1="0%" x2="88%" y2="100%">
      <stop offset="0%" stop-color="#A5F3FC" stop-opacity="0.90"/>
      <stop offset="50%" stop-color="#F3E8FF" stop-opacity="0.42"/>
      <stop offset="100%" stop-color="#FDA4AF" stop-opacity="0.78"/>
    </linearGradient>

    <!-- Center medallion dark core -->
    <linearGradient id="coreBg" x1="20%" y1="15%" x2="80%" y2="85%">
      <stop offset="0%" stop-color="#171930"/>
      <stop offset="100%" stop-color="#070812"/>
    </linearGradient>

    <filter id="softShadow" x="-22%" y="-22%" width="144%" height="144%">
      <feDropShadow dx="0" dy="20" stdDeviation="22" flood-color="#04040A" flood-opacity="0.72"/>
    </filter>

    <filter id="neonGlow" filterUnits="userSpaceOnUse" x="-100" y="-100" width="1224" height="1224">
      <feGaussianBlur stdDeviation="14" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>

    <clipPath id="squircleClip">
      <rect x="28" y="28" width="968" height="968" rx="226" ry="226"/>
    </clipPath>
  </defs>

  ${
    isTg
      ? `<!-- Full-bleed Telegram avatar canvas (circular crop r=512) -->
  <rect width="1024" height="1024" fill="url(#bgBase)"/>
  <!-- Subtle dynamic diagonal neon ribbons -->
  <polygon points="-80,260 420,-80 640,-80 -80,440" fill="url(#energyBeam)" opacity="0.55"/>
  <polygon points="1104,740 580,1104 360,1104 1104,540" fill="url(#energyBeam)" opacity="0.55"/>
  <circle cx="512" cy="512" r="430" fill="url(#centerGlow)"/>

  <!-- Dual-color Neon Portal Ring inside Telegram's circular mask -->
  <g filter="url(#neonGlow)">
    <path d="${tgArcCyan}" fill="none" stroke="#22D3EE" stroke-width="10" stroke-linecap="round" opacity="0.92"/>
    <path d="${tgArcPink}" fill="none" stroke="#FF2E88" stroke-width="10" stroke-linecap="round" opacity="0.92"/>
  </g>
  <circle cx="512" cy="512" r="426" fill="none" stroke="#FFFFFF" stroke-width="1.5" opacity="0.10"/>

  <!-- Subtle streamer sparks -->
  <path d="${sparkPath(228, 250, 22)}" fill="#22D3EE" opacity="0.88" filter="url(#neonGlow)"/>
  <path d="${sparkPath(796, 766, 20)}" fill="#FF4D9D" opacity="0.88" filter="url(#neonGlow)"/>
  <circle cx="764" cy="248" r="14" fill="#FF2E63" filter="url(#neonGlow)"/>
  <circle cx="764" cy="248" r="6" fill="#FFFFFF"/>`
      : `<!-- Full-bodied desktop app squircle with transparent corners -->
  <g filter="${isUi ? '' : 'url(#softShadow)'}">
    <g clip-path="url(#squircleClip)">
      <rect x="28" y="28" width="968" height="968" fill="url(#bgBase)"/>
      <polygon points="-40,280 440,-40 660,-40 -40,460" fill="url(#energyBeam)" opacity="0.62"/>
      <polygon points="1064,720 560,1064 340,1064 1064,520" fill="url(#energyBeam)" opacity="0.62"/>
      <circle cx="512" cy="512" r="440" fill="url(#centerGlow)"/>
    </g>
    <rect x="32" y="32" width="960" height="960" rx="222" ry="222" fill="none" stroke="url(#rimGrad)" stroke-width="8"/>
    <rect x="41" y="41" width="942" height="942" rx="214" ry="214" fill="none" stroke="#FFFFFF" stroke-opacity="0.12" stroke-width="2"/>
  </g>`
  }

  <!-- Hero Emblem: Dynamic Tilted Chromatic Neon Controller + Oversized Play Medallion -->
  <g transform="${glyphTransform}">
    <!-- Sculpted Shoulder Bumpers (L1 Cyan / R1 Pink) -->
    <path d="M 278 360 Q 320 326 382 356" fill="none" stroke="#22D3EE" stroke-width="18" stroke-linecap="round"/>
    <path d="M 642 356 Q 704 326 746 360" fill="none" stroke="#FF2E88" stroke-width="18" stroke-linecap="round"/>

    <!-- TikTok-inspired dual chromatic neon rim offset behind controller -->
    <path d="${CONTROLLER_PATH}" transform="translate(-13 -9)" fill="#22D3EE" opacity="0.80"/>
    <path d="${CONTROLLER_PATH}" transform="translate(13 9)" fill="#FF2E88" opacity="0.80"/>

    <!-- Controller drop shadow + main 3D sculpted body -->
    <g filter="url(#softShadow)">
      <path d="${CONTROLLER_PATH}" fill="url(#padShell)"/>
      <path d="${CONTROLLER_PATH}" fill="url(#padHighlight)"/>
      <path d="${CONTROLLER_PATH}" fill="url(#padShade)"/>
      <path d="${CONTROLLER_PATH}" fill="none" stroke="url(#padEdge)" stroke-width="6"/>
    </g>

    <!-- Left Wing: Bold Minimalist D-Pad -->
    <g>
      <rect x="292" y="446" width="32" height="92" rx="10" fill="#0B0D1C" opacity="0.38" transform="translate(0 5)"/>
      <rect x="262" y="476" width="92" height="32" rx="10" fill="#0B0D1C" opacity="0.38" transform="translate(0 5)"/>
      <rect x="292" y="446" width="32" height="92" rx="10" fill="#FFFFFF"/>
      <rect x="262" y="476" width="92" height="32" rx="10" fill="#FFFFFF"/>
    </g>

    <!-- Right Wing: Glowing Action Buttons Diamond -->
    <g>
      <circle cx="716" cy="450" r="17" fill="#22D3EE"/>
      <circle cx="756" cy="490" r="17" fill="#FF4D9D"/>
      <circle cx="716" cy="530" r="17" fill="#FFFFFF"/>
      <circle cx="676" cy="490" r="17" fill="#FDE047"/>
    </g>

    <!-- Oversized Center Medallion + Chromatic Pure-White Play Prism -->
    <circle cx="512" cy="488" r="116" fill="url(#rimGrad)"/>
    <circle cx="512" cy="488" r="107" fill="url(#coreBg)"/>
    <path d="${playD}" fill="#22D3EE" opacity="0.70" transform="translate(-5 -4)"/>
    <path d="${playD}" fill="#FF2E88" opacity="0.70" transform="translate(5 4)"/>
    <path d="${playD}" fill="#FFFFFF"/>
  </g>
</svg>
`;
}

const appSvgPath = path.join(BRANDING_DIR, 'chlauncher-app-icon.svg');
const tgSvgPath = path.join(BRANDING_DIR, 'chlauncher-tg-avatar.svg');
const uiSvgPath = path.join(PUBLIC_DIR, 'logo.svg');

fs.writeFileSync(appSvgPath, buildSvg('app'));
fs.writeFileSync(tgSvgPath, buildSvg('telegram'));
fs.writeFileSync(uiSvgPath, buildSvg('ui'));

function runTauriIcon(args) {
  if (process.platform === 'win32') {
    execFileSync('cmd.exe', ['/d', '/s', '/c', 'npx', 'tauri', 'icon', ...args], {
      cwd: LAUNCHER_DIR,
      stdio: 'inherit',
    });
  } else {
    execFileSync('npx', ['tauri', 'icon', ...args], {
      cwd: LAUNCHER_DIR,
      stdio: 'inherit',
    });
  }
}

function render1024(svgPath, destPng) {
  const tmpDir = path.join(BRANDING_DIR, '.tmp-icon');
  fs.mkdirSync(tmpDir, { recursive: true });
  runTauriIcon(['-p', '1024', '-o', tmpDir, svgPath]);
  fs.copyFileSync(path.join(tmpDir, '1024x1024.png'), destPng);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const iconSrcPng = path.join(ROOT, 'tools', 'icon-src.png');
const appOutPng = path.join(BRANDING_DIR, 'chlauncher-app-icon.png');
const tgOutPng = path.join(BRANDING_DIR, 'chlauncher-tg-avatar.png');

render1024(appSvgPath, appOutPng);
fs.copyFileSync(appOutPng, iconSrcPng);
render1024(tgSvgPath, tgOutPng);

// Generate full platform bundle (icons/*.png, icon.ico, icon.icns, Windows tiles)
runTauriIcon([iconSrcPng]);

console.log('Generated:', { appOutPng, tgOutPng, iconSrcPng, uiSvgPath });
