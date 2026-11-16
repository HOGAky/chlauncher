import os
import math
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "branding", "tiktok")
os.makedirs(OUTPUT_DIR, exist_ok=True)

ICON_PATH = os.path.join(os.path.dirname(__file__), "..", "branding", "chlauncher-app-icon.png")
app_icon = None
if os.path.exists(ICON_PATH):
    try:
        app_icon = Image.open(ICON_PATH).convert("RGBA")
    except Exception as e:
        print("Could not load icon:", e)

W, H = 1080, 1920

# Fonts
FONTS_DIR = "C:/Windows/Fonts"
def get_font(name, size):
    path = os.path.join(FONTS_DIR, name)
    try:
        return ImageFont.truetype(path, size)
    except:
        return ImageFont.load_default()

font_hero = get_font("arialbd.ttf", 68)
font_title = get_font("arialbd.ttf", 52)
font_card_title = get_font("arialbd.ttf", 38)
font_body = get_font("segoeui.ttf", 32)
font_body_bold = get_font("segoeuib.ttf", 32)
font_badge = get_font("arialbd.ttf", 26)
font_digits = get_font("impact.ttf", 115)
font_small = get_font("segoeui.ttf", 26)
font_mono = get_font("consola.ttf", 28)

# Colors
BG_DARK = (11, 14, 23)
CYAN = (34, 211, 238)
PINK = (255, 77, 157)
PURPLE = (168, 85, 247)
AMBER = (251, 191, 36)
EMERALD = (52, 211, 153)
WHITE = (255, 255, 255)
GRAY = (156, 163, 175)
CARD_BG = (20, 26, 43, 220)
CARD_BORDER = (255, 255, 255, 35)

def draw_gradient_background(glow_color=(34, 211, 238), glow_y=500):
    img = Image.new("RGBA", (W, H), BG_DARK)
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    
    # Ambient radial gradient
    cx, cy = W // 2, glow_y
    for r in range(550, 50, -35):
        alpha = int(48 * (1 - r / 550))
        glow_draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(glow_color[0], glow_color[1], glow_color[2], alpha))
        
    glow = glow.filter(ImageFilter.GaussianBlur(80))
    img = Image.alpha_composite(img, glow)
    
    # Grid lines overlay (tech aesthetic)
    draw = ImageDraw.Draw(img)
    for x in range(0, W, 80):
        draw.line([(x, 0), (x, H)], fill=(255, 255, 255, 6), width=1)
    for y in range(0, H, 80):
        draw.line([(0, y), (W, y)], fill=(255, 255, 255, 6), width=1)
        
    return img

def draw_badge(draw, text, x, y, accent_color, bg_alpha=40):
    bbox = font_badge.getbbox(text)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    px, py = 24, 12
    card_box = [x, y, x + tw + px * 2, y + th + py * 2]
    draw.rounded_rectangle(card_box, radius=999, fill=(accent_color[0], accent_color[1], accent_color[2], bg_alpha), outline=accent_color, width=2)
    draw.text((x + px, y + py - 2), text, font=font_badge, fill=accent_color)
    return card_box[3]

def draw_card(draw, x, y, w, h, radius=24, border_color=CARD_BORDER, fill_color=CARD_BG):
    draw.rounded_rectangle([x, y, x + w, y + h], radius=radius, fill=fill_color, outline=border_color, width=2)

