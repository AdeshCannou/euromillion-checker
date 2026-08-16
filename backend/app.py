"""
EuroMillions draw API
======================

Backend Flask avec deux fonctions :
  1. Dernier tirage officiel        -> GET /api/latest-draw
  2. Tirage d'une date précise      -> GET /api/draw?date=JJ/MM/AAAA

FDJ ne publie pas un seul CSV avec tout l'historique : elle découpe en
plusieurs archives ZIP par période (ex: "février 2020 à août 2026",
"mars 2019 à février 2020", etc.), listées sur la page historique.
Cette page peut évoluer (nouvelle période ouverte, anciennes bornes
modifiées) — `discover_periods()` la scrape à chaque fois qu'on en a
besoin (avec cache) plutôt que de coder les URLs en dur, donc pas de
maintenance nécessaire si FDJ ajoute une période.

Lancer en local :
    pip install -r requirements.txt
    python app.py
    # -> http://localhost:5000/api/latest-draw
    # -> http://localhost:5000/api/draw?date=14/08/2026
"""

import calendar
import csv
import io
import json
import re
import uuid
import zipfile
from datetime import date, datetime, timedelta
from pathlib import Path

import requests
from bs4 import BeautifulSoup
from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

FDJ_HISTORIQUE_PAGE = "https://www.fdj.fr/jeux-de-tirage/euromillions-my-million/historique"
ZIP_URL_PATTERN = re.compile(
    r"https://www\.sto\.api\.fdj\.fr/anonymous/service-draw-info/v3/documentations/[a-f0-9\-]+"
)

FR_MONTHS = {
    "janvier": 1, "février": 2, "fevrier": 2, "mars": 3, "avril": 4,
    "mai": 5, "juin": 6, "juillet": 7, "août": 8, "aout": 8,
    "septembre": 9, "octobre": 10, "novembre": 11, "décembre": 12, "decembre": 12,
}
PERIOD_TITLE_RE = re.compile(
    r"de\s+(\w+)\s+(\d{4})\s+à\s+(\w+)\s+(\d{4})", re.IGNORECASE
)

# Fallback si le scraping de la page historique échoue (changement de
# structure de page, etc.) — couvre au moins la période en cours.
FALLBACK_PERIODS = [
    {
        "url": "https://www.sto.api.fdj.fr/anonymous/service-draw-info/v3/documentations/1a2b3c4d-9876-4562-b3fc-2c963f66afe6",
        "start": date(2020, 2, 1),
        "end": date(2026, 8, 31),
    }
]

# Cache : liste des périodes (change rarement) + contenu CSV par période
# (les tirages n'ont lieu que mardi/vendredi, pas besoin de re-télécharger
# à chaque requête).
_periods_cache = {"data": None, "fetched_at": None}
_rows_cache = {}  # url -> {"rows": [...], "fetched_at": datetime}
PERIODS_TTL = timedelta(hours=24)
ROWS_TTL = timedelta(hours=1)

# ---------------------------------------------------------------------------
# Historique des scores — stocké en JSON Lines (une grille vérifiée = une
# ligne). Simple, lisible à l'oeil, facile à parser sans base de données.
# ---------------------------------------------------------------------------
LOG_DIR = Path(__file__).parent / "logs"
SCORES_LOG_FILE = LOG_DIR / "scores.jsonl"


