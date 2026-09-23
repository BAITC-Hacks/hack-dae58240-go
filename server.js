require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const fs = require('node:fs');
const path = require('node:path');
const core = require('./lib/core');
const { loadAll } = require('./lib/data');

const app = express();
const port = Number(process.env.PORT) || 3000;
const demoMode = !process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const client = demoMode ? null : new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL || undefined, maxRetries: 0 });
app.use(express.json({ limit: '100kb' }));
app.use(express.static('public'));

const toolDefinitions = [
  { name: 'list_skus', description: 'List manufacturer SKUs, risk flags and summary.', parameters: { type: 'object', properties: { supplier: { type: 'string' }, horizonDays: { type: 'integer', minimum: 1, maximum: 365 }, growthPct: { type: 'number', minimum: -99, maximum: 1000 } }, required: ['supplier'] } },
  { name: 'analyze_sku', description: 'Analyze one SKU: regular demand, outliers, seasonality, trend and stockout.', parameters: { type: 'object', properties: { supplier: { type: 'string' }, sku: { type: 'string' }, horizonDays: { type: 'integer', minimum: 1, maximum: 365 }, growthPct: { type: 'number', minimum: -99, maximum: 1000 } }, required: ['supplier', 'sku'] } },
  { name: 'calc_order', description: 'Calculate one SKU order from demand, stock, inbound goods and MOQ.', parameters: { type: 'object', properties: { supplier: { type: 'string' }, sku: { type: 'string' }, horizonDays: { type: 'integer', minimum: 1, maximum: 365 }, growthPct: { type: 'number', minimum: -99, maximum: 1000 } }, required: ['supplier', 'sku'] } },
  { name: 'build_supplier_orders', description: 'Build final manufacturer order rows with urgency and rationale.', parameters: { type: 'object', properties: { supplier: { type: 'string' }, horizonDays: { type: 'integer', minimum: 1, maximum: 365 }, growthPct: { type: 'number', minimum: -99, maximum: 1000 } }, required: ['supplier'] } }
].map(definition => ({ type: 'function', function: definition }));
const toolNames = new Set(toolDefinitions.map(item => item.function.name));
function compact(value) {
  const json = JSON.stringify(value);
  return json.length <= 4000 ? json : JSON.stringify({ truncated: true, preview: json.slice(0, 3800) });
}
const summarize = value => typeof value === 'string' ? value.slice(0, 180) : compact(value).slice(0, 180);
function forModel(name, result) {
  if (name === 'analyze_sku' && !result.error) {
    const { sku, name: skuName, forecast, safetyStock, quantity, urgency, flags, rationale, details, experiments } = result;
    return { sku, name: skuName, forecast, safetyStock, quantity, urgency, flags, rationale,
      details: { levelPerMonth: details.levelPerMonth, trendMonthlyPct: details.trendMonthlyPct,
        seasonSource: details.seasonSource, forecastByMonth: details.forecastByMonth,
        excludedOneOffCount: details.oneOffs.length, restoredStockoutMonths: details.lostDemand.length },
      experiments };
  }
  if (name === 'build_supplier_orders' && !result.error) {
    return { supplier: result.supplier, count: result.count, totalUnits: result.totalUnits,
      sampleOrders: result.orders.slice(0, 6).map(({ sku, quantity, urgency, rationale }) => ({ sku, quantity, urgency, rationale })) };
  }
  return result;
}
function callTool(name, args, trace) {
  if (!toolNames.has(name)) throw new Error('Неизвестный инструмент');
  trace.push({ step: trace.length + 1, type: 'tool_call', name, args });
  const result = core[name](args);
  trace.push({ step: trace.length + 1, type: 'tool_result', name, summary: summarize(result) });
  return result;
}
function validPlan(input) {
  return input && typeof input.supplier === 'string' && core.listSuppliers().some(item => item.id === input.supplier) &&
    (input.horizonDays === undefined || Number.isInteger(input.horizonDays) && input.horizonDays >= 1 && input.horizonDays <= 365) &&
    (input.growthPct === undefined || typeof input.growthPct === 'number' && Number.isFinite(input.growthPct) && input.growthPct >= -99 && input.growthPct <= 1000);
}
app.get('/api/suppliers', (_req, res) => res.json({ suppliers: core.listSuppliers(), dataSource: loadAll().demo ? 'demo' : 'local' }));
app.get('/api/sku', (req, res) => {
  const { supplier, sku } = req.query;
  const horizonDays = req.query.horizonDays === undefined ? 30 : Number(req.query.horizonDays);
  const growthPct = req.query.growthPct === undefined ? 0 : Number(req.query.growthPct);
  if (typeof sku !== 'string' || !sku.trim() || !validPlan({ supplier, horizonDays, growthPct })) {
    return res.status(400).json({ error: 'Укажите производителя, артикул и корректные параметры расчёта.' });
  }
  try { return res.json(core.analyze_sku({ supplier, sku, horizonDays, growthPct })); }
  catch (error) { return res.status(404).json({ error: error.message }); }
});
app.post('/api/plan', async (req, res) => {
  if (!validPlan(req.body)) return res.status(400).json({ error: 'Укажите известного производителя, horizonDays от 1 до 365 и growthPct от −99 до 1000.' });
  const { supplier, horizonDays = 30, growthPct = 0 } = req.body;
  const trace = [];
  try {
    let orders;
    let answer;
    let summary;
    if (demoMode) {
      const listed = callTool('list_skus', { supplier, horizonDays, growthPct }, trace);
      summary = listed.summary;
      const risky = listed.skus.filter(item => item.flags?.length).slice(0, 3);
      for (const item of risky) callTool('analyze_sku', { supplier, sku: item.sku, horizonDays, growthPct }, trace);
      orders = callTool('build_supplier_orders', { supplier, horizonDays, growthPct }, trace).orders;
      answer = `[DEMO] Сформирован проект заказа для производителя ${supplier}. Расчёты выполнены локальным ядром; текст ответа задан заранее. Проверьте и измените количества перед утверждением.`;
    } else {
      const messages = [
        { role: 'system', content: 'Ты — агент по закупкам дистрибьютора электротоваров, готовишь проект заказа производителю для менеджера. Порядок работы: 1) list_skus — сводка и рисковые позиции; 2) analyze_sku только для 3–5 самых важных позиций (срочные и с флагами one_off_excluded, stockout_history, seasonal, growth), не для всех; 3) build_supplier_orders. Все цифры бери только из результатов инструментов, ничего не выдумывай и не пересчитывай сам. Ответ по-русски, до 200 слов: итог (сколько позиций и единиц к заказу, сколько срочных); 3–5 ключевых позиций с причиной — например, разовая продажа исключена (каким был бы заказ без фильтра по experiments), восстановлен упущенный спрос, сезон или тренд; что менеджеру проверить перед утверждением. Не утверждай и не отправляй заказ — это делает только менеджер.' },
        { role: 'user', content: `Сформируй проект заказа для производителя ${supplier} на ${horizonDays} дней с прогнозом прироста ${growthPct}%.` }
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
          let requested;
          try { requested = JSON.parse(call.function.arguments || '{}'); } catch { requested = {}; }
          const args = { supplier, horizonDays, growthPct };
          if (typeof requested.sku === 'string') args.sku = requested.sku;
          let result;
          try { result = callTool(call.function.name, args, trace); }
          catch (error) { result = { error: error.message }; }
          if (call.function.name === 'list_skus' && result.summary) summary = result.summary;
          if (call.function.name === 'build_supplier_orders' && Array.isArray(result.orders)) orders = result.orders;
          if (call === message.tool_calls[0]) trace[trace.length - 1].usage = usage; // расход одного хода модели — один раз
          messages.push({ role: 'tool', tool_call_id: call.id, content: compact(forModel(call.function.name, result)) });
        }
      }
      if (!orders) orders = callTool('build_supplier_orders', { supplier, horizonDays, growthPct }, trace).orders;
      if (!summary) summary = callTool('list_skus', { supplier, horizonDays, growthPct }, trace).summary;
      if (!answer) {
        answer = 'Достигнут лимит шагов агента. Проект заказа рассчитан локальным ядром; проверьте строки.';
        trace.push({ step: trace.length + 1, type: 'final', name: 'assistant', summary: answer });
      }
    }
    if (demoMode) trace.push({ step: trace.length + 1, type: 'final', name: 'assistant', summary: answer });
    return res.json({ demoMode, answer, orders, summary, trace });
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
  const columns = ['sku', 'name', 'supplier', 'stock', 'inTransit', 'forecast', 'safetyStock', 'moq', 'abc', 'quantity', 'urgency', 'flags', 'rationale'];
  const csv = '\ufeff' + columns.join(',') + '\r\n' + orders.map(row => columns.map(column => csvCell(column === 'supplier' ? supplier : column === 'flags' ? (row.flags || []).join('; ') : row[column])).join(',')).join('\r\n') + '\r\n';
  fs.mkdirSync(path.join(__dirname, 'exports'), { recursive: true });
  const filename = `order-${Date.now()}.csv`;
  fs.writeFileSync(path.join(__dirname, 'exports', filename), csv, { flag: 'wx' });
  res.download(path.join(__dirname, 'exports', filename), filename);
});
app.listen(port, () => console.log(demoMode ? '[DEMO MODE] OPENAI_API_KEY не задан' : `[LIVE] модель ${model}`));