# ==================== SLIDE 1: THE HOOK ====================
def make_slide1():
    img = draw_gradient_background(glow_color=PURPLE, glow_y=450)
    draw = ImageDraw.Draw(img)
    
    draw_badge(draw, "РЕВОЛЮЦИЯ СТРИМОВ TIKTOK", 80, 140, PINK)
    
    if app_icon:
        icon_resized = app_icon.resize((180, 180), Image.Resampling.LANCZOS)
        img.paste(icon_resized, (80, 230), icon_resized)
    
    draw.text((80, 440), "МЫ НАПИСАЛИ", font=font_hero, fill=WHITE)
    draw.text((80, 520), "АЛЬТЕРНАТИВУ", font=font_hero, fill=CYAN)
    draw.text((80, 600), "TIKFINITY ДЛЯ СНГ", font=font_hero, fill=PINK)
    
    draw_card(draw, 80, 720, 920, 600, radius=30)
    draw.text((120, 760), "Почему стримеры выбирают нас:", font=font_card_title, fill=WHITE)
    
    features = [
        ("Без подписок по 15$/мес", "Бесплатный лаунчер без скрытых платежей", CYAN),
        ("Вход в 1 клик через QR", "Без мучений с куками и ручными токенами", PINK),
        ("Умная озвучка комментариев", "Живой голос TTS, антиспам, чистый звук", EMERALD),
        ("Интерактивный таймер", "Подарки и лайки продлевают эфир автоматически", AMBER),
    ]
    
    cy = 835
    for title, desc, col in features:
        draw.ellipse([120, cy + 8, 140, cy + 28], fill=col)
        draw.text((160, cy), title, font=font_body_bold, fill=WHITE)
        draw.text((160, cy + 44), desc, font=font_small, fill=GRAY)
        cy += 110

    draw_card(draw, 80, 1360, 920, 180, radius=24, fill_color=(34, 211, 238, 25), border_color=CYAN)
    draw.text((120, 1400), "CHLAUNCHER — ВСЕ В ОДНОМ ОКНЕ", font=font_card_title, fill=CYAN)
    draw.text((120, 1460), "Свайпай дальше — показываем как это работает ->", font=font_body, fill=WHITE)
    
    return img

# ==================== SLIDE 2: TIMER (СУБАТОН) ====================
def make_slide2():
    img = draw_gradient_background(glow_color=AMBER, glow_y=550)
    draw = ImageDraw.Draw(img)
    
    draw_badge(draw, "ИНТЕРАКТИВНЫЙ ТАЙМЕР ЭФИРА", 80, 140, AMBER)
    
    draw.text((80, 230), "ЗРИТЕЛИ САМИ", font=font_hero, fill=WHITE)
    draw.text((80, 310), "ПРОДЛЕВАЮТ СТРИМ", font=font_hero, fill=AMBER)
    draw.text((80, 400), "Каждый подарок и лайк добавляет секунды к таймеру", font=font_body, fill=GRAY)
    
    # Huge Timer Card
    draw_card(draw, 80, 480, 920, 530, radius=32, fill_color=(20, 24, 38, 240), border_color=AMBER)
    
    draw.text((150, 540), "01:24:50", font=font_digits, fill=AMBER)
    draw.text((150, 680), "ТАЙМЕР ЭФИРА · СУБАТОН", font=font_badge, fill=GRAY)
    
    # Progress bar
    draw.rounded_rectangle([150, 730, 930, 746], radius=8, fill=(255, 255, 255, 30))
    draw.rounded_rectangle([150, 730, 690, 746], radius=8, fill=AMBER)
    
    draw.text((150, 780), "ПОСЛЕДНИЕ ДОБАВЛЕНИЯ В ЭФИРЕ:", font=font_badge, fill=GRAY)
    adds = [
        ("+5м", "@alex_streamer", "Подарок «Роза x10»", EMERALD),
        ("+30с", "@vlad_pro", "15 лайков", CYAN),
        ("+15м", "@whale_king", "Подарок «TikTok Корги»", PINK),
    ]
    ay = 830
    for delta, user, reason, col in adds:
        draw.rounded_rectangle([150, ay, 930, ay + 44], radius=12, fill=(255, 255, 255, 12))
        draw.text((170, ay + 6), delta, font=font_body_bold, fill=col)
        draw.text((260, ay + 6), user, font=font_body, fill=WHITE)
        draw.text((540, ay + 8), reason, font=font_small, fill=GRAY)
        ay += 54
        
    draw_card(draw, 80, 1050, 920, 340, radius=24)
    draw.text((120, 1090), "Фишки таймера:", font=font_card_title, fill=WHITE)
    timer_perks = [
        "- Готовое прозрачное окно для захвата в TikTok Live Studio",
        "- Настройка секунд за каждый подарок, подписку и лайки",
        "- Звуковые сигналы при донате и окончании стрима",
    ]
    py = 1155
    for p in timer_perks:
        draw.text((120, py), p, font=font_body, fill=WHITE)
        py += 62

    draw_card(draw, 80, 1430, 920, 140, radius=20, fill_color=(251, 191, 36, 25), border_color=AMBER)
    draw.text((120, 1480), "Свайпай дальше — там про озвучку ->", font=font_card_title, fill=AMBER)
    
    return img