def read_score_entries() -> list:
    if not SCORES_LOG_FILE.exists():
        return []
    entries = []
    with open(SCORES_LOG_FILE, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # ligne corrompue, on ignore plutôt que de tout casser
    return entries


def append_score_entry(entry: dict) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with open(SCORES_LOG_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def discover_periods() -> list:
    """Scrape la page historique FDJ et retourne la liste des périodes
    disponibles, chacune avec son URL de ZIP et ses bornes de date."""
    now = datetime.now()
    if _periods_cache["data"] and now - _periods_cache["fetched_at"] < PERIODS_TTL:
        return _periods_cache["data"]

    try:
        resp = requests.get(FDJ_HISTORIQUE_PAGE, timeout=10)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")

        periods = []
        for link in soup.find_all("a", href=ZIP_URL_PATTERN):
            title = link.get("title", "") or link.get_text(" ", strip=True)
            match = PERIOD_TITLE_RE.search(title)
            if not match:
                continue
            m1, y1, m2, y2 = match.groups()
            m1_num = FR_MONTHS.get(m1.lower())
            m2_num = FR_MONTHS.get(m2.lower())
            if not m1_num or not m2_num:
                continue
            start = date(int(y1), m1_num, 1)
            last_day = calendar.monthrange(int(y2), m2_num)[1]
            end = date(int(y2), m2_num, last_day)
            periods.append({"url": link["href"], "start": start, "end": end})

        if periods:
            periods.sort(key=lambda p: p["start"], reverse=True)
            _periods_cache["data"] = periods
            _periods_cache["fetched_at"] = now
            return periods
    except requests.RequestException:
        pass

    return FALLBACK_PERIODS


def find_period_for_date(target: date, periods: list):
    for period in periods:
        if period["start"] <= target <= period["end"]:
            return period
    return None


def get_period_rows(zip_url: str) -> list:
    """Télécharge (ou sert depuis le cache) toutes les lignes du CSV
    d'une période, normalisées en dicts {colonne_minuscule: valeur}."""
    now = datetime.now()
    cached = _rows_cache.get(zip_url)
    if cached and now - cached["fetched_at"] < ROWS_TTL:
        return cached["rows"]

    resp = requests.get(zip_url, timeout=15)
    resp.raise_for_status()

    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        csv_names = [n for n in zf.namelist() if n.lower().endswith(".csv")]
        if not csv_names:
            raise ValueError("Aucun fichier CSV trouvé dans l'archive FDJ.")
        with zf.open(csv_names[0]) as f:
            raw = f.read().decode("utf-8-sig", errors="replace")

    reader = csv.DictReader(io.StringIO(raw), delimiter=";")
    rows = [
        {k.strip().lower(): v.strip() for k, v in row.items() if k}
        for row in reader
        if any(v.strip() for v in row.values() if v)
    ]
    if not rows:
        raise ValueError("Le CSV FDJ est vide.")

    _rows_cache[zip_url] = {"rows": rows, "fetched_at": now}
    return rows


def parse_draw_row(normalized: dict) -> dict:
    """Extrait date, numéros et étoiles d'une ligne déjà normalisée
    (clés en minuscules). Ne dépend pas d'un nom de colonne exact,
    seulement de motifs ('date', 'boule', 'etoile') puisque FDJ a fait
    varier les en-têtes selon les périodes."""
    date_key = next((k for k in normalized if "date" in k), None)
    draw_date = normalized.get(date_key, "") if date_key else ""

    main_keys = sorted(k for k in normalized if "boule" in k)
    star_keys = sorted(k for k in normalized if "etoile" in k)

    numbers = [int(normalized[k]) for k in main_keys[:5] if normalized[k].isdigit()]
    stars = [int(normalized[k]) for k in star_keys[:2] if normalized[k].isdigit()]

    return {"date": draw_date, "numbers": numbers, "stars": stars}


@app.route("/api/latest-draw", methods=["GET"])
def latest_draw():
    try:
        periods = discover_periods()
        # FDJ trie chaque CSV du tirage le plus récent au plus ancien :
        # la première ligne de la période la plus récente = dernier tirage.
        rows = get_period_rows(periods[0]["url"])
        draw = parse_draw_row(rows[0])

        if len(draw["numbers"]) != 5 or len(draw["stars"]) != 2:
            return jsonify({"error": "Format de tirage inattendu, réessayez plus tard."}), 502

        return jsonify(draw)

    except requests.RequestException as exc:
        return jsonify({"error": f"Impossible de contacter fdj.fr : {exc}"}), 502
    except (zipfile.BadZipFile, ValueError) as exc:
        return jsonify({"error": f"Impossible de lire l'historique FDJ : {exc}"}), 502


@app.route("/api/draw", methods=["GET"])
def draw_by_date():
    date_str = request.args.get("date", "").strip()
    try:
        target = datetime.strptime(date_str, "%d/%m/%Y").date()
    except ValueError:
        return jsonify({"error": "Format de date invalide, attendu JJ/MM/AAAA."}), 400

    try:
        periods = discover_periods()
        oldest_start = min(p["start"] for p in periods)
        newest_end = max(p["end"] for p in periods)
        if target < oldest_start or target > newest_end:
            return jsonify({
                "error": f"Aucun historique disponible avant le {oldest_start.strftime('%d/%m/%Y')}."
            }), 404

        period = find_period_for_date(target, periods)
        if not period:
            return jsonify({"error": "Aucune période d'archive ne couvre cette date."}), 404

        rows = get_period_rows(period["url"])
        match = next(
            (r for r in rows if r.get(next((k for k in r if "date" in k), ""), "") == date_str),
            None,
        )
        if not match:
            return jsonify({
                "error": "Aucun tirage à cette date (les tirages ont lieu le mardi et le vendredi)."
            }), 404

        return jsonify(parse_draw_row(match))

    except requests.RequestException as exc:
        return jsonify({"error": f"Impossible de contacter fdj.fr : {exc}"}), 502
    except (zipfile.BadZipFile, ValueError) as exc:
        return jsonify({"error": f"Impossible de lire l'historique FDJ : {exc}"}), 502


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


# ---------------------------------------------------------------------------
# Historique des scores
# ---------------------------------------------------------------------------

REQUIRED_SCORE_FIELDS = ["score", "my_numbers", "my_stars", "draw_numbers", "draw_stars"]


@app.route("/api/scores", methods=["GET"])
def get_scores():
    return jsonify(read_score_entries())


@app.route("/api/scores", methods=["POST"])
def add_score():
    body = request.get_json(silent=True) or {}
    missing = [k for k in REQUIRED_SCORE_FIELDS if k not in body]
    if missing:
        return jsonify({"error": f"Champs manquants : {', '.join(missing)}"}), 400

    entry = {
        "id": str(uuid.uuid4()),
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "score": body["score"],
        "exact_main": body.get("exact_main", 0),
        "exact_star": body.get("exact_star", 0),
        "my_numbers": body["my_numbers"],
        "my_stars": body["my_stars"],
        "draw_numbers": body["draw_numbers"],
        "draw_stars": body["draw_stars"],
        "draw_date": body.get("draw_date"),  # None si tirage saisi à la main sans date connue
    }
    append_score_entry(entry)
    return jsonify(entry), 201


@app.route("/api/scores", methods=["DELETE"])
def clear_scores():
    if SCORES_LOG_FILE.exists():
        SCORES_LOG_FILE.unlink()
    return jsonify({"status": "cleared"})


if __name__ == "__main__":
    app.run(debug=True, port=5000)
