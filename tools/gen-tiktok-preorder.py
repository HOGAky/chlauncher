import os
import math
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUTPUT_DIR = os.path.abspath(os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "branding", "tiktok_preorder")))
os.makedirs(OUTPUT_DIR, exist_ok=True)

ICON_PATH = os.path.abspath(os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "branding", "chlauncher-app-icon.png")))
app_icon = None
if os.path.exists(ICON_PATH):
    try:
        app_icon = Image.open(ICON_PATH).convert("RGBA")
    except Exception as e:
        print("Could not load icon:", e)

W, H = 1080, 1920

FONTS_DIR = "C:/Windows/Fonts"
def get_font(name, size):
    path = os.path.join(FONTS_DIR, name)
    try:
        return ImageFont.truetype(path, size)
    except:
        return ImageFont.load_default()

font_hero = get_font("arialbd.ttf", 60)
font_title = get_font("arialbd.ttf", 44)
font_card_head = get_font("arialbd.ttf", 34)
font_body = get_font("segoeui.ttf", 28)
font_body_bold = get_font("segoeuib.ttf", 28)
font_small = get_font("segoeui.ttf", 23)
font_badge = get_font("arialbd.ttf", 22)

BG_DARK = (10, 12, 20)
CYAN = (34, 211, 238)
PINK = (255, 77, 157)
PURPLE = (168, 85, 247)
AMBER = (251, 191, 36)
EMERALD = (52, 211, 153)
WHITE = (255, 255, 255)
GRAY = (156, 163, 175)
CARD_BG = (18, 23, 38, 235)
CARD_BORDER = (255, 255, 255, 32)

def draw_gradient_background(glow_color=(34, 211, 238), glow_y=480):
    img = Image.new("RGBA", (W, H), BG_DARK)
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    
    cx, cy = W // 2, glow_y
    for r in range(560, 50, -35):
        alpha = int(48 * (1 - r / 560))
        glow_draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(glow_color[0], glow_color[1], glow_color[2], alpha))
        
    glow = glow.filter(ImageFilter.GaussianBlur(80))
    img = Image.alpha_composite(img, glow)
    
    draw = ImageDraw.Draw(img)
    for x in range(0, W, 80):
        draw.line([(x, 0), (x, H)], fill=(255, 255, 255, 6), width=1)
    for y in range(0, H, 80):
        draw.line([(0, y), (W, y)], fill=(255, 255, 255, 6), width=1)
        
    return img

def draw_badge(draw, text, x, y, accent_color, bg_alpha=35):
    bbox = font_badge.getbbox(text)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    px, py = 22, 9
    card_box = [x, y, x + tw + px * 2, y + th + py * 2]
    draw.rounded_rectangle(card_box, radius=999, fill=(accent_color[0], accent_color[1], accent_color[2], bg_alpha), outline=accent_color, width=2)
    draw.text((x + px, y + py - 2), text, font=font_badge, fill=accent_color)
    return card_box[3]

def draw_card(draw, x, y, w, h, radius=24, border_color=CARD_BORDER, fill_color=CARD_BG):
    draw.rounded_rectangle([x, y, x + w, y + h], radius=radius, fill=fill_color, outline=border_color, width=2)

# ==================== SLIDE 1: ЗНАКОМСТВО + ОТКРЫТ ПРЕДЗАКАЗ ====================
def make_slide1():
    img = draw_gradient_background(glow_color=CYAN, glow_y=420)
    draw = ImageDraw.Draw(img)
    
    draw_badge(draw, "НОВЫЙ СОФТ ДЛЯ СТРИМОВ TIKTOK", 80, 140, CYAN)
    
    if app_icon:
        icon_resized = app_icon.resize((140, 140), Image.Resampling.LANCZOS)
        img.paste(icon_resized, (80, 220), icon_resized)
        
    draw.text((250, 240), "CHLAUNCHER", font=font_hero, fill=WHITE)
    draw.text((250, 315), "ХАБ ИНТЕРАКТИВНЫХ СТРИМОВ", font=font_card_head, fill=CYAN)
    
    draw.text((80, 410), "УДОБНЫЙ ЛАУНЧЕР ДЛЯ", font=font_hero, fill=WHITE)
    draw.text((80, 485), "ИНТЕРАКТИВНЫХ ЭФИРОВ", font=font_hero, fill=CYAN)
    draw.text((80, 565), "Все необходимые инструменты для стримера в одном окне", font=font_body, fill=GRAY)
    
    # What is it Card
    draw_card(draw, 80, 640, 920, 670, radius=28)
    draw.text((120, 680), "Что умеет лаунчер:", font=font_card_head, fill=WHITE)
    
    items = [
        ("Интерактивные игры на стриме", "Подарки зрителей взрывают TNT в Minecraft или спавнят мобов в Roblox", CYAN),
        ("Умный таймер-субатон", "Лайки и подарки продлевают время стрима в реальном времени", AMBER),
        ("Живая озвучка комментариев", "Чтение чата приятным голосом без задержек, с фильтром мата", EMERALD),
        ("Вход в 1 клик через QR", "Без сложных настроек, ковыряния в токенах и скриптах", PINK),
    ]
    
    iy = 750
    for title, desc, col in items:
        draw.ellipse([120, iy + 6, 138, iy + 24], fill=col)
        draw.text((155, iy), title, font=font_body_bold, fill=WHITE)
        draw.text((155, iy + 38), desc, font=font_small, fill=GRAY)
        iy += 125

    # Pre-order Announcement Card
    draw_card(draw, 80, 1350, 920, 260, radius=28, fill_color=(255, 77, 157, 28), border_color=PINK)
    draw.text((120, 1385), "ОТКРЫТ ОФИЦИАЛЬНЫЙ ПРЕДЗАКАЗ!", font=font_card_head, fill=PINK)
    draw.text((120, 1435), "Успей забрать лаунчер одним из первых.", font=font_body_bold, fill=WHITE)
    draw.text((120, 1480), "Участники предзаказа получат софт НА НЕДЕЛЮ РАНЬШЕ!", font=font_body, fill=AMBER)
    draw.text((120, 1535), "Свайпай дальше — показываем заработок ->", font=font_small, fill=GRAY)
    
    return img

