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
const nonNegative = (v, report) => { const n = num(v); if (n < 0) { report.counts.negativeValuesClamped++; return 0; } return n; };
function column(header, re, label, file, report, required = true) {
  const index = col(header, re);
  if (index < 0) {
    const message = `В файле «${path.basename(file)}» не найдена колонка «${label}» (ожидалось ${re}).`;
    (required ? report.errors : report.warnings).push(message);
    if (required) throw new Error(message);
  }
  return index;
}
function headerRow(rows, test, label, file, report) {
  const index = rows.findIndex(r => r.some(test));
  if (index < 0) {
    const message = `В файле «${path.basename(file)}» не найдена строка заголовков «${label}».`;
    report.errors.push(message);
    throw new Error(message);
  }
  return index;
}

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
function parseMonthly(file, report) {
  const rows = readRows(file);
  const hi = headerRow(rows, c => parseMonthHeader(c), 'месячные колонки', file, report);
  const header = rows[hi];
  const codeCol = column(header, /Номенклатура\.Код|Код 1с/i, 'Код 1с / Номенклатура.Код', file, report);
  const nameCol = column(header, /^Номенклатура$|Наименование/i, 'Номенклатура / Наименование', file, report);
  const months = header.map(parseMonthHeader);
  const out = {};
  for (const r of rows.slice(hi + 1)) {
    const code = str(r[codeCol]);
    if (/^итого/i.test(str(r[nameCol])) || /^итого/i.test(code)) { report.counts.skippedTotalsRows++; continue; }
    if (!code) continue;
    const series = {};
    months.forEach((m, j) => { if (m) series[m] = nonNegative(r[j], report); });
    out[code] = { name: str(r[nameCol]), series };
  }
  return out;
}

// Строки расходных накладных: [{date:'YYYY-MM-DD', doc, qty}] по коду
function parseDynamics(file, report) {
  const rows = readRows(file);
  const hi = headerRow(rows, c => str(c) === 'Количество', 'Количество', file, report);
  const h = rows[hi];
  const columns = [
    [/^Дата$/, 'Дата'], [/^Номер$/, 'Номер'], [/^Документ$/, 'Документ'],
    [/^Код$/, 'Код'], [/^Количество$/, 'Количество']
  ];
  const [dCol, nCol, tCol, cCol, qCol] = columns.map(([re, label]) => column(h, re, label, file, report));
  const out = {};
  for (const r of rows.slice(hi + 1)) {
    const code = str(r[cCol]);
    if (!code || !/Расходная накладная/i.test(str(r[tCol]))) continue;
    let date;
    if (typeof r[dCol] === 'number') { const p = XLSX.SSF.parse_date_code(r[dCol]); date = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; }
    else { const m = str(r[dCol]).match(/(\d{2})\.(\d{2})\.(\d{4})/); if (!m) continue; date = `${m[3]}-${m[2]}-${m[1]}`; }
    const qty = nonNegative(r[qCol], report);
    if (!qty) continue;
    (out[code] ||= []).push({ date, doc: str(r[nCol]), qty });
  }
  return out;
}

