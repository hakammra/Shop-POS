import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPostingCosts, productIdsNeedingCostRefresh } from '../src/lib/saleCostSnapshots.js';

test('new sale lines use current average cost when the bill is posted', () => {
  const bill = [{ product_id: 'p1', qty: 2, unitCost: 600 }];
  assert.deepEqual(productIdsNeedingCostRefresh(bill), ['p1']);
  assert.equal(applyPostingCosts(bill, [{ id: 'p1', avg_cost: 700 }])[0].unitCost, 700);
  assert.equal(bill[0].unitCost, 600);
});

test('original invoice lines and returns retain their saved historical cost', () => {
  const bill = [
    { product_id: 'p1', qty: 1, unitCost: 600, originalSaleItemId: 'line-1' },
    { product_id: 'p1', qty: -1, unitCost: 500, isReturn: true, sourceDocumentItemId: 'line-0' }
  ];
  assert.deepEqual(productIdsNeedingCostRefresh(bill), []);
  assert.deepEqual(applyPostingCosts(bill, [{ id: 'p1', avg_cost: 900 }]), bill);
});

test('wholesale transfer cost remains authoritative while a new swap uses current cost', () => {
  const bill = [
    { product_id: 'wholesale', qty: 1, unitCost: 0, isWholesaleLinked: true },
    { product_id: 'swap', qty: -1, unitCost: 200, isReturn: true, isComponentCredit: true }
  ];
  assert.deepEqual(productIdsNeedingCostRefresh(bill), ['swap']);
  const posted = applyPostingCosts(bill, [{ id: 'swap', avg_cost: 250 }]);
  assert.equal(posted[0].unitCost, 0);
  assert.equal(posted[1].unitCost, 250);
});