# ==================== SLIDE 2: РЕАЛЬНЫЙ ЗАРАБОТОК (БЕЗ ПРЕУВЕЛИЧЕНИЙ) ====================
def make_slide2():
    img = draw_gradient_background(glow_color=EMERALD, glow_y=480)
    draw = ImageDraw.Draw(img)
    
    draw_badge(draw, "МОНЕТИЗАЦИЯ TIKTOK ЭФИРОВ", 80, 140, EMERALD)
    
    draw.text((80, 230), "ИНТЕРАКТИВ ПРИНОСИТ", font=font_hero, fill=WHITE)
    draw.text((80, 310), "В 3-5 РАЗ БОЛЬШЕ", font=font_hero, fill=EMERALD)
    draw.text((80, 395), "Зрители охотнее донатят, когда напрямую влияют на стрим", font=font_body, fill=GRAY)
    
    draw_card(draw, 80, 470, 920, 620, radius=28)
    draw.text((120, 510), "Откуда идет доход на стриме:", font=font_card_head, fill=WHITE)
    
    sources = [
        ("Подарки за экшен в игре", "Зрители дарят розы и корги, чтобы запустить триггер в игре", EMERALD),
        ("Таймер эфира (Субатон)", "Хотят продолжения стрима? Донатят на продление времени", AMBER),
        ("Платная озвучка чата", "Сообщения с подарками озвучиваются в приоритете", CYAN),
        ("Рулетки и спиннеры", "Зрители крутят колесо заданий и челленджей за подарки", PINK),
    ]
    
    sy = 575
    for title, desc, col in sources:
        draw.rounded_rectangle([120, sy, 960, sy + 105], radius=16, fill=(26, 34, 52, 220), outline=(255, 255, 255, 18), width=1)
        draw.text((150, sy + 16), title, font=font_body_bold, fill=col)
        draw.text((150, sy + 58), desc, font=font_small, fill=GRAY)
        sy += 125

    draw_card(draw, 80, 1120, 920, 280, radius=24)
    draw.text((120, 1160), "Реальное сравнение доходов:", font=font_card_head, fill=WHITE)
    draw.text((120, 1215), "- Обычный разговорный стрим: 100 - 300 руб за эфир", font=font_body, fill=GRAY)
    draw.text((120, 1265), "- Стрим с интерактивной игрой: 1 000 - 3 500 руб за эфир", font=font_body_bold, fill=EMERALD)
    draw.text((120, 1315), "- Интерактив поднимает стрим в рекомендации TikTok!", font=font_body, fill=WHITE)
    
    draw_card(draw, 80, 1430, 920, 140, radius=20, fill_color=(52, 211, 153, 25), border_color=EMERALD)
    draw.text((120, 1480), "Что дает предзаказ? Смотри дальше ->", font=font_card_head, fill=EMERALD)
    
    return img

