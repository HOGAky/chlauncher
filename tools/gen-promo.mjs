/**
 * @file gen-promo.mjs
 * Generates the 1920x1080 (16:9 Full HD) promo cover image for the first
 * Telegram channel post:
 *   - branding/chlauncher-tg-post-cover.png   (1920x1080 PNG)
 *   - branding/chlauncher-tg-post-cover.svg   (1920x1080 vector source)
 *
 * Uses Tauri CLI's built-in resvg + fontdb renderer on a 1920x1920 square
 * canvas (centering the 1920x1080 artboard at y=420..1500), then decodes PNG
 * scanlines, crops to 1920x1080, applies subtle 1-LSB triangular dithering
 * for zero gradient banding, and writes the final PNG.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRANDING_DIR = path.join(ROOT, 'branding');
const LAUNCHER_DIR = path.join(ROOT, 'apps', 'launcher');

fs.mkdirSync(BRANDING_DIR, { recursive: true });

// --- PNG decode + crop + anti-banding dither + encode ----------------------
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePngRgba(buf) {
  let pos = 8;
  let w = 0, h = 0, colorType = 6;
  const idats = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') {
      idats.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const recon = Buffer.alloc(h * stride);

  for (let y = 0; y < h; y++) {
    const ftype = raw[y * (stride + 1)];
    const srcOff = y * (stride + 1) + 1;
    const dstOff = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[srcOff + i];
      const a = i >= bpp ? recon[dstOff + i - bpp] : 0;
      const b = y > 0 ? recon[dstOff - stride + i] : 0;
      const c = y > 0 && i >= bpp ? recon[dstOff - stride + i - bpp] : 0;
      let val = x;
      if (ftype === 1) val = (x + a) & 0xff;
      else if (ftype === 2) val = (x + b) & 0xff;
      else if (ftype === 3) val = (x + ((a + b) >>> 1)) & 0xff;
      else if (ftype === 4) val = (x + paeth(a, b, c)) & 0xff;
      recon[dstOff + i] = val;
    }
  }

  if (bpp === 4) return { w, h, rgba: recon };
  const rgba = Buffer.alloc(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    rgba[p * 4] = recon[p * 3];
    rgba[p * 4 + 1] = recon[p * 3 + 1];
    rgba[p * 4 + 2] = recon[p * 3 + 2];
    rgba[p * 4 + 3] = 255;
  }
  return { w, h, rgba };
}

function encodePngRgba(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    // Sub filter (type 1) compresses smooth gradients tightly
    const rowOff = y * (stride + 1);
    raw[rowOff] = 1;
    const srcOff = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? rgba[srcOff + i - 4] : 0;
      raw[rowOff + 1 + i] = (rgba[srcOff + i] - a) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Vector helpers --------------------------------------------------------
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

function sectorPath(cx, cy, r, a0Deg, a1Deg) {
  const rad = (d) => (d * Math.PI) / 180;
  const x0 = cx + r * Math.cos(rad(a0Deg));
  const y0 = cy + r * Math.sin(rad(a0Deg));
  const x1 = cx + r * Math.cos(rad(a1Deg));
  const y1 = cy + r * Math.sin(rad(a1Deg));
  return `M ${cx} ${cy} L ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z`;
}

function sparkPath(cx, cy, outerR, innerR = outerR * 0.24) {
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = (i * Math.PI) / 4 - Math.PI / 2;
    pts.push(`${i === 0 ? 'M' : 'L'} ${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(' ') + ' Z';
}

/** Builds the 1920x1080 inner content (placed either standalone or inside 1920x1920). */
function buildArtboardInner() {
  // 8-slice neon Gift Spinner wheel at local (0, 0), radius 92
  const wheelColors = [
    '#7C3AED', '#22D3EE', '#EC4899', '#F59E0B',
    '#6366F1', '#10B981', '#F43F5E', '#A855F7',
  ];
  const wheelSlices = wheelColors
    .map((col, i) => `<path d="${sectorPath(0, 0, 86, i * 45 - 90, (i + 1) * 45 - 90)}" fill="${col}" stroke="#0E1022" stroke-width="2.5"/>`)
    .join('\n          ');

  // Subtle background perspective grid lines
  const bgGrid = [];
  for (let x = 0; x <= 1920; x += 96) {
    bgGrid.push(`<line x1="${x}" y1="0" x2="${x}" y2="1080" stroke="#8B5CF6" stroke-opacity="0.04" stroke-width="1"/>`);
  }
  for (let y = 0; y <= 1080; y += 96) {
    bgGrid.push(`<line x1="0" y1="${y}" x2="1920" y2="${y}" stroke="#8B5CF6" stroke-opacity="0.04" stroke-width="1"/>`);
  }

  // Feature pills on left column (2 columns x 3 rows)
  const pills = [
    { x: 96, y: 690, w: 368, accent: '#22D3EE', icon: 'pad', title: 'Игры с автоапдейтом', sub: 'библиотека как в Steam' },
    { x: 482, y: 690, w: 358, accent: '#FF4D9D', icon: 'wheel', title: 'Gift Spinner', sub: 'колесо фортуны в эфир' },
    { x: 96, y: 786, w: 368, accent: '#A855F7', icon: 'bolt', title: 'Свои триггеры', sub: 'лайки и подарки → экшен' },
    { x: 482, y: 786, w: 358, accent: '#34D399', icon: 'tts', title: 'Голосовой TTS + Звуки', sub: 'антиспам и саундборд' },
    { x: 96, y: 882, w: 368, accent: '#FBBF24', icon: 'cube', title: 'Minecraft-сервер', sub: 'запуск в один клик' },
    { x: 482, y: 882, w: 358, accent: '#C084FC', icon: 'heart', title: 'OBS + DonationAlerts', sub: 'готовые web-оверлеи' },
  ];

  function renderPillIcon(kind, color) {
    switch (kind) {
      case 'pad':
        return `<rect x="-14" y="-9" width="28" height="18" rx="7" fill="none" stroke="${color}" stroke-width="2.6"/>
                <line x1="-9" y1="0" x2="-3" y2="0" stroke="${color}" stroke-width="2.4" stroke-linecap="round"/>
                <line x1="-6" y1="-3" x2="-6" y2="3" stroke="${color}" stroke-width="2.4" stroke-linecap="round"/>
                <circle cx="6" cy="-2" r="1.8" fill="${color}"/><circle cx="9" cy="2" r="1.8" fill="${color}"/>`;
      case 'wheel':
        return `<circle cx="0" cy="0" r="13" fill="none" stroke="${color}" stroke-width="2.6"/>
                <circle cx="0" cy="0" r="3.5" fill="${color}"/>
                <line x1="0" y1="-13" x2="0" y2="13" stroke="${color}" stroke-width="2"/>
                <line x1="-13" y1="0" x2="13" y2="0" stroke="${color}" stroke-width="2"/>`;
      case 'bolt':
        return `<polygon points="2,-14 -10,2 -1,2 -3,14 10,-2 1,-2" fill="${color}"/>`;
      case 'tts':
        return `<path d="M -11 -5 L -5 -5 L 2 -11 L 2 11 L -5 5 L -11 5 Z" fill="${color}"/>
                <path d="M 6 -6 Q 11 0 6 6" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
                <path d="M 10 -10 Q 17 0 10 10" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>`;
      case 'cube':
        return `<polygon points="0,-13 12,-6 12,7 0,14 -12,7 -12,-6" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>
                <polyline points="-12,-6 0,1 12,-6" fill="none" stroke="${color}" stroke-width="2.2"/>
                <line x1="0" y1="1" x2="0" y2="14" stroke="${color}" stroke-width="2.2"/>`;
      default:
        return `<path d="M 0 11 C -2 9 -12 2 -12 -5 C -12 -10 -8 -13 -4 -13 C -1 -13 0 -11 0 -9 C 0 -11 1 -13 4 -13 C 8 -13 12 -10 12 -5 C 12 2 2 9 0 11 Z" fill="${color}"/>`;
    }
  }

  const pillsSvg = pills
    .map(
      (p) => `
    <g transform="translate(${p.x} ${p.y})">
      <rect width="${p.w}" height="78" rx="18" fill="#121428" fill-opacity="0.88" stroke="${p.accent}" stroke-opacity="0.38" stroke-width="1.6"/>
      <rect x="16" y="15" width="48" height="48" rx="13" fill="${p.accent}" fill-opacity="0.15"/>
      <g transform="translate(40 39)">${renderPillIcon(p.icon, p.accent)}</g>
      <text x="78" y="36" fill="#F8FAFC" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="19">${p.title}</text>
      <text x="78" y="59" fill="#94A3B8" font-family="Segoe UI, Arial, sans-serif" font-weight="500" font-size="15">${p.sub}</text>
    </g>`
    )
    .join('');

  return `
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#070913"/>
      <stop offset="48%" stop-color="#110D26"/>
      <stop offset="100%" stop-color="#1E0B2E"/>
    </linearGradient>

    <radialGradient id="glowLeft" cx="22%" cy="32%" r="52%">
      <stop offset="0%" stop-color="#7C3AED" stop-opacity="0.42"/>
      <stop offset="55%" stop-color="#22D3EE" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#070913" stop-opacity="0"/>
    </radialGradient>

    <radialGradient id="glowRight" cx="76%" cy="54%" r="50%">
      <stop offset="0%" stop-color="#EC4899" stop-opacity="0.40"/>
      <stop offset="50%" stop-color="#8B5CF6" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#070913" stop-opacity="0"/>
    </radialGradient>

    <linearGradient id="heroTextGrad" x1="0%" y1="0%" x2="100%" y2="15%">
      <stop offset="0%" stop-color="#22D3EE"/>
      <stop offset="48%" stop-color="#A855F7"/>
      <stop offset="100%" stop-color="#FF3B8B"/>
    </linearGradient>

    <linearGradient id="brandRim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#22D3EE"/>
      <stop offset="50%" stop-color="#8B5CF6"/>
      <stop offset="100%" stop-color="#FF2E88"/>
    </linearGradient>

    <linearGradient id="padShellP" x1="12%" y1="10%" x2="90%" y2="88%">
      <stop offset="0%" stop-color="#4F46E5"/>
      <stop offset="40%" stop-color="#8B5CF6"/>
      <stop offset="78%" stop-color="#D946EF"/>
      <stop offset="100%" stop-color="#F43F8E"/>
    </linearGradient>

    <linearGradient id="cardGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#151830"/>
      <stop offset="100%" stop-color="#0C0E1D"/>
    </linearGradient>

    <linearGradient id="gameBannerGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#312E81"/>
      <stop offset="52%" stop-color="#6D28D9"/>
      <stop offset="100%" stop-color="#BE185D"/>
    </linearGradient>

    <filter id="cardShadow" filterUnits="userSpaceOnUse" x="-120" y="-120" width="1200" height="1100">
      <feDropShadow dx="0" dy="26" stdDeviation="28" flood-color="#020308" flood-opacity="0.78"/>
    </filter>

    <filter id="floatShadow" filterUnits="userSpaceOnUse" x="-120" y="-160" width="900" height="600">
      <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#03040B" flood-opacity="0.82"/>
    </filter>

    <filter id="softNeon" filterUnits="userSpaceOnUse" x="-100" y="-100" width="2120" height="1280">
      <feGaussianBlur stdDeviation="10" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>

    <clipPath id="artClip">
      <rect x="0" y="0" width="1920" height="1080"/>
    </clipPath>
  </defs>

  <g clip-path="url(#artClip)">
    <!-- Cosmic background + dual neon auroras -->
    <rect width="1920" height="1080" fill="url(#bgGrad)"/>
    <rect width="1920" height="1080" fill="url(#glowLeft)"/>
    <rect width="1920" height="1080" fill="url(#glowRight)"/>
    <g>${bgGrid.join('')}</g>

    <!-- Dynamic diagonal cyber ribbons -->
    <polygon points="-120,220 420,-80 620,-80 -120,360" fill="#22D3EE" fill-opacity="0.06"/>
    <polygon points="1280,1140 1980,680 1980,850 1480,1140" fill="#FF2E88" fill-opacity="0.08"/>

    <!-- Subtle star sparks -->
    <path d="${sparkPath(868, 152, 16)}" fill="#22D3EE" opacity="0.85" filter="url(#softNeon)"/>
    <path d="${sparkPath(1836, 520, 15)}" fill="#FF4D9D" opacity="0.85" filter="url(#softNeon)"/>
    <path d="${sparkPath(908, 962, 13)}" fill="#A855F7" opacity="0.80" filter="url(#softNeon)"/>

    <!-- ==================== LEFT COLUMN: BRAND + HEADLINE + PILLS ==================== -->

    <!-- Brand Lockup Row -->
    <g transform="translate(96 86)">
      <!-- Mini squircle app icon -->
      <rect x="0" y="0" width="84" height="84" rx="22" fill="#0E1022" stroke="url(#brandRim)" stroke-width="2.8"/>
      <g transform="translate(42 44) rotate(-6.5) scale(0.088) translate(-512 -555)">
        <path d="${CONTROLLER_PATH}" transform="translate(-14 -10)" fill="#22D3EE" opacity="0.85"/>
        <path d="${CONTROLLER_PATH}" transform="translate(14 10)" fill="#FF2E88" opacity="0.85"/>
        <path d="${CONTROLLER_PATH}" fill="url(#padShellP)"/>
        <rect x="292" y="446" width="34" height="94" rx="10" fill="#FFFFFF"/>
        <rect x="262" y="476" width="94" height="34" rx="10" fill="#FFFFFF"/>
        <circle cx="716" cy="450" r="19" fill="#22D3EE"/>
        <circle cx="756" cy="490" r="19" fill="#FF4D9D"/>
        <circle cx="716" cy="530" r="19" fill="#FFFFFF"/>
        <circle cx="676" cy="490" r="19" fill="#FDE047"/>
        <circle cx="512" cy="488" r="118" fill="#0B0D1A" stroke="url(#brandRim)" stroke-width="14"/>
        <polygon points="482,442 562,488 482,534" fill="#FFFFFF"/>
      </g>

      <text x="104" y="46" fill="#FFFFFF" font-family="Segoe UI, Arial, sans-serif" font-weight="800" font-size="36" letter-spacing="0.5">chlauncher</text>
      <text x="105" y="72" fill="#94A3B8" font-family="Segoe UI, Arial, sans-serif" font-weight="600" font-size="16" letter-spacing="1.5">TIKTOK LIVE GAMES HUB</text>

      <!-- LIVE Pill Badge -->
      <g transform="translate(366 16)">
        <rect width="142" height="38" rx="19" fill="#2A0E26" stroke="#FF3B8B" stroke-width="1.6"/>
        <circle cx="24" cy="19" r="6.5" fill="#FF2E63" filter="url(#softNeon)"/>
        <text x="40" y="25" fill="#FFE4EE" font-family="Segoe UI, Arial, sans-serif" font-weight="800" font-size="15" letter-spacing="1.2">LIVE HUB</text>
      </g>
    </g>

    <!-- Main Hero Headline -->
    <g transform="translate(96 276)">
      <text x="0" y="0" fill="#F8FAFC" font-family="Segoe UI, Arial, sans-serif" font-weight="900" font-size="72" letter-spacing="-1">ТВОИ ЗРИТЕЛИ</text>
      <text x="0" y="84" fill="#F8FAFC" font-family="Segoe UI, Arial, sans-serif" font-weight="900" font-size="72" letter-spacing="-1">ИГРАЮТ ВМЕСТЕ</text>
      <text x="0" y="170" fill="url(#heroTextGrad)" font-family="Segoe UI, Arial, sans-serif" font-weight="900" font-size="76" letter-spacing="-1">С ТОБОЙ В ЭФИРЕ</text>

      <text x="2" y="236" fill="#CBD5E1" font-family="Segoe UI, Arial, sans-serif" font-weight="500" font-size="25">Донаты, подарки, лайки и чат запускают события прямо в игре.</text>
      <text x="2" y="272" fill="#94A3B8" font-family="Segoe UI, Arial, sans-serif" font-weight="500" font-size="23">Один лаунчер вместо десятка ботов, скриптов и костылей.</text>
    </g>

    <!-- 6 Feature Pills -->
    ${pillsSvg}

    <!-- ==================== RIGHT COLUMN: LAUNCHER MOCKUP + FLOATING CARDS ==================== -->

    <!-- Main Launcher Window Card -->
    <g filter="url(#cardShadow)" transform="translate(928 148)">
      <rect width="864" height="744" rx="26" fill="url(#cardGrad)" stroke="url(#brandRim)" stroke-opacity="0.65" stroke-width="2"/>

      <!-- Window Header Bar -->
      <path d="M 26 0 L 838 0 Q 864 0 864 26 L 864 64 L 0 64 L 0 26 Q 0 0 26 0 Z" fill="#181B36"/>
      <line x1="0" y1="64" x2="864" y2="64" stroke="#2A2F52" stroke-width="1.5"/>
      <circle cx="28" cy="32" r="6.5" fill="#FF5F56"/>
      <circle cx="50" cy="32" r="6.5" fill="#FFBD2E"/>
      <circle cx="72" cy="32" r="6.5" fill="#27C93F"/>
      <text x="102" y="38" fill="#E2E8F0" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="17">chlauncher</text>

      <!-- Header Status Badges -->
      <rect x="216" y="17" width="174" height="30" rx="15" fill="#064E3B" stroke="#10B981" stroke-width="1.2"/>
      <circle cx="235" cy="32" r="5" fill="#34D399"/>
      <text x="249" y="37" fill="#A7F3D0" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="13">TikTok LIVE · в эфире</text>

      <rect x="402" y="17" width="166" height="30" rx="15" fill="#2E1065" stroke="#8B5CF6" stroke-width="1.2"/>
      <text x="421" y="37" fill="#DDD6FE" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="13">DonationAlerts · ОК</text>

      <!-- Left Sidebar inside Window -->
      <rect x="0" y="65" width="178" height="679" rx="0" fill="#101326" opacity="0.75"/>
      <line x1="178" y1="64" x2="178" y2="744" stroke="#232746" stroke-width="1.5"/>

      <rect x="14" y="86" width="150" height="42" rx="11" fill="#7C3AED" fill-opacity="0.26" stroke="#8B5CF6" stroke-width="1.2"/>
      <polygon points="30,101 40,107 30,113" fill="#A855F7"/>
      <text x="48" y="112" fill="#F8FAFC" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="15">Библиотека</text>
      <circle cx="34" cy="156" r="4" fill="#22D3EE"/>
      <text x="48" y="161" fill="#94A3B8" font-family="Segoe UI, Arial, sans-serif" font-weight="600" font-size="15">Триггеры</text>
      <circle cx="34" cy="200" r="4" fill="#FF4D9D"/>
      <text x="48" y="205" fill="#94A3B8" font-family="Segoe UI, Arial, sans-serif" font-weight="600" font-size="15">Gift Spinner</text>
      <circle cx="34" cy="244" r="4" fill="#34D399"/>
      <text x="48" y="249" fill="#94A3B8" font-family="Segoe UI, Arial, sans-serif" font-weight="600" font-size="15">Чат в голос</text>
      <circle cx="34" cy="288" r="4" fill="#C084FC"/>
      <text x="48" y="293" fill="#94A3B8" font-family="Segoe UI, Arial, sans-serif" font-weight="600" font-size="15">Web-оверлеи</text>
      <circle cx="34" cy="332" r="4" fill="#FBBF24"/>
      <text x="48" y="337" fill="#94A3B8" font-family="Segoe UI, Arial, sans-serif" font-weight="600" font-size="15">Minecraft</text>
      <circle cx="34" cy="376" r="4" fill="#38BDF8"/>
      <text x="48" y="381" fill="#94A3B8" font-family="Segoe UI, Arial, sans-serif" font-weight="600" font-size="15">Симулятор</text>

      <!-- Featured Active Game Banner inside Window -->
      <g transform="translate(204 88)">
        <rect width="632" height="176" rx="20" fill="url(#gameBannerGrad)" stroke="#C084FC" stroke-opacity="0.45" stroke-width="1.5"/>
        <!-- Decorative mini blocks tower on right of banner -->
        <g opacity="0.95" transform="translate(418 30)">
          <rect x="0" y="96" width="52" height="24" rx="5" fill="#22D3EE"/>
          <rect x="6" y="68" width="52" height="24" rx="5" fill="#38BDF8"/>
          <rect x="-4" y="40" width="52" height="24" rx="5" fill="#A855F7"/>
          <rect x="8" y="12" width="52" height="24" rx="5" fill="#FF4D9D"/>
          <rect x="70" y="96" width="52" height="24" rx="5" fill="#FB7185"/>
          <rect x="64" y="68" width="52" height="24" rx="5" fill="#F43F5E"/>
          <rect x="72" y="40" width="52" height="24" rx="5" fill="#FBBF24"/>
        </g>

        <rect x="24" y="22" width="146" height="28" rx="14" fill="#090D1A" fill-opacity="0.58"/>
        <text x="40" y="41" fill="#67E8F9" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="13">ОБНОВЛЕНО · v2.4</text>

        <text x="24" y="86" fill="#FFFFFF" font-family="Segoe UI, Arial, sans-serif" font-weight="800" font-size="29">GIFT TOWER · Битва чата</text>
        <text x="24" y="114" fill="#E9D5FF" font-family="Segoe UI, Arial, sans-serif" font-weight="500" font-size="15">Синие vs Красные — подарки строят башню в эфире</text>

        <rect x="24" y="128" width="162" height="34" rx="10" fill="#FFFFFF"/>
        <polygon points="44,139 55,145 44,151" fill="#4F46E5"/>
        <text x="64" y="151" fill="#1E1B4B" font-family="Segoe UI, Arial, sans-serif" font-weight="800" font-size="15">В эфире (OBS)</text>

        <rect x="198" y="128" width="150" height="34" rx="10" fill="#0F172A" fill-opacity="0.58" stroke="#E9D5FF" stroke-opacity="0.4"/>
        <text x="218" y="150" fill="#F8FAFC" font-family="Segoe UI, Arial, sans-serif" font-weight="600" font-size="14">Симулятор</text>
      </g>

      <!-- Trigger Mapper Section inside Window -->
      <text x="206" y="302" fill="#94A3B8" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="14" letter-spacing="1.4">АКТИВНЫЕ ПРАВИЛА СТРИМА (КОНСТРУКТОР БЕЗ КОДА)</text>

      <!-- Rule Row 1 -->
      <g transform="translate(204 318)">
        <rect width="632" height="74" rx="16" fill="#161932" stroke="#2E335A" stroke-width="1.4"/>
        <rect x="16" y="15" width="218" height="44" rx="11" fill="#2A1230" stroke="#FF4D9D" stroke-opacity="0.55"/>
        <circle cx="40" cy="37" r="8" fill="#FF4D9D"/>
        <text x="58" y="43" fill="#FCE7F3" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="16">Подарок: Роза x10</text>

        <line x1="248" y1="37" x2="286" y2="37" stroke="#22D3EE" stroke-width="3" stroke-linecap="round"/>
        <polygon points="284,30 298,37 284,44" fill="#22D3EE"/>

        <rect x="312" y="15" width="302" height="44" rx="11" fill="#1E1642" stroke="#8B5CF6" stroke-opacity="0.65"/>
        <text x="332" y="43" fill="#EDE9FE" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="16">Спавн Босса + Алерт в эфир</text>
      </g>

      <!-- Rule Row 2 -->
      <g transform="translate(204 406)">
        <rect width="632" height="74" rx="16" fill="#161932" stroke="#2E335A" stroke-width="1.4"/>
        <rect x="16" y="15" width="218" height="44" rx="11" fill="#291D12" stroke="#F59E0B" stroke-opacity="0.55"/>
        <circle cx="40" cy="37" r="8" fill="#FBBF24"/>
        <text x="58" y="43" fill="#FEF3C7" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="16">Донат от 100 ₽</text>

        <line x1="248" y1="37" x2="286" y2="37" stroke="#22D3EE" stroke-width="3" stroke-linecap="round"/>
        <polygon points="284,30 298,37 284,44" fill="#22D3EE"/>

        <rect x="312" y="15" width="302" height="44" rx="11" fill="#0E2936" stroke="#22D3EE" stroke-opacity="0.65"/>
        <text x="332" y="43" fill="#CFFAFE" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="16">Крутить Gift Spinner + TTS</text>
      </g>

      <!-- Rule Row 3 -->
      <g transform="translate(204 494)">
        <rect width="632" height="74" rx="16" fill="#161932" stroke="#2E335A" stroke-width="1.4"/>
        <rect x="16" y="15" width="218" height="44" rx="11" fill="#0D2824" stroke="#10B981" stroke-opacity="0.55"/>
        <circle cx="40" cy="37" r="8" fill="#34D399"/>
        <text x="58" y="43" fill="#D1FAE5" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="16">Чат: 100 лайков</text>

        <line x1="248" y1="37" x2="286" y2="37" stroke="#22D3EE" stroke-width="3" stroke-linecap="round"/>
        <polygon points="284,30 298,37 284,44" fill="#22D3EE"/>

        <rect x="312" y="15" width="302" height="44" rx="11" fill="#231942" stroke="#C084FC" stroke-opacity="0.65"/>
        <text x="332" y="43" fill="#F3E8FF" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="16">TNT-дождь на Minecraft-сервере</text>
      </g>

      <!-- Bottom Soundboard + TTS Strip inside Window -->
      <g transform="translate(204 588)">
        <rect width="632" height="128" rx="18" fill="#13162C" stroke="#262B4E" stroke-width="1.4"/>
        <text x="22" y="34" fill="#94A3B8" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="13" letter-spacing="1.2">ГОЛОСОВОЙ ЧАТ (TTS) И САУНДБОРД В ОДИН КЛИК</text>

        <!-- Soundwave equalizer bars -->
        <g transform="translate(24 54)">
          <rect x="0" y="18" width="8" height="28" rx="4" fill="#22D3EE"/>
          <rect x="14" y="6" width="8" height="40" rx="4" fill="#38BDF8"/>
          <rect x="28" y="14" width="8" height="32" rx="4" fill="#818CF8"/>
          <rect x="42" y="0" width="8" height="46" rx="4" fill="#A855F7"/>
          <rect x="56" y="10" width="8" height="36" rx="4" fill="#EC4899"/>
          <rect x="70" y="20" width="8" height="26" rx="4" fill="#FF4D9D"/>
          <rect x="84" y="8" width="8" height="38" rx="4" fill="#22D3EE"/>
        </g>

        <text x="136" y="76" fill="#F8FAFC" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="17">«@maksim_gg: Строим выше, поднажмите!»</text>
        <text x="136" y="101" fill="#64748B" font-family="Segoe UI, Arial, sans-serif" font-weight="600" font-size="14">Антиспам-фильтр активен · Очередь 0.4 сек · OBS Browser Source</text>
      </g>
    </g>

    <!-- Floating Overlapping Card 1 (Top-Right): Gift Spinner Wheel -->
    <g filter="url(#floatShadow)" transform="translate(1588 44)">
      <rect width="276" height="248" rx="24" fill="#13152B" stroke="url(#brandRim)" stroke-width="2.2"/>
      <text x="138" y="34" text-anchor="middle" fill="#F8FAFC" font-family="Segoe UI, Arial, sans-serif" font-weight="800" font-size="16" letter-spacing="1">GIFT SPINNER</text>
      <g transform="translate(138 142)">
        <circle cx="0" cy="0" r="92" fill="none" stroke="url(#brandRim)" stroke-width="4"/>
        ${wheelSlices}
        <circle cx="0" cy="0" r="22" fill="#0D0F1E" stroke="#FFFFFF" stroke-width="3"/>
        <circle cx="0" cy="0" r="8" fill="#22D3EE"/>
        <!-- Top pointer -->
        <polygon points="0,-74 -11,-98 11,-98" fill="#FFFFFF"/>
      </g>
    </g>

    <!-- Floating Overlapping Card 2 (Bottom-Left of Mockup): Live Viewer Event Toast -->
    <g filter="url(#floatShadow)" transform="translate(904 846)">
      <rect width="536" height="108" rx="22" fill="#14112A" stroke="#22D3EE" stroke-width="2"/>
      <circle cx="54" cy="54" r="30" fill="#2A143D" stroke="#FF3B8B" stroke-width="2"/>
      <polygon points="48,39 68,54 48,69" fill="#22D3EE"/>
      <text x="102" y="46" fill="#22D3EE" font-family="Segoe UI, Arial, sans-serif" font-weight="800" font-size="15" letter-spacing="0.8">СОБЫТИЕ В ЭФИРЕ · МГНОВЕННЫЙ ОТКЛИК</text>
      <text x="102" y="76" fill="#FFFFFF" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="19">@katya_live: Подарок Котик x5  (+25 блоков!)</text>
    </g>

    <!-- Subtle outer border glow -->
    <rect x="1" y="1" width="1918" height="1078" fill="none" stroke="url(#brandRim)" stroke-opacity="0.28" stroke-width="2"/>
  </g>`;
}

