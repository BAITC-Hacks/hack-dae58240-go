require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const fs = require('node:fs');
const path = require('node:path');
const core = require('./lib/core');
const { review_order } = require('./lib/review');
const { loadAll } = require('./lib/data');
const { toXlsx } = require('./lib/export');

const app = express();
const port = Number(process.env.PORT) || 3000;
const demoMode = !process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const client = demoMode ? null : new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL || undefined, maxRetries: 0 });
app.use(express.json({ limit: '2mb' })); // заказ IEK ~800 строк с обоснованиями
app.use(express.static('public'));

const toolDefinitions = [
  { name: 'list_skus', description: 'List manufacturer SKUs, risk flags and summary.', parameters: { type: 'object', properties: { supplier: { type: 'string' }, horizonDays: { type: 'integer', minimum: 1, maximum: 365 }, growthPct: { type: 'number', minimum: -99, maximum: 1000 } }, required: ['supplier'] } },
  { name: 'analyze_sku', description: 'Analyze one SKU: regular demand, outliers, seasonality, trend and stockout.', parameters: { type: 'object', properties: { supplier: { type: 'string' }, sku: { type: 'string' }, horizonDays: { type: 'integer', minimum: 1, maximum: 365 }, growthPct: { type: 'number', minimum: -99, maximum: 1000 } }, required: ['supplier', 'sku'] } },
  { name: 'calc_order', description: 'Calculate one SKU order from demand, stock, inbound goods and MOQ.', parameters: { type: 'object', properties: { supplier: { type: 'string' }, sku: { type: 'string' }, horizonDays: { type: 'integer', minimum: 1, maximum: 365 }, growthPct: { type: 'number', minimum: -99, maximum: 1000 } }, required: ['supplier', 'sku'] } },
  { name: 'build_supplier_orders', description: 'Build final manufacturer order rows with urgency and rationale.', parameters: { type: 'object', properties: { supplier: { type: 'string' }, horizonDays: { type: 'integer', minimum: 1, maximum: 365 }, growthPct: { type: 'number', minimum: -99, maximum: 1000 } }, required: ['supplier'] } },
  { name: 'review_order', description: 'Проверить готовый заказ на аномалии и вернуть позиции, требующие внимания менеджера.', parameters: { type: 'object', properties: { supplier: { type: 'string' }, horizonDays: { type: 'integer', minimum: 1, maximum: 365 }, growthPct: { type: 'number', minimum: -99, maximum: 1000 } }, required: ['supplier'] } }
].map(definition => ({ type: 'function', function: definition }));
const toolNames = new Set(toolDefinitions.map(item => item.function.name));
function compact(value) {
  const json = JSON.stringify(value);
  return json.length <= 4000 ? json : JSON.stringify({ truncated: true, preview: json.slice(0, 3800) });
}
const summarize = value => typeof value === 'string' ? value.slice(0, 180) : compact(value).slice(0, 180);
const fmt = value => Number(value || 0).toLocaleString('ru-RU').replace(/[\u00a0\u202f]/g, ' ');
const urgencyText = { high: 'высокая', medium: 'средняя', low: 'низкая' };
function toolCallText(name, args, skuNames) {
  if (name === 'list_skus') return `Запрашиваю сводку по производителю ${args.supplier} (горизонт ${fmt(args.horizonDays)} дн, прирост ${fmt(args.growthPct)}%).`;
  if (name === 'analyze_sku') return `Разбираю артикул ${args.sku}${skuNames.get(args.sku) ? ` — ${skuNames.get(args.sku).slice(0, 50)}` : ''}.`;
  if (name === 'calc_order') return `Рассчитываю заказ для артикула ${args.sku}.`;
  if (name === 'build_supplier_orders') return `Собираю итоговый заказ по производителю ${args.supplier}.`;
  if (name === 'review_order') return `Проверяю готовый заказ по производителю ${args.supplier} на аномалии.`;
  return `Вызываю инструмент ${name}.`;
}
function toolResultText(name, result, args) {
  if (result?.error) return `Ошибка инструмента ${name}: ${result.error}`;
  if (name === 'list_skus') {
    const s = result.summary || {};
    const risky = (result.skus || []).slice(0, 3).map(row => row.sku).join(', ');
    return `Активных артикулов ${fmt(s.activeSkus)}, к заказу ${fmt(s.toOrder)}, срочных ${fmt(s.urgent)}; разовые продажи исключены у ${fmt(s.withOneOffsExcluded)}, упущенный спрос восстановлен у ${fmt(s.withLostDemand)}.${risky ? ` Рисковые: ${risky}.` : ''}`;
  }
  if (name === 'analyze_sku' || name === 'calc_order') {
    const days = (result.details?.leadTimeDays || 0) + (result.details?.horizonDays || args.horizonDays || 0);
    const parts = [`Заказ ${fmt(result.quantity)} шт (срочность: ${urgencyText[result.urgency] || result.urgency}).`,
      `Прогноз ${fmt(result.forecast)} на ${fmt(days)} дн, страх. запас ${fmt(result.safetyStock)}, остаток ${fmt(result.stock)}, в пути ${fmt(result.inTransit)}.`];
    const flags = result.flags || [];
    if (flags.includes('one_off_excluded')) {
      const oneOffs = result.details?.oneOffs || [];
      const without = result.experiments?.withoutOneOffFilter?.quantity;
      parts.push(`Исключено разовых: ${fmt(oneOffs.length)} накл.${without === undefined ? '' : ` (без фильтра заказ был бы ${fmt(without)})`}.`);
    }
    if (flags.includes('stockout_history')) {
      const lost = result.details?.lostDemand || [];
      const units = Math.round(lost.reduce((sum, item) => sum + item.restored - item.sold, 0));
      parts.push(`Упущенный спрос: +${fmt(units)} шт за ${fmt(lost.length)} мес.`);
    }
    if (flags.includes('seasonal')) parts.push(`Сезонность: ${result.details?.seasonSource || 'учтена'}.`);
    if (flags.includes('growth') || flags.includes('decline')) parts.push(`Тренд: ${fmt(result.details?.trendMonthlyPct)}% в месяц.`);
    return parts.join(' ');
  }
  if (name === 'build_supplier_orders') {
    const orders = result.orders || [];
    const urgent = orders.filter(row => row.urgency === 'high').length;
    return `Готово: ${fmt(result.count ?? orders.length)} позиций, ${fmt(result.totalUnits ?? orders.reduce((sum, row) => sum + row.quantity, 0))} единиц, из них срочных ${fmt(urgent)}.`;
  }
  if (name === 'review_order') {
    const warnings = (result.issues || []).filter(issue => issue.severity === 'warn').length;
    return `Проверено ${fmt(result.checked)} позиций: найдено ${fmt(result.issues?.length)} замечаний, из них ${fmt(warnings)} требуют проверки менеджера.`;
  }
  return 'Инструмент вернул результат.';
}
function forModel(name, result) {
  if (name === 'analyze_sku' && !result.error) {
    const { sku, name: skuName, forecast, safetyStock, quantity, urgency, flags, rationale, details, experiments } = result;
    return { sku, name: skuName, forecast, safetyStock, quantity, urgency, flags, rationale,
      details: { levelPerMonth: details.levelPerMonth, trendMonthlyPct: details.trendMonthlyPct,
        seasonSource: details.seasonSource, forecastByMonth: details.forecastByMonth,
        excludedOneOffCount: details.oneOffs.length, restoredStockoutMonths: details.lostDemand.length },
      experiments };
  }
  if (name === 'calc_order' && !result.error) {
    const { sku, name: skuName, forecast, safetyStock, quantity, urgency, flags, rationale, details = {} } = result;
    return { sku, name: skuName, forecast, safetyStock, quantity, urgency, flags, rationale,
      details: { levelPerMonth: details.levelPerMonth, trendMonthlyPct: details.trendMonthlyPct, seasonSource: details.seasonSource,
        forecastByMonth: details.forecastByMonth, excludedOneOffCount: (details.oneOffs || []).length, restoredStockoutMonths: (details.lostDemand || []).length } };
  }
  if (name === 'build_supplier_orders' && !result.error) {
    return { supplier: result.supplier, count: result.count, totalUnits: result.totalUnits,
      sampleOrders: result.orders.slice(0, 6).map(({ sku, quantity, urgency, rationale }) => ({ sku, quantity, urgency, rationale })) };
  }
  if (name === 'review_order' && !result.error) {
    return { checked: result.checked, issueCount: result.issues.length,
      issues: result.issues.slice(0, 5).map(({ sku, rule, severity, message, quantity }) => ({ sku, rule, severity, message, quantity })) };
  }
  return result;
}
function callTool(name, args, trace, skuNames) {
  trace.push({ step: trace.length + 1, type: 'tool_call', name, args, text: toolCallText(name, args, skuNames) });
  try {
    if (!toolNames.has(name)) throw new Error('Неизвестный инструмент');
    const result = name === 'review_order' ? review_order(args) : core[name](args);
    if (name === 'list_skus') for (const row of result.skus || []) skuNames.set(row.sku, row.name);
    trace.push({ step: trace.length + 1, type: 'tool_result', name, summary: summarize(result), text: toolResultText(name, result, args) });
    return result;
  } catch (error) {
    trace.push({ step: trace.length + 1, type: 'tool_result', name, summary: error.message, text: `Ошибка инструмента ${name}: ${error.message}` });
    throw error;
  }
}
function validPlan(input) {
  return input && typeof input.supplier === 'string' && core.listSuppliers().some(item => item.id === input.supplier) &&
    (input.horizonDays === undefined || Number.isInteger(input.horizonDays) && input.horizonDays >= 1 && input.horizonDays <= 365) &&
    (input.growthPct === undefined || typeof input.growthPct === 'number' && Number.isFinite(input.growthPct) && input.growthPct >= -99 && input.growthPct <= 1000);
}
function withReviewBlock(answer, review) {
  const intro = String(answer || '').split(/(?:\*\*)?Проверьте перед утверждением(?:\*\*)?\s*:?/i)[0].trim();
  const points = review.issues.slice(0, 5).map(issue => `- ${issue.name}: ${issue.message}`);
  return `${intro}\n\nПроверьте перед утверждением:\n${points.length ? points.join('\n') : 'Замечаний не найдено.'}`;
}
app.get('/api/suppliers', (_req, res) => {
  const data = loadAll();
  const demoData = data.demo || path.resolve(data.dir) === path.join(__dirname, 'data', 'demo');
  res.json({ suppliers: core.listSuppliers(), dataSource: demoData ? 'demo' : 'local' });
});
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
  const skuNames = new Map();
  try {
    let orders;
    let answer;
    let summary;
    let review;
    if (demoMode) {
      const listed = callTool('list_skus', { supplier, horizonDays, growthPct }, trace, skuNames);
      summary = listed.summary;
      const risky = listed.skus.filter(item => item.flags?.length).slice(0, 3);
      for (const item of risky) callTool('analyze_sku', { supplier, sku: item.sku, horizonDays, growthPct }, trace, skuNames);
      orders = callTool('build_supplier_orders', { supplier, horizonDays, growthPct }, trace, skuNames).orders;
      review = callTool('review_order', { supplier, horizonDays, growthPct }, trace, skuNames);
      answer = `[DEMO] Сформирован проект заказа для производителя ${supplier}. Расчёты выполнены локальным ядром; текст ответа задан заранее. Проверьте и измените количества перед утверждением.`;
    } else {
      const messages = [
        { role: 'system', content: 'Ты — агент по закупкам дистрибьютора электротоваров. Порядок работы обязателен: 1) list_skus; 2) analyze_sku для 3–5 важных позиций параллельными tool_calls в одном ходе; 3) build_supplier_orders; 4) ПОСЛЕ сборки обязательно review_order; 5) финальный ответ. Уложись в 5 ходов, лимит 6. Все цифры бери только из инструментов. Ответ по-русски, до 200 слов: итог заказа, несколько ключевых позиций с причиной и отдельный блок «Проверьте перед утверждением» с найденными review_order проблемами (до 5). Не утверждай и не отправляй заказ — это делает менеджер.' },
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
          if (!review) {
            if (!orders) orders = callTool('build_supplier_orders', { supplier, horizonDays, growthPct }, trace, skuNames).orders;
            review = callTool('review_order', { supplier, horizonDays, growthPct }, trace, skuNames);
            messages.push({ role: 'system', content: `Проверка готова. Перед финальным ответом используй эти замечания: ${compact(forModel('review_order', review))}` });
            continue;
          }
          answer = message.content || 'Проект заказа рассчитан.';
          trace.push({ step: trace.length + 1, type: 'final', name: 'assistant', summary: summarize(answer), text: answer.slice(0, 200), usage });
          break;
        }
        for (const call of message.tool_calls) {
          let requested;
          try { requested = JSON.parse(call.function.arguments || '{}'); } catch { requested = {}; }
          const args = { supplier, horizonDays, growthPct };
          if (typeof requested.sku === 'string') args.sku = requested.sku;
          let result;
          try {
            if (call.function.name === 'review_order' && !orders) orders = callTool('build_supplier_orders', args, trace, skuNames).orders;
            result = callTool(call.function.name, args, trace, skuNames);
          }
          catch (error) { result = { error: error.message }; }
          if (call.function.name === 'list_skus' && result.summary) summary = result.summary;
          if (call.function.name === 'build_supplier_orders' && Array.isArray(result.orders)) orders = result.orders;
          if (call.function.name === 'review_order' && Array.isArray(result.issues)) review = result;
          if (call === message.tool_calls[0]) trace[trace.length - 1].usage = usage; // расход одного хода модели — один раз
          messages.push({ role: 'tool', tool_call_id: call.id, content: compact(forModel(call.function.name, result)) });
        }
      }
      if (!orders) orders = callTool('build_supplier_orders', { supplier, horizonDays, growthPct }, trace, skuNames).orders;
      if (!summary) summary = callTool('list_skus', { supplier, horizonDays, growthPct }, trace, skuNames).summary;
      if (!review) review = callTool('review_order', { supplier, horizonDays, growthPct }, trace, skuNames);
      if (!answer) {
        answer = 'Достигнут лимит шагов агента. Проект заказа рассчитан локальным ядром; проверьте строки.';
        trace.push({ step: trace.length + 1, type: 'final', name: 'assistant', summary: answer, text: answer.slice(0, 200) });
      }
    }
    answer = withReviewBlock(answer, review);
    if (demoMode) trace.push({ step: trace.length + 1, type: 'final', name: 'assistant', summary: answer, text: answer.slice(0, 200) });
    return res.json({ demoMode, answer, orders, summary, review, trace, asOf: loadAll().asOf });
  } catch (error) {
    console.error('[PLAN ERROR]', error.message);
    return res.status(502).json({ error: 'Не удалось получить ответ модели. Проверьте настройки API и повторите запрос.' });
  }
});
function csvCell(value) {
  const safe = String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&");
  return `"${safe.replace(/"/g, '""')}"`;
}
function validApproval(body) {
  const { supplier, orders } = body || {};
  if (typeof supplier !== 'string' || !core.listSuppliers().some(item => item.id === supplier)) return false;
  const known = loadAll().manufacturers[supplier]?.sales || {}; // только артикулы этого производителя
  const text = v => v === undefined || v === null || (typeof v === 'string' && v.length <= 2000);
  return Array.isArray(orders) && orders.length > 0 && orders.length <= 1000 &&
    orders.every(row => row && typeof row.sku === 'string' && Object.hasOwn(known, row.sku) &&
      Number.isInteger(row.quantity) && row.quantity >= 0 && row.quantity <= 1000000 &&
      text(row.name) && text(row.rationale) && text(row.urgency) &&
      (row.flags === undefined || (Array.isArray(row.flags) && row.flags.every(f => typeof f === 'string'))));
}
app.post('/api/approve', (req, res) => {
  const { supplier, orders } = req.body || {};
  if (!validApproval(req.body)) {
    return res.status(400).json({ error: 'Некорректный заказ.' });
  }
  const columns = ['sku', 'name', 'supplier', 'stock', 'inTransit', 'forecast', 'safetyStock', 'moq', 'abc', 'quantity', 'urgency', 'flags', 'rationale'];
  const csv = '\ufeff' + columns.join(',') + '\r\n' + orders.map(row => columns.map(column => csvCell(column === 'supplier' ? supplier : column === 'flags' ? (row.flags || []).join('; ') : row[column])).join(',')).join('\r\n') + '\r\n';
  fs.mkdirSync(path.join(__dirname, 'exports'), { recursive: true });
  const filename = `order-${Date.now()}.csv`;
  fs.writeFileSync(path.join(__dirname, 'exports', filename), csv, { flag: 'wx' });
  res.download(path.join(__dirname, 'exports', filename), filename);
});
app.post('/api/approve/xlsx', (req, res) => {
  if (!validApproval(req.body)) return res.status(400).json({ error: 'Некорректный заказ.' });
  const { supplier, orders, horizonDays, growthPct } = req.body;
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.asOf || '')) ? req.body.asOf : new Date().toISOString().slice(0, 10);
  const safeSupplier = supplier.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'manufacturer';
  const filename = `order_${safeSupplier}_${asOf}.xlsx`;
  try {
    const buffer = toXlsx({ supplier, orders, asOf, horizonDays, growthPct });
    fs.mkdirSync(path.join(__dirname, 'exports'), { recursive: true });
    const file = path.join(__dirname, 'exports', filename);
    fs.writeFileSync(file, buffer);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.download(file, filename);
  } catch (error) {
    console.error('[XLSX EXPORT ERROR]', error.message);
    return res.status(500).json({ error: 'Не удалось выгрузить XLSX.' });
  }
});
app.use((error, _req, res, _next) => {
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
  if (status === 500) console.error('[ERROR]', error.message);
  res.status(status).json({ error: status === 413 ? 'Слишком большой запрос.' : status === 500 ? 'Внутренняя ошибка сервера.' : 'Некорректный запрос.' });
});
app.listen(port, () => console.log(demoMode ? '[DEMO MODE] OPENAI_API_KEY не задан' : `[LIVE] модель ${model}`));
