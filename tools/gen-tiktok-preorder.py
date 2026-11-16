import os
import math
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "branding", "tiktok_preorder")
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

font_hero = get_font("arialbd.ttf", 66)
font_title = get_font("arialbd.ttf", 50)
font_card_title = get_font("arialbd.ttf", 38)
font_body = get_font("segoeui.ttf", 32)
font_body_bold = get_font("segoeuib.ttf", 32)
font_badge = get_font("arialbd.ttf", 26)
font_digits = get_font("impact.ttf", 110)
font_small = get_font("segoeui.ttf", 26)
font_mono = get_font("consola.ttf", 28)

# Colors
BG_DARK = (10, 12, 20)
CYAN = (34, 211, 238)
PINK = (255, 77, 157)
PURPLE = (168, 85, 247)
AMBER = (251, 191, 36)
EMERALD = (52, 211, 153)
WHITE = (255, 255, 255)
GRAY = (156, 163, 175)
CARD_BG = (18, 23, 38, 230)
CARD_BORDER = (255, 255, 255, 30)

def draw_gradient_background(glow_color=(255, 77, 157), glow_y=500):
    img = Image.new("RGBA", (W, H), BG_DARK)
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    
    # Ambient radial gradient
    cx, cy = W // 2, glow_y
    for r in range(580, 50, -35):
        alpha = int(50 * (1 - r / 580))
        glow_draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(glow_color[0], glow_color[1], glow_color[2], alpha))
        
    glow = glow.filter(ImageFilter.GaussianBlur(85))
    img = Image.alpha_composite(img, glow)
    
    # Grid lines overlay (cyberpunk tech aesthetic)
    draw = ImageDraw.Draw(img)
    for x in range(0, W, 80):
        draw.line([(x, 0), (x, H)], fill=(255, 255, 255, 7), width=1)
    for y in range(0, H, 80):
        draw.line([(0, y), (W, y)], fill=(255, 255, 255, 7), width=1)
        
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

# ==================== SLIDE 1: HOOK (КАЖДЫЙ ПРЕДЗАКАЗ УСКОРЯЕТ РЕЛИЗ) ====================
def make_slide1():
    img = draw_gradient_background(glow_color=PINK, glow_y=460)
    draw = ImageDraw.Draw(img)
    
    draw_badge(draw, "СОБЫТИЕ СЕЗОНА ДЛЯ СТРИМЕРОВ", 80, 140, PINK)
    
    if app_icon:
        icon_resized = app_icon.resize((170, 170), Image.Resampling.LANCZOS)
        img.paste(icon_resized, (80, 230), icon_resized)
    
    draw.text((80, 430), "РЕЛИЗ УСКОРЯЕТСЯ", font=font_hero, fill=WHITE)
    draw.text((80, 510), "С КАЖДЫМ", font=font_hero, fill=PINK)
    draw.text((80, 590), "ПРЕДЗАКАЗОМ!", font=font_hero, fill=CYAN)
    
    # Progress Tracker Card
    draw_card(draw, 80, 700, 920, 640, radius=32, fill_color=(20, 26, 44, 240), border_color=PINK)
    draw.text((120, 740), "Шкала ускорения релиза:", font=font_card_title, fill=WHITE)
    
    # Countdown clock & progress bar
    draw.text((120, 805), "РЕЛИЗ ЧЕРЕЗ: 4 ДНЯ 18 ЧАСОВ", font=font_body_bold, fill=AMBER)
    draw.rounded_rectangle([120, 855, 960, 880], radius=10, fill=(255, 255, 255, 25))
    draw.rounded_rectangle([120, 855, 740, 880], radius=10, fill=PINK)
    draw.text((120, 895), "72% шкалы заполнено (+260 предзаказов)", font=font_small, fill=GRAY)
    
    rules = [
        ("Каждый предзаказ", "-2 ЧАСА до всеобщего релиза лаунчера", PINK),
        ("Первые участники", "Доступ к закрытой бете УЖЕ СЕГОДНЯ", CYAN),
        ("OG-статус навсегда", "Скидка 50% на все будущие обновления", EMERALD),
        ("Кто первый зашел", "Тот снимает сливки с TikTok Live ниши", AMBER),
    ]
    
    ry = 950
    for title, desc, col in rules:
        draw.ellipse([120, ry + 8, 140, ry + 28], fill=col)
        draw.text((160, ry), title, font=font_body_bold, fill=WHITE)
        draw.text((160, ry + 42), desc, font=font_small, fill=GRAY)
        ry += 90
        
    draw_card(draw, 80, 1375, 920, 170, radius=24, fill_color=(255, 77, 157, 30), border_color=PINK)
    draw.text((120, 1410), "КАК ЗАРАБАТЫВАЮТ НА ИГРАХ В TIKTOK?", font=font_card_title, fill=PINK)
    draw.text((120, 1465), "Свайпай дальше — показываем цифры доходов ->", font=font_body, fill=WHITE)
    
    return img

