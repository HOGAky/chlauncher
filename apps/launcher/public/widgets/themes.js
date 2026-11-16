/* ============================================================
   THEMES — общая система стилей виджетов.
   Виджет вызывает:  TTW.apply('theme-key') или ?theme=key в URL.
   Элементы с классом .fx-text получают фирменный эффект темы
   (хром, 3D, неон и т.д.). Виджеты используют var(--a1..a3, --fd, --fb...).
   ============================================================ */
window.TTW = (function () {

  const GF = 'https://fonts.googleapis.com/css2?';

  // Заготовки текстовых эффектов
  const CHROME_TEXT = `
    .fx-text{
      background:linear-gradient(180deg,#ffffff 0%,#dde3e9 14%,#8d969f 30%,#fbfdff 46%,#eef2f6 50%,#59616b 62%,#e2e8ee 80%,#99a3ad 100%);
      -webkit-background-clip:text; background-clip:text;
      color:transparent !important; -webkit-text-stroke:0 !important;
      text-shadow:none !important;
      filter:drop-shadow(0 2px 0 #101317) drop-shadow(0 5px 1px rgba(0,0,0,.55)) drop-shadow(0 16px 26px rgba(0,0,0,.55));
    }`;
  const SPARKLES = `
    .stage::after{
      content:''; position:absolute; inset:0; pointer-events:none; z-index:50;
      background-image:
        radial-gradient(3px 3px at 12% 18%, #fff, transparent 60%),
        radial-gradient(4px 4px at 82% 12%, #fff, transparent 60%),
        radial-gradient(3px 3px at 68% 42%, #fff, transparent 60%),
        radial-gradient(4px 4px at 24% 58%, #fff, transparent 60%),
        radial-gradient(3px 3px at 90% 66%, #fff, transparent 60%),
        radial-gradient(5px 5px at 40% 82%, #fff, transparent 60%),
        radial-gradient(3px 3px at 8% 88%, #fff, transparent 60%);
      animation:ttwTwinkle 2.2s ease-in-out infinite;
    }
    @keyframes ttwTwinkle{0%,100%{opacity:.25}50%{opacity:.9}}`;

  const THEMES = {

    cyber: {
      label: 'Neon Cyber',
      fonts: 'family=Rubik+Mono+One&family=Share+Tech+Mono',
      fd: "'Rubik Mono One'", fb: "'Share Tech Mono'",
      vars: { a1:'#00f0ff', a2:'#b400ff', a3:'#ff00a8', ink:'#e8fbff', mut:'#7ee9ff', panel:'rgba(5,10,25,.78)', line:'#00f0ff', glow:'#00f0ff' },
      css: `.stage::before{content:'';position:absolute;inset:0;pointer-events:none;opacity:.12;
        background-image:linear-gradient(rgba(0,240,255,.5) 1px,transparent 1px),linear-gradient(90deg,rgba(0,240,255,.5) 1px,transparent 1px);
        background-size:60px 60px;
        mask-image:radial-gradient(ellipse at 50% 30%,#000 30%,transparent 75%);
        -webkit-mask-image:radial-gradient(ellipse at 50% 30%,#000 30%,transparent 75%);}`
    },

    comic: {
      label: 'Comic Fight',
      fonts: 'family=Bangers&family=Russo+One',
      fd: "'Bangers'", fb: "'Russo One'",
      vars: { a1:'#ffe14d', a2:'#ff4757', a3:'#1e90ff', ink:'#ffffff', mut:'#ffe14d', panel:'#141414', line:'#141414', glow:'rgba(0,0,0,.5)' },
      css: `.fx-text{-webkit-text-stroke:4px #141414;text-shadow:6px 6px 0 #141414}
        .stage::before{content:'';position:absolute;inset:0;pointer-events:none;opacity:.10;
        background-image:radial-gradient(#fff 2.5px,transparent 2.5px);background-size:24px 24px;}`
    },

    luxury: {
      label: 'Royal Gold',
      fonts: 'family=Playfair+Display:wght@700;800;900&family=Playfair+Display:ital,wght@1,600',
      fd: "'Playfair Display'", fb: "'Playfair Display'",
      vars: { a1:'#e9c860', a2:'#d4af37', a3:'#a67c1b', ink:'#f4e8c8', mut:'#b9a068', panel:'linear-gradient(165deg,rgba(22,20,18,.9),rgba(8,8,10,.94))', line:'rgba(212,175,55,.55)', glow:'rgba(212,175,55,.5)' },
      css: `.fx-text{background:linear-gradient(180deg,#fff3c4 0%,#e9c860 40%,#a67c1b 70%,#f5df9a 100%);
        -webkit-background-clip:text;background-clip:text;color:transparent!important;
        text-shadow:none!important;filter:drop-shadow(0 3px 6px rgba(0,0,0,.7));}`
    },

    bubble: {
      label: 'Y2K Bubble',
      fonts: 'family=Nunito:wght@800;900&family=Fredoka:wght@500;600;700',
      fd: "'Nunito'", fb: "'Fredoka'",
      vars: { a1:'#ff4fa8', a2:'#c9f74a', a3:'#9a5cff', ink:'#ffffff', mut:'#e3d1ff', panel:'linear-gradient(165deg,rgba(154,92,255,.92),rgba(84,44,180,.95))', line:'#ffffff', glow:'rgba(0,0,0,.35)' },
      css: `.fx-text{background:linear-gradient(180deg,#ffffff 0%,var(--a1) 45%,var(--a3) 100%);
        -webkit-background-clip:text;background-clip:text;color:transparent!important;
        -webkit-text-stroke:5px var(--a3);paint-order:stroke fill;
        text-shadow:none!important;
        filter:drop-shadow(0 8px 0 rgba(60,20,120,.9)) drop-shadow(0 16px 24px rgba(0,0,0,.5));}`
    },

    chrome: {
      label: 'Liquid Chrome',
      fonts: 'family=Bebas+Neue&family=Space+Grotesk:wght@400;600',
      fd: "'Bebas Neue'", fb: "'Space Grotesk'",
      vars: { a1:'#eef2f6', a2:'#8d969f', a3:'#ffffff', ink:'#f2f5f8', mut:'#9aa4ad', panel:'linear-gradient(170deg,rgba(18,20,24,.92),rgba(6,7,9,.95))', line:'rgba(220,228,236,.4)', glow:'rgba(255,255,255,.35)' },
      css: CHROME_TEXT + SPARKLES + `
        .stage::before{content:'';position:absolute;inset:0;pointer-events:none;z-index:1;
          background:radial-gradient(ellipse 90% 55% at 50% 0%,rgba(220,230,240,.10),transparent 60%),
                     radial-gradient(ellipse 80% 45% at 50% 105%,rgba(140,150,165,.10),transparent 60%);}`
    },

    thorns: {
      label: 'Dark Thorns',
      fonts: 'family=Ruslan+Display&family=Space+Grotesk:wght@400;600',
      fd: "'Ruslan Display'", fb: "'Space Grotesk'",
      vars: { a1:'#c8ccd2', a2:'#6b7078', a3:'#e8ecf1', ink:'#e8ecf1', mut:'#7d848e', panel:'linear-gradient(170deg,rgba(14,14,16,.94),rgba(4,4,6,.97))', line:'rgba(160,168,178,.35)', glow:'rgba(200,204,210,.3)' },
      css: `
        .fx-text{
          background:linear-gradient(180deg,#f4f6f9 0%,#b9bec6 20%,#5c6067 40%,#eef1f5 50%,#3a3d43 62%,#aab0b9 85%,#747a83 100%);
          -webkit-background-clip:text;background-clip:text;
          color:transparent!important;-webkit-text-stroke:0!important;
          letter-spacing:.04em;
          text-shadow:none!important;
          filter:drop-shadow(0 3px 0 #050608) drop-shadow(0 8px 4px rgba(0,0,0,.7)) drop-shadow(0 18px 30px rgba(0,0,0,.7));
        }
        .stage::before{content:'';position:absolute;inset:0;pointer-events:none;z-index:1;
          background:radial-gradient(ellipse 100% 60% at 50% 108%,rgba(0,0,0,.85),transparent 65%),
                     radial-gradient(ellipse 70% 35% at 50% -5%,rgba(180,190,205,.08),transparent 60%);}`
    },

    blood: {
      label: 'Blood Drip',
      fonts: 'family=Rubik+Wet+Paint&family=Space+Grotesk:wght@400;600',
      fd: "'Rubik Wet Paint'", fb: "'Space Grotesk'",
      filter: 'drip',
      vars: { a1:'#ff2b3a', a2:'#8b0000', a3:'#ffb3ba', ink:'#fff0f1', mut:'#d98a92', panel:'linear-gradient(170deg,rgba(26,8,10,.93),rgba(10,3,4,.96))', line:'rgba(255,60,75,.45)', glow:'rgba(255,40,60,.5)' },
      css: `
        .fx-text{
          background:linear-gradient(180deg,#ff97a0 0%,#ff2b3a 26%,#c40f1e 52%,#ff4a55 72%,#6d0007 100%);
          -webkit-background-clip:text;background-clip:text;
          color:transparent!important;-webkit-text-stroke:0!important;
          text-shadow:none!important;
          filter:drop-shadow(0 3px 0 #3d0004) drop-shadow(0 6px 0 #2b0003)
                 drop-shadow(0 12px 8px rgba(0,0,0,.65)) drop-shadow(0 0 30px rgba(255,30,50,.4))
                 drop-shadow(0 24px 34px rgba(0,0,0,.65));
        }`
    },

    glitz: {
      label: 'Pink Glitz',
      fonts: 'family=Bungee&family=Space+Grotesk:wght@400;600',
      fd: "'Bungee'", fb: "'Space Grotesk'",
      vars: { a1:'#ff6ec7', a2:'#e9c860', a3:'#ffb3e2', ink:'#ffeef8', mut:'#e8a9d0', panel:'linear-gradient(170deg,rgba(30,8,24,.93),rgba(12,3,10,.96))', line:'rgba(255,140,210,.45)', glow:'rgba(255,110,199,.5)' },
      css: `
        .fx-text{
          background:linear-gradient(180deg,#fff 0%,#ffd7ef 15%,#ff8ad4 32%,#fff0f9 48%,#ff5fc0 60%,#b3127a 78%,#ff9bdd 95%);
          -webkit-background-clip:text;background-clip:text;
          color:transparent!important;-webkit-text-stroke:0!important;
          text-shadow:none!important;
          filter:drop-shadow(0 2px 0 #4d0733) drop-shadow(0 6px 2px rgba(0,0,0,.5)) drop-shadow(0 16px 26px rgba(0,0,0,.55))
                 drop-shadow(0 0 26px rgba(255,110,199,.45));
        }` + SPARKLES
    },

    vapor: {
      label: 'Vaporwave',
      fonts: 'family=Russo+One&family=Space+Grotesk:wght@400;600',
      fd: "'Russo One'", fb: "'Space Grotesk'",
      vars: { a1:'#ff71ce', a2:'#01cdfe', a3:'#fffb96', ink:'#fdf2ff', mut:'#b392d9', panel:'linear-gradient(170deg,rgba(36,10,60,.9),rgba(10,4,24,.95))', line:'rgba(1,205,254,.5)', glow:'rgba(255,113,206,.6)' },
      css: `
        .fx-text{color:var(--a1)!important;text-shadow:0 0 8px var(--a1),0 0 26px var(--a1),0 0 60px var(--a2)!important;-webkit-text-stroke:0!important}
        .stage::before{content:'';position:absolute;left:-20%;right:-20%;bottom:0;height:42%;pointer-events:none;
          background-image:linear-gradient(rgba(1,205,254,.35) 2px,transparent 2px),linear-gradient(90deg,rgba(1,205,254,.35) 2px,transparent 2px);
          background-size:90px 90px;transform:perspective(500px) rotateX(62deg);transform-origin:top center;
          mask-image:linear-gradient(180deg,transparent,#000 40%);-webkit-mask-image:linear-gradient(180deg,transparent,#000 40%);}
        .stage::after{content:'';position:absolute;left:50%;bottom:34%;width:420px;height:420px;transform:translateX(-50%);pointer-events:none;
          border-radius:50%;opacity:.28;
          background:linear-gradient(180deg,#fffb96,#ff71ce 55%,#01cdfe);
          mask-image:linear-gradient(180deg,#000 55%,transparent 56%,#000 58%,transparent 62%,#000 64%,transparent 70%,#000 72%);
          -webkit-mask-image:linear-gradient(180deg,#000 55%,transparent 56%,#000 58%,transparent 62%,#000 64%,transparent 70%,#000 72%);}`
    },

    slime: {
      label: 'Toxic Slime',
      fonts: 'family=Rubik+Puddles&family=Space+Grotesk:wght@400;600',
      fd: "'Rubik Puddles'", fb: "'Space Grotesk'",
      filter: 'melt',
      vars: { a1:'#a8ff00', a2:'#39ff14', a3:'#e4ffa1', ink:'#eeffd2', mut:'#9db87a', panel:'linear-gradient(170deg,rgba(16,26,8,.92),rgba(6,10,3,.96))', line:'rgba(168,255,0,.45)', glow:'rgba(120,255,0,.5)' },
      css: `.fx-text{color:var(--a1)!important;-webkit-text-stroke:0!important;
        text-shadow:0 0 18px rgba(120,255,0,.6),0 6px 0 rgba(30,60,0,.9),0 14px 22px rgba(0,0,0,.6)!important;}
        .stage::before{content:'';position:absolute;inset:0;pointer-events:none;opacity:.15;
          background-image:radial-gradient(rgba(168,255,0,.7) 2px,transparent 2.5px);background-size:34px 34px;}`
    },

    fire: {
      label: 'Hellfire',
      fonts: 'family=Rubik+Distressed&family=Space+Grotesk:wght@400;600',
      fd: "'Rubik Distressed'", fb: "'Space Grotesk'",
      vars: { a1:'#ffb03a', a2:'#ff5722', a3:'#ffe9a3', ink:'#fff3e0', mut:'#d99a6c', panel:'linear-gradient(170deg,rgba(30,10,4,.93),rgba(12,4,2,.97))', line:'rgba(255,140,50,.45)', glow:'rgba(255,120,30,.55)' },
      css: `.fx-text{color:var(--a3)!important;-webkit-text-stroke:0!important;
        text-shadow:0 0 12px rgba(255,160,40,.8),0 0 40px rgba(255,80,20,.6),0 8px 4px rgba(60,10,0,.9)!important;
        animation:ttwFire 1.4s ease-in-out infinite alternate;}
        @keyframes ttwFire{from{text-shadow:0 0 12px rgba(255,160,40,.8),0 0 40px rgba(255,80,20,.6),0 8px 4px rgba(60,10,0,.9)}
        to{text-shadow:0 0 18px rgba(255,190,60,1),0 0 60px rgba(255,100,20,.8),0 8px 4px rgba(60,10,0,.9)}}`
    },

    nosferatu: {
      label: 'Nosferatu (кровь)',
      fonts: 'family=Rubik+Wet+Paint&family=Space+Grotesk:wght@400;600',
      fd: "'Rubik Wet Paint'", fb: "'Space Grotesk'",
      filter: 'drip',
      vars: { a1:'#e8152b', a2:'#8b0000', a3:'#ff6b7a', ink:'#ffe9ea', mut:'#c47a80', panel:'linear-gradient(170deg,rgba(24,4,6,.94),rgba(8,2,3,.97))', line:'rgba(220,30,45,.45)', glow:'rgba(220,20,40,.55)' },
      css: `.fx-text{color:var(--a1)!important;-webkit-text-stroke:0!important;
        filter:url(#ttwDrip) drop-shadow(0 0 22px rgba(220,20,40,.65)) drop-shadow(0 8px 0 rgba(50,0,4,.95)) drop-shadow(0 18px 28px rgba(0,0,0,.8))!important;
        text-shadow:none!important;}
        .stage::before{content:'';position:absolute;inset:0;pointer-events:none;z-index:1;
          background:radial-gradient(ellipse 90% 50% at 50% 110%,rgba(120,0,8,.35),transparent 65%),
                     radial-gradient(ellipse 60% 30% at 50% -8%,rgba(160,10,20,.18),transparent 60%);}`
    },

    nightmare: {
      label: 'Nightmare (царапины)',
      fonts: 'family=Rubik+Broken+Fax&family=Space+Grotesk:wght@400;600',
      fd: "'Rubik Broken Fax'", fb: "'Space Grotesk'",
      filter: 'ragged',
      vars: { a1:'#f2f2f2', a2:'#b3121f', a3:'#8d96a3', ink:'#f2f2f2', mut:'#8d96a3', panel:'linear-gradient(170deg,rgba(14,14,16,.93),rgba(5,5,6,.97))', line:'rgba(200,200,205,.3)', glow:'rgba(255,255,255,.25)' },
      css: `.fx-text{color:var(--a1)!important;-webkit-text-stroke:0!important;
          filter:url(#ttwRagged) drop-shadow(0 4px 0 #000) drop-shadow(0 10px 18px rgba(0,0,0,.85)) drop-shadow(0 0 34px rgba(179,18,31,.35))!important;
          text-shadow:none!important;
          letter-spacing:.06em;}
        .stage::before{content:'';position:absolute;inset:0;pointer-events:none;opacity:.10;
          background:repeating-linear-gradient(105deg,#fff 0 2px,transparent 2px 90px),
                     repeating-linear-gradient(-75deg,#fff 0 2px,transparent 2px 120px);}
        .stage::after{content:'';position:absolute;inset:0;pointer-events:none;
          background:radial-gradient(ellipse 100% 70% at 50% 50%,transparent 55%,rgba(0,0,0,.75));}`
    },

    zombie: {
      label: 'Zombie (гниль)',
      fonts: 'family=Rubik+Dirt&family=Space+Grotesk:wght@400;600',
      fd: "'Rubik Dirt'", fb: "'Space Grotesk'",
      filter: 'melt',
      vars: { a1:'#8fd400', a2:'#4a7c0f', a3:'#d4ff7a', ink:'#e8f5d8', mut:'#8fa374', panel:'linear-gradient(170deg,rgba(14,20,8,.94),rgba(5,8,3,.97))', line:'rgba(143,212,0,.4)', glow:'rgba(143,212,0,.5)' },
      css: `.fx-text{color:var(--a1)!important;-webkit-text-stroke:0!important;
        filter:url(#ttwMelt) drop-shadow(0 0 20px rgba(143,212,0,.5)) drop-shadow(0 7px 0 rgba(20,40,0,.95)) drop-shadow(0 16px 26px rgba(0,0,0,.8))!important;
        text-shadow:none!important;}
        .stage::before{content:'';position:absolute;inset:0;pointer-events:none;opacity:.13;
          background-image:radial-gradient(rgba(143,212,0,.8) 2px,transparent 2.6px),
                           radial-gradient(rgba(60,120,20,.8) 3px,transparent 3.6px);
          background-size:46px 46px,90px 90px;background-position:0 0,23px 40px;}`
    },

    witcher: {
      label: 'Witcher (зависть)',
      fonts: 'family=Rubik+Moonrocks&family=Space+Grotesk:wght@400;600',
      fd: "'Rubik Moonrocks'", fb: "'Space Grotesk'",
      filter: 'ragged',
      vars: { a1:'#c9e8b8', a2:'#7fa86b', a3:'#eaffdd', ink:'#e8f5dc', mut:'#8fa380', panel:'linear-gradient(170deg,rgba(16,18,14,.93),rgba(6,8,5,.97))', line:'rgba(201,232,184,.35)', glow:'rgba(201,232,184,.35)' },
      css: `.fx-text{color:var(--a1)!important;-webkit-text-stroke:0!important;
        filter:url(#ttwRagged) drop-shadow(0 0 18px rgba(201,232,184,.5)) drop-shadow(0 5px 0 rgba(30,40,20,.95)) drop-shadow(0 14px 22px rgba(0,0,0,.8))!important;
        text-shadow:none!important;
        letter-spacing:.08em;}
        .stage::before{content:'';position:absolute;inset:0;pointer-events:none;
          background:radial-gradient(ellipse 70% 45% at 50% 108%,rgba(120,160,90,.14),transparent 65%),
                     radial-gradient(ellipse 100% 70% at 50% 50%,transparent 60%,rgba(0,0,0,.7));}`
    },

    minimal: {
      label: 'Ghost Clean',
      fonts: 'family=Space+Grotesk:wght@500;700&family=Inter:wght@400;600',
      fd: "'Space Grotesk'", fb: "'Inter'",
      vars: { a1:'#ffffff', a2:'#c8ccd2', a3:'#8d96a3', ink:'#f4f6f8', mut:'#8d96a3', panel:'rgba(16,18,24,.72)', line:'rgba(255,255,255,.22)', glow:'rgba(0,0,0,.4)' },
      css: `.fx-text{letter-spacing:.02em}`
    },

    pixel: {
      label: 'Pixel 8-bit',
      fonts: 'family=Press+Start+2P&family=VT323',
      fd: "'Press Start 2P'", fb: "'VT323'",
      vars: { a1:'#7cfc00', a2:'#ffde59', a3:'#5ce1e6', ink:'#e8ffe0', mut:'#9fd66a', panel:'rgba(10,16,6,.92)', line:'#7cfc00', glow:'#7cfc00' },
      css: `.fx-text{color:var(--a1);
        text-shadow:0 8px 0 #1a3a08,8px 8px 0 #0c1d04,0 0 26px rgba(124,252,0,.45)!important;}
        .stage::before{content:'';position:absolute;inset:0;pointer-events:none;opacity:.14;
          background-image:repeating-linear-gradient(0deg,#000 0 3px,transparent 3px 6px);}`
    },

    holo: {
      label: 'Holo Foil',
      fonts: 'family=Unbounded:wght@700;900&family=Rubik:wght@600;800',
      fd: "'Unbounded'", fb: "'Rubik'",
      vars: { a1:'#a8e6ff', a2:'#d5a6ff', a3:'#ffd6f5', ink:'#f4faff', mut:'#9db8d6', panel:'linear-gradient(160deg,rgba(20,24,40,.9),rgba(8,10,18,.95))', line:'rgba(184,200,255,.45)', glow:'#a8e6ff' },
      css: `.fx-text{background:linear-gradient(110deg,#8fe3ff 0%,#d5a6ff 25%,#ffd6f5 50%,#a8ffe0 75%,#8fe3ff 100%);
        background-size:300% 100%;-webkit-background-clip:text;background-clip:text;
        color:transparent!important;-webkit-text-stroke:0!important;text-shadow:none!important;
        filter:drop-shadow(0 4px 0 rgba(10,14,30,.9)) drop-shadow(0 14px 24px rgba(0,0,0,.6));
        animation:ttwHolo 6s linear infinite}
        @keyframes ttwHolo{to{background-position:300% 0}}`
    },

    matrix: {
      label: 'Matrix Rain',
      fonts: 'family=Rubik+Glitch&family=Share+Tech+Mono',
      fd: "'Rubik Glitch'", fb: "'Share Tech Mono'",
      vars: { a1:'#00ff41', a2:'#008f11', a3:'#b4ffc4', ink:'#d8ffe0', mut:'#5da86b', panel:'rgba(2,12,4,.9)', line:'#00ff41', glow:'#00ff41' },
      css: `.fx-text{color:#d8ffe0;
        text-shadow:0 0 12px #00ff41,0 0 36px rgba(0,255,65,.7),0 5px 0 #003b0e!important;}
        .stage::before{content:'';position:absolute;inset:0;pointer-events:none;opacity:.2;
          background-image:repeating-linear-gradient(90deg,rgba(0,255,65,.22) 0 2px,transparent 2px 42px),
                           repeating-linear-gradient(0deg,rgba(0,255,65,.08) 0 14px,transparent 14px 90px);
          mask-image:linear-gradient(180deg,transparent,#000 20%,#000 80%,transparent);
          -webkit-mask-image:linear-gradient(180deg,transparent,#000 20%,#000 80%,transparent);}`
    },

    ice: {
      label: 'Ice Crystal',
      fonts: 'family=Iceberg&family=Exo+2:wght@600;800',
      fd: "'Iceberg'", fb: "'Exo 2'",
      vars: { a1:'#a5e8ff', a2:'#4aa8d8', a3:'#ffffff', ink:'#eefaff', mut:'#8fc3dd', panel:'linear-gradient(170deg,rgba(20,40,60,.85),rgba(8,18,30,.92))', line:'rgba(165,232,255,.45)', glow:'#a5e8ff' },
      css: `.fx-text{background:linear-gradient(180deg,#ffffff 0%,#c8ecff 30%,#6db8e8 55%,#dff4ff 75%,#9fd4f0 100%);
        -webkit-background-clip:text;background-clip:text;color:transparent!important;-webkit-text-stroke:0!important;
        text-shadow:none!important;
        filter:drop-shadow(0 3px 0 #0a2030) drop-shadow(0 12px 22px rgba(0,0,0,.6));}
        .stage::before{content:'';position:absolute;inset:0;pointer-events:none;
          background:radial-gradient(ellipse 90% 55% at 50% 0%,rgba(165,232,255,.14),transparent 60%);}`
    },

    sakura: {
      label: 'Sakura',
      fonts: 'family=Caveat:wght@700&family=Neucha',
      fd: "'Caveat'", fb: "'Neucha'",
      vars: { a1:'#ffb7d5', a2:'#ff7eb0', a3:'#fff0a8', ink:'#fff5fa', mut:'#e8a8c4', panel:'linear-gradient(165deg,rgba(60,20,40,.85),rgba(30,10,25,.9))', line:'rgba(255,183,213,.45)', glow:'#ffb7d5' },
      css: `.fx-text{color:#fff0f6;-webkit-text-stroke:2px rgba(255,110,170,.55);
        text-shadow:0 6px 0 rgba(150,40,90,.7),0 16px 32px rgba(0,0,0,.5)!important;}
        .stage::before{content:'';position:absolute;inset:0;pointer-events:none;opacity:.3;
          background-image:radial-gradient(8px 5px at 18% 14%,#ffb7d5 60%,transparent),
                           radial-gradient(6px 4px at 76% 22%,#ffd6e8 60%,transparent),
                           radial-gradient(7px 5px at 52% 8%,#ff9ec6 60%,transparent),
                           radial-gradient(6px 4px at 88% 46%,#ffb7d5 60%,transparent);}`
    },

    bullion: {
      label: '3D Gold Bar',
      fonts: 'family=Bebas+Neue&family=Oswald:wght@600',
      fd: "'Bebas Neue'", fb: "'Oswald'",
      vars: { a1:'#ffd94a', a2:'#c98a00', a3:'#fff3b0', ink:'#fff6d8', mut:'#c9a84c', panel:'linear-gradient(170deg,rgba(40,28,4,.92),rgba(16,10,2,.95))', line:'#ffd94a', glow:'#ffd94a' },
      css: `.fx-text{background:linear-gradient(180deg,#fff8c8 0%,#ffd94a 30%,#a86e00 52%,#ffe98a 58%,#8a5c00 100%);
        -webkit-background-clip:text;background-clip:text;color:transparent!important;-webkit-text-stroke:0!important;
        text-shadow:none!important;
        filter:drop-shadow(0 4px 0 #241600) drop-shadow(0 10px 2px rgba(0,0,0,.6)) drop-shadow(0 22px 32px rgba(0,0,0,.6));}
        .stage::before{content:'';position:absolute;inset:0;pointer-events:none;opacity:.15;
          background:conic-gradient(from 200deg at 50% -10%,transparent 40%,#ffd94a 50%,transparent 60%);}`
    },

    paper: {
      label: 'Craft Paper',
      fonts: 'family=Neucha&family=Rubik:wght@700',
      fd: "'Neucha'", fb: "'Rubik'",
      vars: { a1:'#e8c07a', a2:'#a8743a', a3:'#f5e6c8', ink:'#f7ecd2', mut:'#c9a878', panel:'linear-gradient(170deg,#3d2e1c,#241a10)', line:'#e8c07a', glow:'rgba(232,192,122,.4)' },
      css: `.fx-text{color:#f7ecd2;
        text-shadow:3px 3px 0 #1a120a,6px 6px 0 rgba(0,0,0,.35)!important;letter-spacing:.03em}
        .stage::before{content:'';position:absolute;inset:0;pointer-events:none;opacity:.12;
          background-image:radial-gradient(#e8c07a 1.5px,transparent 1.5px);background-size:18px 18px;}`
    },

    vhs: {
      label: 'VHS Retro',
      fonts: 'family=Rubik+Mono+One&family=VT323',
      fd: "'Rubik Mono One'", fb: "'VT323'",
      vars: { a1:'#ff2975', a2:'#00e5ff', a3:'#ffe74c', ink:'#f0f0f0', mut:'#8a8a9a', panel:'rgba(12,10,20,.9)', line:'#ff2975', glow:'#ff2975' },
      css: `.fx-text{color:#f0f0f0;
        text-shadow:-4px 0 0 #ff2975,4px 0 0 #00e5ff,0 6px 0 rgba(0,0,0,.8)!important;}
        .stage::before{content:'';position:absolute;inset:0;pointer-events:none;opacity:.16;
          background-image:repeating-linear-gradient(0deg,#000 0 2px,transparent 2px 5px);}
        .stage::after{content:'';position:absolute;inset:0;pointer-events:none;
          background:radial-gradient(ellipse 100% 100% at 50% 50%,transparent 62%,rgba(0,0,0,.75));}`
    }
  };

  /* Фирменные декорации тем — доп. слои поверх базового css.
     ::before/::after уже занятые темой не трогаем, либо дополняем их здесь. */

  // Никнеймы и заголовки всех виджетов — именно БУКВЫ стекают кровью
  // (SVG-фильтр deforms the glyph edges, как на референсах), а не плашки.
  const NAMES = `.stage .fx-text,.stage .m-nick,.stage .e-nick,.stage .nick,.stage .rnick,.stage .gift-name,.stage .donor`;
  const AVAS = `.stage .ava,.stage .k-ava,.stage .m-ava,.stage .a-ava,.stage .mini-ava,.stage .king-ava`;
  const bleedCss = (filterId, shadowColor, glowColor, poolColor) => `
      ${NAMES}{filter:url(${filterId}) drop-shadow(0 3px 0 ${shadowColor}) drop-shadow(0 12px 16px rgba(0,0,0,.7))!important}
      ${AVAS}{border-color:${glowColor}!important;
        box-shadow:0 0 28px ${glowColor},0 0 8px ${glowColor},0 10px 24px rgba(0,0,0,.5)!important}
      .stage::after{content:'';position:absolute;left:0;right:0;bottom:0;height:24%;pointer-events:none;
        background:radial-gradient(ellipse 85% 55% at 50% 115%,${poolColor},transparent 65%)}`;
  // Лепесток сакуры (data-uri SVG).
  const PETAL = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='26' height='18' viewBox='0 0 26 18'%3E%3Cpath d='M13 1c6 2 10 4 12 8-2 4-6 6-12 8C7 15 3 13 1 9 3 5 7 3 13 1Z' fill='%23ffb7d5'/%3E%3Cpath d='M13 1c-1 5-1 10 0 15' stroke='%23ff8fc0' stroke-width='1' fill='none'/%3E%3C/svg%3E")`;

  const EXTRAS = {
    cyber: `.stage::after{content:'';position:absolute;left:0;right:0;top:-12%;height:10%;pointer-events:none;
      background:linear-gradient(180deg,transparent,rgba(0,240,255,.16) 70%,rgba(0,240,255,.5));
      animation:ttwScan 5s linear infinite}
      @keyframes ttwScan{to{transform:translateY(1400%)}}`,

    comic: `.stage::after{content:'';position:absolute;left:50%;top:34%;width:900px;height:900px;
      transform:translate(-50%,-50%);pointer-events:none;opacity:.14;
      background:conic-gradient(from 0deg,#ffe14d 0 12deg,transparent 12deg 24deg);
      border-radius:50%;animation:ttwSpin 60s linear infinite}
      @keyframes ttwSpin{to{transform:translate(-50%,-50%) rotate(360deg)}}`,

    luxury: `.stage::after{content:'';position:absolute;inset:0;pointer-events:none;
      background-image:radial-gradient(2.5px 2.5px at 20% 80%,#ffe9a3,transparent 60%),
        radial-gradient(3px 3px at 60% 88%,#e9c860,transparent 60%),
        radial-gradient(2px 2px at 82% 76%,#fff3c4,transparent 60%),
        radial-gradient(2.5px 2.5px at 38% 92%,#e9c860,transparent 60%);
      animation:ttwRise 9s linear infinite}
      @keyframes ttwRise{to{background-position:0 -600px,0 -700px,0 -500px,0 -650px}}`,

    bubble: `.stage::after{content:'';position:absolute;inset:0;pointer-events:none;
      background-image:radial-gradient(22px 22px at 16% 90%,rgba(255,255,255,.25),transparent 70%),
        radial-gradient(14px 14px at 70% 95%,rgba(255,255,255,.2),transparent 70%),
        radial-gradient(28px 28px at 88% 85%,rgba(255,255,255,.18),transparent 70%),
        radial-gradient(12px 12px at 40% 98%,rgba(255,255,255,.22),transparent 70%);
      animation:ttwRise 7s linear infinite}
      @keyframes ttwRise{to{background-position:0 -900px,0 -800px,0 -950px,0 -700px}}`,

    chrome: `.fx-text{background-size:100% 220%!important;animation:ttwLiquid 5s ease-in-out infinite alternate}
      @keyframes ttwLiquid{to{background-position:0 100%}}`,

    thorns: `.stage::after{content:'';position:absolute;inset:-10%;pointer-events:none;
      background:radial-gradient(ellipse 40% 26% at 22% 78%,rgba(120,130,145,.10),transparent 65%),
        radial-gradient(ellipse 45% 30% at 78% 70%,rgba(90,100,115,.10),transparent 65%);
      animation:ttwDrift 16s ease-in-out infinite alternate}
      @keyframes ttwDrift{to{transform:translateX(4%) scale(1.05)}}`,

    blood: `.stage::before{content:'';position:absolute;inset:0;pointer-events:none;
      background-image:radial-gradient(circle 34px at 14% 82%,rgba(139,0,0,.28),transparent 65%),
        radial-gradient(circle 22px at 84% 74%,rgba(160,10,20,.25),transparent 65%),
        radial-gradient(circle 16px at 60% 90%,rgba(139,0,0,.3),transparent 65%),
        radial-gradient(3px 3px at 30% 60%,rgba(255,60,75,.5),transparent 60%),
        radial-gradient(2px 2px at 72% 52%,rgba(255,60,75,.5),transparent 60%),
        radial-gradient(2.5px 2.5px at 48% 68%,rgba(255,60,75,.45),transparent 60%);}`
      + bleedCss('#ttwDrip', '#3d0004', 'rgba(220,20,40,.6)', 'rgba(109,0,7,.5)'),

    glitz: `.stage::before{content:'';position:absolute;inset:0;pointer-events:none;
      background-image:radial-gradient(10px 10px at 18% 20%,rgba(255,110,199,.3),transparent 70%),
        radial-gradient(7px 7px at 80% 30%,rgba(233,200,96,.28),transparent 70%),
        radial-gradient(9px 9px at 60% 76%,rgba(255,110,199,.22),transparent 70%),
        radial-gradient(6px 6px at 32% 84%,rgba(255,179,226,.3),transparent 70%);
      animation:ttwDrift 12s ease-in-out infinite alternate}`,

    vapor: `.fx-text{animation:ttwFlicker 4s steps(1) infinite}
      @keyframes ttwFlicker{0%,92%,100%{opacity:1}93%{opacity:.75}94%{opacity:1}96%{opacity:.6}}`,

    slime: bleedCss('#ttwMelt', '#1e3a00', 'rgba(143,212,0,.55)', 'rgba(46,92,0,.45)'),

    fire: `.stage::before{content:'';position:absolute;inset:0;pointer-events:none;
      background-image:radial-gradient(3px 3px at 22% 92%,#ffb03a,transparent 60%),
        radial-gradient(2.5px 2.5px at 55% 96%,#ff5722,transparent 60%),
        radial-gradient(3.5px 3.5px at 78% 90%,#ffe9a3,transparent 60%),
        radial-gradient(2px 2px at 38% 98%,#ff8a3d,transparent 60%);
      animation:ttwRise 6s linear infinite}
      .stage::after{content:'';position:absolute;left:0;right:0;bottom:0;height:34%;pointer-events:none;
      background:radial-gradient(ellipse 80% 60% at 50% 110%,rgba(255,90,20,.35),transparent 70%);
      animation:ttwEmberGlow 1.6s ease-in-out infinite alternate}
      @keyframes ttwRise{to{background-position:0 -700px,0 -800px,0 -650px,0 -750px}}
      @keyframes ttwEmberGlow{to{opacity:.55}}`,

    nosferatu: bleedCss('#ttwDrip', '#1a0002', 'rgba(220,20,40,.6)', 'rgba(90,0,10,.5)'),

    nightmare: `.fx-text{animation:ttwJit 3s steps(2) infinite}
      @keyframes ttwJit{0%,94%,100%{transform:translate(0,0)}95%{transform:translate(-3px,1px)}97%{transform:translate(3px,-1px)}}`,

    zombie: `${NAMES}{filter:url(#ttwMelt) drop-shadow(0 3px 0 #14290a) drop-shadow(0 10px 14px rgba(0,0,0,.7))!important}
      ${AVAS}{border-color:rgba(143,212,0,.55)!important;box-shadow:0 0 26px rgba(143,212,0,.5),0 10px 24px rgba(0,0,0,.5)!important}
      .stage::after{content:'';position:absolute;inset:-8%;pointer-events:none;
      background:radial-gradient(ellipse 44% 28% at 26% 82%,rgba(143,212,0,.10),transparent 65%),
        radial-gradient(ellipse 40% 30% at 76% 76%,rgba(74,124,15,.12),transparent 65%);
      animation:ttwDrift 14s ease-in-out infinite alternate}`,

    witcher: `${NAMES}{filter:url(#ttwRagged) drop-shadow(0 3px 0 #0c1408) drop-shadow(0 10px 14px rgba(0,0,0,.7))!important}
      ${AVAS}{border-color:rgba(201,232,184,.5)!important;box-shadow:0 0 24px rgba(201,232,184,.45),0 10px 24px rgba(0,0,0,.5)!important}
      .stage::after{content:'';position:absolute;inset:0;pointer-events:none;
      background-image:radial-gradient(2.5px 2.5px at 26% 88%,#c9e8b8,transparent 60%),
        radial-gradient(3px 3px at 58% 94%,#eaffdd,transparent 60%),
        radial-gradient(2px 2px at 84% 84%,#a8d490,transparent 60%);
      animation:ttwRise 10s linear infinite}`,

    minimal: `.stage::after{content:'';position:absolute;inset:0;pointer-events:none;
      background:radial-gradient(ellipse 70% 50% at 50% 45%,rgba(255,255,255,.04),transparent 70%);
      animation:ttwBreathe 6s ease-in-out infinite alternate}
      @keyframes ttwBreathe{to{opacity:.35}}`,

    pixel: `.stage::after{content:'';position:absolute;inset:0;pointer-events:none;
      background:rgba(255,255,255,.02);animation:ttwCrt .14s steps(2) infinite}
      @keyframes ttwCrt{50%{opacity:.4}}`,

    holo: `.stage::before{content:'';position:absolute;left:-30%;top:0;bottom:0;width:26%;pointer-events:none;
      background:linear-gradient(100deg,transparent,rgba(255,255,255,.16) 45%,rgba(168,230,255,.22) 55%,transparent);
      transform:skewX(-18deg);animation:ttwSheen 7s ease-in-out infinite}
      @keyframes ttwSheen{0%,55%{transform:skewX(-18deg) translateX(0)}100%{transform:skewX(-18deg) translateX(560%)}}`,

    matrix: `.stage::after{content:'';position:absolute;inset:0;pointer-events:none;opacity:.30;
      background-image:repeating-linear-gradient(90deg,rgba(0,255,65,.5) 0 3px,transparent 3px 46px),
        repeating-linear-gradient(0deg,#00ff41 0 14px,transparent 14px 90px);
      background-size:100% 100%;animation:ttwRain 1.8s linear infinite}
      @keyframes ttwRain{to{background-position:0 90px,0 90px}}`,

    ice: `.stage::after{content:'';position:absolute;inset:0;pointer-events:none;
      background-image:radial-gradient(2.5px 2.5px at 16% 6%,#fff,transparent 60%),
        radial-gradient(3px 3px at 46% 12%,#dff4ff,transparent 60%),
        radial-gradient(2px 2px at 76% 4%,#fff,transparent 60%),
        radial-gradient(2.5px 2.5px at 90% 14%,#c8ecff,transparent 60%),
        radial-gradient(2px 2px at 30% 16%,#fff,transparent 60%);
      animation:ttwSnow 8s linear infinite}
      @keyframes ttwSnow{to{background-position:0 900px,20px 980px,-14px 860px,10px 940px,-8px 900px}}`,

    sakura: `.stage::after{content:'';position:absolute;inset:0;pointer-events:none;
      background-image:${PETAL},${PETAL},${PETAL},${PETAL},${PETAL};
      background-size:34px 24px,26px 18px,30px 21px,22px 15px,38px 26px;
      background-position:12% -40px,34% -90px,58% -30px,78% -110px,92% -60px;
      background-repeat:no-repeat;
      animation:ttwPetals 9s linear infinite}
      @keyframes ttwPetals{
        0%{background-position:12% -40px,34% -90px,58% -30px,78% -110px,92% -60px}
        50%{background-position:10% 52%,38% 46%,54% 58%,82% 48%,90% 62%}
        100%{background-position:14% 108%,30% 104%,60% 112%,76% 106%,94% 110%}}`,

    bullion: `.stage::after{content:'';position:absolute;inset:0;pointer-events:none;
      background-image:radial-gradient(2.5px 2.5px at 24% 86%,#ffd94a,transparent 60%),
        radial-gradient(3px 3px at 62% 92%,#fff3b0,transparent 60%),
        radial-gradient(2px 2px at 84% 80%,#ffd94a,transparent 60%),
        radial-gradient(2.5px 2.5px at 42% 96%,#ffe98a,transparent 60%);
      animation:ttwRise 8s linear infinite}`,

    paper: `.stage::after{content:'';position:absolute;inset:0;pointer-events:none;
      background-image:linear-gradient(45deg,transparent 46%,rgba(232,192,122,.5) 46%,rgba(232,192,122,.5) 54%,transparent 54%),
        linear-gradient(-45deg,transparent 46%,rgba(232,192,122,.4) 46%,rgba(232,192,122,.4) 54%,transparent 54%);
      background-size:340px 340px,300px 300px;background-position:-120px -160px,calc(100% + 140px) -140px;
      background-repeat:no-repeat}`,

    vhs: `.fx-text{animation:ttwVhsJit 4s steps(1) infinite}
      @keyframes ttwVhsJit{0%,90%,100%{transform:translate(0)}91%{transform:translate(-6px,0)}93%{transform:translate(5px,0)}95%{transform:translate(0)}}`,
  };

  /* SVG-фильтры для «живых» контуров букв (рваные/капающие края) */
  const FILTERS_SVG = `
    <svg width="0" height="0" style="position:absolute" aria-hidden="true">
      <defs>
        <filter id="ttwRagged" x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.02 0.045" numOctaves="3" seed="7" result="n"/>
          <feDisplacementMap in="SourceGraphic" in2="n" scale="16" xChannelSelector="R" yChannelSelector="G"/>
        </filter>
        <filter id="ttwDrip" x="-20%" y="-40%" width="140%" height="180%">
          <feTurbulence type="fractalNoise" baseFrequency="0.008 0.09" numOctaves="3" seed="11" result="n"/>
          <feDisplacementMap in="SourceGraphic" in2="n" scale="26" xChannelSelector="R" yChannelSelector="G"/>
        </filter>
        <filter id="ttwMelt" x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.04 0.01" numOctaves="2" seed="4" result="n"/>
          <feDisplacementMap in="SourceGraphic" in2="n" scale="12" xChannelSelector="R" yChannelSelector="G"/>
        </filter>
      </defs>
    </svg>`;

  /* Реестр виджетов для галереи/панели */
  const WIDGETS = [
    { id:'likes',    file:'/widgets/likes.html',    name:'Топ по лайкам',      def:'cyber'  },
    { id:'battle',   file:'/widgets/battle.html',   name:'Битва подарков',     def:'comic'  },
    { id:'topgifts', file:'/widgets/topgifts.html', name:'Топ по подаркам',    def:'luxury' },
    { id:'mono',     file:'/widgets/mono.html',     name:'Моно-подарок',       def:'bubble' },
    { id:'alerts',   file:'/widgets/alerts.html',   name:'Алерты',             def:'chrome' },
    { id:'chat',     file:'/widgets/chat.html',     name:'Чат',                def:'chrome' },
    { id:'stats',    file:'/widgets/stats.html',    name:'Статистика эфира',   def:'chrome' },
    { id:'events',   file:'/widgets/events.html',   name:'Лента событий',      def:'chrome' },
    { id:'goal',     file:'/widgets/goal.html',     name:'Цель стрима',        def:'holo'   },
    { id:'latest',   file:'/widgets/latest.html',   name:'Последний герой',    def:'ice'    },
    { id:'combo',    file:'/widgets/combo.html',    name:'Серия подарков',     def:'fire'   },
    { id:'countdown',file:'/widgets/countdown.html',name:'Таймер отсчёта',     def:'vhs'    },
    { id:'top3likes',file:'/widgets/top3.html?metric=likes', name:'Топ-3 лайков', def:'minimal' },
    { id:'top3gifts',file:'/widgets/top3.html?metric=coins', name:'Топ-3 по монетам', def:'minimal' }
  ];

  function apply(defaultTheme) {
    const q = new URLSearchParams(location.search);
    const key = THEMES[q.get('theme')] ? q.get('theme') : (defaultTheme || 'chrome');
    const t = THEMES[key];

    if (t.fonts) {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = GF + t.fonts + '&display=swap';
      document.head.appendChild(l);
    }
    const root = document.documentElement;
    root.style.setProperty('--fd', t.fd);
    root.style.setProperty('--fb', t.fb);
    for (const k in t.vars) root.style.setProperty('--' + k, t.vars[k]);
    if (t.css || EXTRAS[key]) {
      const st = document.createElement('style');
      st.dataset.theme = key;
      st.textContent = (t.css || '') + (EXTRAS[key] || '');
      document.head.appendChild(st);
    }
    if (t.filter && !document.getElementById('ttwRagged')) {
      document.body.insertAdjacentHTML('beforeend', FILTERS_SVG);
    }
    document.body && (document.body.dataset.theme = key);
    return key;
  }

  return { THEMES, WIDGETS, apply };
})();