# ==================== SLIDE 3: ЧТО ВХОДИТ В ЛАУНЧЕР ====================
def make_slide3():
    img = draw_gradient_background(glow_color=PURPLE, glow_y=480)
    draw = ImageDraw.Draw(img)
    
    draw_badge(draw, "ИНСТРУМЕНТЫ В ОДНОМ МЕСТЕ", 80, 140, PURPLE)
    
    draw.text((80, 230), "ВСЕ ДЛЯ ЭФИРА", font=font_hero, fill=WHITE)
    draw.text((80, 310), "В ОДНОМ ОКНЕ", font=font_hero, fill=PURPLE)
    draw.text((80, 395), "Больше не нужно запускать несколько сторонних сайтов", font=font_body, fill=GRAY)
    
    features = [
        ("Интерактивный Таймер", "Субатон со счетчиком секунд за каждый подарок и лайк", AMBER),
        ("Умный TTS-голос", "Озвучка комментов с антиспамом и защитой от запретки", EMERALD),
        ("Minecraft Релей", "Подарок спавнит крипера, TNT или блоки прямо в игру", CYAN),
        ("Roblox StreamToEarn", "Прямое подключение к играм и плейсам в Роблокс", PINK),
        ("Рулетки и Спиннеры", "Донатные колеса фортуны поверх любого стрима", PURPLE),
    ]
    
    fy = 470
    for title, desc, col in features:
        draw_card(draw, 80, fy, 920, 120, radius=20, fill_color=(20, 26, 43, 230), border_color=(col[0], col[1], col[2], 80))
        draw.text((120, fy + 18), title, font=font_card_head, fill=col)
        draw.text((120, fy + 64), desc, font=font_body, fill=WHITE)
        fy += 138
        
    draw_card(draw, 80, 1200, 920, 190, radius=24, fill_color=(168, 85, 247, 25), border_color=PURPLE)
    draw.text((120, 1240), "УДОБНЫЙ СТАРТ В 1 КЛИК", font=font_card_head, fill=PURPLE)
    draw.text((120, 1295), "Сканируешь QR-код телефоном —", font=font_body, fill=WHITE)
    draw.text((120, 1335), "и лаунчер мгновенно подключается к эфиру!", font=font_body, fill=WHITE)
    
    draw_card(draw, 80, 1430, 920, 140, radius=20, fill_color=(251, 191, 36, 25), border_color=AMBER)
    draw.text((120, 1480), "Как работает механика предзаказа? ->", font=font_card_head, fill=AMBER)
    
    return img

# ==================== SLIDE 4: МЕХАНИКА ПРЕДЗАКАЗА (УСКОРЕНИЕ + 1 НЕДЕЛЯ) ====================
def make_slide4():
    img = draw_gradient_background(glow_color=PINK, glow_y=500)
    draw = ImageDraw.Draw(img)
    
    draw_badge(draw, "МЕХАНИКА УСКОРЕНИЯ РЕЛИЗА", 80, 140, PINK)
    
    draw.text((80, 230), "КАЖДЫЙ ПРЕДЗАКАЗ", font=font_hero, fill=WHITE)
    draw.text((80, 310), "ПРИБЛИЖАЕТ РЕЛИЗ!", font=font_hero, fill=PINK)
    draw.text((80, 395), "Софт на стадии финализации — сообщество само ускоряет дату", font=font_body, fill=GRAY)
    
    draw_card(draw, 80, 470, 920, 620, radius=28, fill_color=(20, 26, 44, 240), border_color=PINK)
    draw.text((120, 510), "Что дает предзаказ:", font=font_card_head, fill=WHITE)
    
    perks = [
        ("Доступ ЗА 1 НЕДЕЛЮ до всех", "Ты получишь софт на 7 дней раньше открытого релиза", EMERALD),
        ("Каждый предзаказ: -2 ЧАСА", "Каждая бронь приближает день релиза для всего комьюнити", PINK),
        ("Пожизненный OG Pass 50%", "Твоя цена заморозится навсегда со скидкой 50%", AMBER),
        ("Старт в пустой нише", "Настроишь стримы и наберешь зрителей до толпы", CYAN),
    ]
    
    py = 575
    for title, desc, col in perks:
        draw.rounded_rectangle([120, py, 960, py + 105], radius=16, fill=(26, 34, 52, 220), outline=(255, 255, 255, 18), width=1)
        draw.text((150, py + 16), title, font=font_body_bold, fill=col)
        draw.text((150, py + 58), desc, font=font_small, fill=GRAY)
        py += 125
        
    draw_card(draw, 80, 1120, 920, 280, radius=24)
    draw.text((120, 1160), "Лимит участников:", font=font_card_head, fill=WHITE)
    draw.text((120, 1215), "Выделено всего 500 мест по скидке предзаказа.", font=font_body_bold, fill=AMBER)
    draw.text((120, 1265), "После релиза скидок не будет — доступ станет общим.", font=font_body, fill=WHITE)
    draw.text((120, 1315), "Успей забрать лаунчер одним из первых!", font=font_small, fill=GRAY)
    
    draw_card(draw, 80, 1430, 920, 140, radius=20, fill_color=(255, 77, 157, 25), border_color=PINK)
    draw.text((120, 1480), "Как оформить предзаказ? Смотри финал ->", font=font_card_head, fill=PINK)
    
    return img

