import express from "express";
import * as cheerio from "cheerio";
import { writeFile, readFile } from "fs/promises";

/* ================= Config ================= */
const BASE = "https://pesdb.net/efootball";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, como Gecko) Chrome/118 Safari/537.36";
const PORT = process.env.PORT || 3000;

/** Politeness & control */
const REQUEST_DELAY_MS_MIN = 2500;  // delay mínimo entre páginas
const REQUEST_DELAY_MS_MAX = 4000;  // delay máximo (jitter)
const MAX_RETRIES = 5;              // reintentos ante 429/5xx
const MAX_PAGES_DEBUG = 0;          // 0 = crawl completo; p.ej. 3 para probar

/** Archivos de estado */
const SNAPSHOT_FILE = "./data.json";
const CHECKPOINT_FILE = "./checkpoint.json";

/* ================ Helpers ================ */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sanitize = (s) => String(s ?? "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
const jitter = () =>
  REQUEST_DELAY_MS_MIN + Math.floor(Math.random() * (REQUEST_DELAY_MS_MAX - REQUEST_DELAY_MS_MIN + 1));

/** Descarga HTML con headers + manejo de rate-limit/backoff */
async function fetchHtml(url) {
  let attempt = 0;
  while (true) {
    const res = await fetch(url, {
      headers: {
        "user-agent": UA,
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "es-AR,es;q=0.9,en;q=0.8",
        "referer": "https://pesdb.net/",
        "cache-control": "no-cache"
      },
      redirect: "follow",
      referrerPolicy: "no-referrer-when-downgrade"
    });

    if (res.ok) return await res.text();

    // 429 o 5xx -> backoff exponencial + jitter
    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      attempt++;
      const wait = Math.min(60000, (2 ** attempt) * 1000) + jitter(); // cap 60s
      console.warn(`HTTP ${res.status} en ${url}. Reintento ${attempt}/${MAX_RETRIES} en ${Math.round(wait/1000)}s`);
      await sleep(wait);
      if (attempt < MAX_RETRIES) continue;
    }

    throw new Error(`HTTP ${res.status} for ${url}`);
  }
}

/** Parseo de la tabla principal de una página */
function parsePage(html) {
  const $ = cheerio.load(html);

  // localizar tabla que tenga columnas esperables
  const tables = $("table");
  let target = null;
  tables.each((_, t) => {
    const headTxt = $(t).find("tr").first().text().toLowerCase();
    if (headTxt.includes("player name") && headTxt.includes("overall")) {
      target = $(t);
      return false;
    }
  });
  const rows = [];
  if (!target) return rows;

  target.find("tr").slice(1).each((_, tr) => {
    const $td = $(tr).find("td");
    if ($td.length < 8) return;

    const position = $td.eq(0).text().trim();
    const nameCell = $td.eq(1);
    const name = nameCell.text().trim();
    const href = nameCell.find("a").attr("href") || "";
    const url = href ? new URL(href, BASE).toString() : "";
    const team = $td.eq(2).text().trim();
    const nationality = $td.eq(3).text().trim();
    const height = Number($td.eq(4).text().trim()) || null;
    const weight = Number($td.eq(5).text().trim()) || null;
    const age = Number($td.eq(6).text().trim()) || null;
    const overall = Number($td.eq(7).text().trim()) || null;

    // intentar extraer id si viene ?id=12345
    const idMatch = url.match(/(?:\?|&)id=(\d+)/);
    const id = idMatch ? idMatch[1] : null;

    rows.push({ id, name, position, team, nationality, height, weight, age, overall, url });
  });
  return rows;
}

/** Detecta última página del paginador */
function detectLastPage(html) {
  const $ = cheerio.load(html);
  let last = 1;
  $(".pages a").each((_, a) => {
    const t = $(a).text().trim();
    const n = Number(t);
    if (Number.isInteger(n) && n > last) last = n;
  });
  return last;
}

