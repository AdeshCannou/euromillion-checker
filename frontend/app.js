// ---- Config ----------------------------------------------------------
// Chemin relatif : le frontend est servi par le même Flask que l'API,
// donc pas besoin d'URL absolue (fonctionne en local, sur le Pi, et
// depuis le téléphone via Tailscale sans rien changer).
const API_URL = "/api/latest-draw";

// ---- Helpers -----------------------------------------------------------
function getVals(id) {
  return [...document.querySelectorAll("#" + id + " input")]
    .map((i) => parseInt(i.value))
    .filter((v) => !isNaN(v));
}

function setVals(id, values) {
  const inputs = document.querySelectorAll("#" + id + " input");
  inputs.forEach((input, i) => {
    input.value = values[i] ?? "";
  });
}

// input[type=number] n'empêche pas de taper au-delà de min/max (et
// maxlength est ignoré sur ce type de champ) : il faut donc clamper
// nous-mêmes à chaque frappe.
function clampContainer(id, min, max) {
  document.querySelectorAll("#" + id + " input").forEach((input) => {
    input.addEventListener("input", () => {
      if (input.value === "") return; // laisser vide pendant la saisie
      let v = parseInt(input.value);
      if (isNaN(v)) {
        input.value = "";
        return;
      }
      v = Math.min(max, Math.max(min, v));
      input.value = v;
    });
  });
}

clampContainer("mine-main", 1, 50);
clampContainer("mine-star", 1, 12);
clampContainer("draw-main", 1, 50);
clampContainer("draw-star", 1, 12);

// Appariement optimal (distance totale minimale) par permutations —
// suffisant pour n=5 (120 permutations) et n=2 (2 permutations).
function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) {
      result.push([arr[i], ...p]);
    }
  }
  return result;
}

function bestPairing(picked, drawn) {
  let best = null;
  let bestDist = Infinity;
  for (const perm of permutations(drawn)) {
    let dist = 0;
    for (let i = 0; i < picked.length; i++) dist += Math.abs(picked[i] - perm[i]);
    if (dist < bestDist) {
      bestDist = dist;
      best = perm;
    }
  }
  return best;
}

// ---- Fetch du dernier tirage officiel / d'un tirage à une date donnée ---
const API_BASE = API_URL.replace(/\/api\/latest-draw$/, "");
const SCORES_API = `${API_BASE}/api/scores`;

const fetchBtn = document.getElementById("fetch-btn");
const fetchDateBtn = document.getElementById("fetch-date-btn");
const dateInput = document.getElementById("date-input");
const fetchStatus = document.getElementById("fetch-status");

// Date du tirage actuellement affiché dans le panneau "Tirage officiel",
// pour la joindre à l'historique. Remise à null dès que l'utilisateur
// modifie les champs à la main (setVals ne déclenche pas 'input', donc
// un remplissage automatique ne la réinitialise pas).
let lastKnownDrawDate = null;
document.querySelectorAll("#draw-main input, #draw-star input").forEach((input) => {
  input.addEventListener("input", () => {
    lastKnownDrawDate = null;
  });
});

// Le calendrier ne doit pas proposer de dates futures
dateInput.max = new Date().toISOString().split("T")[0];

async function runFetch(btn, url, successLabel) {
  btn.disabled = true;
  btn.classList.add("loading");
  fetchStatus.textContent = "Récupération du tirage...";
  fetchStatus.className = "fetch-status";

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok || data.error) {
      throw new Error(data.error || "Erreur inconnue");
    }

    setVals("draw-main", data.numbers);
    setVals("draw-star", data.stars);
    lastKnownDrawDate = data.date;

    fetchStatus.textContent = `${successLabel(data)} ✓`;
    fetchStatus.className = "fetch-status ok";
  } catch (err) {
    fetchStatus.textContent = err.message.includes("Aucun")
      ? err.message
      : "Impossible de récupérer le tirage (backend indisponible ?). Entrez-le à la main.";
    fetchStatus.className = "fetch-status error";
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
  }
}

