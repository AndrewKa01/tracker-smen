"""
Бэкенд трекера смен.

Идея простая: фронтенд как раньше работает с одним большим объектом
state = { settings: {...}, shifts: [...] }. Раньше он лежал одним
JSON-блобом в localStorage. Теперь тот же самый блок данных пересобирается
на лету из трёх таблиц SQLite — но наружу, для фронтенда, ничего не
меняется: GET /api/state отдаёт ровно такой же JSON, какой раньше лежал
в localStorage, а POST /api/state принимает такой же JSON обратно.

Почему три таблицы, а не одна:
  - shifts       — одна строка на одну смену, их может быть сотни.
  - settings     — ровно одна строка (id=1): цена бензина, расход, тема.
                   Это не сущность, которая повторяется — она одна на всё
                   приложение, поэтому не имеет смысла хранить её вместе
                   со сменами.
  - month_goals  — одна строка на один месяц с целью. Тоже отдельно от
                   settings, потому что их может быть много (по одной на
                   каждый месяц), а не одна на всё приложение.

Это и есть нормализация в двух словах: каждый факт хранится там, где
у него подходящая "кратность" — один-к-одному, один-ко-многим и т.д.,
а не всё вперемешку в одной большой куче.
"""

import socket
import sqlite3
from pathlib import Path

import ifaddr
from flask import Flask, g, jsonify, request, send_from_directory
from zeroconf import ServiceInfo, Zeroconf

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "database.db"

app = Flask(__name__)  # static_folder='static' и static_url_path='/static' — это и так дефолт


