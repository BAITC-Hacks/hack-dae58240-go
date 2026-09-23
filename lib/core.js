// Расчётное ядро: детерминированный, объяснимый расчёт заказа производителю по каждому артикулу.
// Контракт (его использует server.js и агент): каждая функция-инструмент принимает один объект
// аргументов и возвращает JSON.
//   listSuppliers() → [{id,name,leadTimeDays}]
//   list_skus({supplier,limit?,horizonDays?,growthPct?}) → {summary, skus:[{sku,name,urgency,quantity,flags}]}
//   analyze_sku({supplier,sku,...}) → разбор артикула + «эксперименты» (что даёт каждая поправка)
//   calc_order({supplier,sku,horizonDays?,growthPct?,overrides?}) → одна строка заказа
//   build_supplier_orders({supplier,horizonDays?,growthPct?}) → {supplier, orders:[строки]}
// Методика описана в README («Методология расчёта»).
const { loadAll, getDataReport } = require('./data');

// Сроки поставки в данных партнёра отсутствуют → допущение, настраивается через env.
const LEAD_TIME_DAYS = { IEK: Number(process.env.LEAD_TIME_IEK) || 30, default: Number(process.env.LEAD_TIME_DEFAULT) || 45 };
const Z_BY_ABC = { A: 1.65, B: 1.28, C: 0.84 };     // уровень сервиса 95% / 90% / 80%
const HISTORY_MONTHS = 24;                         // окно анализа
const LEVEL_MONTHS = 6;                            // окно текущего уровня спроса

const leadTime = id => LEAD_TIME_DAYS[id] ?? LEAD_TIME_DAYS.default;
const r1 = x => Math.round(x * 10) / 10;
const sum = a => a.reduce((s, x) => s + x, 0);
const mean = a => (a.length ? sum(a) / a.length : 0);
function quantile(a, q) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const p = (s.length - 1) * q; const i = Math.floor(p); return s[i] + (s[Math.min(i + 1, s.length - 1)] - s[i]) * (p - i); }
const monthIdx = m => Number(m.slice(5, 7)) - 1;
function addMonths(m, k) { const y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7)) - 1 + k; return `${y + Math.floor(mo / 12)}-${String(((mo % 12) + 12) % 12 + 1).padStart(2, '0')}`; }
const daysInMonth = m => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate();

