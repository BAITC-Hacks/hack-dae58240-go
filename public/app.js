const $ = id => document.getElementById(id);
let currentOrders = [];
let plannedSupplier = null;
let plannedHorizon = 30;
let plannedGrowth = 0;
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
    const li = document.createElement('li');
    const label = document.createElement('strong');
    label.textContent = `${entry.step}. ${entry.type === 'tool_call' ? 'Вызов' : entry.type === 'tool_result' ? 'Результат' : 'Ответ'} · ${entry.name}`;
    const detail = document.createElement('span'); detail.textContent = entry.args ? JSON.stringify(entry.args) : entry.summary || '';
    li.append(label, detail);
    if (entry.usage) {
      const usage = document.createElement('small');
      usage.textContent = `Токены: вход ${entry.usage.prompt_tokens ?? '—'}, выход ${entry.usage.completion_tokens ?? '—'}`;
      li.append(usage);
    }
    return li;
  }));
}
function renderOrders() {
  $('orders').replaceChildren(...currentOrders.map((order, index) => {
    const tr = document.createElement('tr'); tr.className = 'orderRow'; tr.tabIndex = 0;
    tr.setAttribute('aria-label', `Разбор артикула ${order.sku}`);
    for (const key of ['sku', 'name', 'stock', 'inTransit', 'forecast', 'safetyStock', 'moq', 'abc']) tr.append(cell(order[key]));
    const quantity = cell(''); const input = document.createElement('input');
    input.type = 'number'; input.min = '0'; input.max = '1000000'; input.step = '1'; input.value = order.quantity;
    input.setAttribute('aria-label', `Количество для ${order.sku}`);
    input.addEventListener('click', event => event.stopPropagation());
    input.addEventListener('input', () => { currentOrders[index].quantity = Number(input.value); });
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
  $('approve').disabled = currentOrders.length === 0;
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
$('plan').addEventListener('click', async () => {
  showError(''); $('working').hidden = false; $('plan').disabled = true; $('approve').disabled = true; $('skuPanel').hidden = true;
  currentOrders = []; plannedSupplier = null;
  try {
    const supplier = $('supplier').value;
    const horizonDays = Number($('horizon').value);
    const growthPct = Number($('growth').value);
    const response = await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ supplier, horizonDays, growthPct }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Ошибка расчёта');
    $('demoBadge').hidden = !data.demoMode;
    $('answer').textContent = data.answer;
    renderSummary(data.summary); renderTrace(data.trace);
    currentOrders = data.orders; plannedSupplier = supplier; plannedHorizon = horizonDays; plannedGrowth = growthPct;
    renderOrders();
  } catch (error) { showError(error.message); }
  finally { $('working').hidden = true; $('plan').disabled = false; }
});
$('approve').addEventListener('click', async () => {
  showError('');
  if (!currentOrders.every(order => Number.isInteger(order.quantity) && order.quantity >= 0 && order.quantity <= 1000000)) return showError('Проверьте количества в таблице.');
  try {
    const response = await fetch('/api/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ supplier: plannedSupplier, orders: currentOrders }) });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Ошибка выгрузки'); }
    const blob = await response.blob(); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `order-${Date.now()}.csv`; a.click(); URL.revokeObjectURL(url);
  } catch (error) { showError(error.message); }
});
loadSuppliers();