# ==================== SLIDE 2: MONEY & MARKET (СКОЛЬКО ТУТ ЗАРАБАТЫВАЮТ) ====================
def make_slide2():
    img = draw_gradient_background(glow_color=EMERALD, glow_y=500)
    draw = ImageDraw.Draw(img)
    
    draw_badge(draw, "ЗАРАБОТОК НА TIKTOK СТРИМАХ", 80, 140, EMERALD)
    
    draw.text((80, 230), "ОТ 50 000 ДО", font=font_hero, fill=WHITE)
    draw.text((80, 310), "300 000 РУБЛЕЙ", font=font_hero, fill=EMERALD)
    draw.text((80, 400), "Интерактивные стримы приносят в 10 раз больше обычных", font=font_body, fill=GRAY)
    
    # Income breakdown card
    draw_card(draw, 80, 480, 920, 560, radius=32)
    draw.text((120, 520), "Откуда берутся деньги в эфирах:", font=font_card_title, fill=WHITE)
    
    incomes = [
        ("Подарки за триггеры в играх", "Зрители спавнят TNT в Minecraft или мобов в Roblox за монеты", EMERALD),
        ("Субатон-таймер эфира", "Хотят продолжения стрима? Донатят на продление времени", AMBER),
        ("Платная озвучка комментариев", "Сообщения с донатом озвучиваются в приоритете", CYAN),
        ("Донат-колесо и рулетки", "Зрители крутят рулетку наказаний и заданий для стримера", PINK),
    ]
    
    iy = 585
    for title, desc, col in incomes:
        draw.rounded_rectangle([120, iy, 960, iy + 105], radius=16, fill=(30, 41, 59, 180), outline=(255, 255, 255, 18), width=1)
        draw.text((150, iy + 16), title, font=font_body_bold, fill=col)
        draw.text((150, iy + 58), desc, font=font_small, fill=GRAY)
        iy += 125
        
    draw_card(draw, 80, 1080, 920, 330, radius=24)
    draw.text((120, 1120), "Почему обычные стримы проигрывают:", font=font_card_title, fill=WHITE)
    facts = [
        "- Обычный разговорный стрим: 100 - 300 руб в час",
        "- Интерактивные игры: 1 500 - 5 000 руб в час",
        "- Алгоритмы TikTok продвигают стримы с интерактивом!",
    ]
    fy = 1185
    for f in facts:
        draw.text((120, fy), f, font=font_body, fill=WHITE)
        fy += 58
        
    draw_card(draw, 80, 1450, 920, 140, radius=20, fill_color=(52, 211, 153, 25), border_color=EMERALD)
    draw.text((120, 1500), "Что входит в chlauncher? Смотри дальше ->", font=font_card_title, fill=EMERALD)
    
    return img

