import test from 'node:test';
import assert from 'node:assert/strict';
import { BALANCE_APPLIED_KEY, UNPAID_BALANCE_KEY, buildPaymentAllocationRows } from '../src/lib/reportPaymentAllocation.js';

const customer = { id: 'sale-1', customer_id: 'customer-1', total_amount: 5000, paid_amount: 5000 };
const saleOptions = (document, flows, paymentMethodId = '') => ({
  documents: [document], flows, partyKey: (row) => row.customer_id, partyName: () => 'Customer', paymentMethodId
});
const cash = (documentId, amount, entryType = 'cash_in') => ({
  document_id: documentId, payment_method_id: 'cash', payment_methods: { name: 'Cash' }, amount, entry_type: entryType
});

test('existing customer credit is a non-cash allocation, not a sales discount', () => {
  const { rows } = buildPaymentAllocationRows(saleOptions(customer, [cash(customer.id, 4000)]));
  assert.equal(rows[0].amounts.cash, 4000);
  assert.equal(rows[0].amounts[BALANCE_APPLIED_KEY], 1000);
  assert.equal(rows[0].amounts[UNPAID_BALANCE_KEY], 0);
  assert.equal(rows[0].total, 5000);
});

test('an unrecorded unpaid remainder is not classified as cash or store credit', () => {
  const { rows } = buildPaymentAllocationRows(saleOptions({ ...customer, paid_amount: 4000 }, [cash(customer.id, 4000)]));
  assert.equal(rows[0].amounts[BALANCE_APPLIED_KEY], 0);
  assert.equal(rows[0].amounts[UNPAID_BALANCE_KEY], 1000);
  assert.equal(rows[0].total, 5000);
});

test('an explicit Credit payment line is not counted again as unpaid', () => {
  const flows = [cash(customer.id, 4000), { document_id: customer.id, payment_method_id: 'credit', payment_methods: { name: 'Credit' }, amount: 1000, entry_type: 'non_cash' }];
  const { rows } = buildPaymentAllocationRows(saleOptions({ ...customer, paid_amount: 4000 }, flows));
  assert.equal(rows[0].amounts.credit, 1000);
  assert.equal(rows[0].amounts[UNPAID_BALANCE_KEY], 0);
  assert.equal(rows[0].total, 5000);
});

test('a customer refund is negative in the sales allocation', () => {
  const refund = { id: 'refund-1', customer_id: 'customer-1', total_amount: -500, paid_amount: 500 };
  const { rows } = buildPaymentAllocationRows(saleOptions(refund, [cash(refund.id, 500, 'cash_out')]));
  assert.equal(rows[0].amounts.cash, -500);
  assert.equal(rows[0].total, -500);
});

test('purchase payment types include cash paid and supplier credit without changing inventory', () => {
  const purchase = { id: 'purchase-1', supplier_id: 'supplier-1', total_amount: 3000, paid_amount: 1000 };
  const flows = [cash(purchase.id, 1000, 'cash_out'), { document_id: purchase.id, payment_method_id: 'credit', payment_methods: { name: 'Credit' }, amount: 2000, entry_type: 'non_cash' }];
  const { rows } = buildPaymentAllocationRows({ documents: [purchase], flows, documentType: 'purchase', partyKey: (row) => row.supplier_id, partyName: () => 'Supplier' });
  assert.equal(rows[0].amounts.cash, 1000);
  assert.equal(rows[0].amounts.credit, 2000);
  assert.equal(rows[0].total, 3000);
});

test('a supplier refund reduces net purchase payments', () => {
  const purchaseReturn = { id: 'purchase-return-1', supplier_id: 'supplier-1', total_amount: -500, paid_amount: 500 };
  const { rows } = buildPaymentAllocationRows({
    documents: [purchaseReturn], flows: [cash(purchaseReturn.id, 500, 'cash_in')], documentType: 'purchase',
    partyKey: (row) => row.supplier_id, partyName: () => 'Supplier'
  });
  assert.equal(rows[0].amounts.cash, -500);
  assert.equal(rows[0].total, -500);
});

test('filtering one payment method does not fabricate balance allocation', () => {
  const { rows } = buildPaymentAllocationRows(saleOptions(customer, [cash(customer.id, 4000)], 'cash'));
  assert.equal(rows[0].total, 4000);
  assert.equal(rows[0].amounts[BALANCE_APPLIED_KEY], undefined);
});
