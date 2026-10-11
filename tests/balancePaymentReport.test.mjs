import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBalancePaymentRows } from '../src/lib/balancePaymentReport.js';

const documents = [
  { id: 'sale', document_type: 'invoice', customer_id: 'party-1', document_date: '2026-10-01', document_no: 'S-1' },
  { id: 'customer-in', document_type: 'customer_payment', customer_id: 'party-1', document_date: '2026-10-03', document_no: 'C-1' },
  { id: 'customer-out', document_type: 'customer_payment', customer_id: 'party-1', document_date: '2026-10-04', document_no: 'C-2' },
  { id: 'supplier-out', document_type: 'supplier_payment', customer_id: 'party-2', document_date: '2026-10-05', document_no: 'P-1' },
  { id: 'cancelled', document_type: 'supplier_payment', customer_id: 'party-2', document_date: '2026-10-06', document_no: 'P-2', status: 'cancelled' }
];
const flow = (id, documentId, entryType, amount, methodId = 'bank') => ({ id, document_id: documentId, entry_type: entryType, amount, payment_method_id: methodId, payment_methods: { name: 'Bank' } });
const flows = [
  flow('direct-sale', 'sale', 'cash_in', 500),
  flow('receipt', 'customer-in', 'cash_in', 1000),
  flow('customer-credit', 'customer-out', 'cash_out', 300),
  flow('supplier-payment', 'supplier-out', 'cash_out', 700),
  flow('cancelled-payment', 'cancelled', 'cash_out', 200),
  flow('non-cash', 'supplier-out', 'non_cash', 900)
];
const report = (side, options = {}) => buildBalancePaymentRows({ documents, flows, side, partyName: (doc) => doc.customer_id, ...options });

test('sales balance report includes later customer receipts, not original invoice collections', () => {
  assert.deepEqual(report('sales').map((row) => [row.id, row.kind, row.amount]), [['receipt', 'Customer balance received', 1000]]);
});

test('purchase balance report includes supplier payments and customer-credit payouts once each', () => {
  assert.deepEqual(report('purchase').map((row) => [row.id, row.kind, row.amount]), [
    ['supplier-payment', 'Supplier balance paid', 700],
    ['customer-credit', 'Customer credit paid', 300]
  ]);
});

test('party and payment-method filters apply to settlement documents', () => {
  assert.deepEqual(report('purchase', { partyId: 'party-1' }).map((row) => row.id), ['customer-credit']);
  assert.deepEqual(report('purchase', { paymentMethodId: 'cash' }), []);
});