// Сезонность производителя: год × месяц (суммы продаж) → 12 коэффициентов, среднее = 1.
// Берутся только полные годы (все 12 месяцев заполнены).
function parseSeasonality(file, report) {
  const rows = readRows(file);
  // 1) если в файле есть готовая колонка партнёра «СЕЗОННОСТЬ» (месяц → коэффициент) — берём её
  const si = rows.findIndex(r => r.some(c => str(c).toUpperCase() === 'СЕЗОННОСТЬ'));
  if (si >= 0) {
    const sc = rows[si].findIndex(c => str(c).toUpperCase() === 'СЕЗОННОСТЬ');
    const mc = rows[si].findIndex(c => str(c) === 'Месяц');
    if (mc < 0) report.warnings.push(`В файле «${path.basename(file)}» не найдена колонка «Месяц» — пробую рассчитать сезонность по годам.`);
    const k = {};
    if (mc >= 0) for (const r of rows.slice(si + 1, si + 14)) { const i = MONTHS.findIndex(p => str(r[mc]).toLowerCase().startsWith(p)); if (i >= 0 && num(r[sc]) > 0) k[i] = num(r[sc]); }
    let growth = null;
    for (const r of rows) { const j = r.findIndex(c => /Поправка/i.test(str(c))); if (j >= 0 && num(r[j + 1]) > 0) growth = num(r[j + 1]); }
    if (Object.keys(k).length === 12) return { factors: MONTHS.map((_, i) => k[i]), source: 'коэффициенты партнёра', growth };
    report.warnings.push(`В файле «${path.basename(file)}» неполная колонка «СЕЗОННОСТЬ» — пробую рассчитать сезонность по годам.`);
  } else report.warnings.push(`В файле «${path.basename(file)}» не найдена колонка «СЕЗОННОСТЬ» — сезонность будет рассчитана по продажам или полным годам.`);
  // 2) иначе считаем по таблице «год × месяц»
  const hi = rows.findIndex(r => r.some(c => str(c).toLowerCase() === 'год'));
  if (hi < 0) { report.warnings.push(`В файле «${path.basename(file)}» не найдена колонка «Год» — сезонность рассчитана по продажам.`); return null; }
  const shares = [];
  for (const r of rows.slice(hi + 1)) {
    if (!/^\d{4}$/.test(str(r[0]))) continue;
    const vals = r.slice(1, 13).map(num);
    if (vals.some(v => v <= 0)) continue;
    const total = vals.reduce((a, b) => a + b, 0);
    shares.push(vals.map(v => v / total * 12));
  }
  if (!shares.length) { report.warnings.push(`В файле «${path.basename(file)}» нет полных годов — сезонность рассчитана по продажам.`); return null; }
  return { factors: MONTHS.map((_, i) => shares.reduce((a, s) => a + s[i], 0) / shares.length), source: 'рассчитано по полным годам', growth: null };
}