# ==================== SLIDE 3: WHAT'S INSIDE (ФИШКИ ЛАУНЧЕРА) ====================
def make_slide3():
    img = draw_gradient_background(glow_color=CYAN, glow_y=500)
    draw = ImageDraw.Draw(img)
    
    draw_badge(draw, "ПОЛНЫЙ АРСЕНАЛ СТРИМЕРА", 80, 140, CYAN)
    
    draw.text((80, 230), "ВСЕ ИНСТРУМЕНТЫ", font=font_hero, fill=WHITE)
    draw.text((80, 310), "В ОДНОМ МЕСТЕ", font=font_hero, fill=CYAN)
    draw.text((80, 400), "Больше не нужно запускать 10 разных сайтов и расширений", font=font_body, fill=GRAY)
    
    features = [
        ("Таймер Субатона", "Подарки и лайки двигают шкалу времени в прямом эфире", AMBER),
        ("Умный TTS-голос", "Озвучка комментов с антиспамом и фильтром мата", EMERALD),
        ("Релеи для Minecraft", "Взрывы, мобы, блоки от подарков в чате", CYAN),
        ("Roblox StreamToEarn", "Прямая связь с вашими плейсами в Роблокс", PINK),
        ("Спиннеры и Колеса", "Рулетки подарков прямо в окне поверх игры", PURPLE),
    ]
    
    fy = 480
    for title, desc, col in features:
        draw_card(draw, 80, fy, 920, 120, radius=20, fill_color=(20, 26, 43, 230), border_color=(col[0], col[1], col[2], 80))
        draw.text((120, fy + 20), title, font=font_card_title, fill=col)
        draw.text((120, fy + 68), desc, font=font_body, fill=WHITE)
        fy += 140
        
    draw_card(draw, 80, 1220, 920, 190, radius=24, fill_color=(34, 211, 238, 25), border_color=CYAN)
    draw.text((120, 1260), "РАБОТАЕТ В 1 КЛИК", font=font_card_title, fill=CYAN)
    draw.text((120, 1320), "Вход через QR-код прямо с телефона без мучений с токенами!", font=font_body, fill=WHITE)
    
    draw_card(draw, 80, 1450, 920, 140, radius=20, fill_color=(251, 191, 36, 25), border_color=AMBER)
    draw.text((120, 1500), "Что дает предзаказ прямо сейчас? ->", font=font_card_title, fill=AMBER)
    
    return img

# ==================== SLIDE 4: PRE-ORDER PERKS (БОНУСЫ РАННИХ ПРЕДЗАКАЗОВ) ====================
def make_slide4():
    img = draw_gradient_background(glow_color=PURPLE, glow_y=500)
    draw = ImageDraw.Draw(img)
    
    draw_badge(draw, "ПРИВИЛЕГИИ ПЕРВЫХ УЧАСТНИКОВ", 80, 140, PURPLE)
    
    draw.text((80, 230), "ПОЧЕМУ НУЖНО", font=font_hero, fill=WHITE)
    draw.text((80, 310), "УСПЕТЬ СЕЙЧАС", font=font_hero, fill=PURPLE)
    draw.text((80, 400), "После официального релиза халявных мест больше не будет", font=font_body, fill=GRAY)
    
    draw_card(draw, 80, 480, 920, 580, radius=32)
    draw.text((120, 520), "Что дает предзаказ прямо сейчас:", font=font_card_title, fill=WHITE)
    
    perks = [
        ("Мгновенный доступ в Closed Beta", "Начинай стримить и зарабатывать уже сегодня, пока другие ждут", PINK),
        ("Пожизненная скидка 50% (OG Pass)", "Твой тариф заморозится навсегда на льготных условиях", AMBER),
        ("Прямая связь с разработчиками", "Добавим нужные тебе фичи и игры под твои стримы", CYAN),
        ("Готовые пресеты под ключ", "Настроенные оверлеи под OBS и TikTok Live Studio", EMERALD),
    ]
    
    py = 590
    for title, desc, col in perks:
        draw.rounded_rectangle([120, py, 960, py + 105], radius=16, fill=(30, 41, 59, 180), outline=(255, 255, 255, 18), width=1)
        draw.text((150, py + 16), title, font=font_body_bold, fill=col)
        draw.text((150, py + 58), desc, font=font_small, fill=GRAY)
        py += 125
        
    draw_card(draw, 80, 1100, 920, 310, radius=24)
    draw.text((120, 1140), "Лимит участников:", font=font_card_title, fill=WHITE)
    draw.text((120, 1200), "Всего выделено 500 мест для ранних стримеров.", font=font_body_bold, fill=AMBER)
    draw.text((120, 1260), "Больше половины мест уже забронировано!", font=font_body, fill=WHITE)
    draw.text((120, 1315), "С каждым предзаказом таймер релиза тает на глазах.", font=font_small, fill=GRAY)
    
    draw_card(draw, 80, 1450, 920, 140, radius=20, fill_color=(168, 85, 247, 25), border_color=PURPLE)
    draw.text((120, 1500), "Как занять свое место? Финал ->", font=font_card_title, fill=PURPLE)
    
    return img