const inner = buildArtboardInner();

// Standalone 1920x1080 SVG
const standaloneSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">${inner}\n</svg>\n`;

// Padded 1920x1920 square SVG for Tauri's square icon rasterizer (y offset = 420)
const squareSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1920" viewBox="0 0 1920 1920">
  <rect width="1920" height="1920" fill="#070913"/>
  <g transform="translate(0 420)">${inner}</g>
</svg>\n`;

const outSvgPath = path.join(BRANDING_DIR, 'chlauncher-tg-post-cover.svg');
const tmpSqSvgPath = path.join(BRANDING_DIR, '.tmp-cover-sq.svg');
const tmpDir = path.join(BRANDING_DIR, '.tmp-cover-out');
const outPngPath = path.join(BRANDING_DIR, 'chlauncher-tg-post-cover.png');

fs.writeFileSync(outSvgPath, standaloneSvg);
fs.writeFileSync(tmpSqSvgPath, squareSvg);
fs.mkdirSync(tmpDir, { recursive: true });

if (process.platform === 'win32') {
  execFileSync('cmd.exe', ['/d', '/s', '/c', 'npx', 'tauri', 'icon', '-p', '1920', '-o', tmpDir, tmpSqSvgPath], {
    cwd: LAUNCHER_DIR,
    stdio: 'inherit',
  });
} else {
  execFileSync('npx', ['tauri', 'icon', '-p', '1920', '-o', tmpDir, tmpSqSvgPath], {
    cwd: LAUNCHER_DIR,
    stdio: 'inherit',
  });
}

// Decode 1920x1920, slice y = 420..1500 -> 1920x1080, apply 1-LSB triangular dither
const sqBuf = fs.readFileSync(path.join(tmpDir, '1920x1920.png'));
const { w, rgba } = decodePngRgba(sqBuf);
const H_OUT = 1080;
const Y_OFF = 420;
const cropped = Buffer.from(rgba.subarray(Y_OFF * w * 4, (Y_OFF + H_OUT) * w * 4));

// Deterministic PRNG for subtle anti-banding triangular dither
let seed = 0x9e3779b9;
function rand01() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) & 0xffff) / 65536;
}
for (let i = 0; i < cropped.length; i += 4) {
  const n = (rand01() - rand01()) * 1.1;
  cropped[i] = Math.max(0, Math.min(255, Math.round(cropped[i] + n)));
  cropped[i + 1] = Math.max(0, Math.min(255, Math.round(cropped[i + 1] + n)));
  cropped[i + 2] = Math.max(0, Math.min(255, Math.round(cropped[i + 2] + n)));
}

fs.writeFileSync(outPngPath, encodePngRgba(w, H_OUT, cropped));
fs.rmSync(tmpSqSvgPath, { force: true });
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('Wrote promo cover:', outPngPath);
