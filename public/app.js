const $ = id => document.getElementById(id);
let currentOrders = [];
let plannedSupplier = null;
let plannedHorizon = 30;
let plannedGrowth = 0;
let advancedMode = false;
let currentSummary = null;
let currentReview = null;
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
  $('modeToggle').checked = advanced;
  try { localStorage.setItem('purchasePlanMode', advanced ? 'advanced' : 'simple'); } catch { /* хранение режима необязательно */ }
}
function renderAnswer(answer) {
  const plain = String(answer || '').split(/Проверьте перед утверждением\s*:/i)[0].replace(/^\[DEMO\]\s*/, '')
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
  $('approveXlsx').disabled = !valid;
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
function issuesFor(sku) { return (currentReview?.issues || []).filter(issue => issue.sku === sku); }
function reviewBadge(issues) {
  const badge = document.createElement('span'); badge.className = 'reviewBadge';
  badge.textContent = '⚠️ Проверить'; badge.title = issues.map(issue => issue.message).join('\n');
  badge.setAttribute('aria-label', badge.title); return badge;
}
function renderReview(review) {
  const issues = review?.issues || [];
  $('reviewPanel').hidden = false;
  $('reviewIssues').replaceChildren(...(issues.length ? issues.slice(0, 5).map(issue => {
    const li = document.createElement('li');
    const name = document.createElement('strong'); name.textContent = issue.name;
    li.append(name, document.createTextNode(` — ${issue.message}`)); return li;
  }) : [Object.assign(document.createElement('li'), { textContent: 'Замечаний не найдено.' })]));
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
    const issues = issuesFor(order.sku);
    if (issues.length) {
      const note = document.createElement('p'); note.className = 'reviewNote'; note.textContent = issues[0].message;
      info.append(reviewBadge(issues), note);
    }
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
  startProgress('Читаю выгрузки 1С…', 'первый запуск до 10 с'); $('plan').disabled = true;
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
  finally { stopProgress(); $('plan').disabled = false; }
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
  $('traceTitle').textContent = `Как агент пришёл к результату (${trace.length} шагов)`;
  $('openTrace').textContent = `Как агент пришёл к результату (${trace.length} шагов)`;
  $('openTrace').disabled = !trace.length;
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
    const issues = issuesFor(order.sku);
    if (issues.length) flags.append(reviewBadge(issues));
    tr.append(flags, cell(order.rationale));
    tr.addEventListener('click', () => loadSku(order.sku));
    tr.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); loadSku(order.sku); } });
    return tr;
  }));
  refreshSimpleSummary();
}
// График спроса: столбики — фактические продажи, линия — спрос после очистки (без разовых,
// с восстановленным упущенным спросом), пунктир — прогноз. Подпись — устойчивый тренд.
function renderSkuChart(data) {
  const history = data.details?.history || [];
  const forecast = Object.entries(data.details?.forecastByMonth || {});
  const fig = $('skuChart');
  if (!history.length) { fig.replaceChildren(); return; }
  // прогноз по месяцам приходит за неполные месяцы периода — приводим к месячному темпу
  const days = (data.details.leadTimeDays || 0) + (data.details.horizonDays || 0);
  const perMonth = days ? data.forecast / days * 30.4 : 0;
  const points = [...history.map(h => ({ m: h.month, raw: h.raw, clean: h.restored })), ...forecast.slice(0, 3).map(([m]) => ({ m, fc: perMonth }))];
  const max = Math.max(1, ...points.map(p => Math.max(p.raw || 0, p.clean || 0, p.fc || 0)));
  const W = 640, H = 180, L = 36, B = 22, T = 10, step = (W - L - 8) / points.length, y = v => T + (H - T - B) * (1 - v / max);
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const bars = points.map((p, i) => p.raw != null ? `<rect x="${L + i * step + step * .2}" y="${y(p.raw)}" width="${step * .6}" height="${Math.max(0, H - B - y(p.raw))}" rx="2" class="barRaw"><title>${esc(p.m)}: продано ${p.raw}</title></rect>` : '').join('');
  const hist = points.filter(p => p.clean != null).map((p, i) => `${L + i * step + step / 2},${y(p.clean)}`);
  const lastIdx = history.length - 1;
  const fc = [`${L + lastIdx * step + step / 2},${y(history[lastIdx].restored)}`, ...points.slice(history.length).map((p, i) => `${L + (history.length + i) * step + step / 2},${y(p.fc)}`)];
  const labels = points.map((p, i) => i % 2 === 0 || i >= history.length ? `<text x="${L + i * step + step / 2}" y="${H - 6}" class="axis">${esc(p.m.slice(2).replace('-', '.'))}</text>` : '').join('');
  const trend = data.details.trendMonthlyPct || 0;
  const trendText = trend > 0 ? `↗ Устойчивый рост +${trend}%/мес` : trend < 0 ? `↘ Устойчивый спад ${trend}%/мес` : '→ Стабильный спрос (устойчивого тренда нет)';
  fig.innerHTML = `<figcaption><span class="trend ${trend > 0 ? 'up' : trend < 0 ? 'down' : ''}">${trendText}</span>
    <span class="legend"><i class="lgRaw"></i>продажи факт <i class="lgClean"></i>спрос после очистки <i class="lgFc"></i>прогноз, шт/мес</span></figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(trendText)}">
      <line x1="${L}" x2="${W - 8}" y1="${H - B}" y2="${H - B}" class="axisLine"/>
      <text x="${L - 6}" y="${T + 8}" class="axis" text-anchor="end">${Math.round(max)}</text><text x="${L - 6}" y="${H - B}" class="axis" text-anchor="end">0</text>
      ${bars}<polyline points="${hist.join(' ')}" class="lineClean"/><polyline points="${fc.join(' ')}" class="lineFc"/>${labels}
    </svg>`;
}
function renderSku(data) {
  $('skuTitle').textContent = `Разбор артикула: ${data.sku} · ${data.name}`;
  $('skuFacts').replaceChildren(
    metric('Базовый заказ', data.quantity), metric('Прогноз', data.forecast),
    metric('Страховой запас', data.safetyStock), metric('Кратность', data.moq),
    metric('Класс ABC', data.abc), metric('Срок поставки, дней', data.details?.leadTimeDays)
  );
  renderSkuChart(data);
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
$('modeToggle').addEventListener('change', () => setMode($('modeToggle').checked));
$('openTrace').addEventListener('click', () => $('traceDialog').showModal());
$('closeTrace').addEventListener('click', () => $('traceDialog').close());
$('traceDialog').addEventListener('click', event => { if (event.target === $('traceDialog')) $('traceDialog').close(); }); // клик по фону

// Индикатор прогресса: полоса + секундомер, чтобы было видно, что процесс идёт, а не завис
let progressTimer = null;
function startProgress(text, hint) {
  const started = Date.now();
  $('progressText').textContent = text; $('progress').hidden = false;
  const tick = () => { $('progressTime').textContent = `прошло ${Math.round((Date.now() - started) / 1000)} с${hint ? ` · ${hint}` : ''}`; };
  tick(); clearInterval(progressTimer); progressTimer = setInterval(tick, 1000);
}
function stopProgress() { clearInterval(progressTimer); progressTimer = null; $('progress').hidden = true; }
$('moreOrders').addEventListener('click', () => setMode(true));
$('plan').addEventListener('click', async () => {
  showError(''); startProgress('Агент анализирует данные и формирует заказ…', 'обычно 15–30 с'); $('plan').disabled = true; $('approve').disabled = true; $('approveSimple').disabled = true; $('approveXlsx').disabled = true; $('openTrace').disabled = true; $('skuPanel').hidden = true;
  currentOrders = []; currentSummary = null; currentReview = null; plannedSupplier = null; $('reviewPanel').hidden = true;
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
    currentReview = data.review; renderReview(currentReview);
    currentOrders = data.orders; plannedSupplier = supplier; plannedHorizon = horizonDays; plannedGrowth = growthPct;
    renderOrders(); renderAttention();
  } catch (error) { showError(error.message); }
  finally { stopProgress(); $('plan').disabled = false; }
});
async function approveOrder(format = 'csv') {
  showError('');
  if (!plannedSupplier || !currentOrders.every(order => Number.isInteger(order.quantity) && order.quantity >= 0 && order.quantity <= 1000000)) return showError('Проверьте количества в заказе.');
  const orders = currentOrders.filter(order => order.quantity > 0);
  if (!orders.length) return showError('Укажите хотя бы одну позицию к заказу.');
  const units = orders.reduce((total, order) => total + order.quantity, 0);
  if (!window.confirm(`Выгрузить заказ на ${orders.length} позиций / ${units} единиц?`)) return;
  try {
    const response = await fetch(format === 'xlsx' ? '/api/approve/xlsx' : '/api/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ supplier: plannedSupplier, orders: orders.map(({ details, ...row }) => row), horizonDays: plannedHorizon, growthPct: plannedGrowth }) });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Ошибка выгрузки'); }
    const blob = await response.blob(); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `order-${Date.now()}.${format}`; a.click(); URL.revokeObjectURL(url);
  } catch (error) { showError(error.message); }
}
$('approve').addEventListener('click', () => approveOrder('csv'));
$('approveSimple').addEventListener('click', () => approveOrder('csv'));
$('approveXlsx').addEventListener('click', () => approveOrder('xlsx'));
// Дата и время в шапке: «Среда, 23 сентября 2026 · 16:35»
function tickClock() {
  const now = new Date();
  const day = now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).replace(' г.', '');
  const time = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  $('clock').textContent = `${day.charAt(0).toUpperCase()}${day.slice(1)} · ${time}`;
  $('clock').dateTime = now.toISOString();
}
tickClock(); setInterval(tickClock, 15000);
try { advancedMode = localStorage.getItem('purchasePlanMode') === 'advanced'; } catch { advancedMode = false; }
setMode(advancedMode);
if (location.protocol === 'file:') {
  $('plan').disabled = true;
  showError('Для расчёта запустите приложение по README: npm start, затем откройте адрес сервера в браузере.');
} else {
  loadSuppliers();
}
