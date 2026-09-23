// Проверка устойчивости к синтетической разовой продаже. Выводит только агрегаты.
const { build_supplier_orders, analyze_sku } = require('../lib/core');

const supplier = process.argv[2] || 'IEK';
// Загрузчик данных пишет служебный лог; проверка показывает только агрегаты.
const originalLog = console.log;
console.log = () => {};
const orders = build_supplier_orders({ supplier }).orders;
const leaks = orders.map(({ sku, quantity }) => {
  const injected = analyze_sku({ supplier, sku }).experiments.injectedOneOff;
  return (injected.quantity - quantity) / injected.added;
}).sort((a, b) => a - b);
const percentile = p => {
  if (!leaks.length) return 0;
  const index = (leaks.length - 1) * p;
  const lo = Math.floor(index), hi = Math.ceil(index);
  return leaks[lo] + (leaks[hi] - leaks[lo]) * (index - lo);
};
console.log = originalLog;
console.log(JSON.stringify({ count: leaks.length, p50: percentile(0.5), p90: percentile(0.9), p99: percentile(0.99) }));