# ── подключение к БД ──────────────────────────────────────────────
# На каждый запрос — своё соединение (это дёшево для SQLite), храним его
# в объекте g, который Flask создаёт заново на каждый запрос и убирает
# по завершении. Так не нужно думать про потокобезопасность вручную.
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row  # чтобы обращаться к колонкам по имени, а не по индексу
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS settings (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            fuel_price  REAL,
            consumption REAL DEFAULT 9,
            theme       TEXT DEFAULT 'dark'
        );

        CREATE TABLE IF NOT EXISTS month_goals (
            month_key TEXT PRIMARY KEY,   -- 'YYYY-MM'
            amount    REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS shifts (
            id         INTEGER PRIMARY KEY,   -- id приходит с фронтенда (Date.now()), не autoincrement
            date       TEXT NOT NULL,          -- 'YYYY-MM-DD'
            period     TEXT NOT NULL,          -- 'day' | 'night' | 'personal'
            duration   INTEGER NOT NULL DEFAULT 0,   -- минуты
            start_time TEXT,                    -- 'HH:MM' или NULL
            end_time   TEXT,                    -- 'HH:MM' или NULL
            amount     REAL NOT NULL,
            mileage    REAL,
            liters     REAL,
            expenses   REAL NOT NULL DEFAULT 0
        );
        """
    )
    # ровно одна строка настроек — создаём один раз, если её ещё нет
    db.execute("INSERT OR IGNORE INTO settings (id) VALUES (1)")
    db.commit()
    db.close()


# ── сборка/разбор state — тут и происходит вся "магия" совместимости ──
def load_state():
    db = get_db()

    s = db.execute("SELECT * FROM settings WHERE id = 1").fetchone()
    goals = db.execute("SELECT month_key, amount FROM month_goals").fetchall()

    settings = {
        "fuelPrice": s["fuel_price"],
        "consumption": s["consumption"],
        "theme": s["theme"],
        "monthGoals": {row["month_key"]: row["amount"] for row in goals},
    }

    rows = db.execute("SELECT * FROM shifts ORDER BY date, start_time").fetchall()
    shifts = [
        {
            "id": row["id"],
            "date": row["date"],
            "period": row["period"],
            "duration": row["duration"],
            # start/end — так их называет фронтенд; start_time/end_time — только имена колонок в БД
            "start": row["start_time"],
            "end": row["end_time"],
            "amount": row["amount"],
            "mileage": row["mileage"],
            "liters": row["liters"],
            "expenses": row["expenses"],
        }
        for row in rows
    ]

    return {"settings": settings, "shifts": shifts}


def save_state(data):
    db = get_db()
    settings = data.get("settings", {}) or {}
    shifts = data.get("shifts", []) or []
    month_goals = settings.get("monthGoals", {}) or {}

    # settings — просто перезаписываем единственную строку
    db.execute(
        "UPDATE settings SET fuel_price = ?, consumption = ?, theme = ? WHERE id = 1",
        (settings.get("fuelPrice"), settings.get("consumption"), settings.get("theme")),
    )

    # month_goals и shifts — целиком стираем и заливаем заново.
    # Это не "правильный" построчечный CRUD (в духе POST/PUT/DELETE на
    # каждую смену отдельно), а прямой аналог того, как раньше работал
    # localStorage: весь стейт целиком одним куском. Для личного трекера
    # на одном компьютере это абсолютно нормально — объём данных крошечный,
    # а код в разы проще. Если захочешь позже сделать "по-честному" —
    # это будет отдельным добавлением пары эндпоинтов, без переделки схемы.
    db.execute("DELETE FROM month_goals")
    db.executemany(
        "INSERT INTO month_goals (month_key, amount) VALUES (?, ?)",
        list(month_goals.items()),
    )

    db.execute("DELETE FROM shifts")
    db.executemany(
        """
        INSERT INTO shifts (id, date, period, duration, start_time, end_time, amount, mileage, liters, expenses)
        VALUES (:id, :date, :period, :duration, :start, :end, :amount, :mileage, :liters, :expenses)
        """,
        shifts,
    )

    db.commit()


# ── mDNS: чтобы с телефона можно было набрать http://smena.local:5000 ──
# вместо голого IP. Windows сам по себе НЕ отвечает на mDNS-запросы для
# произвольных имён (в отличие от macOS/iOS, где это встроено) — поэтому
# программа сама берёт это на себя: пока app.py запущен, в сети рассылается
# объявление "IP такой-то отзывается на имя smena.local". Как только
# скрипт останавливаешь — объявление снимается, и имя больше не отвечает.
# ── mDNS: чтобы с телефона можно было набрать http://smena.local:5000 ──
# вместо голого IP. Windows сам по себе НЕ отвечает на mDNS-запросы для
# произвольных имён (в отличие от macOS/iOS, где это встроено) — поэтому
# программа сама берёт это на себя: пока app.py запущен, в сети рассылается
# объявление "IP такой-то отзывается на имя smena.local". Как только
# скрипт останавливаешь — объявление снимается, и имя больше не отвечает.
def get_all_local_ips():
    # Раньше тут был трюк с "подключением" по UDP к 8.8.8.8, чтобы
    # посмотреть, какой интерфейс ОС выберет для выхода наружу. Проблема:
    # если на компьютере есть виртуальные адаптеры (Hyper-V, WSL, Docker,
    # VPN) — таблица маршрутизации может отдать предпочтение ИМ, и трюк
    # вернёт адрес виртуальной сети, до которой с телефона не достучаться
    # (ровно это и произошло: 10.0.85.1 — это виртуальный адаптер, а не Wi-Fi).
    #
    # Поэтому теперь просто перебираем ВСЕ адаптеры и рассылаем smena.local
    # сразу на все найденные адреса. Телефон получит все варианты, реальный
    # Wi-Fi-адрес окажется среди них и просто сработает, а до виртуальных
    # адресов телефон физически не дотянется — они тихо будут пропущены.
    ips = []
    for adapter in ifaddr.get_adapters():
        for ip in adapter.ips:
            if ip.is_IPv4 and ip.ip != "127.0.0.1":
                ips.append(ip.ip)
    return ips


def start_mdns(port):
    ips = get_all_local_ips()
    if not ips:
        print("[mDNS] не нашёл ни одного сетевого адаптера — объявление не запущено")
        return None, None

    info = ServiceInfo(
        "_http._tcp.local.",
        "Смена._http._tcp.local.",
        addresses=[socket.inet_aton(ip) for ip in ips],
        port=port,
        server="smena.local.",
    )
    zc = Zeroconf()
    zc.register_service(info)
    print(f"[mDNS] smena.local -> {', '.join(ips)}")
    print("       (если не заработает — открой на телефоне напрямую один из этих адресов с портом :5000)")
    return zc, info



@app.get("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")


@app.get("/api/state")
def get_state():
    return jsonify(load_state())


@app.post("/api/state")
def post_state():
    data = request.get_json(force=True, silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "expected a JSON object"}), 400
    save_state(data)
    return jsonify({"ok": True})


if __name__ == "__main__":
    init_db()
    PORT = 5000
    # use_reloader=False — важно: дефолтный авто-перезапуск Flask следит за
    # изменением файлов в папке проекта, а database.db лежит в той же папке.
    # Каждая запись в базу (INSERT/DELETE) выглядела для него как "файл
    # изменился", и сервер на середине запроса перезапускался сам на себя.
    zc, info = start_mdns(PORT)
    try:
        app.run(host="0.0.0.0", debug=True, use_reloader=False, port=PORT)
    finally:
        # снимаем объявление, чтобы имя не "висело" в сети после остановки сервера
        if zc is not None:
            zc.unregister_service(info)
            zc.close()