// Товар в пути: сумма по колонкам заказов/«в пути»; попутно категория, если есть
function parseTransit(file, report) {
  const rows = readRows(file);
  const hi = rows.findIndex(r => r.some(c => /Код 1с/i.test(str(c))));
  if (hi < 0) { report.warnings.push(`В файле «${path.basename(file)}» не найдена колонка «Код 1с» — товар в пути принят 0.`); return {}; }
  const h = rows[hi];
  const codeCol = column(h, /Код 1с/i, 'Код 1с', file, report, false);
  const catCol = column(h, /Категория/i, 'Категория', file, report, false);
  const qtyCols = h.map((c, j) => (/в пути|УТ-\d/i.test(str(c)) ? j : -1)).filter(j => j >= 0);
  if (!qtyCols.length) report.warnings.push(`В файле «${path.basename(file)}» нет колонок количества «в пути» или «УТ-…» — товар в пути принят 0.`);
  // дата поступления из заголовка заказа: «(поступление до 10.10.2026)»
  const arrival = j => { const m = str(h[j]).match(/поступлени[ея] до (\d{2})\.(\d{2})\.(\d{4})/i); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
  const freeCol = column(h, /^Свободный остаток$/i, 'Свободный остаток', file, report, false);
  const resCol = column(h, /^Зарезервировано$/i, 'Зарезервировано', file, report, false);
  const out = {};
  for (const r of rows.slice(hi + 1)) {
    const code = str(r[codeCol]);
    if (!code) continue;
    const parts = qtyCols.map(j => ({ qty: nonNegative(r[j], report), arrival: arrival(j) })).filter(p => p.qty > 0);
    out[code] = {
      inTransit: parts.reduce((a, p) => a + p.qty, 0), parts,
      category: catCol >= 0 ? str(r[catCol]) : '',
      freeStock: freeCol >= 0 && str(r[freeCol]) !== '' ? nonNegative(r[freeCol], report) : null, // текущий свободный остаток (есть у SE)
      reserved: resCol >= 0 ? nonNegative(r[resCol], report) : 0
    };
  }
  return out;
}

function parseMoq(file, report) {
  const rows = readRows(file);
  const hi = rows.findIndex(r => r.some(c => /Код 1с|Номенклатура\.Код/i.test(str(c))));
  if (hi < 0) { report.warnings.push(`В файле «${path.basename(file)}» не найдена колонка «Код 1с / Номенклатура.Код» — кратность принята 1.`); return {}; }
  const h = rows[hi];
  const codeCol = column(h, /Код 1с|Номенклатура\.Код/i, 'Код 1с / Номенклатура.Код', file, report, false);
  const qCol = column(h, /Мин\.|Кратность/i, 'Мин. разр. к отгр. / Кратность', file, report, false);
  if (codeCol < 0 || qCol < 0) return {};
  const out = {};
  for (const r of rows.slice(hi + 1)) { const code = str(r[codeCol]); if (code) out[code] = Math.max(1, nonNegative(r[qCol], report) || 1); }
  return out;
}

const FILES = {
  sales: /продажи в кол/i, stock: /остатки/i, dynamics: /динамика/i,
  seasonality: /сезонность/i, transit: /пут[ьи]/i, moq: /moq/i
};

function loadManufacturer(dir, manufacturer) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.xlsx') && !f.startsWith('~$'));
  const names = Object.fromEntries(Object.keys(FILES).map(key => [key, files.find(x => FILES[key].test(x)) || null]));
  const report = { manufacturer, files: names, counts: {
    skusInSales: 0, skusInStock: 0, skusWithInvoices: 0, matchedAllThree: 0,
    inTransitSkus: 0, moqSkus: 0, invoiceLines: 0, skippedTotalsRows: 0, negativeValuesClamped: 0
  }, warnings: [], errors: [] };
  const pick = key => names[key] ? path.join(dir, names[key]) : null;
  const need = ['sales', 'stock', 'dynamics'];
  for (const k of need) if (!pick(k)) {
    const message = `У производителя «${manufacturer}» в папке «${dir}» не найден обязательный файл «${k}» (ключевое слово в имени: ${FILES[k]}).`;
    report.errors.push(message); throw new Error(message);
  }
  let sales, stock, lines;
  try {
    sales = parseMonthly(pick('sales'), report);
    stock = parseMonthly(pick('stock'), report);
    lines = parseDynamics(pick('dynamics'), report);
  } catch (error) { throw new Error(`Ошибка загрузки производителя «${manufacturer}» из «${dir}»: ${error.message}`); }
  const optional = (key, parse, fallback, absent) => {
    if (!pick(key)) { report.warnings.push(absent); return fallback; }
    try { return parse(pick(key), report) ?? fallback; }
    catch (error) { report.warnings.push(`Файл «${names[key]}» не удалось разобрать: ${error.message}. Использовано значение по умолчанию.`); return fallback; }
  };
  const seasonality = optional('seasonality', parseSeasonality, null, 'Файл «сезонность» не найден — сезонность рассчитана по продажам.');
  const transit = optional('transit', parseTransit, {}, 'Файл «товар в пути» не найден — товар в пути принят 0, заказ может быть завышен.');
  const moq = optional('moq', parseMoq, {}, 'Файл «MOQ» не найден — кратность принята 1.');
  Object.assign(report.counts, {
    skusInSales: Object.keys(sales).length, skusInStock: Object.keys(stock).length,
    skusWithInvoices: Object.keys(lines).length, inTransitSkus: Object.values(transit).filter(row => row.inTransit > 0).length,
    moqSkus: Object.keys(moq).length,
    invoiceLines: Object.values(lines).reduce((sum, rows) => sum + rows.length, 0),
    matchedAllThree: Object.keys(sales).filter(code => code in stock && code in lines).length
  });
  const matchedStock = Object.keys(sales).filter(code => code in stock).length;
  const percent = report.counts.skusInSales ? Math.round(matchedStock / report.counts.skusInSales * 100) : 0;
  if (percent < 80) report.warnings.push(`Только ${percent}% кодов из продаж найдены в остатках (${matchedStock} из ${report.counts.skusInSales}) — проверьте сопоставление артикулов.`);
  if (report.counts.negativeValuesClamped) report.warnings.push(`Обнулено отрицательных значений: ${report.counts.negativeValuesClamped} — проверьте возвраты и корректность выгрузки.`);
  return { data: { sales, stock, lines, seasonality, transit, moq }, report };
}