/** Checkpoint helpers */
async function loadCheckpoint() {
  try {
    const raw = await readFile(CHECKPOINT_FILE, "utf8");
    const { lastPageDone = 0 } = JSON.parse(raw);
    return Number(lastPageDone) || 0;
  } catch {
    return 0;
  }
}
async function saveCheckpoint(page) {
  await writeFile(CHECKPOINT_FILE, JSON.stringify({ lastPageDone: page }, null, 2));
}

/** Crawl completo 1..N páginas (con callback de progreso opcional) */
async function crawlAll(onProgress) {
  const firstHtml = await fetchHtml(BASE);
  const lastPage = detectLastPage(firstHtml);
  onProgress?.(`Paginas detectadas: ${lastPage}\n`);

  const limit = MAX_PAGES_DEBUG > 0 ? Math.min(lastPage, MAX_PAGES_DEBUG) : lastPage;

  const all = [];
  let startPage = await loadCheckpoint() || 1;

  if (startPage === 1) {
    all.push(...parsePage(firstHtml));
    await saveCheckpoint(1);
    startPage = 2;
  } else {
    // si reanudamos desde X>1, procesamos esa página también
    const resumeUrl = `${BASE}?page=${startPage}`;
    await sleep(jitter());
    const html = await fetchHtml(resumeUrl);
    all.push(...parsePage(html));
    onProgress?.(`Reanudado en página ${startPage}/${limit} — total ${all.length}\n`);
  }

  for (let p = startPage; p <= limit; p++) {
    const url = `${BASE}?page=${p}`;
    await sleep(jitter());
    try {
      const html = await fetchHtml(url);
      const rows = parsePage(html);
      all.push(...rows);
      await saveCheckpoint(p);
      if (p % 10 === 0) onProgress?.(`Progreso: página ${p}/${limit} — total ${all.length}\n`);
    } catch (e) {
      onProgress?.(`Error en ${url}: ${e.message}\n`);
      break; // dejamos checkpoint para reanudar en próximo /refresh
    }
  }

  // normalización mínima + dedupe por (id | name+team+age)
  const seen = new Set();
  const deduped = [];
  for (const r of all) {
    const key = r.id ? `id:${r.id}` : `nt:${r.name}|${r.team}|${r.age}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(r);
    }
  }

  // si completamos hasta limit, limpiamos checkpoint
  try {
    if ((await loadCheckpoint()) >= limit) await saveCheckpoint(0);
  } catch {}

  return { players: deduped, pages: limit, generatedAt: new Date().toISOString() };
}

/* ============== Cache y persistencia ============== */
let SNAPSHOT = { players: [], pages: 0, generatedAt: null };

async function loadSnapshot() {
  try {
    const raw = await readFile(SNAPSHOT_FILE, "utf8");
    SNAPSHOT = JSON.parse(raw);
    console.log(`Snapshot cargado: ${SNAPSHOT.players.length} jugadores (de archivo)`);
  } catch {
    console.log("Sin data.json, generaremos uno cuando refresques.");
  }
}

async function saveSnapshot() {
  await writeFile(SNAPSHOT_FILE, JSON.stringify(SNAPSHOT, null, 2));
}

/* ================== Server ================== */
const app = express();

app.get("/", (_req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="es">
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>PESDB Clone</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial;margin:24px;line-height:1.35;background:#fafafa;}
  h1{font-size:22px;margin:0 0 8px}
  input{width:100%;max-width:400px;padding:8px;border:1px solid #ccc;border-radius:6px;font-size:15px}
  table{border-collapse:collapse;width:100%;max-width:1200px;margin-top:16px;background:white;box-shadow:0 2px 6px rgba(0,0,0,0.05)}
  th,td{border:1px solid #eee;padding:6px 8px;font-size:13px}
  th{background:#f8f9fa;text-align:left}
  td.num{text-align:center}
  .pager{margin-top:16px;display:flex;gap:8px;align-items:center}
  button{padding:6px 10px;font-size:14px;border:1px solid #ccc;background:#fff;cursor:pointer;border-radius:4px}
  button:disabled{opacity:0.4;cursor:not-allowed}
</style>
<body>
  <h1>PESDB Snapshot</h1>
  <div><input id="q" placeholder="Buscar jugador..." autofocus/></div>
  <table id="t">
    <thead><tr><th>Pos</th><th>Nombre</th><th>Equipo</th><th>Nacionalidad</th><th>Alt</th><th>Peso</th><th>Edad</th><th>OVR</th></tr></thead>
    <tbody></tbody>
  </table>
  <div class="pager">
    <button id="prev">← Anterior</button>
    <span id="page-info"></span>
    <button id="next">Siguiente →</button>
  </div>
<script>
let page=1,totalPages=1;
const tbody=document.querySelector("#t tbody");
const q=document.querySelector("#q");
const prev=document.querySelector("#prev");
const next=document.querySelector("#next");
const info=document.querySelector("#page-info");

async function load(pageNum){
  const res=await fetch("/players?page="+pageNum);
  const data=await res.json();
  totalPages=data.totalPages;
  page=data.page;
  renderRows(data.results);
  info.textContent="Página "+page+" de "+totalPages;
  prev.disabled=(page<=1);
  next.disabled=(page>=totalPages);
}

function renderRows(rows){
  tbody.innerHTML=rows.map(r=>\`
  <tr>
    <td>\${r.position||""}</td>
    <td>\${r.url?'<a href="\'+r.url+\'" target="_blank">'+r.name+'</a>':r.name}</td>
    <td>\${r.team||""}</td>
    <td>\${r.nationality||""}</td>
    <td class="num">\${r.height||""}</td>
    <td class="num">\${r.weight||""}</td>
    <td class="num">\${r.age||""}</td>
    <td class="num"><b>\${r.overall||""}</b></td>
  </tr>\`).join("");
}

async function search(term){
  const res=await fetch("/search?q="+encodeURIComponent(term));
  const data=await res.json();
  renderRows(data.results);
  info.textContent="Resultados: "+data.results.length;
  prev.disabled=next.disabled=true;
}

prev.onclick=()=>{ if(page>1){ load(page-1); } };
next.onclick=()=>{ if(page<totalPages){ load(page+1); } };
q.oninput=()=>{ const v=q.value.trim(); if(v.length>=3) search(v); else load(1); };

load(1);
</script>
</body></html>`);
});


