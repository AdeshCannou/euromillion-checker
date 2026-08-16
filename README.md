# EuroMillions — Grille vs Tirage

Compare ta grille au dernier tirage EuroMillions officiel et obtiens un
score de proximité (pas juste "bon/mauvais numéro", mais à quel point
chaque numéro est proche du tirage).

## Structure

```
euromillions-checker/
├── backend/          Flask API qui va chercher le dernier tirage sur fdj.fr
│   ├── app.py
│   └── requirements.txt
├── frontend/         Interface statique (HTML/CSS/JS, aucun framework)
│   ├── index.html
│   ├── style.css
│   └── app.js
└── README.md
```

## Lancer le backend

```bash
cd backend
python -m venv venv
source venv/bin/activate      # Windows : venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

L'API tourne sur `http://localhost:5000`. Teste avec :

```bash
curl http://localhost:5000/api/latest-draw
```

Tu dois obtenir quelque chose comme :

```json
{"date": "15/08/2026", "numbers": [3, 12, 24, 31, 45], "stars": [4, 9]}
```

Pour un tirage à une date précise (n'importe quand depuis février 2004) :

```bash
curl "http://localhost:5000/api/draw?date=14/08/2026"
```

## Lancer le frontend

Le frontend est 100% statique — pas de build, pas de dépendance.
Ouvre simplement `frontend/index.html` dans un navigateur, ou sers-le
avec un petit serveur local :

```bash
cd frontend
python -m http.server 8000
# puis ouvre http://localhost:8000
```

Deux façons de remplir "Tirage officiel" :
- **"Récupérer le dernier tirage officiel"** → dernier tirage en date.
- **Calendrier + "Récupérer ce tirage"** → tirage d'une date précise,
  n'importe où dans l'historique FDJ (depuis février 2004).

Tu peux toujours modifier les valeurs à la main à tout moment.

## Comment ça marche (backend)

1. `discover_periods()` scrape la page historique FDJ et retrouve
   dynamiquement toutes les périodes d'archive disponibles (FDJ découpe
   son historique en plusieurs ZIP : 2004→2011, 2011→2014, ...,
   2020→aujourd'hui). Pas d'URL codée en dur : si FDJ ouvre une
   nouvelle période, rien à changer dans le code.
2. Pour le dernier tirage : on télécharge le ZIP de la période la plus
   récente, on parse le CSV, on prend la première ligne (FDJ trie du
   plus récent au plus ancien).
3. Pour une date précise : on détermine quelle période contient cette
   date, on télécharge son ZIP si besoin, et on cherche la ligne dont
   la colonne date correspond exactement.
4. Chaque période téléchargée est mise en cache 1h côté serveur (et la
   liste des périodes 24h) pour éviter de re-télécharger à chaque appel.

## Historique des scores

Chaque grille vérifiée est enregistrée automatiquement dans
`backend/logs/scores.jsonl` (créé au premier score), une ligne JSON par
grille. Le panneau latéral affiche :

- Dernier score / meilleur / pire / moyenne
- Nombre de grilles vérifiées
- Meilleur alignement (numéros + étoiles exacts en une seule grille)
- Un graphique d'évolution (20 derniers scores)
- La liste des 15 grilles les plus récentes

Le bouton "Effacer l'historique" supprime `scores.jsonl`. Comme le
fichier est en JSON Lines, tu peux aussi l'ouvrir/éditer à la main ou
l'analyser avec n'importe quel outil ligne par ligne.

## Notes

- **CORS** est activé côté backend (`flask-cors`) pour que le frontend
  (servi sur un autre port) puisse appeler l'API sans blocage navigateur.
- Si `fdj.fr` change la structure de sa page ou son format CSV, seul
  `backend/app.py` a besoin d'être ajusté — le frontend n'a pas à changer.
- Le fichier CSV FDJ est en `;` avec encodage UTF-8 avec BOM, c'est géré
  automatiquement (`utf-8-sig`).
- Ce projet suppose un usage local / réseau de confiance (pas
  d'authentification sur l'API). Pour un déploiement public, ajoute une
  limite de débit (rate limiting) sur `/api/latest-draw`.

## Déployer sur le Raspberry Pi (accès permanent, y compris depuis le tel)

Même principe que pour PSG : un service systemd, accès à distance via
Tailscale (pas de port forwarding nécessaire avec le CGNAT SFR).

Différence avec PSG : ici un seul service suffit, car Flask sert
directement les fichiers du frontend (`frontend/index.html`,
`style.css`, `app.js`) en plus de l'API — pas besoin d'un second
service ni d'un reverse proxy.

```bash
# Sur le Pi
git clone <url-de-ton-repo> euromillions-checker
cd euromillions-checker/backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Test manuel avant de passer en service
waitress-serve --host=0.0.0.0 --port=5000 app:app
# -> depuis un autre appareil sur le même réseau (ou via Tailscale) :
#    http://<ip-du-pi>:5000
```

Si l'accès manuel fonctionne, installe le service (`deploy/euromillions.service` est déjà prêt, adapte juste le `User=` et les chemins si ton repo n'est pas dans `/home/pi/`) :

```bash
sudo cp deploy/euromillions.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now euromillions.service

# Vérifier que ça tourne
sudo systemctl status euromillions
journalctl -u euromillions -f
```

Ensuite, depuis ton téléphone (avec Tailscale installé et connecté au
même tailnet que le Pi) : `http://<ip-tailscale-du-pi>:5000`.

**Note sur `backend/logs/scores.jsonl`** : ce fichier vit sur le Pi une
fois déployé — c'est lui la source de vérité pour ton historique de
scores, pas ton poste de dev local. Le `.gitignore` fourni exclut déjà
`backend/logs/` du repo Git, pour ne pas committer tes scores ni
écraser ceux du Pi à chaque `git pull`.
