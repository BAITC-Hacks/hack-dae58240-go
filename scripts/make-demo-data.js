// Генератор синтетических данных в ТОМ ЖЕ формате xlsx, что выгрузки партнёра из 1С.
// Нужен, чтобы проект запускался из чистого клона без конфиденциальных данных.
// В каждый набор специально заложены сценарии для проверок из ТЗ: сезонный товар, рост,
// stockout, разовая крупная продажа, товар в пути, кратность заказа.
// Запуск: node scripts/make-demo-data.js  → data/demo/<производитель>/*.xlsx
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const OUT = path.join(__dirname, '..', 'data', 'demo');
const AS_OF = new Date('2026-09-22');
const START = new Date('2024-01-01');
const MONTHS_RU = ['янв.', 'февр.', 'март', 'апр.', 'май', 'июнь', 'июль', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];
const SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const SEASON = [0.8, 0.8, 0.85, 0.95, 1.05, 1.15, 1.2, 1.2, 1.1, 1.0, 0.95, 0.95]; // строительный сезон

let seed = 42;
const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const poisson = l => { if (l > 30) return Math.max(0, Math.round(l + Math.sqrt(l) * (rnd() + rnd() + rnd() - 1.5) * 2)); let k = 0, p = 1; const L = Math.exp(-l); do { k++; p *= rnd(); } while (p > L); return k - 1; };
const ym = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const fmtDate = d => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()} ${10 + Math.floor(rnd() * 8)}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}:00`;

// Сценарии: base — продаж в день, line — средний размер строки накладной
const SCENARIOS = [
  { key: 'steady', name: 'Автоматический выключатель 1P 16А', base: 6, line: 3, moq: 12 },
  { key: 'seasonal', name: 'Кабель силовой ВВГнг 3х2,5 (м)', base: 40, line: 25, moq: 100, unit: 'м', ownSeason: [0.3, 0.3, 0.5, 0.9, 1.4, 1.8, 1.9, 1.8, 1.3, 0.9, 0.5, 0.4] },
  { key: 'growth', name: 'Светильник LED панель 36Вт', base: 2, line: 2, moq: 4, growth: 0.04 },
  { key: 'stockout', name: 'Розетка 2-местная с заземлением', base: 5, line: 3, moq: 10, stockoutMonths: ['2026-05', '2026-06', '2026-07'] },
  { key: 'oneoff', name: 'Щит распределительный ЩРН-24', base: 1.2, line: 1, moq: 1, oneOff: { date: '2026-07-14', qty: 180 } },
  { key: 'lowstock', name: 'Контактор модульный 25А', base: 3, line: 2, moq: 6, lowStockNow: true },
  { key: 'transit', name: 'Выключатель 1-клавишный белый', base: 8, line: 5, moq: 20, bigTransit: 900 },
  { key: 'decline', name: 'Лампа люминесцентная Т8 18Вт', base: 10, line: 10, moq: 25, growth: -0.04 },
  { key: 'slow', name: 'Коробка распаячная IP55', base: 0.4, line: 1, moq: 1 },
  { key: 'steady2', name: 'Гофротруба ПВХ 20мм (м)', base: 60, line: 50, moq: 100, unit: 'м' },
  { key: 'steady3', name: 'Дифавтомат 2P 25А 30мА', base: 2.5, line: 2, moq: 6 },
  { key: 'seasonal2', name: 'Прожектор светодиодный 50Вт', base: 3, line: 2, moq: 10, ownSeason: [0.5, 0.5, 0.7, 1.1, 1.4, 1.5, 1.5, 1.4, 1.2, 0.9, 0.7, 0.6] }
];

function makeManufacturer(label, prefix, codeBase, scale) {
  const dir = path.join(OUT, label);
  fs.mkdirSync(dir, { recursive: true });
  const months = []; for (let d = new Date(START); d <= AS_OF; d.setMonth(d.getMonth() + 1)) months.push(ym(d));
  const skus = SCENARIOS.map((s, i) => ({ ...s, code: `${codeBase}${String(i + 1).padStart(4, '0')}_`, article: `${prefix}-${1000 + i * 7}`, name: `${s.name} ${label.split(' ')[0]}` }));
  const lines = []; const monthlySales = {}; const monthlyStock = {}; const transit = {}; const freeStock = {};
  let doc = 20000001000 + codeBase.length * 1000;
  const brandMonthMoney = {};
  for (const s of skus) {
    const base = s.base * scale;
    let stock = Math.round(base * 45);
    const pending = []; // [{arrive, qty}]
    monthlySales[s.code] = {}; monthlyStock[s.code] = {};
    for (let d = new Date(START), t = 0; d <= AS_OF; d.setDate(d.getDate() + 1), t++) {
      const m = ym(d);
      if (d.getDate() === 1) monthlyStock[s.code][m] = stock;
      for (let i = pending.length - 1; i >= 0; i--) if (pending[i].arrive <= d) { stock += pending[i].qty; pending.splice(i, 1); }
      const forcedOut = s.stockoutMonths?.includes(m);
      if (forcedOut) stock = 0;
      const monthsFromStart = t / 30.4;
      const season = (s.ownSeason || SEASON)[d.getMonth()];
      const lambda = base * season * Math.pow(1 + (s.growth || 0), monthsFromStart) * (d.getDay() === 0 ? 0.2 : 1.15);
      let want = poisson(lambda);
      const sold = Math.min(want, stock);
      stock -= sold;
      let left = sold;
      while (left > 0) { const q = Math.min(left, Math.max(1, poisson(s.line))); left -= q; lines.push([fmtDate(d), String(doc), `Расходная накладная ${doc} от ${fmtDate(d).slice(0, 5)}`, s.code, s.name, s.unit || 'шт', 'Алматы', q]); if (rnd() < 0.7) doc++; }
      if (s.oneOff && s.oneOff.date === d.toISOString().slice(0, 10)) {
        stock += s.oneOff.qty; // под крупный проект товар завезли специально
        lines.push([fmtDate(d), String(++doc), `Расходная накладная ${doc} от ${fmtDate(d).slice(0, 5)}`, s.code, s.name, s.unit || 'шт', 'Алматы', s.oneOff.qty]);
        stock -= s.oneOff.qty; monthlySales[s.code][m] = (monthlySales[s.code][m] || 0) + s.oneOff.qty;
      }
      monthlySales[s.code][m] = (monthlySales[s.code][m] || 0) + sold;
      brandMonthMoney[m] = (brandMonthMoney[m] || 0) + sold * 1000;
      // простая политика пополнения «как у менеджера»: раз в 2 недели, если запаса меньше чем на 30 дней
      if (!forcedOut && d.getDate() % 14 === 1 && stock + pending.reduce((a, p) => a + p.qty, 0) < base * 30) {
        const arrive = new Date(d); arrive.setDate(arrive.getDate() + 30);
        pending.push({ arrive, qty: Math.ceil(base * 45 / s.moq) * s.moq });
      }
    }
    if (s.lowStockNow) stock = Math.round(base * 3);
    transit[s.code] = s.bigTransit ? s.bigTransit * scale : pending.reduce((a, p) => a + p.qty, 0);
    freeStock[s.code] = stock; // текущий свободный остаток на дату выгрузки (как колонка у Systeme Electric)
  }
  const write = (file, rows, sheet = 'Лист_1') => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheet); XLSX.writeFile(wb, path.join(dir, file), { compression: true }); };
  const mHead = months.map(m => `${MONTHS_RU[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`);

  write('Динамика продаж (демо).xlsx', [['Дата', 'Номер', 'Документ', 'Код', 'Номенклатура', 'Ед.', 'Склад', 'Количество'], ...lines, ['Итого', '', '', '', '', '', '', lines.reduce((a, l) => a + l[7], 0)]]);
  write('Ежемесячные продажи в количественном выражении (демо).xlsx', [
    ['Номенклатура', 'Номенклатура.Код', ...mHead, 'Итого'], ['', '', ...months.map(() => 'Количество'), 'Количество'],
    ...skus.map(s => [s.name, s.code, ...months.map(m => monthlySales[s.code][m] || ''), months.reduce((a, m) => a + (monthlySales[s.code][m] || 0), 0)])]);
  write('Ежемесячные остатки (демо).xlsx', [
    ['Номенклатура', 'Ед.', 'Номенклатура.Код', ...mHead], ['', '', '', ...months.map(() => 'Количество')], ['', '', '', ...months.map(() => 'нач. остаток')],
    ...skus.map(s => [s.name, s.unit || 'шт', s.code, ...months.map(m => monthlyStock[s.code][m] || '')])]);
  const years = ['2024', '2025', '2026'];
  write('Сезонность (демо).xlsx', [[], [], ['год', ...SHORT, 'ИТОГО'],
    ...years.map(y => { const v = SHORT.map((_, i) => { const m = `${y}-${String(i + 1).padStart(2, '0')}`; return m < ym(AS_OF) ? Math.round(brandMonthMoney[m] || 0) : ''; }); return [y, ...v, v.reduce((a, b) => a + (b || 0), 0)]; })], 'Сезонность');
  write('Товар в пути (демо).xlsx', [['Код 1с', 'Артикул', 'Наименование', 'УТ-0001 от 15 сентября 2026 г. (поступление до 15.10.2026)', 'Свободный остаток'],
    ...skus.map(s => [s.code, s.article, s.name, transit[s.code] || '', freeStock[s.code]])], 'Лист1');
  write('MOQ (демо).xlsx', [['№', 'Код 1с', 'Артикул поставщика', 'Наименование', 'Мин. разр. к отгр.'], ...skus.map((s, i) => [i + 1, s.code, s.article, s.name, s.moq])], 'Лист1');
  console.log(`${label}: ${skus.length} артикулов, ${lines.length} строк накладных`);
}

fs.rmSync(OUT, { recursive: true, force: true });
makeManufacturer('Производитель А (демо)', 'PA', 'DA', 1);
makeManufacturer('Производитель Б (демо)', 'PB', 'DB', 0.6);
console.log(`Готово: ${path.relative(process.cwd(), OUT)}`);
