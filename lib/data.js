// Загрузка данных производителя из выгрузок 1С (xlsx) в нормализованный вид.
// Источник: DATA_DIR из env, иначе локальная папка заказчик/ (реальные данные партнёра,
// в git не попадает), иначе data/demo/ (синтетика в том же формате — для жюри).
// Каждая подпапка = один производитель. Файлы распознаются по ключевым словам в имени,
// колонки — по заголовкам, поэтому один парсер читает и реальные, и демо-файлы.
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = path.join(__dirname, '..');
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function resolveDataDir() {
  const candidates = [process.env.DATA_DIR, path.join(ROOT, 'заказчик'), path.join(ROOT, 'data', 'demo')].filter(Boolean);
  const dir = candidates.find(d => fs.existsSync(d) && fs.statSync(d).isDirectory());
  if (!dir) throw new Error('Нет данных: ни DATA_DIR, ни заказчик/, ни data/demo/');
  return { dir, demo: dir === path.join(ROOT, 'data', 'demo') };
}

const str = v => String(v ?? '').trim();
const num = v => { const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };

// "янв. 2024" / "Январь 2024 г." → "2024-01"
function parseMonthHeader(h) {
  const m = str(h).toLowerCase().match(/^([а-я]+)\.?\s+(\d{4})/);
  if (!m) return null;
  const idx = MONTHS.findIndex(p => m[1].startsWith(p));
  return idx < 0 ? null : `${m[2]}-${String(idx + 1).padStart(2, '0')}`;
}

function readRows(file, sheetIndex = 0) {
  const wb = XLSX.readFile(file, { dense: true });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[sheetIndex]], { header: 1, defval: '', raw: true });
}

function findHeader(rows, test) {
  const i = rows.findIndex(r => r.some(test));
  if (i < 0) throw new Error('Не найдена строка заголовков');
  return i;
}
const col = (header, re) => header.findIndex(h => re.test(str(h)));

// Таблица «артикул × месяцы» (месячные продажи и месячные остатки на начало месяца)
function parseMonthly(file) {
  const rows = readRows(file);
  const hi = findHeader(rows, c => parseMonthHeader(c));
  const header = rows[hi];
  const codeCol = col(header, /Номенклатура\.Код|Код 1с/i);
  const nameCol = col(header, /^Номенклатура$|Наименование/i);
  const months = header.map(parseMonthHeader);
  const out = {};
  for (const r of rows.slice(hi + 1)) {
    const code = str(r[codeCol]);
    if (!code || /^итого/i.test(str(r[nameCol]))) continue; // подвал «Итого»
    const series = {};
    months.forEach((m, j) => { if (m) series[m] = num(r[j]); });
    out[code] = { name: str(r[nameCol]), series };
  }
  return out;
}

// Строки расходных накладных: [{date:'YYYY-MM-DD', doc, qty}] по коду
function parseDynamics(file) {
  const rows = readRows(file);
  const hi = findHeader(rows, c => str(c) === 'Количество');
  const h = rows[hi];
  const [dCol, nCol, tCol, cCol, qCol] = [/^Дата$/, /^Номер$/, /^Документ$/, /^Код$/, /^Количество$/].map(re => col(h, re));
  const out = {};
  for (const r of rows.slice(hi + 1)) {
    const code = str(r[cCol]);
    if (!code || !/Расходная накладная/i.test(str(r[tCol]))) continue;
    let date;
    if (typeof r[dCol] === 'number') { const p = XLSX.SSF.parse_date_code(r[dCol]); date = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; }
    else { const m = str(r[dCol]).match(/(\d{2})\.(\d{2})\.(\d{4})/); if (!m) continue; date = `${m[3]}-${m[2]}-${m[1]}`; }
    const qty = Math.abs(num(r[qCol]));
    if (!qty) continue;
    (out[code] ||= []).push({ date, doc: str(r[nCol]), qty });
  }
  return out;
}

// Сезонность производителя: год × месяц (суммы продаж) → 12 коэффициентов, среднее = 1.
// Берутся только полные годы (все 12 месяцев заполнены).
function parseSeasonality(file) {
  const rows = readRows(file);
  // 1) если в файле есть готовая колонка партнёра «СЕЗОННОСТЬ» (месяц → коэффициент) — берём её
  const si = rows.findIndex(r => r.some(c => str(c).toUpperCase() === 'СЕЗОННОСТЬ'));
  if (si >= 0) {
    const sc = rows[si].findIndex(c => str(c).toUpperCase() === 'СЕЗОННОСТЬ');
    const mc = rows[si].findIndex(c => str(c) === 'Месяц');
    const k = {};
    for (const r of rows.slice(si + 1, si + 14)) { const i = MONTHS.findIndex(p => str(r[mc]).toLowerCase().startsWith(p)); if (i >= 0 && num(r[sc]) > 0) k[i] = num(r[sc]); }
    let growth = null;
    for (const r of rows) { const j = r.findIndex(c => /Поправка/i.test(str(c))); if (j >= 0 && num(r[j + 1]) > 0) growth = num(r[j + 1]); }
    if (Object.keys(k).length === 12) return { factors: MONTHS.map((_, i) => k[i]), source: 'коэффициенты партнёра', growth };
  }
  // 2) иначе считаем по таблице «год × месяц»
  const hi = findHeader(rows, c => str(c).toLowerCase() === 'год');
  const shares = [];
  for (const r of rows.slice(hi + 1)) {
    if (!/^\d{4}$/.test(str(r[0]))) continue;
    const vals = r.slice(1, 13).map(num);
    if (vals.some(v => v <= 0)) continue;
    const total = vals.reduce((a, b) => a + b, 0);
    shares.push(vals.map(v => v / total * 12));
  }
  if (!shares.length) return null;
  return { factors: MONTHS.map((_, i) => shares.reduce((a, s) => a + s[i], 0) / shares.length), source: 'рассчитано по полным годам', growth: null };
}