# ==================== SLIDE 5: CTA (КАК ЗАБРАТЬ ПРЕДЗАКАЗ) ====================
def make_slide5():
    img = draw_gradient_background(glow_color=PINK, glow_y=460)
    draw = ImageDraw.Draw(img)
    
    draw_badge(draw, "БРОНИРУЙ МЕСТО В ПРЕДЗАКАЗЕ", 80, 140, PINK)
    
    if app_icon:
        icon_resized = app_icon.resize((170, 170), Image.Resampling.LANCZOS)
        img.paste(icon_resized, (W // 2 - 85, 210), icon_resized)
        
    draw.text((W // 2 - 240, 420), "CHLAUNCHER", font=font_hero, fill=WHITE)
    draw.text((W // 2 - 290, 495), "ПРЕДЗАКАЗ ОТКРЫТ", font=font_title, fill=PINK)
    draw.text((W // 2 - 325, 565), "Получи софт за неделю до релиза и ускори дату", font=font_body, fill=GRAY)
    
    # Steps Card
    draw_card(draw, 80, 630, 920, 520, radius=28)
    draw.text((120, 670), "Как оформить предзаказ за 1 минуту:", font=font_card_head, fill=WHITE)
    
    steps = [
        "1. Переходи по кликабельной ссылке в шапке профиля",
        "2. Или найди в Telegram нашего бота: @chlnchbot",
        "3. Нажимай «Оформить предзаказ» со скидкой 50%",
        "4. Твой предзаказ ускорит релиз на 2 ЧАСА для всех!",
        "5. За 1 НЕДЕЛЮ до публичного старта получаешь софт!",
    ]
    sy = 735
    for s in steps:
        is_highlight = "1 НЕДЕЛЮ" in s or "2 ЧАСА" in s or "50%" in s or "@chlnchbot" in s
        draw.text((120, sy), s, font=font_body_bold if is_highlight else font_body, fill=AMBER if "1 НЕДЕЛЮ" in s else (CYAN if "@chlnchbot" in s else (PINK if "2 ЧАСА" in s else WHITE)))
        sy += 65
        
    # Massive CTA & QR Card
    draw_card(draw, 80, 1180, 920, 420, radius=32, fill_color=(255, 77, 157, 35), border_color=PINK)
    
    # Generate QR Code
    try:
        import qrcode
        qr = qrcode.QRCode(box_size=6, border=2)
        qr.add_data("https://t.me/+nXUpPl7nOeQ1OWYy")
        qr.make(fit=True)
        qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGBA")
        qr_img = qr_img.resize((220, 220), Image.Resampling.LANCZOS)
        # Paste QR code on the right side
        img.paste(qr_img, (730, 1260), qr_img)
        draw.text((740, 1495), "Отсканируй QR", font=font_small, fill=GRAY)
        draw.text((735, 1525), "или зажми фото", font=font_small, fill=GRAY)
    except Exception as e:
        print("QR failed:", e)

    # Left text inside CTA card
    draw.text((120, 1220), "ССЫЛКА НА КАНАЛ И ПРЕДЗАКАЗ:", font=font_badge, fill=PINK)
    draw.text((120, 1265), "В шапке профиля", font=font_title, fill=WHITE)
    draw.text((120, 1315), "нашего TikTok", font=font_title, fill=WHITE)
    draw.text((120, 1380), "(ссылка в био кликабельна!)", font=font_body_bold, fill=AMBER)
    draw.text((120, 1450), "Или поиск в Telegram:", font=font_body, fill=GRAY)
    draw.text((120, 1495), "@chlnchbot", font=font_hero, fill=CYAN)
    
    return img

print("Generating TikTok Pre-Order slides (1080x1920)...")
slides = [
    ("slide1_preorder_hook.png", make_slide1()),
    ("slide2_earnings.png", make_slide2()),
    ("slide3_features.png", make_slide3()),
    ("slide4_perks.png", make_slide4()),
    ("slide5_cta.png", make_slide5()),
]

saved_images = []
for name, img in slides:
    out_path = os.path.join(OUTPUT_DIR, name)
    with open(out_path, "wb") as f:
        img.save(f, format="PNG")
    saved_images.append(img.convert("RGB"))
    print("Saved:", out_path)

gif_path = os.path.join(OUTPUT_DIR, "tiktok_preorder_preview.gif")
small_frames = [im.resize((540, 960), Image.Resampling.LANCZOS) for im in saved_images]
with open(gif_path, "wb") as f:
    small_frames[0].save(f, format="GIF", save_all=True, append_images=small_frames[1:], duration=2500, loop=0)
print("Saved preview GIF:", gif_path)
print("Done!")
