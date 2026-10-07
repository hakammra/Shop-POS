import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';

const INK = [28, 40, 49];
const ACCENT = [30, 151, 197];
const MUTED = [92, 105, 114];

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function createReportPdf({ title, company, period, filters = [], totals = [], columns = [], rows = [], footer = [], generatedAt = new Date() }) {
  const landscape = columns.length > 6;
  const pdf = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
  const width = pdf.internal.pageSize.getWidth();
  const height = pdf.internal.pageSize.getHeight();
  const left = 14;
  const right = 14;
  const contentWidth = width - left - right;
  const generatedLabel = `Generated ${generatedAt.toLocaleString('en-LK')}`;

  const drawPageChrome = () => {
    pdf.setFillColor(...INK);
    pdf.rect(0, 0, width, 12, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8.5);
    pdf.text(clean(company || 'Shop POS'), left, 7.9, { maxWidth: contentWidth * 0.55 });
    pdf.setFont('helvetica', 'normal');
    pdf.text('REPORT', width - right, 7.9, { align: 'right' });
    pdf.setDrawColor(205, 214, 219);
    pdf.line(left, height - 12, width - right, height - 12);
    pdf.setTextColor(...MUTED);
    pdf.setFontSize(8);
    pdf.text(generatedLabel, left, height - 7.5);
  };

  pdf.setTextColor(...INK);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(18);
  const heading = pdf.splitTextToSize(clean(title), contentWidth);
  pdf.text(heading, left, 22);
  let y = 22 + heading.length * 7;

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(...MUTED);
  pdf.text(`Period: ${clean(period)}`, left, y);
  y += 5;
  for (const [label, value] of filters.filter(([, value]) => clean(value) && clean(value) !== 'All')) {
    pdf.text(`${clean(label)}: ${clean(value)}`, left, y, { maxWidth: contentWidth });
    y += 5;
  }

  if (totals.length) {
    y += 2;
    const maxPerRow = landscape ? 4 : 3;
    const gap = 3;
    const cardWidth = (contentWidth - gap * (maxPerRow - 1)) / maxPerRow;
    totals.forEach(([label, value], index) => {
      const column = index % maxPerRow;
      if (index > 0 && column === 0) y += 17;
      const x = left + column * (cardWidth + gap);
      pdf.setFillColor(241, 246, 248);
      pdf.setDrawColor(210, 222, 227);
      pdf.roundedRect(x, y, cardWidth, 14, 1, 1, 'FD');
      pdf.setTextColor(...MUTED);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(7.5);
      pdf.text(clean(label), x + 2.5, y + 4.5, { maxWidth: cardWidth - 5 });
      pdf.setTextColor(...INK);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(10);
      pdf.text(clean(value), x + 2.5, y + 10.8, { maxWidth: cardWidth - 5 });
    });
    y += 18;
  } else {
    y += 4;
  }

  const head = [columns.map((column) => clean(column.label))];
  const body = rows.length ? rows.map((row) => row.map(clean)) : [[`No records found for this report.`, ...columns.slice(1).map(() => '')]];
  const foot = footer.length ? [footer.map(clean)] : undefined;
  autoTable(pdf, {
    head,
    body,
    ...(foot ? { foot } : {}),
    showFoot: 'lastPage',
    startY: y,
    margin: { top: 20, right, bottom: 17, left },
    theme: 'grid',
    styles: {
      font: 'helvetica',
      fontSize: landscape ? 8.1 : 8.7,
      cellPadding: 2.1,
      lineWidth: 0.12,
      lineColor: [215, 224, 228],
      textColor: INK,
      overflow: 'linebreak',
      valign: 'middle'
    },
    headStyles: { fillColor: INK, textColor: [255, 255, 255], fontStyle: 'bold', lineColor: INK },
    footStyles: { fillColor: [229, 239, 243], textColor: INK, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 251] },
    columnStyles: columns.reduce((styles, column, index) => {
      if (column.numeric) styles[index] = { halign: 'right' };
      return styles;
    }, {}),
    horizontalPageBreak: columns.length > 8,
    horizontalPageBreakRepeat: columns.length > 8 ? 0 : undefined,
    horizontalPageBreakBehaviour: 'afterAllRows'
  });

  const pages = pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    pdf.setPage(page);
    drawPageChrome();
    if (page > 1) {
      pdf.setTextColor(...INK);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(8);
      pdf.text(clean(title), left, 16, { maxWidth: contentWidth });
    }
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(...MUTED);
    pdf.text(`Page ${page} of ${pages}`, width - right, height - 7.5, { align: 'right' });
  }
  return pdf;
}
