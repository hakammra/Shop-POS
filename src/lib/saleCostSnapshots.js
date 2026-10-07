function needsCurrentCost(item) {
  return Boolean(item.product_id)
    && !item.originalSaleItemId
    && !item.isWholesaleLinked
    && (Number(item.qty || 0) > 0 || item.isComponentCredit === true);
}

export function productIdsNeedingCostRefresh(items) {
  return [...new Set(items.filter(needsCurrentCost).map((item) => item.product_id))];
}

export function applyPostingCosts(items, productRows) {
  const currentCostById = new Map(productRows.map((row) => [row.id, Number(row.avg_cost || 0)]));
  return items.map((item) => needsCurrentCost(item)
    ? { ...item, unitCost: currentCostById.get(item.product_id) }
    : item);
}
