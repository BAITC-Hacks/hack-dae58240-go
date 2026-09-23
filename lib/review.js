// Проверка результата расчётного ядра. Не меняет заказы и не читает исходные выгрузки.
const core = require('./core');

function review_order({ supplier, horizonDays = 30, growthPct = 0 }) {
  const args = { supplier, horizonDays, growthPct };
  const orders = core.build_supplier_orders(args).orders;
  const leadTime = core.listSuppliers().find(item => item.id === supplier)?.leadTimeDays || 45;
  const days = leadTime + horizonDays;
  const issues = [];
  const add = (row, rule, severity, message) => issues.push({
    sku: row.sku, name: row.name, rule, severity, message, quantity: row.quantity
  });

  for (const row of orders) {
    const forecast30 = days > 0 ? row.forecast / days * 30 : 0;
    if (forecast30 > 0 && row.quantity > 3 * forecast30) {
      const months = Math.round(row.quantity / forecast30 * 10) / 10;
      add(row, 'big_order', 'warn', `Заказ на ${months} мес вперёд — проверьте, не завышен ли`);
    }
    if (row.inTransit > row.forecast) {
      add(row, 'big_transit', 'info', 'В пути больше, чем нужно на период');
    }
  }

  // Анализ дорогой: не более 20 вызовов и только среди 20 крупнейших строк заказа.
  const largest = [...orders].sort((a, b) => b.quantity - a.quantity).slice(0, 20);
  for (const row of largest.filter(item => item.flags?.includes('one_off_excluded'))) {
    const analyzed = core.analyze_sku({ ...args, sku: row.sku });
    const without = analyzed.experiments?.withoutOneOffFilter?.quantity;
    if (without > 1.5 * row.quantity) {
      add(row, 'filter_sensitive', 'warn',
        `Фильтр разовых продаж уменьшил заказ с ${without} до ${row.quantity} — подтвердите, что крупные продажи не повторятся`);
    }
  }

  // build_supplier_orders содержит лишь положительные заказы; нулевые рисковые SKU
  // доступны через ограниченный список list_skus (до 50 наиболее рисковых).
  const listed = core.list_skus({ ...args, limit: 50 }).skus;
  for (const item of listed.filter(row => row.quantity === 0 && row.flags?.includes('stockout_now'))) {
    const row = core.calc_order({ ...args, sku: item.sku });
    if (row.quantity === 0 && row.flags?.includes('stockout_now')) {
      add(row, 'no_order_but_stockout', 'warn',
        'Товара нет, но заказ не рассчитан: спрос ≈ 0 за 6 мес — возможно, вывести из ассортимента');
    }
  }

  issues.sort((a, b) => (a.severity === 'warn' ? 0 : 1) - (b.severity === 'warn' ? 0 : 1) || b.quantity - a.quantity);
  return { checked: orders.length + listed.filter(row => row.quantity === 0 && row.flags?.includes('stockout_now')).length, issues: issues.slice(0, 15) };
}

module.exports = { review_order };
