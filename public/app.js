const $ = id => document.getElementById(id);
let currentOrders = [];
const urgencyText = { high: 'Высокая', medium: 'Средняя', low: 'Низкая' };
function showError(message) { $('error').textContent = message; $('error').hidden = !message; }
async function loadSuppliers() {
  try {
    const response = await fetch('/api/suppliers');
    if (!response.ok) throw new Error('Не удалось загрузить поставщиков');
    const suppliers = await response.json();
    $('supplier').replaceChildren(...suppliers.map(item => {
      const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; return option;
    }));
  } catch (error) { showError(error.message); }
}
function renderTrace(trace) {
  $('trace').replaceChildren(...trace.map(entry => {
    const li = document.createElement('li');
    const label = document.createElement('strong');
    label.textContent = `${entry.step}. ${entry.type === 'tool_call' ? 'Вызов' : entry.type === 'tool_result' ? 'Результат' : 'Ответ'} · ${entry.name}`;
    const detail = document.createElement('span');
    detail.textContent = entry.args ? JSON.stringify(entry.args) : entry.summary || '';
    li.append(label, detail);
    if (entry.usage) {
      const usage = document.createElement('small');
      usage.textContent = `Токены: вход ${entry.usage.prompt_tokens ?? '—'}, выход ${entry.usage.completion_tokens ?? '—'}`;
      li.append(usage);
    }
    return li;
  }));
}
function cell(text) { const td = document.createElement('td'); td.textContent = text ?? ''; return td; }
function renderOrders() {
  $('orders').replaceChildren(...currentOrders.map((order, index) => {
    const tr = document.createElement('tr');
    for (const key of ['sku', 'name', 'stock', 'inTransit', 'forecast']) tr.append(cell(order[key]));
    const quantity = cell('');
    const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.max = '1000000'; input.step = '1'; input.value = order.quantity;
    input.setAttribute('aria-label', `Количество для ${order.sku}`);
    input.addEventListener('input', () => { currentOrders[index].quantity = Number(input.value); });
    quantity.append(input); tr.append(quantity);
    const urgency = cell(urgencyText[order.urgency] || order.urgency);
    urgency.className = `urgency ${['high', 'medium', 'low'].includes(order.urgency) ? order.urgency : ''}`;
    tr.append(urgency, cell(order.rationale)); return tr;
  }));
  $('approve').disabled = currentOrders.length === 0;
}
$('plan').addEventListener('click', async () => {
  showError(''); $('working').hidden = false; $('plan').disabled = true; $('approve').disabled = true;
  try {
    const response = await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplier: $('supplier').value, horizonDays: Number($('horizon').value) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Ошибка расчёта');
    $('demoBadge').hidden = !data.demoMode;
    $('answer').textContent = data.answer;
    renderTrace(data.trace);
    currentOrders = data.orders;
    renderOrders();
  } catch (error) { showError(error.message); }
  finally { $('working').hidden = true; $('plan').disabled = false; }
});
$('approve').addEventListener('click', async () => {
  showError('');
  if (!currentOrders.every(row => Number.isInteger(row.quantity) && row.quantity >= 0 && row.quantity <= 1000000)) return showError('Проверьте количества в таблице.');
  try {
    const response = await fetch('/api/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ supplier: $('supplier').value, orders: currentOrders }) });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Ошибка выгрузки'); }
    const blob = await response.blob(); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `order-${Date.now()}.csv`; a.click(); URL.revokeObjectURL(url);
  } catch (error) { showError(error.message); }
});
loadSuppliers();
