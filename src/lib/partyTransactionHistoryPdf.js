const DOCUMENT_LABELS = {
  invoice: 'Sales Invoice',
  unconfirmed_sale: 'Sales Invoice',
  refund: 'Refund',
  quotation: 'Quotation',
  purchase: 'Purchase',
  stock_in_transit: 'Stock in Transit',
  stock_adjustment: 'Stock Adjustment',
  trade_in: 'Trade-In',
  job: 'Job',
  customer_payment: 'Customer Payment',
  supplier_payment: 'Supplier Payment',
  expense: 'Expense',
  other_income: 'Other Income',
  account_transfer: 'Account Transfer',
  online_order: 'Online Order',
  cod_order: 'Delivery Order'
};

function numberValue(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function money(value, currency = 'LKR') {
  return `${currency} ${numberValue(value).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function safeFilename(value) {
  return String(value || 'customer').replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '') || 'customer';
}

async function imageUrlToDataUrl(url) {
  if (!url) return '';
  const response = await fetch(url);
  if (!response.ok) throw new Error('Could not load the company logo for the statement.');
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read the company logo for the statement.'));
    reader.readAsDataURL(blob);
  });
}

function profileType(party = {}) {
  const roles = [];
  if (party.is_customer !== false) roles.push('Customer');
  if (party.is_supplier === true) roles.push('Supplier');
  return roles.join(' / ') || 'Profile';
}

export async function createPartyTransactionHistoryPdf(party, transactions = [], companySettings = {}, options = {}) {
  if (!party) throw new Error('Select a customer or supplier first.');
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const currency = companySettings.currency || 'LKR';
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 12;
  const orderedRows = [...transactions].sort((a, b) => new Date(b.date || b.created_at) - new Date(a.date || a.created_at));
  const outstanding = numberValue(party.due_balance) - numberValue(party.store_credit_balance);
  const balanceLabel = outstanding > 0.005 ? 'They owe the shop' : outstanding < -0.005 ? 'Shop owes them' : 'Settled';
  const oldestDate = orderedRows.length ? orderedRows[orderedRows.length - 1].date || orderedRows[orderedRows.length - 1].created_at : null;
  const newestDate = orderedRows.length ? orderedRows[0].date || orderedRows[0].created_at : null;

  let logoData = '';
  if (options.logoUrl) {
    try { logoData = await imageUrlToDataUrl(options.logoUrl); } catch { logoData = ''; }
  }
  let companyX = margin;
  if (logoData) {
    const logoFormat = logoData.startsWith('data:image/png') ? 'PNG' : logoData.startsWith('data:image/webp') ? 'WEBP' : 'JPEG';
    pdf.addImage(logoData, logoFormat, margin, margin, 17, 17, undefined, 'FAST');
    companyX += 21;
  }
  pdf.setTextColor(23, 32, 42);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(14);
  pdf.text(String(companySettings.shop_name || 'Computer Shop'), companyX, margin + 5);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7.5);
  const companyLines = [
    companySettings.header_subtitle,
    companySettings.address,
    [companySettings.phone, companySettings.email].filter(Boolean).join(' | '),
    companySettings.registration_no ? `Reg: ${companySettings.registration_no}` : ''
  ].filter(Boolean);
  if (companyLines.length) pdf.text(pdf.splitTextToSize(companyLines.join('\n'), 92), companyX, margin + 9);

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(12);
  pdf.text('TRANSACTION HISTORY', pageWidth - margin, margin + 5, { align: 'right' });
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7.5);
  pdf.text(`${orderedRows.length} document${orderedRows.length === 1 ? '' : 's'}`, pageWidth - margin, margin + 10, { align: 'right' });
  pdf.setDrawColor(22, 136, 189);
  pdf.setLineWidth(.7);
  pdf.line(margin, margin + 22, pageWidth - margin, margin + 22);

  const profileY = margin + 27;
  pdf.setFillColor(245, 248, 250);
  pdf.setDrawColor(214, 221, 226);
  pdf.roundedRect(margin, profileY, pageWidth - margin * 2, 27, 1.5, 1.5, 'FD');
  pdf.setTextColor(23, 32, 42);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.text(String(party.name || 'Customer / Supplier'), margin + 4, profileY + 6);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7.4);
  const identity = [profileType(party), party.party_code ? `Code: ${party.party_code}` : ''].filter(Boolean).join(' | ');
  pdf.text(identity, margin + 4, profileY + 11);
  const contact = [party.phone, party.address].filter(Boolean).join(' | ') || 'No contact details saved';
  pdf.setTextColor(78, 91, 100);
  pdf.text(pdf.splitTextToSize(contact, 112), margin + 4, profileY + 16);
  const period = oldestDate && newestDate ? `${formatDate(oldestDate)} to ${formatDate(newestDate)}` : 'No transactions recorded';
  pdf.text(`Statement period: ${period}`, margin + 4, profileY + 23);

  const balanceX = pageWidth - margin - 57;
  pdf.setDrawColor(outstanding > 0.005 ? 205 : outstanding < -0.005 ? 47 : 138, outstanding > 0.005 ? 128 : outstanding < -0.005 ? 143 : 151, outstanding > 0.005 ? 35 : outstanding < -0.005 ? 78 : 158);
  pdf.setFillColor(outstanding > 0.005 ? 255 : outstanding < -0.005 ? 236 : 241, outstanding > 0.005 ? 247 : outstanding < -0.005 ? 249 : 244, outstanding > 0.005 ? 230 : outstanding < -0.005 ? 240 : 246);
  pdf.roundedRect(balanceX, profileY + 4, 53, 18, 1.3, 1.3, 'FD');
  pdf.setTextColor(78, 91, 100);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(6.2);
  pdf.text('CURRENT OUTSTANDING', balanceX + 3, profileY + 8);
  pdf.setTextColor(23, 32, 42);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9.3);
  pdf.text(`${outstanding < 0 ? '-' : ''}${money(Math.abs(outstanding), currency)}`, balanceX + 3, profileY + 13.5);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(6.2);
  pdf.text(balanceLabel, balanceX + 3, profileY + 17.5);

  const tableRows = orderedRows.map((row) => {
    const amount = Math.abs(numberValue(row.total_amount) || numberValue(row.paid_amount));
    return [
      formatDate(row.date || row.document_date || row.created_at),
      DOCUMENT_LABELS[row.document_type] || row.document_type || '-',
      row.document_no || '-',
      row.notes || '-',
      row.payment_methods?.name || '-',
      money(amount, currency),
      row.status || '-'
    ];
  });
  autoTable(pdf, {
    startY: profileY + 32,
    head: [['Date', 'Type', 'Document', 'Description', 'Payment', 'Amount', 'Status']],
    body: tableRows.length ? tableRows : [['-', '-', '-', 'No documents for this profile.', '-', '-', '-']],
    margin: { top: 14, left: margin, right: margin, bottom: 15 },
    showHead: 'everyPage',
    rowPageBreak: 'avoid',
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 7.1, cellPadding: 1.8, overflow: 'linebreak', textColor: [23, 32, 42], lineColor: [214, 221, 226], lineWidth: .14, valign: 'middle' },
    headStyles: { fillColor: [30, 43, 52], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 6.9 },
    alternateRowStyles: { fillColor: [248, 250, 251] },
    columnStyles: {
      0: { cellWidth: 21 },
      1: { cellWidth: 28 },
      2: { cellWidth: 25 },
      3: { cellWidth: 'auto' },
      4: { cellWidth: 24 },
      5: { cellWidth: 29, halign: 'right', fontStyle: 'bold' },
      6: { cellWidth: 19 }
    }
  });

  const pageCount = pdf.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    pdf.setPage(page);
    pdf.setDrawColor(214, 221, 226);
    pdf.setLineWidth(.15);
    pdf.line(margin, pageHeight - 10, pageWidth - margin, pageHeight - 10);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(6.5);
    pdf.setTextColor(100, 112, 120);
    pdf.text(`Generated ${new Date().toLocaleString('en-LK')}`, margin, pageHeight - 6);
    pdf.text(`${companySettings.shop_name || 'Computer Shop'} - Page ${page} of ${pageCount}`, pageWidth - margin, pageHeight - 6, { align: 'right' });
  }

  if (options.output === 'arraybuffer') return pdf.output('arraybuffer');
  if (options.output === 'blob') return pdf.output('blob');
  pdf.save(`${safeFilename(party.party_code || party.name)}-transaction-history.pdf`);
  return null;
}