fetchBtn.addEventListener("click", () => {
  runFetch(fetchBtn, API_URL, (data) => `Tirage du ${data.date} récupéré`);
});

fetchDateBtn.addEventListener("click", () => {
  if (!dateInput.value) {
    fetchStatus.textContent = "Choisis d'abord une date.";
    fetchStatus.className = "fetch-status error";
    return;
  }
  // input[type=date] donne AAAA-MM-JJ -> l'API attend JJ/MM/AAAA
  const [y, m, d] = dateInput.value.split("-");
  const frDate = `${d}/${m}/${y}`;
  runFetch(fetchDateBtn, `${API_BASE}/api/draw?date=${frDate}`, (data) => `Tirage du ${data.date} récupéré`);
});

// ---- Historique & stats ---------------------------------------------------
async function loadHistory() {
  try {
    const res = await fetch(SCORES_API);
    const entries = await res.json();
    renderStats(entries);
    renderSparkline(entries);
    renderHistoryList(entries);
  } catch (err) {
    console.error("Impossible de charger l'historique", err);
  }
}

function renderStats(entries) {
  const els = {
    last: document.getElementById("stat-last"),
    best: document.getElementById("stat-best"),
    worst: document.getElementById("stat-worst"),
    avg: document.getElementById("stat-avg"),
    count: document.getElementById("stat-count"),
    bestAlign: document.getElementById("stat-best-align"),
  };

  if (!entries.length) {
    els.last.textContent = els.best.textContent = els.worst.textContent = els.avg.textContent = "—";
    els.count.textContent = "0";
    els.bestAlign.textContent = "—";
    return;
  }

  const scores = entries.map((e) => e.score);
  const last = entries[entries.length - 1].score; // log en ordre chronologique croissant
  const best = Math.max(...scores);
  const worst = Math.min(...scores);
  const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const bestAlign = Math.max(...entries.map((e) => (e.exact_main || 0) + (e.exact_star || 0)));

  els.last.textContent = last;
  els.best.textContent = best;
  els.worst.textContent = worst;
  els.avg.textContent = avg;
  els.count.textContent = entries.length;
  els.bestAlign.textContent = `${bestAlign} / 7`;
}