# ==================== SLIDE 3: TTS (ОЗВУЧКА) ====================
def make_slide3():
    img = draw_gradient_background(glow_color=EMERALD, glow_y=500)
    draw = ImageDraw.Draw(img)
    
    draw_badge(draw, "УМНАЯ ОЗВУЧКА КОММЕНТАРИЕВ", 80, 140, EMERALD)
    
    draw.text((80, 230), "ЖИВОЙ ГОЛОС", font=font_hero, fill=WHITE)
    draw.text((80, 310), "ВМЕСТО РОБОТА", font=font_hero, fill=EMERALD)
    draw.text((80, 400), "Каждый коммент читается вслух прямо на трансляции", font=font_body, fill=GRAY)
    
    draw_card(draw, 80, 480, 920, 560, radius=32)
    draw.text((120, 520), "Как это слышат зрители:", font=font_card_title, fill=WHITE)
    
    bubbles = [
        ("@masha_cat", "Врубай камеру и музыку на полную!", "Женский голос", EMERALD),
        ("@danil_gamer", "Прыгай в лаву если смелый :D", "Мужской голос", CYAN),
        ("@spammer123", "[Мат и спам заблокированы фильтром]", "Антиспам", PINK),
    ]
    by = 585
    for user, text, note, col in bubbles:
        draw.rounded_rectangle([120, by, 900, by + 120], radius=18, fill=(30, 41, 59, 200), outline=(255, 255, 255, 20), width=1)
        draw.text((150, by + 16), user, font=font_body_bold, fill=col)
        draw.text((150, by + 58), text, font=font_body, fill=WHITE)
        draw.text((680, by + 18), note, font=font_small, fill=GRAY)
        by += 140
        
    draw_card(draw, 80, 1080, 920, 320, radius=24)
    draw.text((120, 1120), "Преимущества нашего TTS:", font=font_card_title, fill=WHITE)
    tts_points = [
        "- Встроенный антиспам и фильтр нецензурных слов",
        "- Ограничение длины сообщений и регулировка очереди",
        "- Горячая клавиша мгновенного глушения (Mute)",
    ]
    ty = 1190
    for p in tts_points:
        draw.text((120, ty), p, font=font_body, fill=WHITE)
        ty += 58
        
    draw_card(draw, 80, 1440, 920, 140, radius=20, fill_color=(52, 211, 153, 25), border_color=EMERALD)
    draw.text((120, 1490), "А еще внутри есть интерактивные игры ->", font=font_card_title, fill=EMERALD)
    
    return img

# ==================== SLIDE 4: GAMES & TRIGGERS ====================
def make_slide4():
    img = draw_gradient_background(glow_color=CYAN, glow_y=500)
    draw = ImageDraw.Draw(img)
    
    draw_badge(draw, "ИНТЕРАКТИВНЫЕ ИГРЫ И ТРИГГЕРЫ", 80, 140, CYAN)
    
    draw.text((80, 230), "ПОДАРКИ ИГРАЮТ", font=font_hero, fill=WHITE)
    draw.text((80, 310), "ВМЕСТЕ С ТОБОЙ", font=font_hero, fill=CYAN)
    draw.text((80, 400), "Каждое действие зрителя влияет на игру в реальном времени", font=font_body, fill=GRAY)
    
    games = [
        ("Minecraft релей", "Подарок спавнит крипера или блок TNT", CYAN),
        ("Roblox триггеры", "Лайки двигают полосу и спавнят мобов", PINK),
        ("Gift Tower", "Интерактивная башня из подарков зрителей", AMBER),
        ("Snake & Flappy Gifts", "Донаты управляют змейкой или птицей", EMERALD),
    ]
    
    gy = 480
    for icon_title, desc, col in games:
        draw_card(draw, 80, gy, 920, 125, radius=20, fill_color=(20, 26, 43, 230), border_color=(col[0], col[1], col[2], 80))
        draw.text((120, gy + 20), icon_title, font=font_card_title, fill=col)
        draw.text((120, gy + 72), desc, font=font_body, fill=WHITE)
        gy += 145
        
    draw_card(draw, 80, 1090, 920, 320, radius=24)
    draw.text((120, 1130), "Как запустить за 2 минуты:", font=font_card_title, fill=WHITE)
    steps = [
        "1. Открываешь лаунчер и подключаешь свой TikTok",
        "2. Выбираешь игру из каталога и жмешь «Запуск»",
        "3. Добавляешь окно в TikTok Live Studio и стримишь!",
    ]
    sy = 1200
    for s in steps:
        draw.text((120, sy), s, font=font_body, fill=WHITE)
        sy += 58
        
    draw_card(draw, 80, 1450, 920, 140, radius=20, fill_color=(34, 211, 238, 25), border_color=CYAN)
    draw.text((120, 1500), "Где скачать бесплатно? Смотри финал ->", font=font_card_title, fill=CYAN)
    
    return img