# ==================== SLIDE 5: CTA (КАК ОФОРМИТЬ ПРЕДЗАКАЗ) ====================
def make_slide5():
    img = draw_gradient_background(glow_color=PINK, glow_y=500)
    draw = ImageDraw.Draw(img)
    
    draw_badge(draw, "БРОНИРУЙ МЕСТО В ПЕРВОЙ ВОЛНЕ", 80, 140, PINK)
    
    if app_icon:
        icon_resized = app_icon.resize((240, 240), Image.Resampling.LANCZOS)
        img.paste(icon_resized, (W // 2 - 120, 230), icon_resized)
        
    draw.text((W // 2 - 240, 500), "CHLAUNCHER", font=font_hero, fill=WHITE)
    draw.text((W // 2 - 310, 590), "ПРЕДЗАКАЗ ОТКРЫТ", font=font_title, fill=PINK)
    draw.text((W // 2 - 330, 670), "Ускорь релиз и заходи в бета-тест прямо сейчас", font=font_body, fill=GRAY)
    
    draw_card(draw, 80, 750, 920, 480, radius=28)
    draw.text((120, 790), "Как оформить предзаказ за 1 минуту:", font=font_card_title, fill=WHITE)
    
    steps = [
        "1. Переходи по ссылке в шапке профиля TikTok",
        "2. Заходи в наш Telegram-канал или бота @chlnchbot",
        "3. Нажимай «Предзаказ» — получи OG-роль и доступ к бете",
        "4. Каждый предзаказ срезает 2 ЧАСА до всеобщего релиза!",
    ]
    sy = 860
    for s in steps:
        draw.text((120, sy), s, font=font_body_bold if "2 ЧАСА" in s else font_body, fill=AMBER if "2 ЧАСА" in s else WHITE)
        sy += 65
        
    draw_card(draw, 80, 1270, 920, 260, radius=32, fill_color=(255, 77, 157, 45), border_color=PINK)
    draw.text((140, 1310), "ССЫЛКА НА КАНАЛ И ПРЕДЗАКАЗ:", font=font_badge, fill=PINK)
    draw.text((140, 1360), "В шапке профиля TikTok", font=font_hero, fill=WHITE)
    draw.text((140, 1450), "Канал: t.me/+nXUpPl7nOeQ1OWYy", font=font_card_title, fill=CYAN)
    
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
    img.save(out_path, format="PNG")
    saved_images.append(img.convert("RGB"))
    print("Saved:", out_path)

gif_path = os.path.join(OUTPUT_DIR, "tiktok_preorder_preview.gif")
small_frames = [im.resize((540, 960), Image.Resampling.LANCZOS) for im in saved_images]
small_frames[0].save(gif_path, save_all=True, append_images=small_frames[1:], duration=2500, loop=0)
print("Saved preview GIF:", gif_path)
print("Done!")
