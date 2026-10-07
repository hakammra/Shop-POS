function amount(value) {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(String(value).replace(/,/g, '').replace(/LKR/gi, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

// A sale line's unit_cost is the saved cost snapshot. Never recalculate an
// earlier sale from the product's current average cost after later purchases.
export function buildProfitMarginSummary(saleItems) {
  const products = new Map();
  let salesRevenue = 0;
  let salesCost = 0;
  let returnedSales = 0;
  let returnedCost = 0;

  for (const item of saleItems) {
    const qty = amount(item.qty);
    const lineTotal = amount(item.line_total);
    const savedUnitCost = amount(item.unit_cost);
    const lineCost = qty * savedUnitCost;
    salesRevenue += lineTotal;
    salesCost += lineCost;

    if (qty < 0 || lineTotal < 0) {
      returnedSales += Math.abs(lineTotal);
      returnedCost += Math.abs(qty) * savedUnitCost;
    }

    const key = item.product_id || `${item.item_code}|${item.description}`;
    const product = products.get(key) || {
      id: key,
      item_code: item.item_code || '-',
      description: item.description || '-',
      qty: 0,
      sales: 0,
      cost: 0
    };
    product.qty += qty;
    product.sales += lineTotal;
    product.cost += lineCost;
    products.set(key, product);
  }

  return {
    salesRevenue,
    salesCost,
    salesProfit: salesRevenue - salesCost,
    returnedSales,
    returnedCost,
    returnedProfitImpact: returnedSales - returnedCost,
    productPerformance: [...products.values()].sort((a, b) => b.sales - a.sales)
  };
}
