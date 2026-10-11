function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

// Balance settlements have their own payment documents. They belong to the
// settlement date, not the date of the original sale or purchase.
export function buildBalancePaymentRows({ documents, flows, side, partyName, partyId = '', paymentMethodId = '' }) {
  const paymentDocuments = new Map(documents
    .filter((document) => ['customer_payment', 'supplier_payment'].includes(document.document_type)
      && !['cancelled', 'void', 'voided'].includes(String(document.status || '').toLowerCase())
      && (!partyId || document.customer_id === partyId))
    .map((document) => [document.id, document]));

  return flows.flatMap((flow) => {
    const document = paymentDocuments.get(flow.document_id);
    if (!document || (paymentMethodId && flow.payment_method_id !== paymentMethodId)) return [];
    if (side === 'sales' && (document.document_type !== 'customer_payment' || flow.entry_type !== 'cash_in')) return [];
    if (side === 'purchase' && flow.entry_type !== 'cash_out') return [];
    if (!['sales', 'purchase'].includes(side) || roundMoney(flow.amount) <= 0) return [];

    return [{
      id: flow.id,
      document_date: document.document_date,
      document_no: document.document_no,
      party: partyName(document),
      kind: document.document_type === 'supplier_payment' ? 'Supplier balance paid' : flow.entry_type === 'cash_out' ? 'Customer credit paid' : 'Customer balance received',
      method: flow.payment_methods?.name || flow.account_name || 'Unknown',
      amount: roundMoney(flow.amount)
    }];
  }).sort((a, b) => String(b.document_date || '').localeCompare(String(a.document_date || '')) || String(b.document_no || '').localeCompare(String(a.document_no || '')));
}
