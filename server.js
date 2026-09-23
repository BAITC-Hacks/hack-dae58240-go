require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const fs = require('node:fs');
const path = require('node:path');
const core = require('./lib/core');

const app = express();
const port = Number(process.env.PORT) || 3000;
const demoMode = !process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const client = demoMode ? null : new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL || undefined, maxRetries: 0 });
app.use(express.json({ limit: '100kb' }));
app.use(express.static('public'));

const toolDefinitions = [
  { name: 'list_skus', description: 'List supplier SKUs and risk flags.', parameters: { type: 'object', properties: { supplier: { type: 'string' } }, required: ['supplier'] } },
  { name: 'analyze_sku', description: 'Analyze one SKU: regular demand, outliers, seasonality, trend and stockout.', parameters: { type: 'object', properties: { supplier: { type: 'string' }, sku: { type: 'string' } }, required: ['supplier', 'sku'] } },
  { name: 'calc_order', description: 'Calculate one SKU order from demand, stock, inbound goods and MOQ.', parameters: { type: 'object', properties: { supplier: { type: 'string' }, sku: { type: 'string' }, horizonDays: { type: 'integer', minimum: 1, maximum: 365 } }, required: ['supplier', 'sku'] } },
  { name: 'build_supplier_orders', description: 'Build final supplier order rows with urgency and rationale.', parameters: { type: 'object', properties: { supplier: { type: 'string' }, horizonDays: { type: 'integer', minimum: 1, maximum: 365 } }, required: ['supplier'] } }
].map(definition => ({ type: 'function', function: definition }));
const toolNames = new Set(toolDefinitions.map(item => item.function.name));
const compact = value => JSON.stringify(value).slice(0, 4000);
const summarize = value => typeof value === 'string' ? value.slice(0, 180) : compact(value).slice(0, 180);
function callTool(name, args, trace) {
  if (!toolNames.has(name)) throw new Error('Неизвестный инструмент');
  trace.push({ step: trace.length + 1, type: 'tool_call', name, args });
  const result = core[name](args);
  trace.push({ step: trace.length + 1, type: 'tool_result', name, summary: summarize(result) });
  return result;
}
function validPlan(input) {
  return input && typeof input.supplier === 'string' && core.listSuppliers().some(item => item.id === input.supplier) &&
    (input.horizonDays === undefined || Number.isInteger(input.horizonDays) && input.horizonDays >= 1 && input.horizonDays <= 365);
}
app.get('/api/suppliers', (_req, res) => res.json(core.listSuppliers()));
app.post('/api/plan', async (req, res) => {
  if (!validPlan(req.body)) return res.status(400).json({ error: 'Укажите известного поставщика и horizonDays от 1 до 365.' });
  const { supplier, horizonDays = 30 } = req.body;
  const trace = [];
  try {
    let orders;
    let answer;
    if (demoMode) {
      const listed = callTool('list_skus', { supplier }, trace);
      const risky = listed.skus.filter(item => item.flags?.length).slice(0, 3);
      for (const item of risky) callTool('analyze_sku', { supplier, sku: item.sku }, trace);
      orders = callTool('build_supplier_orders', { supplier, horizonDays }, trace).orders;
      answer = `[DEMO] Сформирован проект заказа для ${supplier}. Расчёты выполнены локальным ядром; текст ответа задан заранее. Проверьте и измените количества перед утверждением.`;
    } else {
      const messages = [
        { role: 'system', content: 'Ты помощник менеджера закупок. Вызывай инструменты для анализа и формирования заказа. Используй только агрегаты по артикулам. Сначала list_skus, затем анализ рисковых SKU, затем build_supplier_orders. Кратко объясни результат по-русски. Не утверждай и не отправляй заказ.' },
        { role: 'user', content: `Сформируй проект заказа для поставщика ${supplier} на ${horizonDays} дней.` }
      ];
      for (let i = 0; i < 6; i++) {
        const completion = await client.chat.completions.create({ model, messages, tools: toolDefinitions, max_tokens: 1500 });
        const usage = completion.usage || null;
        console.log('[LLM usage]', JSON.stringify(usage));
        const message = completion.choices?.[0]?.message;
        if (!message) throw new Error('Модель вернула пустой ответ');
        messages.push(message);
        if (!message.tool_calls?.length) {
          answer = message.content || 'Проект заказа рассчитан.';
          trace.push({ step: trace.length + 1, type: 'final', name: 'assistant', summary: summarize(answer), usage });
          break;
        }
        for (const call of message.tool_calls) {
          let args;
          try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
          args.supplier = supplier;
          if (['calc_order', 'build_supplier_orders'].includes(call.function.name)) args.horizonDays = horizonDays;
          let result;
          try { result = callTool(call.function.name, args, trace); }
          catch (error) { result = { error: error.message }; }
          if (call.function.name === 'build_supplier_orders' && Array.isArray(result.orders)) orders = result.orders;
          trace[trace.length - 1].usage = usage;
          messages.push({ role: 'tool', tool_call_id: call.id, content: compact(result) });
        }
      }
      if (!orders) orders = callTool('build_supplier_orders', { supplier, horizonDays }, trace).orders;
      if (!answer) {
        answer = 'Достигнут лимит шагов агента. Проект заказа рассчитан локальным ядром; проверьте строки.';
        trace.push({ step: trace.length + 1, type: 'final', name: 'assistant', summary: answer });
      }
    }
    if (demoMode) trace.push({ step: trace.length + 1, type: 'final', name: 'assistant', summary: answer });
    return res.json({ demoMode, answer, orders, trace });
  } catch (error) {
    console.error('[PLAN ERROR]', error.message);
    return res.status(502).json({ error: 'Не удалось получить ответ модели. Проверьте настройки API и повторите запрос.' });
  }
});
function csvCell(value) {
  const safe = String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&");
  return `"${safe.replace(/"/g, '""')}"`;
}
app.post('/api/approve', (req, res) => {
  const { supplier, orders } = req.body || {};
  if (typeof supplier !== 'string' || !core.listSuppliers().some(item => item.id === supplier) || !Array.isArray(orders) || !orders.length || orders.length > 1000 ||
      !orders.every(row => row && typeof row.sku === 'string' && Number.isInteger(row.quantity) && row.quantity >= 0 && row.quantity <= 1000000)) {
    return res.status(400).json({ error: 'Некорректный заказ.' });
  }
  const columns = ['sku', 'name', 'supplier', 'stock', 'inTransit', 'forecast', 'quantity', 'urgency', 'rationale'];
  const csv = '\ufeff' + columns.join(',') + '\r\n' + orders.map(row => columns.map(column => csvCell(column === 'supplier' ? supplier : row[column])).join(',')).join('\r\n') + '\r\n';
  fs.mkdirSync(path.join(__dirname, 'exports'), { recursive: true });
  const filename = `order-${Date.now()}.csv`;
  fs.writeFileSync(path.join(__dirname, 'exports', filename), csv, { flag: 'wx' });
  res.download(path.join(__dirname, 'exports', filename), filename);
});
app.listen(port, () => console.log(demoMode ? '[DEMO MODE] OPENAI_API_KEY не задан' : `[LIVE] модель ${model}`));