// Товар в пути: сумма по колонкам заказов/«в пути»; попутно категория, если есть
function parseTransit(file) {
  const rows = readRows(file);
  const hi = findHeader(rows, c => /Код 1с/i.test(str(c)));
  const h = rows[hi];
  const codeCol = col(h, /Код 1с/i);
  const catCol = col(h, /Категория/i);
  const qtyCols = h.map((c, j) => (/в пути|УТ-\d/i.test(str(c)) ? j : -1)).filter(j => j >= 0);
  // дата поступления из заголовка заказа: «(поступление до 10.10.2026)»
  const arrival = j => { const m = str(h[j]).match(/поступлени[ея] до (\d{2})\.(\d{2})\.(\d{4})/i); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
  const freeCol = col(h, /^Свободный остаток$/i), resCol = col(h, /^Зарезервировано$/i);
  const out = {};
  for (const r of rows.slice(hi + 1)) {
    const code = str(r[codeCol]);
    if (!code) continue;
    const parts = qtyCols.filter(j => num(r[j]) > 0).map(j => ({ qty: num(r[j]), arrival: arrival(j) }));
    out[code] = {
      inTransit: parts.reduce((a, p) => a + p.qty, 0), parts,
      category: catCol >= 0 ? str(r[catCol]) : '',
      freeStock: freeCol >= 0 && str(r[freeCol]) !== '' ? num(r[freeCol]) : null, // текущий свободный остаток (есть у SE)
      reserved: resCol >= 0 ? num(r[resCol]) : 0
    };
  }
  return out;
}

function parseMoq(file) {
  const rows = readRows(file);
  const hi = findHeader(rows, c => /Мин\.|Кратность/i.test(str(c)));
  const h = rows[hi];
  const codeCol = col(h, /Код 1с|Номенклатура\.Код/i);
  const qCol = col(h, /Мин\.|Кратность/i);
  const out = {};
  for (const r of rows.slice(hi + 1)) { const code = str(r[codeCol]); if (code) out[code] = Math.max(1, num(r[qCol]) || 1); }
  return out;
}

const FILES = {
  sales: /продажи в кол/i, stock: /остатки/i, dynamics: /динамика/i,
  seasonality: /сезонность/i, transit: /пут[ьи]/i, moq: /moq/i
};

function loadManufacturer(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.xlsx') && !f.startsWith('~$'));
  const pick = key => { const f = files.find(x => FILES[key].test(x)); return f ? path.join(dir, f) : null; };
  const need = ['sales', 'stock', 'dynamics'];
  for (const k of need) if (!pick(k)) throw new Error(`${dir}: не найден файл «${k}»`);
  return {
    sales: parseMonthly(pick('sales')),
    stock: parseMonthly(pick('stock')),
    lines: parseDynamics(pick('dynamics')),
    seasonality: pick('seasonality') ? parseSeasonality(pick('seasonality')) : null,
    transit: pick('transit') ? parseTransit(pick('transit')) : {},
    moq: pick('moq') ? parseMoq(pick('moq')) : {}
  };
}

let cache = null;
function loadAll() {
  if (cache) return cache;
  const { dir, demo } = resolveDataDir();
  const t0 = Date.now();
  const manufacturers = {};
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) manufacturers[name] = loadManufacturer(p);
  }
  // Дата актуальности = последняя дата продажи в выгрузке
  let asOf = '0000-00-00';
  for (const m of Object.values(manufacturers)) for (const ls of Object.values(m.lines)) for (const l of ls) if (l.date > asOf) asOf = l.date;
  cache = { dir, demo, asOf, manufacturers };
  console.log(`[DATA] ${demo ? 'ДЕМО (синтетика data/demo)' : 'локальные данные ' + path.relative(ROOT, dir)}: ${Object.keys(manufacturers).join(', ')}; дата актуальности ${asOf}; загрузка ${Date.now() - t0} мс`);
  return cache;
}

module.exports = { loadAll, MONTHS };
