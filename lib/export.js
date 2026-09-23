const XLSX = require('xlsx');

const urgencyNames = { high: 'Высокая', medium: 'Средняя', low: 'Низкая' };

// horizonDays и growthPct необязательны для старых клиентов API; без них используются
// значения плана по умолчанию. Коды 1С всегда записываются как текстовые ячейки.
function toXlsx({ supplier, orders, asOf, horizonDays = 30, growthPct = 0 }) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(asOf || '')) ? asOf : new Date().toISOString().slice(0, 10);
  const workbook = XLSX.utils.book_new();
  const rows = [
    [`Заказ производителю ${supplier} от ${date}, проект (утверждён менеджером)`],
    [],
    ['№', 'Код 1С', 'Наименование', 'Количество', 'Ед.', 'Срочность', 'Обоснование'],
    ...orders.map((order, index) => [
      index + 1, String(order.sku), String(order.name || ''), order.quantity,
      String(order.unit || ''), urgencyNames[order.urgency] || String(order.urgency || ''), String(order.rationale || '')
    ])
  ];
  const orderSheet = XLSX.utils.aoa_to_sheet(rows);
  orderSheet['!cols'] = [{ wch: 6 }, { wch: 20 }, { wch: 48 }, { wch: 15 }, { wch: 8 }, { wch: 14 }, { wch: 90 }];
  for (let index = 0; index < orders.length; index++) {
    orderSheet[`B${index + 4}`] = { t: 's', v: String(orders[index].sku) };
    orderSheet[`D${index + 4}`] = { t: 'n', v: orders[index].quantity };
  }
  XLSX.utils.book_append_sheet(workbook, orderSheet, 'Заказ');

  const parameters = XLSX.utils.aoa_to_sheet([
    ['Параметр', 'Значение'],
    ['Производитель', supplier],
    ['Дата расчёта', date],
    ['Горизонт, дней', horizonDays],
    ['Прирост, %', growthPct],
    ['Число позиций', orders.length],
    ['Сумма единиц', orders.reduce((sum, order) => sum + order.quantity, 0)]
  ]);
  parameters['!cols'] = [{ wch: 24 }, { wch: 44 }];
  XLSX.utils.book_append_sheet(workbook, parameters, 'Параметры');

  const importSheet = XLSX.utils.aoa_to_sheet([
    ['Код', 'Количество'],
    ...orders.map(order => [String(order.sku), order.quantity])
  ]);
  importSheet['!cols'] = [{ wch: 22 }, { wch: 16 }];
  for (let index = 0; index < orders.length; index++) {
    importSheet[`A${index + 2}`] = { t: 's', v: String(orders[index].sku) };
    importSheet[`B${index + 2}`] = { t: 'n', v: orders[index].quantity };
  }
  XLSX.utils.book_append_sheet(workbook, importSheet, 'Для загрузки в 1С');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { toXlsx };