// Категория товара = товарная группа по первому слову наименования («Светильник», «Розетка»…)
function categoryOf(name) {
  const w = String(name).replace(/["«»()]/g, ' ').trim().split(/\s+/).find(x => /^[А-ЯЁа-яё]{3,}/.test(x));
  return w ? w.slice(0, 1).toUpperCase() + w.slice(1).toLowerCase().replace(/[.,]+$/, '') : 'Прочее';
}

// ---------- 1. Очистка истории: разовые крупные накладные ----------
// Сначала ищем крупную накладную относительно остальных строк, её доли в общем объёме
// и типичного месяца без неё;
// максимум исключаем из опорной выборки, чтобы добавленная продажа не подняла собственный порог.
// Выброс исключается целиком: даже медианный остаток искажает уровень, разброс и тренд редких SKU.
// Затем проверяем месячные итоги после очистки накладных: превышение медианы + 4·1.4826·MAD
// и 2× медианы обрезаем до статистического порога. Это ловит сумму нескольких разовых строк.
function detectOneOffs(lines, typicalMonth, fromMonth, lastMonth) {
  const window = lines.filter(l => l.date.slice(0, 7) >= fromMonth && l.date.slice(0, 7) <= lastMonth);
  if (!window.length) return { threshold: null, events: [] };
  const q = window.map(l => l.qty).sort((a, b) => a - b);
  const reference = q.slice(0, -1);
  const q1 = quantile(reference, 0.25), q3 = quantile(reference, 0.75);
  const med = quantile(reference, 0.5);
  const monthly = {};
  for (const l of window) monthly[l.date.slice(0, 7)] = (monthly[l.date.slice(0, 7)] || 0) + l.qty;
  const positiveMonths = Object.values(monthly).filter(x => x > 0);
  // Для единственного месяца typicalMonth включает саму инъекцию и не служит опорой.
  const monthBase = positiveMonths.length > 1
    ? quantile(positiveMonths.sort((a, b) => a - b).slice(0, -1), 0.5) : 0;
  const threshold = Math.max(5, q3 + 3 * (q3 - q1), 5 * med,
    reference.length && monthBase > 0 ? Math.min(typicalMonth, 2 * monthBase) : 0);
  const totalQty = sum(q);
  const events = window.filter(l => l.qty > threshold ||
    (l.qty > 5 && l.qty > 2 * med && l.qty > 0.25 * (totalQty - l.qty)))
    .map(l => ({ date: l.date, doc: l.doc, qty: l.qty, excluded: r1(l.qty) }));

  const cleanedMonths = { ...monthly };
  for (const e of events) cleanedMonths[e.date.slice(0, 7)] -= e.excluded;
  const values = Object.values(cleanedMonths).filter(x => x > 0);
  if (values.length >= 6) {
    const base = values.slice().sort((a, b) => a - b).slice(0, -1);
    const center = quantile(base, 0.5);
    const mad = quantile(base.map(x => Math.abs(x - center)), 0.5);
    const cap = center + 4 * 1.4826 * mad;
    for (const [month, qty] of Object.entries(cleanedMonths)) {
      if (qty > cap && qty > 2 * center) {
        events.push({ date: `${month}-01`, doc: 'месячный выброс', qty: r1(qty), excluded: r1(qty - cap) });
      }
    }
  }
  return { threshold: r1(threshold), events };
}

// ---------- 2. Сезонность: артикул → категория → производитель ----------
function seasonalIndex(seriesList, months) {
  // средняя доля каждого календарного месяца внутри полных лет, нормированная к 1
  const byYear = {};
  for (const s of seriesList) for (const m of months) { const y = m.slice(0, 4); (byYear[y] ||= Array(12).fill(0))[monthIdx(m)] += s[m] || 0; }
  const full = Object.entries(byYear).filter(([y]) => months.filter(m => m.startsWith(y)).length === 12).map(([, v]) => v).filter(v => sum(v) > 0);
  if (!full.length) return null;
  return Array.from({ length: 12 }, (_, i) => clampS(mean(full.map(v => v[i] / (sum(v) / 12)))));
}
const clampS = x => Math.max(0.5, Math.min(2, x)); // защита от взрыва на редких продажах

// ---------- Подготовка производителя (кэш) ----------
const prepared = {};
function prepare(supplier) {
  if (prepared[supplier]) return prepared[supplier];
  const data = loadAll();
  const m = data.manufacturers[supplier];
  if (!m) throw new Error(`Производитель не найден: ${supplier}`);
  const curMonth = data.asOf.slice(0, 7);
  const lastFull = addMonths(curMonth, -1);
  const months = Array.from({ length: HISTORY_MONTHS }, (_, i) => addMonths(lastFull, i - HISTORY_MONTHS + 1));
  const skus = {};
  for (const [code, s] of Object.entries(m.sales)) {
    const series = Object.fromEntries(months.map(mm => [mm, Math.max(0, s.series[mm] || 0)])); // возвраты (<0) → 0
    const stockSeries = m.stock[code]?.series || {};
    skus[code] = {
      code, name: s.name.trim(), category: categoryOf(s.name), series,
      curSales: s.series[curMonth] || 0,
      stockSeries, lines: m.lines[code] || [],
      inTransit: m.transit[code]?.inTransit || 0, transitParts: m.transit[code]?.parts || [],
      freeStock: m.transit[code]?.freeStock ?? null, moq: m.moq[code] || 1
    };
  }
  // сезонность категорий (по сумме продаж группы) и производителя (файл «Сезонность» или по продажам)
  const byCat = {};
  for (const k of Object.values(skus)) (byCat[k.category] ||= []).push(k.series);
  const catSeason = {};
  for (const [c, list] of Object.entries(byCat)) if (list.length >= 5 && sum(list.map(s => sum(Object.values(s)))) >= 500) catSeason[c] = seasonalIndex(list, months);
  const brandSeason = (m.seasonality && m.seasonality.factors.map(clampS)) || seasonalIndex(Object.values(skus).map(k => k.series), months) || Array(12).fill(1);
  // ABC по объёму продаж за 12 мес: A — 80% объёма, B — следующие 15%, C — остальное
  const vol = Object.values(skus).map(k => [k.code, sum(months.slice(-12).map(mm => k.series[mm]))]).sort((a, b) => b[1] - a[1]);
  const total = sum(vol.map(v => v[1])) || 1; let acc = 0;
  for (const [code, v] of vol) { acc += v; skus[code].abc = acc / total <= 0.8 ? 'A' : acc / total <= 0.95 ? 'B' : 'C'; }
  const brandSeasonSource = m.seasonality ? m.seasonality.source : 'рассчитано по продажам';
  return (prepared[supplier] = { supplier, asOf: data.asOf, demo: data.demo, curMonth, lastFull, months, skus, catSeason, brandSeason, brandSeasonSource });
}

// ---------- 3–6. Расчёт по одному артикулу ----------
// overrides — для проверок из ТЗ: stockDelta, inTransitDelta, oneOffQty (добавить разовую продажу),
// noOutlierFilter, noStockoutAdj, noSeasonality, noTrend
function computeSku(P, k, { horizonDays = 30, growthPct = 0, overrides = {} } = {}) {
  const o = overrides || {};
  const { months, lastFull, curMonth } = P;
  const L = leadTime(P.supplier);
  let lines = k.lines;
  const raw = { ...k.series };
  if (o.oneOffQty > 0) { // искусственная разовая продажа в последнем полном месяце
    lines = [...lines, { date: `${lastFull}-15`, doc: 'ТЕСТ-разовый', qty: o.oneOffQty }];
    raw[lastFull] += o.oneOffQty;
  }
  // типичный месяц — медиана ненулевых продаж
  const typical = quantile(months.map(m => raw[m]).filter(x => x > 0), 0.5);
  const oneOff = o.noOutlierFilter ? { threshold: null, events: [] } : detectOneOffs(lines, typical, months[0], lastFull);
  const cleaned = { ...raw };
  for (const e of oneOff.events) { const mm = e.date.slice(0, 7); if (mm in cleaned) cleaned[mm] = Math.max(0, cleaned[mm] - e.excluded); }

  // сезонность: 50% собственная (если есть 24 мес и объём) + 50% категории/производителя
  const baseSeason = P.catSeason[k.category] || P.brandSeason;
  const seasonSource = P.catSeason[k.category] ? `категория «${k.category}»` : `производитель (${P.brandSeasonSource})`;
  // собственная сезонность — только у регулярно продаваемых товаров (продажи в ≥20 из 24 мес)
  const own = months.filter(m => cleaned[m] > 0).length >= 20 && sum(months.map(m => cleaned[m])) >= 200 ? seasonalIndex([cleaned], months) : null;
  let season = own ? baseSeason.map((b, i) => 0.5 * own[i] + 0.5 * b) : [...baseSeason];
  if (o.noSeasonality) season = Array(12).fill(1);
  const S = m => season[monthIdx(m)] || 1;

  // доступность товара в месяце по остаткам на начало месяца и начало следующего
  const st = m => Math.max(0, k.stockSeries[m] ?? 0);
  const avail = {};
  for (const m of months) {
    const a = st(m) > 0, b = st(addMonths(m, 1)) > 0;
    avail[m] = a && b ? 1 : !a && !b ? (cleaned[m] > 0 ? 0.5 : 0) : 0.5;
  }
  // уровень спроса по месяцам, когда товар был в наличии (очищенный от сезона)
  const inStock = months.slice(-12).filter(m => avail[m] === 1);
  const instockLevel = mean(inStock.map(m => cleaned[m] / S(m)));
  const restored = { ...cleaned };
  const lost = [];
  if (!o.noStockoutAdj && inStock.length >= 3) for (const m of months.slice(-12)) {
    if (avail[m] < 1) {
      const expected = instockLevel * S(m);
      const add = Math.max(0, (1 - avail[m]) * expected - Math.max(0, cleaned[m] - avail[m] * expected));
      if (add > 0.5) { restored[m] = cleaned[m] + add; lost.push({ month: m, sold: r1(cleaned[m]), restored: r1(restored[m]) }); }
    }
  }

  // уровень: взвешенное среднее последних 6 мес без сезона (свежие весят больше)
  const d = months.map(m => restored[m] / S(m));
  const last = d.slice(-LEVEL_MONTHS), w = last.map((_, i) => i + 1);
  const level = sum(last.map((x, i) => x * w[i])) / sum(w);
  // устойчивый рост: и последние 6 мес к предыдущим 6, и 12 к 12 — в одну сторону больше 5%
  const r6 = mean(d.slice(-6)) / (mean(d.slice(-12, -6)) || NaN);
  const r12 = mean(d.slice(-12)) / (mean(d.slice(-24, -12)) || NaN);
  let trendMonthly = 0;
  if (!o.noTrend && Number.isFinite(r6) && Number.isFinite(r12) && ((r6 > 1.05 && r12 > 1.05) || (r6 < 0.95 && r12 < 0.95)))
    trendMonthly = Math.max(-0.05, Math.min(0.05, Math.pow(r6, 1 / 6) - 1));
  const growth = 1 + (Number(growthPct) || 0) / 100;

  // прогноз на срок поставки + период покрытия, по дням с сезонным коэффициентом месяца
  const days = L + horizonDays;
  let forecast = 0; const monthly = {};
  const start = new Date(P.asOf);
  for (let i = 1; i <= days; i++) {
    const dt = new Date(start); dt.setDate(dt.getDate() + i);
    const mm = dt.toISOString().slice(0, 7);
    const ahead = (dt.getFullYear() - start.getFullYear()) * 12 + dt.getMonth() - start.getMonth() + 3; // уровень ≈ 3 мес назад
    const v = level * S(mm) * Math.pow(1 + trendMonthly, ahead) * growth / daysInMonth(mm);
    forecast += v; monthly[mm] = (monthly[mm] || 0) + v;
  }
  const sigma = Math.sqrt(mean(d.slice(-12).map(x => (x - mean(d.slice(-12))) ** 2)));
  const z = Z_BY_ABC[k.abc] || 1.28;
  const safety = z * sigma * Math.sqrt(days / 30);

  // остаток сейчас: свободный остаток из выгрузки (если есть), иначе остаток на начало месяца − продажи месяца
  const stockNow = k.freeStock != null ? k.freeStock : st(curMonth) - k.curSales;
  const stock = Math.max(0, stockNow + (o.stockDelta || 0));
  const inTransit = Math.max(0, k.inTransit + (o.inTransitDelta || 0));
  const net = forecast + safety - stock - inTransit;
  const quantity = net > 0 ? Math.ceil(net / k.moq) * k.moq : 0;
  const daily = forecast / days;
  const coverDays = daily > 0 ? (stock + inTransit) / daily : Infinity;
  let urgency = daily <= 0 ? 'low' : stock <= 0 || coverDays < L ? 'high' : coverDays < L + horizonDays ? 'medium' : 'low';
  // Срочность не завышаем, когда данных недостаточно (заказ при этом не меняется):
  // 1) ноль получен ОЦЕНКОЙ (нет «Свободного остатка»), а на начало месяца товар был — поступления
  //    внутри месяца в выгрузке не видны, остаток неизвестен;
  // 2) товара не было на складе ≥6 из 12 мес — нерегулярная позиция (вероятно, под заказ клиента).
  const stockUncertain = k.freeStock == null && stockNow <= 0 && st(curMonth) > 0 && !o.stockDelta;
  const rarelyStocked = months.slice(-12).filter(m => st(m) <= 0).length >= 6;
  if (urgency === 'high' && (stockUncertain || rarelyStocked)) urgency = 'medium';

  const flags = [];
  if (stock <= 0 && daily > 0 && !stockUncertain) flags.push('stockout_now');
  if (stockUncertain) flags.push('stock_uncertain');
  if (rarelyStocked && daily > 0) flags.push('rarely_stocked');
  if (lost.length) flags.push('stockout_history');
  if (oneOff.events.length) flags.push('one_off_excluded');
  if (trendMonthly > 0) flags.push('growth'); if (trendMonthly < 0) flags.push('decline');
  if (own && Math.max(...own) / Math.max(0.01, Math.min(...own)) > 2) flags.push('seasonal');

  const seasonNow = S(addMonths(curMonth, 1));
  const parts = [`спрос ~${r1(level)} шт/мес без сезона`];
  if (Math.abs(seasonNow - 1) > 0.05) parts.push(`сезон ${addMonths(curMonth, 1).slice(5)}: ×${seasonNow.toFixed(2)} (${own ? 'свой + ' : ''}${seasonSource})`);
  if (trendMonthly) parts.push(`устойчивый ${trendMonthly > 0 ? 'рост' : 'спад'} ${(trendMonthly * 100).toFixed(1)}%/мес`);
  if (growth !== 1) parts.push(`прогноз прироста ${growthPct > 0 ? '+' : ''}${growthPct}%`);
  const rationale = `Прогноз ${Math.round(forecast)} шт на ${days} дн (поставка ${L} + покрытие ${horizonDays}): ${parts.join(', ')}. ` +
    `+ страх. запас ${Math.round(safety)} (класс ${k.abc}) − остаток ${Math.round(stock)} − в пути ${Math.round(inTransit)}` +
    (quantity ? ` = ${Math.ceil(net)} → ${quantity} (кратность ${k.moq}).` : ` → заказ не нужен.`) +
    (oneOff.events.length ? ` Исключены разовые продажи: ${oneOff.events.length} накл., −${Math.round(sum(oneOff.events.map(e => e.excluded)))} шт.` : '') +
    (lost.length ? ` Упущенный спрос при отсутствии товара: +${Math.round(sum(lost.map(l => l.restored - l.sold)))} шт за ${lost.length} мес.` : '') +
    (stockUncertain ? ` Остаток оценён как 0 (продажи месяца больше остатка на его начало, поступления не видны) — уточните остаток в 1С.` : '') +
    (rarelyStocked && daily > 0 ? ` Товара не было на складе ≥6 из 12 мес — возможно, позиция под заказ.` : '');

  return {
    sku: k.code, name: k.name, supplier: P.supplier, category: k.category, abc: k.abc,
    stock: Math.round(stock), inTransit: Math.round(inTransit), forecast: Math.round(forecast),
    safetyStock: Math.round(safety), moq: k.moq, quantity, urgency, coverDays: Number.isFinite(coverDays) ? Math.round(coverDays) : null,
    flags, rationale,
    details: {
      leadTimeDays: L, horizonDays, levelPerMonth: r1(level), trendMonthlyPct: r1(trendMonthly * 100), growthPct: Number(growthPct) || 0,
      seasonality: season.map(x => Math.round(x * 100) / 100), seasonSource: own ? `свой + ${seasonSource}` : seasonSource,
      forecastByMonth: Object.fromEntries(Object.entries(monthly).map(([mm, v]) => [mm, r1(v)])),
      oneOffThreshold: oneOff.threshold, oneOffs: oneOff.events.slice(-5), lostDemand: lost,
      history: months.slice(-12).map(m => ({ month: m, raw: raw[m], cleaned: r1(cleaned[m]), restored: r1(restored[m]), stockStart: st(m) }))
    }
  };
}

// ---------- API инструментов ----------
const opts = a => ({ horizonDays: Number(a.horizonDays) || 30, growthPct: Number(a.growthPct) || 0, overrides: a.overrides });
const isActive = (k, P) => sum(P.months.slice(-12).map(m => k.series[m])) > 0 || k.inTransit > 0;
const URG = { high: 0, medium: 1, low: 2 };

const cacheAll = {};
function allRows(supplier, a) {
  const P = prepare(supplier);
  const key = `${supplier}|${a.horizonDays}|${a.growthPct}`;
  if (!cacheAll[key]) cacheAll[key] = Object.values(P.skus).filter(k => isActive(k, P)).map(k => computeSku(P, k, a));
  return cacheAll[key];
}
function getSku(supplier, sku) {
  const P = prepare(supplier);
  const k = P.skus[String(sku).trim()];
  if (!k) throw new Error(`Артикул ${sku} не найден у производителя ${supplier}`);
  return { P, k };
}

function listSuppliers() {
  const { manufacturers } = loadAll();
  return Object.keys(manufacturers).map(id => ({ id, name: id, leadTimeDays: leadTime(id) }));
}

function list_skus(args) {
  const a = opts(args);
  const rows = allRows(args.supplier, a);
  const limit = Math.min(Number(args.limit) || 15, 50);
  const risky = [...rows].sort((x, y) => URG[x.urgency] - URG[y.urgency] || y.flags.length - x.flags.length || y.forecast - x.forecast);
  const count = f => rows.filter(f).length;
  return {
    supplier: args.supplier, asOf: prepare(args.supplier).asOf,
    summary: {
      activeSkus: rows.length, toOrder: count(r => r.quantity > 0),
      urgent: count(r => r.urgency === 'high'), stockoutNow: count(r => r.flags.includes('stockout_now')),
      withOneOffsExcluded: count(r => r.flags.includes('one_off_excluded')), withLostDemand: count(r => r.flags.includes('stockout_history')),
      seasonal: count(r => r.flags.includes('seasonal')), growing: count(r => r.flags.includes('growth')),
      dataWarnings: getDataReport().find(item => item.manufacturer === args.supplier)?.warnings.length || 0
    },
    skus: risky.slice(0, limit).map(r => ({ sku: r.sku, name: r.name.slice(0, 50), urgency: r.urgency, quantity: r.quantity, coverDays: r.coverDays, flags: r.flags }))
  };
}

// Разбор артикула + проверки из ТЗ: как меняется заказ без каждой поправки
function analyze_sku(args) {
  const { P, k } = getSku(args.supplier, args.sku);
  const a = opts(args);
  const base = computeSku(P, k, a);
  const q = over => computeSku(P, k, { ...a, overrides: over });
  const v = r => ({ forecast: r.forecast, quantity: r.quantity });
  const avg = base.details.history.reduce((s, h) => s + h.raw, 0) / 12;
  return {
    ...base,
    experiments: {
      withoutOneOffFilter: v(q({ noOutlierFilter: true })),
      withoutStockoutAdjustment: v(q({ noStockoutAdj: true })),
      withoutSeasonality: v(q({ noSeasonality: true })),
      withoutTrend: v(q({ noTrend: true })),
      injectedOneOff: { added: Math.max(50, Math.round(avg * 10)), ...v(q({ oneOffQty: Math.max(50, Math.round(avg * 10)) })) },
      inTransitPlus100: v(q({ inTransitDelta: 100 })),
      naiveAverageForecast: Math.round(avg / 30 * (base.details.leadTimeDays + base.details.horizonDays))
    }
  };
}

function calc_order(args) {
  const { P, k } = getSku(args.supplier, args.sku);
  const r = computeSku(P, k, opts(args));
  delete r.details.history;
  return r;
}

function build_supplier_orders(args) {
  const rows = allRows(args.supplier, opts(args))
    .filter(r => r.quantity > 0)
    .sort((x, y) => URG[x.urgency] - URG[y.urgency] || y.quantity - x.quantity)
    .map(({ details, ...r }) => r);
  return { supplier: args.supplier, asOf: prepare(args.supplier).asOf, count: rows.length, totalUnits: sum(rows.map(r => r.quantity)), orders: rows };
}

function dataReport() { return getDataReport(); }
module.exports = { listSuppliers, list_skus, analyze_sku, calc_order, build_supplier_orders, dataReport };
