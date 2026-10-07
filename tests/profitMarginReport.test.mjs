import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProfitMarginSummary } from '../src/lib/profitMarginReport.js';

test('later changes to a product average cost do not change historical sale profit', () => {
  const savedSale = {
    product_id: 'p1', item_code: '1001', description: 'Laptop',
    qty: 1, line_total: 1000, unit_cost: 600,
    products: { avg_cost: 900 }
  };
  const before = buildProfitMarginSummary([savedSale]);
  savedSale.products.avg_cost = 1200;
  const after = buildProfitMarginSummary([savedSale]);

  assert.equal(before.salesCost, 600);
  assert.equal(before.salesProfit, 400);
  assert.deepEqual(after, before);
});

test('sales of the same product at different saved costs retain each cost', () => {
  const result = buildProfitMarginSummary([
    { product_id: 'p1', item_code: '1001', description: 'Laptop', qty: 1, line_total: 1000, unit_cost: 600 },
    { product_id: 'p1', item_code: '1001', description: 'Laptop', qty: 1, line_total: 1100, unit_cost: 700 }
  ]);

  assert.equal(result.salesRevenue, 2100);
  assert.equal(result.salesCost, 1300);
  assert.equal(result.salesProfit, 800);
  assert.equal(result.productPerformance[0].cost, 1300);
});

test('a later return reverses the original saved cost in its own report period', () => {
  const result = buildProfitMarginSummary([
    { product_id: 'p1', item_code: '1001', description: 'Laptop', qty: -1, line_total: -1000, unit_cost: 600 }
  ]);

  assert.equal(result.returnedSales, 1000);
  assert.equal(result.returnedCost, 600);
  assert.equal(result.salesProfit, -400);
});