function renderSparkline(entries) {
  const svg = document.getElementById("sparkline");
  if (!entries.length) {
    svg.innerHTML = "";
    return;
  }
  const recent = entries.slice(-20);
  const w = 260, h = 50, pad = 4;
  const scores = recent.map((e) => e.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;
  const stepX = recent.length > 1 ? (w - pad * 2) / (recent.length - 1) : 0;

  const points = scores
    .map((s, i) => {
      const x = pad + i * stepX;
      const y = h - pad - ((s - min) / range) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  svg.innerHTML = `
    <defs>
      <linearGradient id="sparkGrad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#D4AF37"/>
        <stop offset="100%" stop-color="#7C6FFF"/>
      </linearGradient>
    </defs>
    <polyline points="${points}" fill="none" stroke="url(#sparkGrad)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  `;
}

function renderHistoryList(entries) {
  const list = document.getElementById("history-list");
  if (!entries.length) {
    list.innerHTML = `<p class="empty-hint">Aucune grille vérifiée pour l'instant.</p>`;
    return;
  }
  const recent = [...entries].reverse().slice(0, 15);
  list.innerHTML = recent
    .map((e) => {
      const dt = new Date(e.timestamp);
      const dateLabel = isNaN(dt)
        ? ""
        : dt.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      const drawLabel = e.draw_date ? ` · tirage ${e.draw_date}` : "";
      return `<div class="history-row">
        <span class="history-date">${dateLabel}${drawLabel}</span>
        <span class="history-score">${e.score}</span>
      </div>`;
    })
    .join("");
}

async function saveScoreEntry(payload) {
  try {
    await fetch(SCORES_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    loadHistory();
  } catch (err) {
    console.error("Impossible d'enregistrer le score", err);
  }
}

document.getElementById("clear-history-btn").addEventListener("click", async () => {
  if (!confirm("Effacer tout l'historique des scores ?")) return;
  try {
    await fetch(SCORES_API, { method: "DELETE" });
    loadHistory();
  } catch (err) {
    console.error(err);
  }
});

loadHistory();

// ---- Calcul du score -----------------------------------------------------
document.getElementById("calc-btn").addEventListener("click", computeScore);

function computeScore() {
  const myMain = getVals("mine-main");
  const myStar = getVals("mine-star");
  const drMain = getVals("draw-main");
  const drStar = getVals("draw-star");

  if (myMain.length !== 5 || myStar.length !== 2 || drMain.length !== 5 || drStar.length !== 2) {
    alert("Merci de remplir les 5 numéros et 2 étoiles pour votre grille ET le tirage.");
    return;
  }

  const mainPairs = bestPairing(myMain, drMain);
  const starPairs = bestPairing(myStar, drStar);

  // Numéros : 20 pts max par paire (5x20=100), écart max = 49
  let mainScore = 0;
  const mainLines = [];
  let exactMain = 0;
  myMain.forEach((n, i) => {
    const d = Math.abs(n - mainPairs[i]);
    if (d === 0) exactMain++;
    mainScore += Math.max(0, 20 * (1 - d / 49));
    mainLines.push({ n, m: mainPairs[i], d });
  });

  // Étoiles : 50 pts max par paire (2x50=100), écart max = 11
  let starScore = 0;
  const starLines = [];
  let exactStar = 0;
  myStar.forEach((n, i) => {
    const d = Math.abs(n - starPairs[i]);
    if (d === 0) exactStar++;
    starScore += Math.max(0, 50 * (1 - d / 11));
    starLines.push({ n, m: starPairs[i], d });
  });

  const finalScore = Math.round(0.8 * mainScore + 0.2 * starScore);

  document.getElementById("score-val").textContent = finalScore;
  document.getElementById("exact-main").textContent = exactMain + " / 5";
  document.getElementById("exact-star").textContent = exactStar + " / 2";

  let title, desc;
  if (finalScore >= 90) {
    title = "Extrêmement proche !";
    desc = "Vos numéros collent presque parfaitement au tirage.";
  } else if (finalScore >= 70) {
    title = "Très proche";
    desc = "Bon nombre de vos numéros sont voisins du tirage.";
  } else if (finalScore >= 45) {
    title = "Dans la moyenne";
    desc = "Quelques numéros proches, d'autres assez éloignés.";
  } else {
    title = "Assez éloigné";
    desc = "Vos numéros sont globalement loin du tirage cette fois.";
  }
  document.getElementById("score-title").textContent = title;
  document.getElementById("score-desc").textContent = desc;

  const circumference = 351.86;
  const offset = circumference * (1 - finalScore / 100);
  const arc = document.getElementById("gauge-arc");
  arc.style.strokeDashoffset = circumference;
  requestAnimationFrame(() => {
    arc.style.strokeDashoffset = offset;
  });

  document.getElementById("pairs-main").innerHTML = mainLines
    .sort((a, b) => a.d - b.d)
    .map(
      (p) =>
        `<div class="pair-line"><span class="n">${p.n}</span><span class="arrow">→</span><span class="${
          p.d === 0 ? "d0" : ""
        }">${p.m}</span><span style="margin-left:auto;">écart ${p.d === 0 ? "exact" : p.d}</span></div>`
    )
    .join("");

  document.getElementById("pairs-star").innerHTML = starLines
    .sort((a, b) => a.d - b.d)
    .map(
      (p) =>
        `<div class="pair-line"><span class="n">${p.n}</span><span class="arrow">→</span><span class="${
          p.d === 0 ? "d0" : ""
        }">${p.m}</span><span style="margin-left:auto;">écart ${p.d === 0 ? "exact" : p.d}</span></div>`
    )
    .join("");

  document.getElementById("result").classList.add("show");

  saveScoreEntry({
    score: finalScore,
    exact_main: exactMain,
    exact_star: exactStar,
    my_numbers: myMain,
    my_stars: myStar,
    draw_numbers: drMain,
    draw_stars: drStar,
    draw_date: lastKnownDrawDate,
  });
}
