const $ = id => document.getElementById(id);
let currentOrders = [];
let plannedSupplier = null;
let plannedHorizon = 30;
let plannedGrowth = 0;
let advancedMode = false;
let currentSummary = null;
const urgencyText = { high: 'Высокая', medium: 'Средняя', low: 'Низкая' };
const flagLabels = {
  stockout_now: ['⛔', 'Нет в наличии сейчас'],
  stockout_history: ['📈', 'Продажи скорректированы на упущенный спрос'],
  one_off_excluded: ['✂️', 'Разовая крупная продажа исключена из регулярного спроса'],
  seasonal: ['☀️', 'Выраженная сезонность'],
  growth: ['↗️', 'Устойчивый рост'],
  decline: ['↘️', 'Устойчивое снижение']
};
const experimentLabels = {
  withoutOneOffFilter: 'Без фильтра разовых продаж',
  withoutStockoutAdjustment: 'Без учёта stockout',
  withoutSeasonality: 'Без сезонности',
  withoutTrend: 'Без тренда',
  injectedOneOff: 'С добавленной разовой продажей',
  inTransitPlus100: 'Товар в пути +100',
  naiveAverageForecast: 'Наивное среднее (оценка заказа)'
};
function showError(message) { $('error').textContent = message; $('error').hidden = !message; }
function cell(text) { const td = document.createElement('td'); td.textContent = text ?? '—'; return td; }
function row(values) { const tr = document.createElement('tr'); tr.append(...values.map(cell)); return tr; }
function metric(label, value) {
  const item = document.createElement('div'); item.className = 'metric';
  const number = document.createElement('strong'); number.textContent = value ?? '—';
  const caption = document.createElement('span'); caption.textContent = label;
  item.append(number, caption); return item;
}
function setMode(advanced) {
  advancedMode = advanced;
  $('advancedSummary').hidden = !advanced;
  $('advancedOrders').hidden = !advanced;
  $('modeToggle').textContent = advanced ? 'Простой режим' : 'Расширенный режим';
  $('modeToggle').setAttribute('aria-pressed', String(advanced));
  $('traceDetails').open = advanced;
  $('traceTitle').textContent = advanced ? 'Лог шагов агента' : `Как агент пришёл к результату (${$('trace').children.length === 1 && !plannedSupplier ? 0 : $('trace').children.length} шагов)`;
  try { localStorage.setItem('purchasePlanMode', advanced ? 'advanced' : 'simple'); } catch { /* хранение режима необязательно */ }
}
function renderAnswer(answer) {
  const plain = String(answer || '').replace(/^\[DEMO\]\s*/, '')
    .replace(/^[ \t]*(?:[-•*]|\d+[.)])\s+/gm, '').replace(/^[ \t]*#{1,6}\s+/gm, '').trim();
  const short = plain.split(/(?<=[.!?])\s+|\n+/).map(part => part.trim()).filter(Boolean).slice(0, 4).join(' ').replace(/\s+/g, ' ');
  const parts = short.split(/\*\*([^*]+)\*\*/g);
  $('answer').replaceChildren(...parts.map((part, index) => {
    if (index % 2 === 0) return document.createTextNode(part);
    const strong = document.createElement('strong'); strong.textContent = part; return strong;
  }));
}
function orderTotals() {
  const included = currentOrders.filter(order => Number.isInteger(order.quantity) && order.quantity > 0);
  return { positions: included.length, units: included.reduce((total, order) => total + order.quantity, 0), urgent: included.filter(order => order.urgency === 'high').length };
}
function refreshSimpleSummary() {
  const totals = orderTotals();
  $('simpleSummary').replaceChildren(
    metric('Позиций к заказу', totals.positions),
    metric('Единиц', totals.units),
    metric('Срочных', totals.urgent)
  );
  const valid = currentOrders.length > 0 && currentOrders.every(order => Number.isInteger(order.quantity) && order.quantity >= 0 && order.quantity <= 1000000) && totals.positions > 0;
  $('approve').disabled = !valid;
  $('approveSimple').disabled = !valid;
  if (currentSummary) renderSummary({ ...currentSummary, toOrder: totals.positions, urgent: totals.urgent });
}
function setQuantity(index, value) {
  currentOrders[index].quantity = value.trim() === '' ? NaN : Number(value);
  document.querySelectorAll(`[data-order-index="${index}"]`).forEach(input => { if (input.value !== value) input.value = value; });
  refreshSimpleSummary();
}
function attentionReason(flags = []) {
  const reasons = [
    ['stockout_now', 'нет в наличии'], ['one_off_excluded', 'исключена разовая продажа'],
    ['stockout_history', 'восстановлен упущенный спрос'], ['seasonal', 'сезонный пик'],
    ['growth', 'рост']
  ].filter(([flag]) => flags.includes(flag)).map(([, text]) => text);
  return reasons.length ? reasons.join(' · ') : 'высокий риск дефицита';
}
function renderAttention() {
  const urgent = currentOrders.map((order, index) => ({ order, index })).filter(({ order }) => order.urgency === 'high');
  const cards = urgent.slice(0, 10).map(({ order, index }) => {
    const card = document.createElement('article'); card.className = 'attentionCard'; card.tabIndex = 0;
    card.setAttribute('role', 'button'); card.setAttribute('aria-label', `Разбор артикула ${order.sku}`);
    const info = document.createElement('div'); info.className = 'attentionInfo';
    const name = document.createElement('h3'); name.textContent = order.name;
    const amount = document.createElement('strong'); amount.textContent = `Заказать ${order.quantity} шт`;
    const reason = document.createElement('p'); reason.className = 'attentionReason'; reason.textContent = attentionReason(order.flags);
    info.append(name, amount, reason);
    const label = document.createElement('label'); label.textContent = 'Количество, шт';
    const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.max = '1000000'; input.step = '1';
    input.value = order.quantity; input.dataset.orderIndex = index;
    input.addEventListener('click', event => event.stopPropagation());
    input.addEventListener('keydown', event => event.stopPropagation());
    input.addEventListener('input', () => { setQuantity(index, input.value); amount.textContent = `Заказать ${input.value || '—'} шт`; });
    label.append(input); card.append(info, label);
    card.addEventListener('click', () => loadSku(order.sku));
    card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); loadSku(order.sku); } });
    return card;
  });
  $('attention').replaceChildren(...(cards.length ? cards : [Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Срочных позиций нет.' })]));
  const other = currentOrders.filter(order => order.urgency !== 'high').length;
  const noun = other % 10 === 1 && other % 100 !== 11 ? 'позиция' : other % 10 >= 2 && other % 10 <= 4 && (other % 100 < 12 || other % 100 > 14) ? 'позиции' : 'позиций';
  $('moreOrders').textContent = `Ещё ${other} ${noun} средней и низкой срочности — смотреть в расширенном режиме`;
  $('moreOrders').hidden = other === 0;
}
async function loadSuppliers() {
  try {
    const response = await fetch('/api/suppliers');
    if (!response.ok) throw new Error('Не удалось загрузить производителей');
    const data = await response.json();
    $('supplier').replaceChildren(...data.suppliers.map(item => {
      const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; return option;
    }));
    $('sourceBadge').textContent = data.dataSource === 'demo' ? 'ИСТОЧНИК: ДЕМО-ДАННЫЕ' : 'ИСТОЧНИК: ЛОКАЛЬНЫЕ ДАННЫЕ';
    $('sourceBadge').hidden = false;
  } catch (error) { showError(error.message); }
}
function renderSummary(summary) {
  const labels = [
    ['activeSkus', 'Активных SKU'], ['toOrder', 'К заказу'], ['urgent', 'Срочных'],
    ['stockoutNow', 'Нет в наличии'], ['withOneOffsExcluded', 'Разовые исключены'],
    ['withLostDemand', 'Упущенный спрос'], ['seasonal', 'Сезонных'], ['growing', 'Растущих']
  ];
  $('summary').replaceChildren(...labels.map(([key, label]) => metric(label, summary?.[key])));
}
function renderTrace(trace) {
  $('trace').replaceChildren(...trace.map(entry => {
    const li = document.createElement('li'); li.className = `traceItem ${entry.type}`;
    const header = document.createElement('div'); header.className = 'traceHeader';
    const icon = document.createElement('span'); icon.className = 'traceIcon';
    icon.textContent = entry.type === 'tool_call' ? '🔧' : entry.type === 'tool_result' ? '📊' : '💬';
    const step = document.createElement('strong'); step.textContent = `Шаг ${entry.step}`;
    const name = document.createElement('small'); name.textContent = entry.name;
    header.append(icon, step, name);
    const explanation = document.createElement('p'); explanation.className = 'traceText';
    explanation.textContent = entry.text || entry.summary || '';
    li.append(header, explanation);
    if (entry.usage) {
      const usage = document.createElement('small');
      usage.className = 'traceUsage';
      usage.textContent = `Токены: вход ${entry.usage.prompt_tokens ?? '—'}, выход ${entry.usage.completion_tokens ?? '—'}`;
      li.append(usage);
    }
    if (entry.args || entry.summary) {
      const details = document.createElement('details'); details.className = 'traceDetails';
      const title = document.createElement('summary'); title.textContent = 'Технические детали';
      const raw = document.createElement('pre');
      raw.textContent = [entry.args ? `Аргументы: ${JSON.stringify(entry.args)}` : '', entry.summary ? `Результат: ${entry.summary}` : ''].filter(Boolean).join('\n');
      details.append(title, raw); li.append(details);
    }
    return li;
  }));
  $('traceTitle').textContent = advancedMode ? 'Лог шагов агента' : `Как агент пришёл к результату (${trace.length} шагов)`;
}
function renderOrders() {
  $('orders').replaceChildren(...currentOrders.map((order, index) => {
    const tr = document.createElement('tr'); tr.className = 'orderRow'; tr.tabIndex = 0;
    tr.setAttribute('aria-label', `Разбор артикула ${order.sku}`);
    for (const key of ['sku', 'name', 'stock', 'inTransit', 'forecast', 'safetyStock', 'moq', 'abc']) tr.append(cell(order[key]));
    const quantity = cell(''); const input = document.createElement('input');
    input.type = 'number'; input.min = '0'; input.max = '1000000'; input.step = '1'; input.value = order.quantity;
    input.dataset.orderIndex = index;
    input.setAttribute('aria-label', `Количество для ${order.sku}`);
    input.addEventListener('click', event => event.stopPropagation());
    input.addEventListener('keydown', event => event.stopPropagation());
    input.addEventListener('input', () => {
      setQuantity(index, input.value);
      const cardInput = $('attention').querySelector(`[data-order-index="${index}"]`);
      if (cardInput) cardInput.closest('.attentionCard').querySelector('.attentionInfo strong').textContent = `Заказать ${input.value || '—'} шт`;
    });
    quantity.append(input); tr.append(quantity);
    const urgency = cell(urgencyText[order.urgency] || order.urgency);
    urgency.className = `urgency ${['high', 'medium', 'low'].includes(order.urgency) ? order.urgency : ''}`;
    tr.append(urgency);
    const flags = cell(''); flags.className = 'flags';
    for (const flag of order.flags || []) {
      const badge = document.createElement('span'); badge.className = 'flag';
      badge.textContent = flagLabels[flag]?.[0] || '●';
      badge.title = flagLabels[flag]?.[1] || flag;
      badge.setAttribute('aria-label', badge.title); flags.append(badge);
    }
    tr.append(flags, cell(order.rationale));
    tr.addEventListener('click', () => loadSku(order.sku));
    tr.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); loadSku(order.sku); } });
    return tr;
  }));
  refreshSimpleSummary();
}
function renderSku(data) {
  $('skuTitle').textContent = `Разбор артикула: ${data.sku} · ${data.name}`;
  $('skuFacts').replaceChildren(
    metric('Базовый заказ', data.quantity), metric('Прогноз', data.forecast),
    metric('Страховой запас', data.safetyStock), metric('Кратность', data.moq),
    metric('Класс ABC', data.abc), metric('Срок поставки, дней', data.details?.leadTimeDays)
  );
  $('history').replaceChildren(...(data.details?.history || []).map(h => row([h.month, h.raw, h.cleaned, h.restored, h.stockStart])));
  $('forecastByMonth').replaceChildren(...Object.entries(data.details?.forecastByMonth || {}).map(([month, forecast]) => row([month, forecast])));
  const oneOffs = data.details?.oneOffs || [];
  $('oneOffs').replaceChildren(...(oneOffs.length ? oneOffs.map(event => {
    const p = document.createElement('p'); p.textContent = `${event.date}: продажа ${event.qty} шт., исключено ${event.excluded} шт.`; return p;
  }) : [document.createTextNode('Разовых продаж не выявлено.') ]));
  const lost = data.details?.lostDemand || [];
  $('lostDemand').replaceChildren(...(lost.length ? lost.map(event => {
    const p = document.createElement('p'); p.textContent = `${event.month}: продажи ${event.sold} шт. → восстановленный спрос ${event.restored} шт.`; return p;
  }) : [document.createTextNode('Корректировка упущенного спроса не требовалась.') ]));
  const base = data.quantity;
  $('experiments').replaceChildren(...Object.entries(experimentLabels).map(([key, label]) => {
    const experiment = data.experiments?.[key];
    if (experiment === undefined) return row([label, base, '—', '—', '—']);
    let forecast = typeof experiment === 'number' ? experiment : experiment.forecast;
    let quantity = typeof experiment === 'number'
      ? Math.max(0, Math.ceil((forecast + data.safetyStock - data.stock - data.inTransit) / data.moq) * data.moq)
      : experiment.quantity;
    const suffix = key === 'injectedOneOff' ? ` (+${experiment.added} шт. разово)` : '';
    return row([label + suffix, base, quantity, `${quantity - base > 0 ? '+' : ''}${quantity - base}`, `${data.forecast} / ${forecast}`]);
  }));
  $('skuStatus').textContent = data.rationale;
  $('skuContent').hidden = false;
}
async function loadSku(sku) {
  if (!plannedSupplier) return;
  $('skuPanel').hidden = false; $('skuContent').hidden = true;
  $('skuTitle').textContent = `Разбор артикула: ${sku}`;
  $('skuStatus').textContent = 'Загружаем расчёт…';
  $('skuPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const params = new URLSearchParams({ supplier: plannedSupplier, sku, horizonDays: String(plannedHorizon), growthPct: String(plannedGrowth) });
    const response = await fetch(`/api/sku?${params}`); const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Не удалось получить разбор артикула');
    renderSku(data);
  } catch (error) { $('skuStatus').textContent = error.message; }
}
$('closeSku').addEventListener('click', () => { $('skuPanel').hidden = true; });
$('modeToggle').addEventListener('click', () => setMode(!advancedMode));
$('moreOrders').addEventListener('click', () => setMode(true));
$('plan').addEventListener('click', async () => {
  showError(''); $('working').hidden = false; $('plan').disabled = true; $('approve').disabled = true; $('approveSimple').disabled = true; $('skuPanel').hidden = true;
  currentOrders = []; currentSummary = null; plannedSupplier = null;
  try {
    const supplier = $('supplier').value;
    const horizonDays = Number($('horizon').value);
    const growthPct = Number($('growth').value);
    const response = await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ supplier, horizonDays, growthPct }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Ошибка расчёта');
    $('demoBadge').hidden = !data.demoMode;
    renderAnswer(data.answer);
    currentSummary = data.summary; renderTrace(data.trace);
    currentOrders = data.orders; plannedSupplier = supplier; plannedHorizon = horizonDays; plannedGrowth = growthPct;
    renderOrders(); renderAttention();
  } catch (error) { showError(error.message); }
  finally { $('working').hidden = true; $('plan').disabled = false; }
});
async function approveOrder() {
  showError('');
  if (!plannedSupplier || !currentOrders.every(order => Number.isInteger(order.quantity) && order.quantity >= 0 && order.quantity <= 1000000)) return showError('Проверьте количества в заказе.');
  const orders = currentOrders.filter(order => order.quantity > 0);
  if (!orders.length) return showError('Укажите хотя бы одну позицию к заказу.');
  const units = orders.reduce((total, order) => total + order.quantity, 0);
  if (!window.confirm(`Выгрузить заказ на ${orders.length} позиций / ${units} единиц?`)) return;
  try {
    const response = await fetch('/api/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ supplier: plannedSupplier, orders }) });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Ошибка выгрузки'); }
    const blob = await response.blob(); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `order-${Date.now()}.csv`; a.click(); URL.revokeObjectURL(url);
  } catch (error) { showError(error.message); }
}
$('approve').addEventListener('click', approveOrder);
$('approveSimple').addEventListener('click', approveOrder);
try { advancedMode = localStorage.getItem('purchasePlanMode') === 'advanced'; } catch { advancedMode = false; }
setMode(advancedMode);
loadSuppliers();