/** JSON: búsqueda por nombre/apellido */
app.get("/search", (req, res) => {
  const q = String(req.query.q || "").toLowerCase();
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 50));
  let results = [];

  if (q.length >= 1) {
    results = SNAPSHOT.players.filter(p =>
      (p.name || "").toLowerCase().includes(q)
    );
  }
  res.json({ count: results.length, results: results.slice(0, limit) });
});

/** JSON: dump completo (ojo, puede ser pesado) */
app.get("/players.json", (_req, res) => {
  res.json(SNAPSHOT);
});

/** Forzar recrawl manual desde el navegador (con progreso) */
app.get("/refresh", async (_req, res) => {
  try {
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.write("Actualizando snapshot... Esto puede tardar unos minutos.\n");
    const data = await crawlAll((line) => res.write(line));
    SNAPSHOT = data;
    await saveSnapshot();
    res.write(`Listo. Jugadores: ${SNAPSHOT.players.length}. Páginas: ${SNAPSHOT.pages}.\n`);
    res.end("OK\n");
  } catch (e) {
    res.status(500).end("Error: " + e.message);
  }
});

app.get("/players", (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || "1"));
  const pageSize = 50; // cantidad de jugadores por página
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const totalPages = Math.ceil(SNAPSHOT.players.length / pageSize);

  const results = SNAPSHOT.players.slice(start, end);

  res.json({
    page,
    totalPages,
    count: results.length,
    results
  });
});


/* Boot (sin top-level await, compatible con pkg) */
async function start() {
  try {
    await loadSnapshot();
    const appServer = express();
    appServer.use(app);
    appServer.listen(PORT, () => {
      console.log(`Mini app lista en http://localhost:${PORT}`);
      console.log(`Refrescá datos en http://localhost:${PORT}/refresh`);
    });
  } catch (err) {
    console.error("Fallo al iniciar:", err);
    process.exit(1);
  }
}

start();

