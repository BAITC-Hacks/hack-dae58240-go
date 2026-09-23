// Temporary core contract: each tool accepts one arguments object and returns JSON.
// listSuppliers() returns [{id,name}]. list_skus({supplier}) returns {skus:[{sku,name,supplier,flags}]}.
// analyze_sku({supplier,sku}) returns an aggregate analysis. calc_order({supplier,sku,horizonDays})
// returns one order row. build_supplier_orders({supplier,horizonDays}) returns {orders:[rows]}.
// The replacement calculation core can keep these shapes without changing the API or UI.
const suppliers = [
  { id: 'IEK', name: 'IEK' },
  { id: 'Systeme electric', name: 'Systeme electric' }
];
const catalog = Object.fromEntries(suppliers.map(({ id }) => [id, Array.from({ length: 5 }, (_, i) => ({
  sku: `${id === 'IEK' ? 'IEK' : 'SE'}-${String(i + 1).padStart(3, '0')}`,
  name: ['Автоматический выключатель', 'Кабель силовой', 'Розетка', 'Контактор', 'Корпус щита'][i],
  supplier: id, stock: [4, 16, 5, 28, 12][i], inTransit: [0, 3, 2, 4, 0][i],
  dailyDemand: [2.4, 1.3, 1.8, 0.7, 1.1][i], moq: [10, 5, 10, 5, 5][i],
  flags: [i === 0 ? 'low_stock' : null, i === 2 ? 'stockout' : null, i === 3 ? 'outlier' : null].filter(Boolean)
}))]));
function getSku({ supplier, sku }) {
  const item = catalog[supplier]?.find(row => row.sku === sku);
  if (!item) throw new Error('Артикул или поставщик не найден');
  return item;
}
function listSuppliers() { return suppliers; }
function list_skus({ supplier }) {
  if (!catalog[supplier]) throw new Error('Поставщик не найден');
  return { skus: catalog[supplier].map(({ sku, name, supplier: supplierId, flags }) => ({ sku, name, supplier: supplierId, flags })) };
}
function analyze_sku(args) {
  const item = getSku(args);
  return { sku: item.sku, supplier: item.supplier, averageDailyDemand: item.dailyDemand,
    seasonalFactor: item.sku.endsWith('002') ? 1.2 : 1,
    trendFactor: item.sku.endsWith('002') ? 1.08 : 1,
    stockoutAdjustment: item.flags.includes('stockout') ? 0.25 : 0,
    excludedOneOffOrders: item.flags.includes('outlier') ? 1 : 0,
    note: 'Синтетические показатели временной заглушки; не использовать для закупки.' };
}
function calc_order({ supplier, sku, horizonDays = 30 }) {
  const item = getSku({ supplier, sku });
  const analysis = analyze_sku({ supplier, sku });
  const forecast = Math.ceil(item.dailyDemand * horizonDays * analysis.seasonalFactor * analysis.trendFactor * (1 + analysis.stockoutAdjustment));
  const net = Math.max(0, forecast - item.stock - item.inTransit);
  const quantity = Math.ceil(net / item.moq) * item.moq;
  return { sku, name: item.name, supplier, stock: item.stock, inTransit: item.inTransit, forecast,
    quantity, urgency: item.stock < item.dailyDemand * 7 ? 'high' : item.stock < item.dailyDemand * 14 ? 'medium' : 'low',
    rationale: `Прогноз ${forecast} шт. на ${horizonDays} дн.; остаток ${item.stock}, в пути ${item.inTransit}, MOQ ${item.moq}.` };
}
function build_supplier_orders({ supplier, horizonDays = 30 }) {
  if (!catalog[supplier]) throw new Error('Поставщик не найден');
  return { supplier, orders: catalog[supplier].map(item => calc_order({ supplier, sku: item.sku, horizonDays })).filter(row => row.quantity > 0) };
}
module.exports = { listSuppliers, list_skus, analyze_sku, calc_order, build_supplier_orders };
