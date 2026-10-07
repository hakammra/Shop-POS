export const BALANCE_APPLIED_KEY = 'balance-applied';
export const UNPAID_BALANCE_KEY = 'unpaid-balance';

function amount(value) {
  return Number(value || 0);
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function signedPaymentAmount(flow, documentType, documentTotal) {
  const value = amount(flow.amount);
  if (flow.entry_type === 'non_cash') return documentTotal < 0 ? -value : value;
  if (documentType === 'purchase') return flow.entry_type === 'cash_in' ? -value : value;
  return flow.entry_type === 'cash_out' ? -value : value;
}

// Allocate a document's value among its recorded payment methods, any earlier
// party balance consumed by it, and the balance still unpaid. The latter two
// are not cash movements and must never be added to the cashflow ledger.
export function buildPaymentAllocationRows({
  documents,
  flows,
  documentType = 'sales',
  partyKey,
  partyName,
  paymentMethodId = ''
}) {
  const byDocument = new Map();
  for (const flow of flows) {
    const current = byDocument.get(flow.document_id) || [];
    current.push(flow);
    byDocument.set(flow.document_id, current);
  }

  const methods = new Map();
  const parties = new Map();
  for (const document of documents) {
    const key = partyKey(document);
    const documentFlows = (byDocument.get(document.id) || []).filter((flow) => !paymentMethodId || flow.payment_method_id === paymentMethodId);
    if (paymentMethodId && !documentFlows.length) continue;
    const current = parties.get(key) || { id: key, party: partyName(document), amounts: {}, total: 0, documentTotal: 0, documents: 0 };
    let recorded = 0;
    let paidTowardDocument = 0;
    const direction = amount(document.total_amount) < 0 ? -1 : 1;

    for (const flow of documentFlows) {
      const methodKey = flow.payment_method_id || `account:${flow.account_name || 'unknown'}`;
      if (!methods.has(methodKey)) methods.set(methodKey, { key: methodKey, name: flow.payment_methods?.name || flow.account_name || 'Unknown' });
      const signed = signedPaymentAmount(flow, documentType, amount(document.total_amount));
      current.amounts[methodKey] = round(amount(current.amounts[methodKey]) + signed);
      current.total = round(current.total + signed);
      recorded = round(recorded + signed);
      if (flow.entry_type !== 'non_cash' && signed * direction > 0) paidTowardDocument = round(paidTowardDocument + Math.abs(signed));
    }

    if (!paymentMethodId) {
      const gap = round(amount(document.total_amount) - recorded);
      const possibleApplied = Math.max(amount(document.paid_amount) - paidTowardDocument, 0);
      const balanceApplied = gap * direction > 0 ? direction * Math.min(Math.abs(gap), possibleApplied) : 0;
      const unpaid = round(gap - balanceApplied);
      current.amounts[BALANCE_APPLIED_KEY] = round(amount(current.amounts[BALANCE_APPLIED_KEY]) + balanceApplied);
      current.amounts[UNPAID_BALANCE_KEY] = round(amount(current.amounts[UNPAID_BALANCE_KEY]) + unpaid);
      current.total = round(current.total + balanceApplied + unpaid);
    }

    current.documentTotal = round(current.documentTotal + amount(document.total_amount));
    current.documents += 1;
    parties.set(key, current);
  }

  return {
    methods: [...methods.values()].sort((a, b) => a.name.localeCompare(b.name)),
    rows: [...parties.values()].sort((a, b) => a.party.localeCompare(b.party))
  };
}