let cache = null;
function loadAll() {
  if (cache) return cache;
  const { dir, demo } = resolveDataDir();
  const t0 = Date.now();
  const manufacturers = {};
  const report = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) {
      const loaded = loadManufacturer(p, name);
      manufacturers[name] = loaded.data;
      report.push(loaded.report);
    }
  }
  // Дата актуальности = последняя дата продажи в выгрузке
  let asOf = '0000-00-00';
  for (const m of Object.values(manufacturers)) for (const ls of Object.values(m.lines)) for (const l of ls) if (l.date > asOf) asOf = l.date;
  for (const item of report) {
    const m = manufacturers[item.manufacturer];
    const ownAsOf = Object.values(m.lines).flat().reduce((latest, row) => row.date > latest ? row.date : latest, '0000-00-00');
    const salesMonths = new Set(Object.values(m.sales).flatMap(row => Object.keys(row.series)));
    const stockMonths = new Set(Object.values(m.stock).flatMap(row => Object.keys(row.series)));
    const latestMonth = [...salesMonths, ...stockMonths].sort().at(-1);
    const asOfMonth = ownAsOf.slice(0, 7);
    if (ownAsOf === '0000-00-00') item.warnings.push('В динамике продаж нет дат накладных — дата актуальности не определена.');
    else if (!salesMonths.has(asOfMonth) || !stockMonths.has(asOfMonth)) item.warnings.push(`Месячные таблицы не содержат месяц даты актуальности ${asOfMonth} — прогноз может быть неполным.`);
    if (latestMonth && ownAsOf !== '0000-00-00') {
      const [year, month] = latestMonth.split('-').map(Number);
      const latestMonthlyDate = new Date(Date.UTC(year, month, 0));
      const lagDays = (latestMonthlyDate - new Date(`${ownAsOf}T00:00:00Z`)) / 86400000;
      if (lagDays > 14) item.warnings.push(`Дата актуальности накладных старше конца последнего месяца в таблицах на ${Math.floor(lagDays)} дн — проверьте свежесть данных.`);
    }
    const c = item.counts;
    console.log(`[DATA CHECK] ${item.manufacturer}: продажи ${c.skusInSales} SKU, остатки ${c.skusInStock}, накладные ${c.skusWithInvoices} SKU / ${c.invoiceLines} строк, совпали во всех трёх ${c.matchedAllThree}, в пути ${c.inTransitSkus}, MOQ ${c.moqSkus}, пропущено «Итого» ${c.skippedTotalsRows}, отрицательных значений обнулено ${c.negativeValuesClamped}.`);
    for (const warning of item.warnings) console.log(`[DATA CHECK] ⚠️ ${warning}`);
  }
  cache = { dir, demo, asOf, manufacturers, report };
  console.log(`[DATA] ${demo ? 'ДЕМО (синтетика data/demo)' : 'локальные данные ' + path.relative(ROOT, dir)}: ${Object.keys(manufacturers).join(', ')}; дата актуальности ${asOf}; загрузка ${Date.now() - t0} мс`);
  return cache;
}

function getDataReport() { return loadAll().report; }
module.exports = { loadAll, getDataReport, MONTHS };