# ==================== SLIDE 5: CTA ====================
def make_slide5():
    img = draw_gradient_background(glow_color=PINK, glow_y=500)
    draw = ImageDraw.Draw(img)
    
    draw_badge(draw, "БЕСПЛАТНЫЙ ДОСТУП ДЛЯ СТРИМЕРОВ", 80, 140, PINK)
    
    if app_icon:
        icon_resized = app_icon.resize((240, 240), Image.Resampling.LANCZOS)
        img.paste(icon_resized, (W // 2 - 120, 240), icon_resized)
        
    draw.text((W // 2 - 240, 510), "CHLAUNCHER", font=font_hero, fill=WHITE)
    draw.text((W // 2 - 280, 600), "ОТКРЫТЫЙ БЕТА-ТЕСТ", font=font_title, fill=PINK)
    draw.text((W // 2 - 270, 680), "Все функции доступны бесплатно", font=font_body, fill=GRAY)
    
    draw_card(draw, 80, 760, 920, 480, radius=28)
    draw.text((120, 800), "Что ты получаешь прямо сейчас:", font=font_card_title, fill=WHITE)
    perks = [
        "- Стабильное чтение TikTok LIVE без разрывов",
        "- Интерактивный субатон-таймер под стрим",
        "- Голосовая озвучка комментов (TTS)",
        "- Интеграция с DonationAlerts и OBS",
        "- Каталог интерактивных мини-игр",
    ]
    py = 870
    for p in perks:
        draw.text((120, py), p, font=font_body, fill=WHITE)
        py += 62
        
    draw_card(draw, 80, 1280, 920, 250, radius=32, fill_color=(255, 77, 157, 45), border_color=PINK)
    draw.text((140, 1320), "ССЫЛКА НА СКАЧИВАНИЕ:", font=font_badge, fill=PINK)
    draw.text((140, 1370), "В шапке профиля TikTok", font=font_hero, fill=WHITE)
    draw.text((140, 1460), "или в Telegram: @chlnchbot", font=font_card_title, fill=CYAN)
    
    return img

print("Generating TikTok slides (1080x1920)...")
slides = [
    ("slide1_hook.png", make_slide1()),
    ("slide2_timer.png", make_slide2()),
    ("slide3_tts.png", make_slide3()),
    ("slide4_games.png", make_slide4()),
    ("slide5_cta.png", make_slide5()),
]

saved_images = []
for name, img in slides:
    out_path = os.path.join(OUTPUT_DIR, name)
    img.save(out_path, format="PNG")
    saved_images.append(img.convert("RGB"))
    print("Saved:", out_path)

gif_path = os.path.join(OUTPUT_DIR, "tiktok_carousel_preview.gif")
small_frames = [im.resize((540, 960), Image.Resampling.LANCZOS) for im in saved_images]
small_frames[0].save(gif_path, save_all=True, append_images=small_frames[1:], duration=2500, loop=0)
print("Saved preview GIF:", gif_path)
print("Done!")
