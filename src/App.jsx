import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './lib/supabaseClient';
import * as XLSX from 'xlsx';

const NAV_ITEMS = [
  { key: 'pos', label: 'POS', icon: '▦' },
  { key: 'dashboard', label: 'Dashboard', icon: '▤' },
  { key: 'documents', label: 'Documents', icon: '▰' },
  { key: 'products', label: 'Products', icon: '◇' },
  { key: 'stock', label: 'Stock', icon: '▣' },
  { key: 'reports', label: 'Reporting', icon: '▥' },
  { key: 'cashflow', label: 'Cashflow', icon: '↕' },
  { key: 'customers_suppliers', label: 'Customers & Suppliers', icon: '♟' },
  { key: 'online_orders', label: 'Online Orders', icon: '◉' },
  { key: 'payment_types', label: 'Payment Types', icon: '▭' },
  { key: 'users_security', label: 'Users & Security', icon: '⚿' },
  { key: 'my_company', label: 'My Company', icon: '▦' }
];

const DOCUMENT_TYPES = [
  { value: '', label: 'All document types' },
  { value: 'invoice', label: 'Sales Invoice' },
  { value: 'refund', label: 'Refund / Return' },
  { value: 'quotation', label: 'Quotation' },
  { value: 'purchase', label: 'Purchase' },
  { value: 'stock_in_transit', label: 'Stock in Transit' },
  { value: 'stock_adjustment', label: 'Stock Adjustment' },
  { value: 'trade_in', label: 'Trade-In / Buyback' },
  { value: 'job', label: 'Job / Repair' },
  { value: 'customer_payment', label: 'Customer Payment' },
  { value: 'supplier_payment', label: 'Supplier Payment' },
  { value: 'expense', label: 'Expense' },
  { value: 'online_order', label: 'Online Order' }
];

const PAYMENT_OPTIONS = ['Cash', 'Card', 'Bank', 'Credit'];

const STOCK_FILTERS = [
  { value: 'all', label: 'All', description: 'All stock items' },
  { value: 'in_stock', label: 'In Stock', description: 'Qty greater than zero' },
  { value: 'zero', label: 'Zero Qty', description: 'Qty is exactly zero' },
  { value: 'negative', label: 'Negative Qty', description: 'Qty is below zero' },
  { value: 'low', label: 'Low Stock', description: 'Qty is above zero and at or below low-stock level' },
  { value: 'in_transit', label: 'In Transit', description: 'Incoming stock not yet added to inventory' },
  { value: 'reserved', label: 'Reserved', description: 'Stock reserved for customer/online order' },
  { value: 'damaged', label: 'Warranty / Damaged', description: 'Non-sellable returned or damaged stock' },
  { value: 'unavailable', label: 'Unavailable', description: 'Available stock is zero or below' },
  { value: 'inactive', label: 'Inactive', description: 'Inactive products' }
];

const DOCUMENT_DRAFT_TABS_KEY = 'computer_shop_document_draft_tabs_v18';
const POS_DRAFTS_KEY = 'computer_shop_pos_bill_drafts_v16';
const QUOTE_TO_POS_KEY = 'computer_shop_quote_to_pos_invoice_v23';

const emptyBill = (name = 'Bill 1') => ({
  id: crypto.randomUUID(),
  name,
  documentNo: '',
  customerId: '',
  customerName: '',
  items: [],
  selectedItemId: '',
  cartDiscountType: 'amount',
  cartDiscountValue: 0,
  paymentMethodId: '',
  paymentMethodName: '',
  paymentIsPaid: true,
  paymentLines: [],
  paymentTargetMode: 'current',
  customPaymentAmount: '',
  customPaymentDirection: 'in',
  notes: '',
  sourceQuoteId: '',
  sourceQuoteNo: ''
});

function safeReadJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function documentDraftKey(tabId) {
  return `computer_shop_document_draft_${tabId}`;
}

function money(value) {
  return `LKR ${Number(value || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleDateString('en-LK');
}

function documentTypeLabel(value) {
  return DOCUMENT_TYPES.find((item) => item.value === value)?.label || value || '-';
}

export default function App() {
  const [session, setSession] = useState(null);
  const [activePage, setActivePage] = useState('pos');
  const [loadingSession, setLoadingSession] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoadingSession(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  const currentPage = NAV_ITEMS.find((item) => item.key === activePage) || NAV_ITEMS[0];

  if (loadingSession) return <FullScreenMessage title="Loading" message="Checking login session..." />;
  if (!session) return <AuthScreen />;

  return (
    <div className={sidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"}>
      <aside className={`${sidebarOpen ? 'sidebar open' : 'sidebar'} ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="brand-block">
          <div className="brand-logo">CS</div>
          <div>
            <h1>Computer Shop</h1>
            <p>LKR • No Tax</p>
          </div>
        </div>

        <nav className="nav-list">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              className={activePage === item.key ? 'nav-item active' : 'nav-item'}
              onClick={() => {
                setActivePage(item.key);
                setSidebarOpen(false);
              }}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <button className="mobile-menu always-show" title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>☰</button>
          <div>
            <h2>{currentPage.label}</h2>
            <p>{session.user.email}</p>
          </div>
          <button className="secondary-button" onClick={() => supabase.auth.signOut()}>
            Logout
          </button>
        </header>

        {activePage === 'pos' && <POSScreen />}
        {activePage === 'dashboard' && <Dashboard />}
        {activePage === 'documents' && <DocumentsPage onOpenPOS={() => setActivePage('pos')} />}
        {activePage === 'products' && <ProductsPage />}
        {activePage === 'stock' && <StockPage />}
        {activePage === 'reports' && <ReportsPage />}
        {activePage === 'cashflow' && <CashflowPage />}
        {activePage === 'customers_suppliers' && <CustomersSuppliersPage />}
        {activePage === 'online_orders' && <OnlineOrdersPage />}
        {activePage === 'payment_types' && <PaymentTypesPage />}
        {activePage === 'users_security' && <UsersSecurityPage />}
        {activePage === 'my_company' && <MyCompanyPage />}
      </main>
    </div>
  );
}

function AuthScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState('login');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');

    const result =
      mode === 'login'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });

    if (result.error) setMessage(result.error.message);
    else if (mode === 'signup') setMessage('Account created. Check email confirmation settings in Supabase if login does not happen immediately.');
    setBusy(false);
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={handleSubmit}>
        <h1>Computer Shop POS</h1>
        <p>Login to continue.</p>

        <label>Email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />

        <label>Password</label>
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required minLength={6} />

        {message && <div className="notice">{message}</div>}

        <button className="primary-button" disabled={busy}>
          {busy ? 'Please wait...' : mode === 'login' ? 'Login' : 'Sign up'}
        </button>

        <button type="button" className="link-button" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>
          {mode === 'login' ? 'Need a test account? Sign up' : 'Already have account? Login'}
        </button>
      </form>
    </div>
  );
}




function POSScreen() {
  const savedBills = safeReadJson(POS_DRAFTS_KEY, null);
  const initialBills = Array.isArray(savedBills?.bills) && savedBills.bills.length ? savedBills.bills : [emptyBill()];
  const [bills, setBills] = useState(initialBills);
  const [activeBillId, setActiveBillId] = useState(savedBills?.activeBillId || initialBills[0]?.id);
  const [search, setSearch] = useState('');
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [posCategoryId, setPosCategoryId] = useState(savedBills?.posCategoryId || 'root');
  const [customers, setCustomers] = useState([]);
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [showCustomerPanel, setShowCustomerPanel] = useState(false);
  const [showPaymentPanel, setShowPaymentPanel] = useState(false);
  const [paymentDraft, setPaymentDraft] = useState([]);
  const [paymentTargetMode, setPaymentTargetMode] = useState('current');
  const [customPaymentAmount, setCustomPaymentAmount] = useState('');
  const [customPaymentDirection, setCustomPaymentDirection] = useState('in');
  const [lineAmountInput, setLineAmountInput] = useState('');
  const [newCustomer, setNewCustomer] = useState({ name: '', phone: '', address: '' });
  const posGridRef = useRef(null);
  const [posLeftPercent, setPosLeftPercent] = useState(() => Number(window.localStorage.getItem('computer_shop_pos_split_left_percent') || 52));
  const [isResizingPos, setIsResizingPos] = useState(false);

  const activeBill = bills.find((bill) => bill.id === activeBillId) || bills[0] || emptyBill();
  const visiblePaymentMethods = paymentMethods.filter((method) => !method.name.toLowerCase().includes('store credit'));
  const selectedCustomer = customers.find((row) => row.id === activeBill.customerId);
  const currentOutstanding = selectedCustomer ? numberValue(selectedCustomer.due_balance) - numberValue(selectedCustomer.store_credit_balance) : 0;
  const paymentLines = Array.isArray(activeBill.paymentLines) ? activeBill.paymentLines : [];

  const subtotal = useMemo(() => activeBill.items.reduce((sum, item) => sum + Number(item.lineTotal || 0), 0), [activeBill.items]);
  const cartDiscount = activeBill.cartDiscountType === 'percent'
    ? subtotal * (Number(activeBill.cartDiscountValue || 0) / 100)
    : Number(activeBill.cartDiscountValue || 0);
  const total = subtotal < 0 ? subtotal + Math.abs(cartDiscount) : subtotal - cartDiscount;
  const outstandingAfterBill = currentOutstanding + total;
  const balanceUsedForCurrentBill = total > 0 && currentOutstanding < 0
    ? Math.min(Math.abs(currentOutstanding), Math.abs(total))
    : total < 0 && currentOutstanding > 0
      ? Math.min(currentOutstanding, Math.abs(total))
      : 0;
  const amountToSettleCurrentBill = Math.max(Math.abs(total) - balanceUsedForCurrentBill, 0);

  const cashInAmount = paymentLines
    .filter((line) => line.direction === 'in' && line.isPaidMethod !== false)
    .reduce((sum, line) => sum + Number(line.amount || 0), 0);
  const refundOutAmount = paymentLines
    .filter((line) => line.direction === 'out' && line.isPaidMethod !== false)
    .reduce((sum, line) => sum + Number(line.amount || 0), 0);
  const projectedOutstanding = currentOutstanding + total - cashInAmount + refundOutAmount;
  const creditLinesAmount = paymentLines
    .filter((line) => line.isPaidMethod === false)
    .reduce((sum, line) => sum + Number(line.amount || 0), 0);

  const categoryChildren = useMemo(() => {
    return categories
      .filter((cat) => (posCategoryId === 'root' ? !cat.parent_id : cat.parent_id === posCategoryId))
      .sort((a, b) => categoryDisplayName(a).localeCompare(categoryDisplayName(b)));
  }, [categories, posCategoryId]);

  const currentCategory = categories.find((cat) => cat.id === posCategoryId);
  const breadcrumb = useMemo(() => {
    if (posCategoryId === 'root') return [{ id: 'root', name: 'Products' }];
    const names = (currentCategory?.path || currentCategory?.name || '').split('/').filter(Boolean);
    const crumbs = [{ id: 'root', name: 'Products' }];
    let current = '';
    names.forEach((name) => {
      current = current ? `${current}/${name}` : name;
      const found = categories.find((cat) => cat.path === current);
      if (found) crumbs.push({ id: found.id, name: found.name });
    });
    return crumbs;
  }, [posCategoryId, currentCategory, categories]);

  useEffect(() => {
    loadCategories();
    loadCustomers();
    loadPaymentMethods();
  }, []);

  useEffect(() => {
    const rawQuote = window.localStorage.getItem(QUOTE_TO_POS_KEY);
    if (!rawQuote) return;
    try {
      const quote = JSON.parse(rawQuote);
      window.localStorage.removeItem(QUOTE_TO_POS_KEY);
      if (!quote?.items?.length) return;
      const quoteBill = {
        ...emptyBill(quote.quoteNo ? `From ${quote.quoteNo}` : `Quote to invoice`),
        customerId: quote.customerId || '',
        customerName: quote.customerName || '',
        items: quote.items.map((item) => recalcItem({
          id: crypto.randomUUID(),
          product_id: item.product_id,
          item_code: item.item_code,
          name: item.description || item.name || item.item_code || 'Quote item',
          qty: Number(item.qty || 0),
          unitPrice: Number(item.unit_price || item.unitPrice || 0),
          unitCost: Number(item.unit_cost || item.unitCost || 0),
          discountType: item.discount_type || item.discountType || 'none',
          discountValue: Number(item.discount_value || item.discountValue || 0),
          isReturn: Number(item.qty || 0) < 0,
          returnCondition: item.return_condition || 'sellable',
          lineTotal: Number(item.line_total || 0)
        })),
        selectedItemId: '',
        notes: quote.notes || `Converted from quotation ${quote.quoteNo || ''}`.trim(),
        sourceQuoteId: quote.quoteId || '',
        sourceQuoteNo: quote.quoteNo || ''
      };
      quoteBill.selectedItemId = quoteBill.items[0]?.id || '';
      setBills((current) => [...current, quoteBill]);
      setActiveBillId(quoteBill.id);
      setMessage(`Loaded quotation ${quote.quoteNo || ''} into POS. Select payment and save as invoice.`);
    } catch {
      window.localStorage.removeItem(QUOTE_TO_POS_KEY);
    }
  }, []);

  useEffect(() => {
    const timeout = setTimeout(() => loadProducts(), 120);
    return () => clearTimeout(timeout);
  }, [search, posCategoryId, categories.length]);

  useEffect(() => {
    window.localStorage.setItem(POS_DRAFTS_KEY, JSON.stringify({ bills, activeBillId, posCategoryId }));
  }, [bills, activeBillId, posCategoryId]);

  useEffect(() => {
    if (!isResizingPos) return undefined;

    function handleMouseMove(event) {
      const rect = posGridRef.current?.getBoundingClientRect();
      if (!rect?.width) return;
      const nextPercent = ((event.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.min(68, Math.max(36, nextPercent));
      setPosLeftPercent(clamped);
      window.localStorage.setItem('computer_shop_pos_split_left_percent', String(clamped));
    }

    function stopResize() {
      setIsResizingPos(false);
    }

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', stopResize);
    document.body.classList.add('pos-resizing');

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', stopResize);
      document.body.classList.remove('pos-resizing');
    };
  }, [isResizingPos]);

  useEffect(() => {
    if (!activeBill?.id || activeBill.documentNo) return;
    prepareInvoiceNumber(activeBill.id);
  }, [activeBill?.id]);

  async function prepareInvoiceNumber(billId) {
    const { data, error } = await supabase.rpc('next_document_no', { p_document_type: 'invoice' });
    if (error) {
      setMessage(error.message);
      return;
    }
    if (data) {
      setBills((current) => current.map((bill) => (bill.id === billId && !bill.documentNo ? { ...bill, documentNo: data, name: data } : bill)));
    }
  }

  async function loadCategories() {
    const { data, error } = await supabase.from('categories').select('id, name, parent_id, path').order('path', { ascending: true });
    if (error) setMessage(error.message);
    else setCategories(data || []);
  }

  async function loadProducts() {
    const clean = search.trim().replace(/,/g, ' ');
    if (!clean && posCategoryId === 'root') {
      setProducts([]);
      return;
    }

    let query = supabase
      .from('product_stock_view')
      .select('*')
      .eq('is_active', true)
      .order('item_code', { ascending: true })
      .limit(1200);

    if (clean) {
      query = query.or(`item_code.ilike.%${clean}%,name.ilike.%${clean}%,barcode.ilike.%${clean}%`);
    } else if (posCategoryId === 'uncategorized') {
      query = query.is('category_id', null);
    } else {
      query = query.eq('category_id', posCategoryId);
    }

    const { data, error } = await query;
    if (error) setMessage(error.message);
    else setProducts(data || []);
  }

  async function loadCustomers() {
    const { data, error } = await supabase.from('customers').select('id, name, phone, address, store_credit_balance, due_balance').order('name').limit(500);
    if (error) setMessage(error.message);
    else setCustomers(data || []);
  }

  async function loadPaymentMethods() {
    const { data, error } = await supabase
      .from('payment_methods')
      .select('id, name, affects_cashflow, is_active, is_paid_method')
      .eq('is_active', true)
      .order('name');
    if (error) {
      setMessage(error.message);
      return;
    }
    setPaymentMethods((data || []).filter((method) => !method.name.toLowerCase().includes('store credit')));
  }

  function addBill() {
    const bill = emptyBill(`Bill ${bills.length + 1}`);
    setBills((current) => [...current, bill]);
    setActiveBillId(bill.id);
  }

  function updateBillById(billId, patch) {
    setBills((current) => current.map((bill) => (bill.id === billId ? { ...bill, ...patch } : bill)));
  }

  function updateActiveBill(patch) {
    updateBillById(activeBill.id, patch);
  }

  function addProduct(product) {
    const qty = 1;
    const unitPrice = Number(product.selling_price || 0);
    const item = recalcItem({
      id: crypto.randomUUID(),
      product_id: product.product_id,
      item_code: product.item_code,
      name: product.name,
      qty,
      unitPrice,
      unitCost: Number(product.avg_cost || 0),
      discountType: 'amount',
      discountValue: 0,
      isReturn: false,
      returnCondition: 'sellable',
      lineTotal: unitPrice * qty
    });
    updateActiveBill({ items: [...activeBill.items, item], selectedItemId: item.id });
  }

  function recalcItem(item) {
    const gross = Number(item.qty || 0) * Number(item.unitPrice || 0);
    const discount = item.discountType === 'percent'
      ? Math.abs(gross) * (Number(item.discountValue || 0) / 100)
      : Number(item.discountValue || 0);
    return { ...item, lineTotal: gross < 0 ? gross + discount : gross - discount };
  }

  function updateItem(itemId, patch) {
    const items = activeBill.items.map((item) => item.id === itemId ? recalcItem({ ...item, ...patch }) : item);
    updateActiveBill({ items });
  }

  function markReturn(itemId = activeBill.selectedItemId) {
    if (!itemId) {
      setMessage('Select an item first.');
      return;
    }
    const items = activeBill.items.map((item) => {
      if (item.id !== itemId) return item;
      const nextQty = -Math.abs(Number(item.qty || 1));
      return recalcItem({ ...item, qty: nextQty, isReturn: true, returnCondition: item.returnCondition || 'sellable' });
    });
    updateActiveBill({ items });
  }

  function removeItem(itemId = activeBill.selectedItemId) {
    updateActiveBill({ items: activeBill.items.filter((item) => item.id !== itemId), selectedItemId: '' });
  }

  function closeBill() {
    if (bills.length === 1) {
      const fresh = emptyBill('Bill 1');
      setBills([fresh]);
      setActiveBillId(fresh.id);
      return;
    }
    const remaining = bills.filter((bill) => bill.id !== activeBill.id);
    setBills(remaining);
    setActiveBillId(remaining[0].id);
  }

  function setCustomer(customerId) {
    const customer = customers.find((row) => row.id === customerId);
    updateActiveBill({ customerId, customerName: customer?.name || '' });
  }

  async function addCustomer(event) {
    event.preventDefault();
    setMessage('');
    const payload = {
      name: newCustomer.name.trim(),
      phone: newCustomer.phone.trim() || null,
      address: newCustomer.address.trim() || null
    };
    const { data, error } = await supabase.from('customers').insert(payload).select('id, name, phone, address, store_credit_balance, due_balance').single();
    if (error) {
      setMessage(error.message);
      return;
    }
    setCustomers((current) => [...current, data].sort((a, b) => a.name.localeCompare(b.name)));
    updateActiveBill({ customerId: data.id, customerName: data.name });
    setNewCustomer({ name: '', phone: '', address: '' });
    setShowCustomerPanel(false);
  }

  function currentBillTarget() {
    return {
      amount: amountToSettleCurrentBill,
      direction: total >= 0 ? 'in' : 'out',
      label: total >= 0 ? 'Current bill payment' : 'Current bill refund',
      balanceUsed: balanceUsedForCurrentBill
    };
  }

  function openPaymentPanel() {
    setPaymentDraft(Array.isArray(activeBill.paymentLines) ? activeBill.paymentLines : []);
    setLineAmountInput('');
    setShowPaymentPanel(true);
  }

  function paymentLineTotal(lines = paymentDraft) {
    return lines.reduce((sum, line) => sum + Number(line.amount || 0), 0);
  }

  function paymentNetForBalance(lines = paymentDraft) {
    const paidIn = lines.filter((line) => line.direction === 'in' && line.isPaidMethod !== false).reduce((sum, line) => sum + Number(line.amount || 0), 0);
    const refundOut = lines.filter((line) => line.direction === 'out' && line.isPaidMethod !== false).reduce((sum, line) => sum + Number(line.amount || 0), 0);
    return { paidIn, refundOut };
  }

  function paymentMethodByName(name) {
    const clean = name.toLowerCase();
    return visiblePaymentMethods.find((method) => method.name.toLowerCase() === clean)
      || visiblePaymentMethods.find((method) => method.name.toLowerCase().includes(clean));
  }

  function addPaymentLine(method, amountOverride = null) {
    const target = currentBillTarget();
    const currentTotal = paymentLineTotal();
    const remaining = Math.max(target.amount - currentTotal, 0);
    const amount = amountOverride !== null
      ? Number(amountOverride || 0)
      : Number(lineAmountInput || remaining || target.amount || 0);
    if (!method || amount <= 0) return;
    const line = {
      id: crypto.randomUUID(),
      paymentMethodId: method.id,
      paymentMethodName: method.name,
      amount,
      direction: target.direction,
      isPaidMethod: method.is_paid_method !== false,
      affectsCashflow: method.affects_cashflow !== false
    };
    setPaymentDraft((current) => [...current, line]);
    setLineAmountInput('');
  }

  function quickPayment(method) {
    const target = currentBillTarget();
    if (!method) return;
    if (target.amount <= 0) {
      updateActiveBill({ paymentLines: [] });
      setMessage('No cash/card/bank payment needed. Existing outstanding balance covers this bill.');
      return;
    }
    const line = {
      id: crypto.randomUUID(),
      paymentMethodId: method.id,
      paymentMethodName: method.name,
      amount: target.amount,
      direction: target.direction,
      isPaidMethod: method.is_paid_method !== false,
      affectsCashflow: method.affects_cashflow !== false
    };
    updateActiveBill({ paymentLines: [line] });
    setShowPaymentPanel(false);
    setMessage(`Payment set: ${method.name} ${money(target.amount)}.`);
  }

  function quickPayAndSave(methodName) {
    const method = paymentMethodByName(methodName);
    const target = currentBillTarget();
    if (!method) {
      setMessage(`${methodName} payment type is not active.`);
      return;
    }
    if (target.amount <= 0) {
      updateActiveBill({ paymentLines: [] });
      saveInvoice([]);
      return;
    }
    const line = {
      id: crypto.randomUUID(),
      paymentMethodId: method.id,
      paymentMethodName: method.name,
      amount: target.amount,
      direction: target.direction,
      isPaidMethod: method.is_paid_method !== false,
      affectsCashflow: method.affects_cashflow !== false
    };
    updateActiveBill({ paymentLines: [line] });
    saveInvoice([line]);
  }

  function savePaymentDraft() {
    updateActiveBill({ paymentLines: paymentDraft });
    setShowPaymentPanel(false);
  }

  async function saveCurrentBillAsQuotation() {
    setMessage('');
    if (!activeBill.items.length) {
      setMessage('Add at least one item before saving quotation.');
      return;
    }
    setSaving(true);
    try {
      const numberRes = await supabase.rpc('next_document_no', { p_document_type: 'quotation' });
      if (numberRes.error) throw numberRes.error;
      const quoteNo = numberRes.data;
      const { data: doc, error: docError } = await supabase
        .from('documents')
        .insert({
          document_no: quoteNo,
          document_type: 'quotation',
          status: 'draft',
          customer_id: activeBill.customerId || null,
          total_amount: total,
          paid_amount: 0,
          balance_amount: total,
          currency: 'LKR',
          document_date: new Date().toISOString(),
          notes: activeBill.notes || 'Created from POS quote shortcut'
        })
        .select('id, document_no')
        .single();
      if (docError) throw docError;
      const quoteItems = activeBill.items.map((item) => ({
        document_id: doc.id,
        product_id: item.product_id,
        item_code: item.item_code,
        description: item.name,
        qty: Number(item.qty || 0),
        unit_price: Number(item.unitPrice || 0),
        unit_cost: Number(item.unitCost || 0),
        discount_type: item.discountValue ? item.discountType : 'none',
        discount_value: Number(item.discountValue || 0),
        line_total: Number(item.lineTotal || 0)
      }));
      const { error: itemError } = await supabase.from('document_items').insert(quoteItems);
      if (itemError) throw itemError;
      setMessage(`Quotation saved: ${doc.document_no}.`);
      if (window.confirm('Quotation saved. Clear this POS bill now?')) closeBill();
    } catch (err) {
      setMessage(err.message || String(err));
    } finally {
      setSaving(false);
    }
  }

  async function saveInvoice(paymentLinesOverride = null) {
    const linesForSave = paymentLinesOverride || paymentLines;
    setMessage('');
    if (!activeBill.items.length) {
      setMessage('Add at least one item.');
      return;
    }
    if (!linesForSave.length && currentBillTarget().amount > 0.005) {
      openPaymentPanel();
      setMessage('Select payment details before saving.');
      return;
    }

    const paidIn = linesForSave.filter((line) => line.direction === 'in' && line.isPaidMethod !== false).reduce((sum, line) => sum + Number(line.amount || 0), 0);
    const refundOut = linesForSave.filter((line) => line.direction === 'out' && line.isPaidMethod !== false).reduce((sum, line) => sum + Number(line.amount || 0), 0);
    const creditUsed = linesForSave.some((line) => line.isPaidMethod === false);
    const resultingOutstanding = currentOutstanding + total - paidIn + refundOut;
    const requiresCustomer = total < 0 || creditUsed || Math.abs(resultingOutstanding) > 0.005 || Math.abs(currentOutstanding) > 0.005;
    if (requiresCustomer && !activeBill.customerId) {
      setMessage('Select a customer first. Outstanding balance, credit, overpayment, and negative bills must be saved under a customer name.');
      setShowCustomerPanel(true);
      return;
    }

    setSaving(true);
    const payload = {
      document_no: activeBill.documentNo,
      customer_id: activeBill.customerId || null,
      cart_discount_type: activeBill.cartDiscountType,
      cart_discount_value: Number(activeBill.cartDiscountValue || 0),
      notes: activeBill.notes || ''
    };
    const itemsPayload = activeBill.items.map((item) => ({
      product_id: item.product_id,
      item_code: item.item_code,
      description: item.name,
      qty: Number(item.qty || 0),
      unit_price: Number(item.unitPrice || 0),
      unit_cost: Number(item.unitCost || 0),
      discount_type: item.discountValue ? item.discountType : 'none',
      discount_value: Number(item.discountValue || 0),
      return_condition: item.isReturn ? item.returnCondition || 'sellable' : null
    }));
    const paymentPayload = linesForSave.map((line) => ({
      payment_method_id: line.paymentMethodId,
      payment_method_name: line.paymentMethodName,
      amount: Number(line.amount || 0),
      direction: line.direction || 'in'
    }));

    const { data, error } = await supabase.rpc('save_pos_invoice', {
      p_header: payload,
      p_items: itemsPayload,
      p_payments: paymentPayload
    });
    setSaving(false);
    if (error) {
      setMessage(error.message);
      return;
    }
    if (activeBill.sourceQuoteId && data?.id) {
      await supabase
        .from('documents')
        .update({ status: 'converted', linked_document_id: data.id, notes: `${activeBill.notes || ''}\nConverted to invoice ${data.document_no || activeBill.documentNo}`.trim() })
        .eq('id', activeBill.sourceQuoteId);
    }
    setMessage(`Invoice saved: ${data?.document_no || activeBill.documentNo}${activeBill.sourceQuoteNo ? ` from quotation ${activeBill.sourceQuoteNo}` : ''}.`);
    await loadCustomers();
    closeBill();
  }

  const customerBalanceText = selectedCustomer
    ? currentOutstanding === 0
      ? 'Outstanding balance: LKR 0.00'
      : `Outstanding balance: ${currentOutstanding < 0 ? '-' : ''}${money(Math.abs(currentOutstanding))}`
    : 'Walk-in customer';

  const projectedBalanceText = projectedOutstanding === 0
    ? 'Outstanding after payment: LKR 0.00'
    : `Outstanding after payment: ${projectedOutstanding < 0 ? '-' : ''}${money(Math.abs(projectedOutstanding))}`;

  const quickMethods = ['Cash', 'Bank', 'Credit'].map((name) => paymentMethodByName(name)).filter(Boolean);
  const currentTarget = currentBillTarget();
  const remainingCurrent = Math.max(currentTarget.amount - paymentLineTotal(), 0);
  const modalNet = paymentNetForBalance(paymentDraft);
  const modalProjectedOutstanding = currentOutstanding + total - modalNet.paidIn + modalNet.refundOut;

  return (
    <section className="page-section pos-page pos-page-v16">
      {message && <div className={message.toLowerCase().includes('saved') ? 'notice success' : 'error-box'}>{message}</div>}

      <div className="pos-action-grid pos-actions-v16">
        <button className="pos-action" onClick={() => document.querySelector('.pos-search-input')?.focus()}>⌕<span>Search</span></button>
        <button className="pos-action" onClick={() => setShowCustomerPanel(!showCustomerPanel)}>♙<span>Customer</span></button>
        <button className="pos-action" onClick={() => updateActiveBill({ cartDiscountType: activeBill.cartDiscountType === 'amount' ? 'percent' : 'amount' })}>%<span>Discount</span></button>
        <button className="pos-action" onClick={addBill}>＋<span>New sale</span></button>
        <button className="pos-action" onClick={() => markReturn()}>↩<span>Return</span></button>
        <button className="pos-action" onClick={saveCurrentBillAsQuotation}>Q<span>Quote</span></button>
        <button className="pos-action green" onClick={() => openPaymentPanel()}>F10<span>Payment</span></button>
        {quickMethods.map((method) => (
          <button key={method.id} className={method.is_paid_method === false ? 'pos-action credit' : 'pos-action pay-quick'} onClick={() => quickPayAndSave(method.name)}>
            {method.name === 'Cash' ? 'F12' : '✓'}<span>{method.name}</span>
          </button>
        ))}
        <button className="pos-action" onClick={() => saveInvoice()} disabled={saving}>✓<span>{saving ? 'Saving...' : 'Save'}</span></button>
      </div>

      <div className="pos-toolbar compact-toolbar">
        <div className="bill-tabs">
          {bills.map((bill) => (
            <button key={bill.id} className={bill.id === activeBill.id ? 'tab active' : 'tab'} onClick={() => setActiveBillId(bill.id)}>
              {bill.documentNo || bill.name}
            </button>
          ))}
          <button className="tab add-tab" onClick={addBill}>+ New Bill</button>
        </div>
        <button className="secondary-button" onClick={closeBill}>Close Bill</button>
      </div>

      <div className="pos-customer-strip pos-customer-strip-v16">
        <label>Invoice No.<input value={activeBill.documentNo || ''} onFocus={selectAllText} onChange={(e) => updateActiveBill({ documentNo: e.target.value })} /></label>
        <label>Customer
          <select value={activeBill.customerId || ''} onChange={(e) => setCustomer(e.target.value)}>
            <option value="">Walk-in customer</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>{customer.name}{customer.phone ? ` - ${customer.phone}` : ''}</option>
            ))}
          </select>
        </label>
        <div className="customer-balance-chip balance-chip-v16">
          <strong>{customerBalanceText}</strong>
          {selectedCustomer && <small>After bill before payment: {outstandingAfterBill < 0 ? '-' : ''}{money(Math.abs(outstandingAfterBill))}</small>}
          {paymentLines.length > 0 && <small>{projectedBalanceText}</small>}
        </div>
      </div>

      {showCustomerPanel && (
        <form className="quick-customer-card" onSubmit={addCustomer}>
          <strong>New customer</strong>
          <input placeholder="Name" value={newCustomer.name} onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })} required />
          <input placeholder="Phone" value={newCustomer.phone} onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })} />
          <input placeholder="Address" value={newCustomer.address} onChange={(e) => setNewCustomer({ ...newCustomer, address: e.target.value })} />
          <button className="primary-button">Add customer</button>
        </form>
      )}

      <div
        ref={posGridRef}
        className="pos-grid pos-grid-v16 resizable-pos-grid"
        style={{ '--pos-left': `${posLeftPercent}%`, '--pos-right': `${100 - posLeftPercent}%` }}
      >
        <div className="panel-card bill-panel left-bill-panel">
          <div className="pos-line-toolbar">
            <button className="secondary-button" onClick={() => removeItem()}>Delete</button>
            <button className="secondary-button" onClick={() => markReturn()}>Return selected</button>
          </div>

          <div className="pos-bill-area pos-bill-cards compact-bill-cards">
            {activeBill.items.map((item) => (
              <div
                key={item.id}
                className={`pos-bill-card compact ${item.isReturn ? 'return-row' : ''} ${activeBill.selectedItemId === item.id ? 'selected' : ''}`}
                onClick={() => updateActiveBill({ selectedItemId: item.id })}
              >
                <div className="bill-card-main">
                  <strong>{item.item_code}</strong>
                  <span>{item.name}</span>
                  <b>{money(item.lineTotal)}</b>
                </div>
                <div className="bill-card-controls compact-controls">
                  <label>Qty<input type="number" value={item.qty} onFocus={selectAllText} onChange={(e) => updateItem(item.id, { qty: Number(e.target.value) })} /></label>
                  <label>Price<input type="number" value={item.unitPrice} onFocus={selectAllText} onChange={(e) => updateItem(item.id, { unitPrice: Number(e.target.value) })} /></label>
                  <label>Disc.<input type="number" value={item.discountValue} onFocus={selectAllText} onChange={(e) => updateItem(item.id, { discountValue: Number(e.target.value) })} /></label>
                  <label>Type
                    <select value={item.discountType} onChange={(e) => updateItem(item.id, { discountType: e.target.value })}>
                      <option value="amount">Amount</option>
                      <option value="percent">%</option>
                    </select>
                  </label>
                  {item.isReturn && (
                    <label className="wide-control">Return stock
                      <select value={item.returnCondition} onChange={(e) => updateItem(item.id, { returnCondition: e.target.value })}>
                        <option value="sellable">Good / Sellable</option>
                        <option value="warranty_damaged">Warranty / Damaged</option>
                      </select>
                    </label>
                  )}
                </div>
              </div>
            ))}
            {activeBill.items.length === 0 && <div className="empty-pos-bill">No items</div>}
          </div>

          <div className="checkout-box aronium-total-box">
            <div className="discount-row">
              <select value={activeBill.cartDiscountType} onChange={(e) => updateActiveBill({ cartDiscountType: e.target.value })}>
                <option value="amount">Bill discount amount</option>
                <option value="percent">Bill discount %</option>
              </select>
              <input type="number" value={activeBill.cartDiscountValue} onFocus={selectAllText} onChange={(e) => updateActiveBill({ cartDiscountValue: Number(e.target.value) })} />
            </div>
            <SummaryLine label="Subtotal" value={money(subtotal)} />
            <SummaryLine label="Discount" value={money(cartDiscount)} />
            <SummaryLine label="Document total" value={money(total)} strong />
            {selectedCustomer && <SummaryLine label="Outstanding balance" value={`${currentOutstanding < 0 ? '-' : ''}${money(Math.abs(currentOutstanding))}`} />}
            {selectedCustomer && balanceUsedForCurrentBill > 0 && (
              <SummaryLine
                label={total >= 0 ? 'Balance used automatically' : 'Previous due reduced'}
                value={money(balanceUsedForCurrentBill)}
              />
            )}
            {selectedCustomer && balanceUsedForCurrentBill > 0 && (
              <SummaryLine
                label={total >= 0 ? 'Amount to collect' : 'Amount to refund'}
                value={money(amountToSettleCurrentBill)}
                strong
              />
            )}
            {paymentLines.length > 0 && <SummaryLine label="Payment lines" value={paymentLines.map((line) => `${line.paymentMethodName} ${line.direction === 'out' ? 'out' : 'in'} ${money(line.amount)}`).join(' + ')} />}
            {paymentLines.length > 0 && <SummaryLine label="After payment" value={`${projectedOutstanding < 0 ? '-' : ''}${money(Math.abs(projectedOutstanding))}`} strong />}
            {total < 0 && <div className="negative-total">Negative total: select a customer. Refund by cash/bank or leave unpaid to keep negative outstanding balance.</div>}
          </div>
        </div>

        <button
          type="button"
          className="pos-resize-handle"
          onMouseDown={(event) => { event.preventDefault(); setIsResizingPos(true); }}
          title="Drag to resize bill/products panels"
          aria-label="Resize POS panels"
        >
          <span />
        </button>

        <div className="panel-card product-search-panel right-product-panel pos-category-panel">
          <div className="pos-search-bar">
            <input className="pos-search-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products by code, name, or barcode" autoFocus />
            <span>⌕</span>
          </div>

          <div className="pos-breadcrumbs">
            {breadcrumb.map((crumb, index) => (
              <button key={crumb.id} onClick={() => { setSearch(''); setPosCategoryId(crumb.id); }}>
                {index > 0 && <span>›</span>} {crumb.name}
              </button>
            ))}
          </div>

          {!search.trim() && categoryChildren.length > 0 && (
            <div className="pos-category-tiles">
              {posCategoryId !== 'root' && (
                <button className="pos-category-tile back" onClick={() => setPosCategoryId(currentCategory?.parent_id || 'root')}>← Back</button>
              )}
              {categoryChildren.map((category) => (
                <button key={category.id} className="pos-category-tile" onClick={() => { setSearch(''); setPosCategoryId(category.id); }}>
                  <strong>{category.name}</strong>
                  <small>{category.path}</small>
                </button>
              ))}
            </div>
          )}

          <div className="search-results tile-results pos-product-tiles">
            {products.map((product) => {
              const availableQty = Number(product.available_qty || 0);
              return (
                <button
                  key={product.product_id}
                  className={`product-result product-tile ${availableQty <= 0 ? 'no-stock-tile' : ''}`}
                  onClick={() => addProduct(product)}
                  title={availableQty <= 0 ? 'No available stock' : ''}
                >
                  <strong>{product.item_code}</strong>
                  <span>{product.name}</span>
                  <small>{money(product.selling_price)} • Avail: {availableQty}</small>
                  {availableQty <= 0 && <em>No stock</em>}
                </button>
              );
            })}
            {products.length === 0 && search.trim() && <div className="muted-box">No matching products.</div>}
            {products.length === 0 && !search.trim() && categoryChildren.length === 0 && <div className="muted-box">No products inside this category.</div>}
          </div>
        </div>
      </div>

      {showPaymentPanel && (
        <div className="payment-screen-backdrop">
          <div className="payment-screen-card">
            <div className="payment-screen-left">
              <h3>Items</h3>
              <div className="payment-item-list">
                {activeBill.items.map((item) => (
                  <div key={item.id} className="payment-item-row">
                    <strong>{item.name}</strong>
                    <span>{Number(item.qty || 0)} × {money(item.unitPrice)}</span>
                    <b>{money(item.lineTotal)}</b>
                  </div>
                ))}
              </div>
              <div className="payment-screen-totals">
                <SummaryLine label="Subtotal" value={money(subtotal)} />
                <SummaryLine label="Discount" value={money(cartDiscount)} />
                <SummaryLine label="Current bill" value={money(total)} strong />
                {selectedCustomer && <SummaryLine label="Outstanding balance" value={`${currentOutstanding < 0 ? '-' : ''}${money(Math.abs(currentOutstanding))}`} />}
                {selectedCustomer && balanceUsedForCurrentBill > 0 && (
                  <SummaryLine
                    label={total >= 0 ? 'Balance used automatically' : 'Previous due reduced'}
                    value={money(balanceUsedForCurrentBill)}
                  />
                )}
                <SummaryLine label={total >= 0 ? 'Amount to collect' : 'Amount to refund'} value={money(amountToSettleCurrentBill)} strong />
              </div>
            </div>

            <div className="payment-screen-main">
              <div className="payment-screen-header">
                <h3>Payment</h3>
                <button className="danger-button" onClick={() => setShowPaymentPanel(false)}>Cancel</button>
              </div>

              <div className="payment-method-large-grid">
                {visiblePaymentMethods.map((method) => (
                  <button key={method.id} className={method.is_paid_method === false ? 'payment-method-tile credit' : 'payment-method-tile'} onClick={() => addPaymentLine(method)}>
                    {method.name}
                    <small>{method.is_paid_method === false ? 'Add unpaid balance' : 'Receive / refund'}</small>
                  </button>
                ))}
              </div>

              <div className="payment-screen-summary">
                {selectedCustomer && balanceUsedForCurrentBill > 0 && (
                  <SummaryLine
                    label={total >= 0 ? 'Outstanding balance used' : 'Outstanding due used'}
                    value={money(balanceUsedForCurrentBill)}
                  />
                )}
                <SummaryLine label={currentTarget.direction === 'out' ? 'Refund target' : 'Bill target'} value={money(currentTarget.amount)} strong />
                <SummaryLine label="Payment lines total" value={money(paymentLineTotal())} />
                <SummaryLine label="Remaining current bill" value={money(remainingCurrent)} />
                <SummaryLine label="Outstanding after save" value={`${modalProjectedOutstanding < 0 ? '-' : ''}${money(Math.abs(modalProjectedOutstanding))}`} />
              </div>

              <div className="payment-custom-row">
                <label>Custom amount for next line
                  <input type="number" step="0.01" value={lineAmountInput} onFocus={selectAllText} onChange={(e) => setLineAmountInput(e.target.value)} placeholder={String(remainingCurrent || currentTarget.amount)} />
                </label>
                <small>Leave empty to add remaining current-bill amount. Split payments are for this bill. Extra paid amount reduces the selected customer's outstanding balance.</small>
              </div>

              <div className="table-wrap compact-table payment-lines-table">
                <table>
                  <thead><tr><th>Method</th><th>Direction</th><th>Amount</th><th></th></tr></thead>
                  <tbody>
                    {paymentDraft.map((line) => (
                      <tr key={line.id}>
                        <td>{line.paymentMethodName}{line.isPaidMethod === false ? ' / Credit' : ''}</td>
                        <td>{line.direction === 'out' ? 'Refund / out' : 'Receive / in'}</td>
                        <td><input type="number" value={line.amount} onFocus={selectAllText} onChange={(e) => setPaymentDraft((rows) => rows.map((row) => row.id === line.id ? { ...row, amount: Number(e.target.value) } : row))} /></td>
                        <td><button className="link-button" onClick={() => setPaymentDraft((rows) => rows.filter((row) => row.id !== line.id))}>Remove</button></td>
                      </tr>
                    ))}
                    {paymentDraft.length === 0 && <tr><td colSpan="4" className="empty-cell">Select a payment type to add a line.</td></tr>}
                  </tbody>
                </table>
              </div>

              <div className="payment-popup-footer payment-screen-footer">
                <button className="secondary-button" onClick={savePaymentDraft}>Save payment lines</button>
                <button className="primary-button green-button" onClick={() => { updateActiveBill({ paymentLines: paymentDraft }); setShowPaymentPanel(false); saveInvoice(paymentDraft); }}>Save invoice</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}


function Dashboard() {
  const [stats, setStats] = useState({ products: 0, customers: 0, suppliers: 0, documents: 0, cashIn: 0, cashOut: 0 });
  const [error, setError] = useState('');

  useEffect(() => {
    async function loadStats() {
      setError('');
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const [productsRes, customersRes, suppliersRes, docsRes, cashRes] = await Promise.all([
        supabase.from('products').select('id', { count: 'exact', head: true }),
        supabase.from('customers').select('id', { count: 'exact', head: true }),
        supabase.from('suppliers').select('id', { count: 'exact', head: true }),
        supabase.from('documents').select('id', { count: 'exact', head: true }),
        supabase.from('cashflow_entries').select('entry_type, amount').gte('created_at', todayStart.toISOString())
      ]);

      const firstError = productsRes.error || customersRes.error || suppliersRes.error || docsRes.error || cashRes.error;
      if (firstError) {
        setError(firstError.message);
        return;
      }

      setStats({
        products: productsRes.count || 0,
        customers: customersRes.count || 0,
        suppliers: suppliersRes.count || 0,
        documents: docsRes.count || 0,
        cashIn: (cashRes.data || []).filter((row) => row.entry_type === 'cash_in').reduce((sum, row) => sum + Number(row.amount || 0), 0),
        cashOut: (cashRes.data || []).filter((row) => row.entry_type === 'cash_out').reduce((sum, row) => sum + Number(row.amount || 0), 0)
      });
    }

    loadStats();
  }, []);

  return (
    <section className="page-section">
      {error && <div className="error-box">{error}</div>}
      <div className="stats-grid">
        <StatCard label="Products" value={stats.products} />
        <StatCard label="Customers" value={stats.customers} />
        <StatCard label="Suppliers" value={stats.suppliers} />
        <StatCard label="Documents" value={stats.documents} />
        <StatCard label="Today Cash In" value={money(stats.cashIn)} />
        <StatCard label="Today Cash Out" value={money(stats.cashOut)} />
      </div>
      <div className="panel-card">
        <h3>Build status</h3>
        <p>This update creates the main structure first: POS, documents, stock, cashflow, customers/suppliers, payment types, users/security, and company settings.</p>
        <p>Next step is to connect full product add/edit and stock opening import screens.</p>
      </div>
    </section>
  );
}

function DocumentsPage({ onOpenPOS } = {}) {
  const [documents, setDocuments] = useState([]);
  const [selected, setSelected] = useState(null);
  const [items, setItems] = useState([]);
  const [filters, setFilters] = useState({ product: '', customer: '', number: '', user: '', type: '', paid: '', periodFrom: '', periodTo: '' });
  const [parties, setParties] = useState([]);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [documentTabs, setDocumentTabs] = useState(() => {
    const savedTabs = safeReadJson(DOCUMENT_DRAFT_TABS_KEY, []);
    const draftTabs = Array.isArray(savedTabs) ? savedTabs.filter((tab) => tab.id && (tab.kind === 'new_purchase_like' || tab.kind === 'trade_in_intake' || tab.kind === 'job_intake' || tab.kind === 'edit_document')) : [];
    return [{ id: 'view', kind: 'view', label: 'View documents' }, ...draftTabs];
  });
  const [activeDocumentTabId, setActiveDocumentTabId] = useState('view');
  const [busyAction, setBusyAction] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { loadDocuments(); loadDocumentFilterParties(); }, []);

  useEffect(() => {
    const timeout = setTimeout(() => loadDocuments(), 300);
    return () => clearTimeout(timeout);
  }, [filters]);

  useEffect(() => {
    const draftTabs = documentTabs
      .filter((tab) => tab.kind === 'new_purchase_like' || tab.kind === 'trade_in_intake' || tab.kind === 'job_intake' || tab.kind === 'edit_document')
      .map((tab) => ({
        id: tab.id,
        kind: tab.kind,
        documentType: tab.documentType || tab.document?.document_type,
        label: tab.label,
        document: tab.kind === 'edit_document' ? tab.document : undefined
      }));
    window.localStorage.setItem(DOCUMENT_DRAFT_TABS_KEY, JSON.stringify(draftTabs));
  }, [documentTabs]);

  async function loadDocuments() {
    setError('');
    setMessage('');

    let matchingDocumentIds = null;
    if (filters.product.trim()) {
      const cleanProduct = filters.product.trim().replace(/,/g, ' ');
      const { data: matchItems, error: matchError } = await supabase
        .from('document_items')
        .select('document_id')
        .or(`item_code.ilike.%${cleanProduct}%,description.ilike.%${cleanProduct}%`)
        .limit(1000);

      if (matchError) {
        setError(matchError.message);
        return;
      }

      matchingDocumentIds = [...new Set((matchItems || []).map((row) => row.document_id).filter(Boolean))];
      if (!matchingDocumentIds.length) {
        setDocuments([]);
        setSelected(null);
        setItems([]);
        return;
      }
    }

    let query = supabase
      .from('documents')
      .select('id, document_no, job_no, job_status, external_document_no, document_type, status, total_amount, paid_amount, balance_amount, currency, document_date, created_at, shipping_method, expected_arrival_date, linked_document_id, supplier_id, customer_id, payment_method_id, notes')
      .order('document_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(250);

    if (matchingDocumentIds) query = query.in('id', matchingDocumentIds);
    if (filters.type) query = query.eq('document_type', filters.type);
    if (filters.number) query = query.ilike('document_no', `%${filters.number}%`);
    if (filters.periodFrom) query = query.gte('document_date', `${filters.periodFrom}T00:00:00`);
    if (filters.periodTo) query = query.lte('document_date', `${filters.periodTo}T23:59:59`);

    const { data, error: docError } = await query;
    if (docError) {
      setError(docError.message);
      return;
    }

    let filtered = data || [];

    const customerIds = [...new Set(filtered.map((doc) => doc.customer_id).filter(Boolean))];
    const supplierIds = [...new Set(filtered.map((doc) => doc.supplier_id).filter(Boolean))];
    const paymentIds = [...new Set(filtered.map((doc) => doc.payment_method_id).filter(Boolean))];

    const [customerLookupRes, supplierLookupRes, paymentLookupRes] = await Promise.all([
      customerIds.length ? supabase.from('customers').select('id, name').in('id', customerIds) : Promise.resolve({ data: [] }),
      supplierIds.length ? supabase.from('suppliers').select('id, name').in('id', supplierIds) : Promise.resolve({ data: [] }),
      paymentIds.length ? supabase.from('payment_methods').select('id, name').in('id', paymentIds) : Promise.resolve({ data: [] })
    ]);

    const customerMap = new Map((customerLookupRes.data || []).map((row) => [row.id, row.name]));
    const supplierMap = new Map((supplierLookupRes.data || []).map((row) => [row.id, row.name]));
    const paymentMap = new Map((paymentLookupRes.data || []).map((row) => [row.id, row.name]));

    filtered = filtered.map((doc) => ({
      ...doc,
      party_name: customerMap.get(doc.customer_id) || supplierMap.get(doc.supplier_id) || '',
      payment_method_name: paymentMap.get(doc.payment_method_id) || ''
    }));

    if (filters.customer.trim()) {
      const key = filters.customer.trim().toLowerCase();
      filtered = filtered.filter((doc) => (doc.party_name || '').toLowerCase().includes(key));
    }
    if (filters.paid) {
      filtered = filtered.filter((doc) => {
        const paidStatus = paidStatusLabel(doc).toLowerCase();
        return paidStatus === filters.paid;
      });
    }

    setDocuments(filtered);
    setSelected(null);
    setItems([]);
  }

  async function loadDocumentFilterParties() {
    const [customerRes, supplierRes] = await Promise.all([
      supabase.from('customers').select('name, phone').order('name', { ascending: true }).limit(500),
      supabase.from('suppliers').select('name, phone').order('name', { ascending: true }).limit(500)
    ]);
    const merged = new Map();
    if (!customerRes.error) {
      for (const row of customerRes.data || []) {
        const key = `${(row.name || '').trim().toLowerCase()}|${row.phone || ''}`;
        merged.set(key, { label: row.name, phone: row.phone, type: 'Customer/Supplier profile' });
      }
    }
    if (!supplierRes.error) {
      for (const row of supplierRes.data || []) {
        const key = `${(row.name || '').trim().toLowerCase()}|${row.phone || ''}`;
        const current = merged.get(key);
        merged.set(key, current ? { ...current, type: current.type.includes('Supplier') ? current.type : 'Customer/Supplier profile' } : { label: row.name, phone: row.phone, type: 'Supplier' });
      }
    }
    setParties([...merged.values()].sort((a, b) => a.label.localeCompare(b.label)));
  }

  async function selectDocument(document) {
    setSelected(document);
    const { data, error: itemError } = await supabase
      .from('document_items')
      .select('*')
      .eq('document_id', document.id)
      .order('created_at', { ascending: true });

    if (itemError) setError(itemError.message);
    else setItems(data || []);
  }

  function openAddDocument(type) {
    setShowAddMenu(false);
    if (type === 'purchase' || type === 'stock_in_transit') {
      const tab = {
        id: crypto.randomUUID(),
        kind: 'new_purchase_like',
        documentType: type,
        label: type === 'stock_in_transit' ? 'New Stock in Transit' : 'New Purchase'
      };
      setDocumentTabs((current) => [...current, tab]);
      setActiveDocumentTabId(tab.id);
      return;
    }
    if (type === 'trade_in') {
      const tab = {
        id: crypto.randomUUID(),
        kind: 'trade_in_intake',
        documentType: type,
        label: 'New Buyback Intake'
      };
      setDocumentTabs((current) => [...current, tab]);
      setActiveDocumentTabId(tab.id);
      return;
    }
    if (type === 'job') {
      const tab = {
        id: crypto.randomUUID(),
        kind: 'job_intake',
        documentType: type,
        label: 'New Job / Repair'
      };
      setDocumentTabs((current) => [...current, tab]);
      setActiveDocumentTabId(tab.id);
      return;
    }
    if (type === 'quotation') {
      const tab = {
        id: crypto.randomUUID(),
        kind: 'quotation_document',
        documentType: type,
        label: 'New Quotation'
      };
      setDocumentTabs((current) => [...current, tab]);
      setActiveDocumentTabId(tab.id);
      return;
    }
    setMessage(`${documentTypeLabel(type)} will be added after purchase/transit, job, trade-in intake, and quotation modules are stable.`);
  }

  function openEditDocument() {
    if (!selected) {
      setError('Select a document first.');
      return;
    }
    if (!['purchase', 'stock_in_transit', 'quotation'].includes(selected.document_type)) {
      setError('Full tab editing is available for Purchase, Stock in Transit, and Quotation documents first.');
      return;
    }
    const existing = documentTabs.find((tab) => tab.kind === 'edit_document' && tab.document?.id === selected.id);
    if (existing) {
      setActiveDocumentTabId(existing.id);
      return;
    }
    const tab = {
      id: crypto.randomUUID(),
      kind: 'edit_document',
      document: selected,
      label: selected.document_no || 'Edit document'
    };
    setDocumentTabs((current) => [...current, tab]);
    setActiveDocumentTabId(tab.id);
  }

  async function convertTransitToPurchase() {
    if (!selected || selected.document_type !== 'stock_in_transit') return;
    if (!window.confirm(`Convert ${selected.document_no} to Purchase and add the items to inventory?`)) return;
    setBusyAction(true);
    setError('');
    setMessage('');
    const { data, error: convertError } = await supabase.rpc('convert_stock_in_transit_to_purchase', {
      p_transit_doc_id: selected.id
    });
    if (convertError) setError(convertError.message);
    else setMessage(`Stock In Transit converted to Purchase. New purchase ID: ${String(data || '').slice(0, 8)}`);
    setBusyAction(false);
    await loadDocuments();
  }

  async function convertQuotationToInvoice() {
    if (!selected || selected.document_type !== 'quotation') return;
    setBusyAction(true);
    setError('');
    setMessage('');
    const { data: quoteItems, error: itemError } = await supabase
      .from('document_items')
      .select('*')
      .eq('document_id', selected.id)
      .order('created_at', { ascending: true });
    setBusyAction(false);
    if (itemError) {
      setError(itemError.message);
      return;
    }
    if (!quoteItems?.length) {
      setError('This quotation has no items to convert.');
      return;
    }
    window.localStorage.setItem(QUOTE_TO_POS_KEY, JSON.stringify({
      quoteId: selected.id,
      quoteNo: selected.document_no,
      customerId: selected.customer_id || '',
      customerName: selected.party_name || '',
      notes: selected.notes || '',
      items: quoteItems
    }));
    setMessage(`${selected.document_no} loaded into POS. Complete payment there to save it as a sales invoice.`);
    onOpenPOS?.();
  }

  async function applySelectedDocumentStock() {
    if (!selected || !['purchase', 'stock_in_transit'].includes(selected.document_type)) return;
    const rpcName = selected.document_type === 'purchase' ? 'post_purchase_document' : 'post_stock_in_transit_document';
    if (!window.confirm(`Apply stock updates for ${selected.document_no}?`)) return;
    setBusyAction(true);
    setError('');
    setMessage('');
    const { error: postError } = await supabase.rpc(rpcName, { p_document_id: selected.id });
    if (postError) setError(postError.message);
    else setMessage(`${selected.document_no} stock update applied.`);
    setBusyAction(false);
    await loadDocuments();
  }

  async function deleteSelectedDocument() {
    if (!selected) {
      setError('Select a document first.');
      return;
    }
    if (!['purchase', 'stock_in_transit'].includes(selected.document_type)) {
      setError('Delete with stock reversal is currently enabled for Purchase and Stock in Transit documents only.');
      return;
    }
    if (!window.confirm(`Delete ${selected.document_no}? This will reverse its stock/cashflow effect before deleting.`)) return;
    setBusyAction(true);
    setError('');
    setMessage('');
    const { error: deleteError } = await supabase.rpc('delete_purchase_like_document', {
      p_document_id: selected.id
    });
    if (deleteError) setError(deleteError.message);
    else setMessage(`${selected.document_no} deleted and stock/cashflow reversed.`);
    setBusyAction(false);
    await loadDocuments();
  }

  const canConvertTransit = selected?.document_type === 'stock_in_transit' && selected?.status === 'in_transit';
  const canConvertQuote = selected?.document_type === 'quotation' && selected?.status !== 'converted';
  const canApplyStock = selected && ['purchase', 'stock_in_transit'].includes(selected.document_type) && selected.status === 'draft';
  const activeDocumentTab = documentTabs.find((tab) => tab.id === activeDocumentTabId) || documentTabs[0];

  function closeDocumentTab(tabId) {
    if (tabId === 'view') return;
    window.localStorage.removeItem(documentDraftKey(tabId));
    setDocumentTabs((current) => current.filter((tab) => tab.id !== tabId));
    setActiveDocumentTabId('view');
  }

  return (
    <section className="documents-screen">
      <div className="action-toolbar">
        <div className="toolbar-menu-wrap">
          <button className="toolbar-button bright" onClick={() => setShowAddMenu(!showAddMenu)}><span>＋</span>Add</button>
          {showAddMenu && (
            <div className="add-menu">
              {DOCUMENT_TYPES.filter((type) => type.value).map((type) => (
                <button key={type.value} onClick={() => openAddDocument(type.value)}>{type.label}</button>
              ))}
            </div>
          )}
        </div>
        <button className="toolbar-button"><span>▣</span>Print</button>
        <button className="toolbar-button"><span>◫</span>Print preview</button>
        <button className="toolbar-button"><span>⌁</span>Save as PDF</button>
        <button className="toolbar-button" disabled={!selected} onClick={openEditDocument}><span>✎</span>Edit</button>
        <button className="toolbar-button" disabled={!selected || busyAction} onClick={deleteSelectedDocument}><span>▥</span>Delete</button>
        <button className="toolbar-button" disabled={!canApplyStock || busyAction} onClick={applySelectedDocumentStock}><span>✓</span>Apply Stock</button>
        <button className="toolbar-button bright" disabled={!canConvertTransit || busyAction} onClick={convertTransitToPurchase}><span>⇢</span>Convert to Purchase</button>
        <button className="toolbar-button bright" disabled={!canConvertQuote || busyAction} onClick={convertQuotationToInvoice}><span>⇢</span>Convert Quote to Sales</button>
      </div>

      <div className="document-tabbar">
        {documentTabs.map((tab) => (
          <button
            key={tab.id}
            className={activeDocumentTabId === tab.id ? 'document-tab active' : 'document-tab'}
            onClick={() => setActiveDocumentTabId(tab.id)}
          >
            <span>{tab.kind === 'view' ? '⌕' : tab.kind === 'edit_document' ? '✎' : tab.kind === 'trade_in_intake' ? '↔' : '＋'}</span>
            {tab.label}
            {tab.id !== 'view' && (
              <em onClick={(event) => { event.stopPropagation(); closeDocumentTab(tab.id); }}>×</em>
            )}
          </button>
        ))}
      </div>

      {activeDocumentTab?.kind === 'view' && (
        <>
      <div className="document-filters">
        <FilterInput label="Product / Item code" value={filters.product} onChange={(value) => setFilters({ ...filters, product: value })} placeholder="Type SKU/code or product name" />
        <label>
          Customer / Supplier
          <input list="document-party-options" value={filters.customer} onChange={(e) => setFilters({ ...filters, customer: e.target.value })} placeholder="Type or select customer/supplier" />
          <datalist id="document-party-options">
            {parties.map((party, index) => (
              <option key={`${party.type}-${party.label}-${index}`} value={party.label}>{party.type}{party.phone ? ` • ${party.phone}` : ''}</option>
            ))}
          </datalist>
        </label>
        <FilterInput label="Document number" value={filters.number} onChange={(value) => setFilters({ ...filters, number: value })} />
        <FilterInput label="User" value={filters.user} onChange={(value) => setFilters({ ...filters, user: value })} />
        <label>
          Document type
          <select value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })}>
            {DOCUMENT_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
          </select>
        </label>
        <label>
          Paid status
          <select value={filters.paid} onChange={(e) => setFilters({ ...filters, paid: e.target.value })}>
            <option value="">All transactions</option>
            <option value="paid">Paid</option>
            <option value="partial">Partial</option>
            <option value="unpaid">Unpaid</option>
          </select>
        </label>
        <label>
          From
          <input type="date" value={filters.periodFrom} onChange={(e) => setFilters({ ...filters, periodFrom: e.target.value })} />
        </label>
        <label>
          To
          <input type="date" value={filters.periodTo} onChange={(e) => setFilters({ ...filters, periodTo: e.target.value })} />
        </label>
        <div className="filter-actions">
          <button className="primary-button" onClick={loadDocuments}>Refresh</button>
          <button className="secondary-button" onClick={() => setFilters({ product: '', customer: '', number: '', user: '', type: '', paid: '', periodFrom: '', periodTo: '' })}>Clear</button>
        </div>
      </div>

      {message && <div className="notice">{message}</div>}
      {error && <div className="error-box">{error}</div>}
      <SplitTables
        titleA={`Documents (${documents.length})`}
        tableA={
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Number</th>
                <th>Job No</th>
                <th>External No</th>
                <th>Document Type</th>
                <th>Paid</th>
                <th>Customer / Supplier</th>
                <th>Date</th>
                <th>Payment</th>
                <th>Total</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((document) => {
                const name = document.party_name || '-';
                return (
                  <tr key={document.id} className={selected?.id === document.id ? 'selected-row' : ''} onClick={() => selectDocument(document)}>
                    <td>{document.id.slice(0, 8)}</td>
                    <td>{document.document_no}</td>
                    <td>{document.job_no || '-'}</td>
                    <td>{document.external_document_no || '-'}</td>
                    <td>{documentTypeLabel(document.document_type)}</td>
                    <td>{paidStatusLabel(document)}</td>
                    <td>{name}</td>
                    <td>{fmtDate(document.document_date || document.created_at)}</td>
                    <td>{document.payment_method_name || '-'}</td>
                    <td>{money(document.total_amount)}</td>
                    <td>{document.status === 'converted' && ['stock_in_transit', 'quotation'].includes(document.document_type) ? 'Converted ✓' : document.status}</td>
                  </tr>
                );
              })}
              {documents.length === 0 && <EmptyRow colSpan={11} text="No documents found." />}
            </tbody>
          </table>
        }
        titleB={`Document items (${items.length})`}
        tableB={
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Code</th>
                <th>Name</th>
                <th>Quantity</th>
                <th>Cost</th>
                <th>Price</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className={Number(item.qty) < 0 ? 'return-row' : ''}>
                  <td>{item.id.slice(0, 8)}</td>
                  <td>{item.item_code || '-'}</td>
                  <td>{item.description}</td>
                  <td>{Number(item.qty)}</td>
                  <td>{money(item.unit_cost)}</td>
                  <td>{money(item.unit_price)}</td>
                  <td>{money(item.line_total)}</td>
                </tr>
              ))}
              {items.length === 0 && <EmptyRow colSpan={7} text="Select a document to view items." />}
            </tbody>
          </table>
        }
      />

        </>
      )}

      <div className="document-workspace">
        {documentTabs.filter((tab) => tab.kind === 'new_purchase_like' || tab.kind === 'edit_document' || tab.kind === 'trade_in_intake' || tab.kind === 'job_intake' || tab.kind === 'quotation_document').map((tab) => {
          const isActive = activeDocumentTabId === tab.id;
          return (
            <div key={tab.id} className={isActive ? 'document-tab-panel active' : 'document-tab-panel hidden-document-tab'}>
              {tab.kind === 'new_purchase_like' && (
                <PurchaseDocumentForm
                  documentType={tab.documentType}
                  tabId={tab.id}
                  tabLabel={tab.label}
                  onNumberReady={(number) => {
                    setDocumentTabs((current) => current.map((item) => (item.id === tab.id ? { ...item, label: number || item.label } : item)));
                  }}
                  onClose={() => closeDocumentTab(tab.id)}
                  onSaved={() => { closeDocumentTab(tab.id); loadDocuments(); }}
                />
              )}
              {tab.kind === 'edit_document' && tab.document.document_type === 'quotation' && (
                <QuotationDocumentForm
                  document={tab.document}
                  tabId={tab.id}
                  onNumberReady={(number) => {
                    setDocumentTabs((current) => current.map((item) => (item.id === tab.id ? { ...item, label: number || item.label } : item)));
                  }}
                  onClose={() => closeDocumentTab(tab.id)}
                  onSaved={() => { closeDocumentTab(tab.id); loadDocuments(); }}
                />
              )}
              {tab.kind === 'edit_document' && tab.document.document_type !== 'quotation' && (
                <PurchaseDocumentForm
                  documentType={tab.document.document_type}
                  document={tab.document}
                  tabId={tab.id}
                  tabLabel={tab.label}
                  onNumberReady={(number) => {
                    setDocumentTabs((current) => current.map((item) => (item.id === tab.id ? { ...item, label: number || item.label } : item)));
                  }}
                  onClose={() => closeDocumentTab(tab.id)}
                  onSaved={() => { closeDocumentTab(tab.id); loadDocuments(); }}
                />
              )}
              {tab.kind === 'trade_in_intake' && (
                <TradeInIntakeForm
                  tabId={tab.id}
                  onNumberReady={(number) => {
                    setDocumentTabs((current) => current.map((item) => (item.id === tab.id ? { ...item, label: number || item.label } : item)));
                  }}
                  onClose={() => closeDocumentTab(tab.id)}
                  onSaved={() => { closeDocumentTab(tab.id); loadDocuments(); }}
                />
              )}
              {tab.kind === 'job_intake' && (
                <JobDocumentForm
                  tabId={tab.id}
                  onNumberReady={(number) => {
                    setDocumentTabs((current) => current.map((item) => (item.id === tab.id ? { ...item, label: number || item.label } : item)));
                  }}
                  onClose={() => closeDocumentTab(tab.id)}
                  onSaved={() => { closeDocumentTab(tab.id); loadDocuments(); }}
                />
              )}
              {tab.kind === 'quotation_document' && (
                <QuotationDocumentForm
                  tabId={tab.id}
                  onNumberReady={(number) => {
                    setDocumentTabs((current) => current.map((item) => (item.id === tab.id ? { ...item, label: number || item.label } : item)));
                  }}
                  onClose={() => closeDocumentTab(tab.id)}
                  onSaved={() => { closeDocumentTab(tab.id); loadDocuments(); }}
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DocumentHeaderEditor({ document, onClose, onSaved, embedded = false }) {
  const [suppliers, setSuppliers] = useState([]);
  const [supplierSearch, setSupplierSearch] = useState('');
  const [supplierMenuOpen, setSupplierMenuOpen] = useState(false);
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [form, setForm] = useState({
    document_no: document.document_no || '',
    external_document_no: document.external_document_no || '',
    document_date: (document.document_date || document.created_at || '').slice(0, 10) || todayInputDate(),
    supplier_id: document.supplier_id || '',
    payment_method_id: document.payment_method_id || '',
    shipping_method: document.shipping_method || '',
    expected_arrival_date: document.expected_arrival_date || '',
    notes: document.notes || ''
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      supabase.from('suppliers').select('id, name').order('name', { ascending: true }).limit(500),
      supabase.from('payment_methods').select('id, name').eq('is_active', true).order('name')
    ]).then(([supplierRes, paymentRes]) => {
      if (supplierRes.error) setError(supplierRes.error.message);
      else setSuppliers(supplierRes.data || []);
      if (paymentRes.error) setError(paymentRes.error.message);
      else setPaymentMethods(paymentRes.data || []);
    });
  }, []);

  async function saveHeader(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const payload = {
      document_no: form.document_no.trim(),
      external_document_no: form.external_document_no.trim() || null,
      document_date: `${form.document_date || todayInputDate()}T12:00:00`,
      supplier_id: form.supplier_id || null,
      payment_method_id: form.payment_method_id || null,
      shipping_method: form.shipping_method.trim() || null,
      expected_arrival_date: form.expected_arrival_date || null,
      notes: form.notes.trim() || null
    };
    const { error: updateError } = await supabase.from('documents').update(payload).eq('id', document.id);
    setBusy(false);
    if (updateError) setError(updateError.message);
    else onSaved();
  }

  const content = (
    <>
      <div className="section-title-row">
        <div>
          <h3>Edit document</h3>
          <p>For now, this edits document header/payment details. Item changes after stock posting will be added later with reversal protection.</p>
        </div>
        <button type="button" className="secondary-button" onClick={onClose}>Close</button>
      </div>
      {error && <div className="error-box">{error}</div>}
      <form className="product-form-grid" onSubmit={saveHeader}>
        <label>Document number<input value={form.document_no} onFocus={selectAllText} onChange={(e) => setForm({ ...form, document_no: e.target.value })} required /></label>
        <label>External no<input value={form.external_document_no} onFocus={selectAllText} onChange={(e) => setForm({ ...form, external_document_no: e.target.value })} /></label>
        <label>Date<input type="date" value={form.document_date} onChange={(e) => setForm({ ...form, document_date: e.target.value })} /></label>
        <label>Supplier
          <select value={form.supplier_id} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}>
            <option value="">No supplier</option>
            {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
          </select>
        </label>
        <label>Payment method
          <select value={form.payment_method_id} onChange={(e) => setForm({ ...form, payment_method_id: e.target.value })}>
            <option value="">No payment method</option>
            {paymentMethods.map((method) => <option key={method.id} value={method.id}>{method.name}</option>)}
          </select>
        </label>
        <label>Shipping method<input value={form.shipping_method} onFocus={selectAllText} onChange={(e) => setForm({ ...form, shipping_method: e.target.value })} /></label>
        <label>Expected arrival<input type="date" value={form.expected_arrival_date || ''} onChange={(e) => setForm({ ...form, expected_arrival_date: e.target.value })} /></label>
        <label className="wide-field">Notes<textarea value={form.notes} onFocus={selectAllText} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
        <button className="primary-button" disabled={busy}>{busy ? 'Saving...' : 'Save document changes'}</button>
      </form>
    </>
  );

  if (embedded) {
    return <div className="document-form-panel">{content}</div>;
  }

  return (
    <div className="modal-backdrop">
      <div className="modal-card wide-modal">{content}</div>
    </div>
  );
}

function paidStatusLabel(document) {
  if (Number(document.balance_amount || 0) <= 0) return 'Paid';
  if (Number(document.paid_amount || 0) > 0) return 'Partial';
  return 'Unpaid';
}

function documentPrefix(type) {
  if (type === 'invoice' || type === 'sale') return '100';
  if (type === 'purchase') return '200';
  if (type === 'stock_in_transit') return '300';
  if (type === 'quotation') return '400';
  if (type === 'refund') return '500';
  if (type === 'stock_adjustment') return '600';
  if (type === 'trade_in') return '700';
  if (type === 'job') return '750';
  if (type === 'customer_payment') return '800';
  if (type === 'supplier_payment') return '850';
  if (type === 'expense') return '900';
  return '999';
}

function todayInputDate() {
  return new Date().toISOString().slice(0, 10);
}

function selectAllText(event) {
  event.target.select();
}

function emptyPurchaseLine() {
  return {
    id: crypto.randomUUID(),
    product_id: '',
    item_code: '',
    description: '',
    qty: 1,
    unit_cost: 0,
    line_total: 0
  };
}

function paidMethodAmount(lines = []) {
  return lines
    .filter((line) => line.isPaidMethod !== false)
    .reduce((sum, line) => sum + numberValue(line.amount), 0);
}

function totalPaymentLines(lines = []) {
  return lines.reduce((sum, line) => sum + numberValue(line.amount), 0);
}


function PurchaseDocumentForm({ documentType: requestedDocumentType, document = null, tabId = '', onClose, onSaved, onNumberReady }) {
  const isEditing = Boolean(document?.id);
  const rawSavedDraft = tabId ? safeReadJson(documentDraftKey(tabId), null) : null;
  const savedDraft = rawSavedDraft && (!isEditing || rawSavedDraft.editDocumentId === document?.id) ? rawSavedDraft : null;
  const isDraftForSameType = savedDraft?.documentType === (document?.document_type || requestedDocumentType);
  const documentType = document?.document_type || savedDraft?.documentType || requestedDocumentType;
  const isTransit = documentType === 'stock_in_transit';

  const [suppliers, setSuppliers] = useState([]);
  const [supplierSearch, setSupplierSearch] = useState('');
  const [supplierMenuOpen, setSupplierMenuOpen] = useState(false);
  const [supplierId, setSupplierId] = useState((isDraftForSameType ? savedDraft?.supplierId : '') || document?.supplier_id || '');
  const [partyCustomerId, setPartyCustomerId] = useState((isDraftForSameType ? savedDraft?.partyCustomerId : '') || document?.customer_id || '');

  const [paymentMethods, setPaymentMethods] = useState([]);
  const [paymentLines, setPaymentLines] = useState(isDraftForSameType && Array.isArray(savedDraft?.paymentLines) ? savedDraft.paymentLines : []);
  const [showPaymentPanel, setShowPaymentPanel] = useState(false);

  const [productSearch, setProductSearch] = useState('');
  const [categories, setCategories] = useState([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState('all');
  const [categoryProducts, setCategoryProducts] = useState([]);

  const [documentNo, setDocumentNo] = useState((isDraftForSameType ? savedDraft?.documentNo : '') || document?.document_no || '');
  const [externalNo, setExternalNo] = useState((isDraftForSameType ? savedDraft?.externalNo : '') || document?.external_document_no || '');
  const [documentDate, setDocumentDate] = useState((isDraftForSameType ? savedDraft?.documentDate : '') || (document?.document_date || document?.created_at || '').slice(0, 10) || todayInputDate());
  const [shippingMethod, setShippingMethod] = useState((isDraftForSameType ? savedDraft?.shippingMethod : '') || document?.shipping_method || (isTransit ? 'Air Cargo' : 'Local'));
  const [expectedArrivalDate, setExpectedArrivalDate] = useState((isDraftForSameType ? savedDraft?.expectedArrivalDate : '') || document?.expected_arrival_date || '');
  const [notes, setNotes] = useState((isDraftForSameType ? savedDraft?.notes : '') || document?.notes || '');
  const [lines, setLines] = useState(isDraftForSameType && Array.isArray(savedDraft?.lines) && savedDraft.lines.length ? savedDraft.lines : [emptyPurchaseLine()]);

  const [selectedLineProduct, setSelectedLineProduct] = useState(null);
  const [lineDraft, setLineDraft] = useState({ qty: 1, unit_cost: 0 });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const total = lines.reduce((sum, line) => sum + numberValue(line.line_total), 0);
  const paidOut = paidMethodAmount(paymentLines);
  const paymentLineTotalValue = totalPaymentLines(paymentLines);
  const balance = total - paidOut;
  const partyDelta = -total + paidOut;
  const selectedParty = suppliers.find((row) => (partyCustomerId && row.customer_id === partyCustomerId) || (supplierId && row.supplier_id === supplierId));
  const previousOutstanding = selectedParty ? numberValue(selectedParty.due_balance) - numberValue(selectedParty.store_credit_balance) : 0;
  const finalOutstandingAfterSave = previousOutstanding + partyDelta;
  const fullBalancePaymentAmount = Math.max(total - previousOutstanding, 0);
  const filteredSupplierChoices = suppliers.filter((party) => {
    const text = `${party.name || ''} ${party.phone || ''} ${party.address || ''}`.toLowerCase();
    const clean = supplierSearch.trim().toLowerCase();
    return !clean || text.includes(clean);
  }).slice(0, 80);

  useEffect(() => {
    loadSuppliersAndPayments();
    loadCategoriesForDocument();
    if (isEditing) {
      onNumberReady?.(document?.document_no || 'Edit document');
      loadExistingDocumentItemsAndPayments();
    } else if (documentNo) {
      onNumberReady?.(documentNo);
    } else {
      prepareDocumentNumber();
    }
  }, []);

  useEffect(() => {
    if (!tabId) return;
    const draft = {
      editDocumentId: isEditing ? document?.id : null,
      documentType,
      supplierId,
      partyCustomerId,
      documentNo,
      externalNo,
      documentDate,
      shippingMethod,
      expectedArrivalDate,
      notes,
      lines,
      paymentLines
    };
    window.localStorage.setItem(documentDraftKey(tabId), JSON.stringify(draft));
  }, [isEditing, tabId, documentType, supplierId, partyCustomerId, documentNo, externalNo, documentDate, shippingMethod, expectedArrivalDate, notes, lines, paymentLines]);

  useEffect(() => {
    const timeout = setTimeout(() => loadCategoryProducts(), 200);
    return () => clearTimeout(timeout);
  }, [selectedCategoryId, productSearch, categories.length]);

  async function prepareDocumentNumber() {
    const { data, error: numberError } = await supabase.rpc('next_document_no', { p_document_type: documentType });
    if (numberError) setError(numberError.message);
    else if (data) {
      setDocumentNo(data);
      onNumberReady?.(data);
    }
  }

  async function loadExistingDocumentItemsAndPayments() {
    if (!document?.id) return;
    const [itemRes, cashRes] = await Promise.all([
      supabase.from('document_items').select('*').eq('document_id', document.id).order('created_at', { ascending: true }),
      supabase.from('cashflow_entries').select('id, entry_type, account_name, payment_method_id, amount').eq('document_id', document.id).order('created_at', { ascending: true })
    ]);

    if (itemRes.error) setError(itemRes.error.message);
    else {
      const loadedLines = (itemRes.data || []).map((item) => ({
        id: item.id || crypto.randomUUID(),
        product_id: item.product_id,
        item_code: item.item_code || '',
        description: item.description || '',
        qty: numberValue(item.qty, 1),
        unit_cost: numberValue(item.unit_cost),
        line_total: numberValue(item.qty, 1) * numberValue(item.unit_cost)
      }));
      setLines(loadedLines.length ? loadedLines : [emptyPurchaseLine()]);
    }

    if (cashRes.error) setError(cashRes.error.message);
    else {
      const existingLines = (cashRes.data || [])
        .filter((row) => Number(row.amount || 0) > 0)
        .map((row) => ({
          id: row.id || crypto.randomUUID(),
          paymentMethodId: row.payment_method_id,
          paymentMethodName: row.account_name || 'Payment',
          amount: numberValue(row.amount),
          isPaidMethod: row.entry_type !== 'non_cash',
          affectsCashflow: row.entry_type !== 'non_cash'
        }));
      if (existingLines.length) setPaymentLines(existingLines);
      else if (Number(document?.paid_amount || 0) > 0 && document?.payment_method_id) {
        setPaymentLines([{ id: crypto.randomUUID(), paymentMethodId: document.payment_method_id, paymentMethodName: 'Payment', amount: Number(document.paid_amount || 0), isPaidMethod: true, affectsCashflow: true }]);
      }
    }
  }

  async function loadSuppliersAndPayments() {
    const [supplierRes, customerRes, paymentRes] = await Promise.all([
      supabase.from('suppliers').select('id, name, phone, address').order('name', { ascending: true }).limit(1000),
      supabase.from('customers').select('id, name, phone, address, is_customer, is_supplier, due_balance, store_credit_balance').order('name', { ascending: true }).limit(1500),
      supabase.from('payment_methods').select('id, name, affects_cashflow, is_paid_method, is_active').eq('is_active', true).order('name')
    ]);

    const customers = customerRes.data || [];
    const supplierRows = supplierRes.data || [];
    const byKey = new Map();

    for (const customer of customers) {
      const key = `${(customer.name || '').trim().toLowerCase()}|${customer.phone || ''}`;
      byKey.set(key, {
        name: customer.name,
        phone: customer.phone,
        address: customer.address,
        source: 'profile',
        customer_id: customer.id,
        supplier_id: '',
        label: customer.name,
        due_balance: customer.due_balance || 0,
        store_credit_balance: customer.store_credit_balance || 0,
        is_supplier: customer.is_supplier,
        is_customer: customer.is_customer
      });
    }

    for (const supplier of supplierRows) {
      const key = `${(supplier.name || '').trim().toLowerCase()}|${supplier.phone || ''}`;
      const current = byKey.get(key);
      if (current) {
        byKey.set(key, { ...current, source: 'merged', supplier_id: supplier.id, name: current.name || supplier.name, phone: current.phone || supplier.phone, address: current.address || supplier.address });
      } else {
        byKey.set(key, { ...supplier, source: 'supplier', supplier_id: supplier.id, customer_id: '', label: supplier.name, due_balance: 0, store_credit_balance: 0 });
      }
    }

    const uniqueChoices = [...byKey.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (supplierRes.error) setError(supplierRes.error.message);
    if (customerRes.error) setError(customerRes.error.message);
    setSuppliers(uniqueChoices);

    if (supplierId || partyCustomerId) {
      const selected = uniqueChoices.find((row) => row.supplier_id === supplierId || row.customer_id === partyCustomerId);
      if (selected) setSupplierSearch(selected.name || '');
    }

    if (paymentRes.error) setError(paymentRes.error.message);
    else setPaymentMethods(paymentRes.data || []);
  }

  async function ensureCustomerProfileFromParty(party) {
    if (party.customer_id) return party.customer_id;
    const { data, error: createError } = await supabase
      .from('customers')
      .insert({ name: party.name, phone: party.phone || null, address: party.address || null, is_customer: false, is_supplier: true })
      .select('id')
      .single();
    if (createError) throw createError;
    return data.id;
  }

  async function selectSupplierChoice(choice) {
    setError('');
    if (!choice) return;
    try {
      let customerId = choice.customer_id || '';
      let supplierRowId = choice.supplier_id || '';

      if (!customerId) {
        customerId = await ensureCustomerProfileFromParty(choice);
      }

      if (!supplierRowId) {
        const { data, error: createError } = await supabase
          .from('suppliers')
          .insert({ name: choice.name, phone: choice.phone || null, address: choice.address || null })
          .select('id, name, phone, address')
          .single();
        if (createError) throw createError;
        supplierRowId = data.id;
      }

      setSupplierId(supplierRowId);
      setPartyCustomerId(customerId);
      setSupplierSearch(choice.name || '');
      setSupplierMenuOpen(false);
    } catch (err) {
      setError(err.message || String(err));
    }
  }

  async function quickAddSupplier() {
    const name = window.prompt('Supplier/profile name');
    if (!name?.trim()) return;
    const cleanName = name.trim();
    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .insert({ name: cleanName, is_customer: false, is_supplier: true })
      .select('id, name, phone, address')
      .single();
    if (customerError) {
      setError(customerError.message);
      return;
    }
    const { data, error: supplierError } = await supabase.from('suppliers').insert({ name: cleanName }).select('id, name, phone, address').single();
    if (supplierError) setError(supplierError.message);
    else {
      const choice = { ...data, source: 'supplier', supplier_id: data.id, customer_id: customer.id, label: data.name };
      setSuppliers((current) => [...current, choice].sort((a, b) => (a.name || '').localeCompare(b.name || '')));
      setSupplierId(data.id);
      setPartyCustomerId(customer.id);
      setSupplierSearch(data.name || '');
    }
  }

  async function loadCategoriesForDocument() {
    const { data, error: categoryError } = await supabase
      .from('categories')
      .select('id, name, parent_id, path')
      .order('path', { ascending: true });
    if (categoryError) setError(categoryError.message);
    else setCategories(data || []);
  }

  async function loadCategoryProducts() {
    let query = supabase
      .from('product_stock_view')
      .select('*')
      .eq('is_active', true)
      .order('item_code', { ascending: true })
      .limit(1200);

    const clean = productSearch.trim();
    if (clean) {
      query = query.or(`item_code.ilike.%${clean}%,name.ilike.%${clean}%,barcode.ilike.%${clean}%`);
    } else if (selectedCategoryId === 'uncategorized') {
      query = query.is('category_id', null);
    } else {
      const ids = categoryDescendantIds(categories, selectedCategoryId);
      if (ids.length) query = query.in('category_id', ids);
    }

    const { data, error: productsError } = await query;
    if (productsError) setError(productsError.message);
    else setCategoryProducts(data || []);
  }

  function startAddProductToLines(product) {
    setSelectedLineProduct(product);
    setLineDraft({ qty: 1, unit_cost: numberValue(product.avg_cost) });
  }

  function confirmAddProductToLines() {
    if (!selectedLineProduct) return;
    const qty = numberValue(lineDraft.qty);
    const unitCost = numberValue(lineDraft.unit_cost);
    if (qty <= 0) {
      setError('Quantity must be greater than zero.');
      return;
    }
    const newLine = {
      id: crypto.randomUUID(),
      product_id: selectedLineProduct.product_id,
      item_code: selectedLineProduct.item_code,
      description: selectedLineProduct.name,
      qty,
      unit_cost: unitCost,
      line_total: qty * unitCost
    };
    const current = lines.length === 1 && !lines[0].product_id && !lines[0].description ? [] : lines;
    setLines([...current, newLine]);
    setProductSearch('');
    setSelectedLineProduct(null);
    setLineDraft({ qty: 1, unit_cost: 0 });
  }

  function updateLine(lineId, patch) {
    setLines((current) => current.map((line) => {
      if (line.id !== lineId) return line;
      const next = { ...line, ...patch };
      next.line_total = numberValue(next.qty) * numberValue(next.unit_cost);
      return next;
    }));
  }

  function removeLine(lineId) {
    const next = lines.filter((line) => line.id !== lineId);
    setLines(next.length ? next : [emptyPurchaseLine()]);
  }

  function addPaymentLine(method, amountOverride = null) {
    if (!method) return;
    const remaining = Math.max(total - totalPaymentLines(paymentLines), 0);
    const amount = Number(amountOverride !== null ? amountOverride : remaining || total || 0);
    if (amount <= 0) return;
    const line = {
      id: crypto.randomUUID(),
      paymentMethodId: method.id,
      paymentMethodName: method.name,
      amount,
      isPaidMethod: method.is_paid_method !== false,
      affectsCashflow: method.affects_cashflow !== false
    };
    setPaymentLines((current) => [...current, line]);
  }

  async function saveDocument(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');

    const validLines = lines.filter((line) => line.product_id && numberValue(line.qty) > 0);
    if (!validLines.length) {
      setError('Add at least one product with quantity greater than zero.');
      setBusy(false);
      return;
    }

    if (!paymentLines.length) {
      setShowPaymentPanel(true);
      setError('Select payment details before saving the document. Use Credit if nothing is paid now.');
      setBusy(false);
      return;
    }

    if (!partyCustomerId && Math.abs(total - paidOut) > 0.005) {
      setSupplierMenuOpen(true);
      setError('Select a supplier/customer profile when the purchase has a balance.');
      setBusy(false);
      return;
    }

    try {
      if (!documentNo.trim()) throw new Error('Document number is required. Close and open New again if it did not load.');
      const validPaymentLines = paymentLines.map((line) => ({
        payment_method_id: line.paymentMethodId,
        payment_method_name: line.paymentMethodName,
        amount: numberValue(line.amount)
      })).filter((line) => line.payment_method_id && line.amount > 0);
      if (!validPaymentLines.length) throw new Error('Add at least one valid payment line.');

      const header = {
        document_no: documentNo.trim(),
        external_document_no: externalNo.trim(),
        supplier_id: supplierId || '',
        customer_id: partyCustomerId || '',
        payment_method_id: validPaymentLines[0]?.payment_method_id || '',
        document_date: documentDate || todayInputDate(),
        shipping_method: shippingMethod || '',
        expected_arrival_date: expectedArrivalDate || '',
        notes: notes.trim() || '',
        document_type: documentType
      };
      const itemPayload = validLines.map((line) => ({
        product_id: line.product_id,
        item_code: line.item_code,
        description: line.description,
        qty: numberValue(line.qty),
        unit_cost: numberValue(line.unit_cost)
      }));

      if (isEditing) {
        const { error: replaceError } = await supabase.rpc('replace_purchase_like_document_v18', {
          p_document_id: document.id,
          p_header: header,
          p_items: itemPayload,
          p_payments: validPaymentLines
        });
        if (replaceError) throw replaceError;
        setMessage(`${documentTypeLabel(documentType)} updated as ${documentNo}.`);
        onSaved();
        return;
      }

      const { data, error: saveError } = await supabase.rpc('save_purchase_like_document_v18', {
        p_header: header,
        p_items: itemPayload,
        p_payments: validPaymentLines
      });
      if (saveError) throw saveError;

      setMessage(`${documentTypeLabel(documentType)} saved as ${data?.document_no || documentNo}.`);
      if (tabId) window.localStorage.removeItem(documentDraftKey(tabId));
      onSaved();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  const creditMethod = paymentMethods.find((method) => method.name.toLowerCase() === 'credit');
  const paidMethodChoices = paymentMethods.filter((method) => !method.name.toLowerCase().includes('store credit'));

  return (
    <div className="document-form-panel">
      <div className="section-title-row">
        <div>
          <h3>{isEditing ? `Edit ${documentNo}` : (isTransit ? 'New Stock in Transit' : 'New Purchase')}</h3>
          <p>{isEditing ? 'Edit items/payment. Saving will reverse the old stock and balance effect, then apply this document again.' : (isTransit ? 'Use this when items are ordered/paid but not arrived yet. Convert to Purchase when they arrive.' : 'Use this when items are received immediately.')}</p>
        </div>
        <button className="secondary-button" onClick={onClose}>Close</button>
      </div>

      {message && <div className="notice">{message}</div>}
      {error && <div className="error-box">{error}</div>}

      <form onSubmit={saveDocument}>
        <div className="purchase-form-grid">
          <label>Document number<input value={documentNo} onFocus={selectAllText} onChange={(e) => setDocumentNo(e.target.value)} required /></label>
          <label>Supplier / Profile
            <div className="supplier-combo-field">
              <div className="inline-field">
                <input value={supplierSearch} onFocus={() => setSupplierMenuOpen(true)} onChange={(e) => { setSupplierSearch(e.target.value); setSupplierId(''); setPartyCustomerId(''); setSupplierMenuOpen(true); }} placeholder="Type supplier/customer name or phone" />
                <button type="button" className="small-button" onClick={quickAddSupplier}>New</button>
              </div>
              {supplierMenuOpen && (
                <div className="supplier-suggestion-menu">
                  {filteredSupplierChoices.map((choice) => (
                    <button type="button" key={`${choice.source}-${choice.supplier_id || choice.customer_id}`} onClick={() => selectSupplierChoice(choice)}>
                      <strong>{choice.name}</strong>
                      <span>{choice.phone || '-'}</span>
                      <small>{choice.source === 'merged' ? 'Customer/Supplier profile' : choice.source === 'supplier' ? 'Supplier' : 'Customer/Supplier profile'}</small>
                    </button>
                  ))}
                  {filteredSupplierChoices.length === 0 && <div className="empty-suggestion">No match. Use New to add.</div>}
                </div>
              )}
            </div>
          </label>
          <label>External invoice/order no<input value={externalNo} onFocus={selectAllText} onChange={(e) => setExternalNo(e.target.value)} placeholder="Supplier invoice or order number" /></label>
          <label>Date<input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} /></label>
          {isTransit && <label>Shipping method
            <select value={shippingMethod} onChange={(e) => setShippingMethod(e.target.value)}>
              <option>Air Cargo</option>
              <option>Sea Cargo</option>
              <option>Courier</option>
              <option>Hand Carry</option>
              <option>Local Delivery</option>
            </select>
          </label>}
          {isTransit && <label>Expected arrival<input type="date" value={expectedArrivalDate} onChange={(e) => setExpectedArrivalDate(e.target.value)} /></label>}
          <label>Notes<input value={notes} onFocus={selectAllText} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes" /></label>
        </div>

        <div className="document-edit-layout">
          <div className="document-product-tree-panel">
            <div className="inventory-search-bar compact-search">
              <input value={productSearch} onFocus={selectAllText} onChange={(e) => setProductSearch(e.target.value)} placeholder="Product code / name / barcode" />
              <button type="button" className="secondary-button" onClick={() => { setProductSearch(''); setSelectedCategoryId('all'); }}>Clear</button>
            </div>
            <DocumentProductTree
              categories={categories}
              products={categoryProducts}
              selectedCategoryId={selectedCategoryId}
              setSelectedCategoryId={(id) => { setSelectedCategoryId(id); setProductSearch(''); }}
              onProductClick={startAddProductToLines}
              searchText={productSearch}
            />
          </div>

          <div className="document-lines-panel">
            <div className="document-lines-toolbar">
              <span className="count-label">Items: {lines.filter((line) => line.product_id).length}</span>
            </div>
            <div className="table-wrap purchase-items-wrap">
              <table>
                <thead>
                  <tr><th>Code</th><th>Name</th><th>Qty</th><th>Unit cost</th><th>Total</th><th></th></tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.id}>
                      <td>{line.item_code || '-'}</td>
                      <td>{line.description || '-'}</td>
                      <td><input className="mini-input" type="number" step="0.001" value={line.qty} onFocus={selectAllText} onChange={(e) => updateLine(line.id, { qty: e.target.value })} /></td>
                      <td><input className="mini-input" type="number" step="0.01" value={line.unit_cost} onFocus={selectAllText} onChange={(e) => updateLine(line.id, { unit_cost: e.target.value })} /></td>
                      <td>{money(line.line_total)}</td>
                      <td><button type="button" className="small-button danger" onClick={() => removeLine(line.id)}>Remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {selectedLineProduct && (
          <div className="modal-backdrop">
            <div className="modal-card compact-modal">
              <h3>Add item</h3>
              <p><strong>{selectedLineProduct.item_code}</strong> — {selectedLineProduct.name}</p>
              <label>Unit cost / purchase price
                <input type="number" step="0.01" value={lineDraft.unit_cost} onFocus={selectAllText} onChange={(e) => setLineDraft({ ...lineDraft, unit_cost: e.target.value })} autoFocus />
              </label>
              <label>Quantity
                <input type="number" step="0.001" value={lineDraft.qty} onFocus={selectAllText} onChange={(e) => setLineDraft({ ...lineDraft, qty: e.target.value })} />
              </label>
              <div className="modal-actions">
                <button type="button" className="secondary-button" onClick={() => setSelectedLineProduct(null)}>Cancel</button>
                <button type="button" className="primary-button" onClick={confirmAddProductToLines}>Add item</button>
              </div>
            </div>
          </div>
        )}

        <div className="purchase-summary-row purchase-summary-row-v18">
          <SummaryLine label="Total" value={money(total)} strong />
          <SummaryLine label="Paid now" value={money(paidOut)} />
          <SummaryLine label="Purchase balance" value={money(balance)} />
          <SummaryLine label="Previous outstanding" value={`${previousOutstanding < 0 ? '-' : ''}${money(Math.abs(previousOutstanding))}`} />
          <SummaryLine label="After save balance" value={`${finalOutstandingAfterSave < 0 ? '-' : ''}${money(Math.abs(finalOutstandingAfterSave))}`} />
          <button type="button" className="secondary-button full-button" onClick={() => setShowPaymentPanel(true)}>Payment / Split</button>
          <button className="primary-button" disabled={busy}>{busy ? 'Saving...' : isEditing ? 'Save Edited Document' : isTransit ? 'Save Stock in Transit' : 'Save Purchase'}</button>
        </div>

        {showPaymentPanel && (
          <div className="payment-screen-backdrop">
            <div className="modal-card wide-modal purchase-payment-screen">
              <div className="section-title-row">
                <div>
                  <h3>Purchase payment</h3>
                  <p>Use Cash/Bank/Card for money paid out. Use Credit when nothing is paid now or for the remaining unpaid balance.</p>
                </div>
                <button type="button" className="danger-button" onClick={() => setShowPaymentPanel(false)}>Close</button>
              </div>

              <div className="payment-screen-summary cards-4">
                <StatCard label="Purchase total" value={money(total)} />
                <StatCard label="Paid now" value={money(paidOut)} />
                <StatCard label="Purchase balance" value={money(balance)} />
                <StatCard label="Previous outstanding" value={`${previousOutstanding < 0 ? '-' : ''}${money(Math.abs(previousOutstanding))}`} />
                <StatCard label="After save balance" value={`${finalOutstandingAfterSave < 0 ? '-' : ''}${money(Math.abs(finalOutstandingAfterSave))}`} />
              </div>

              <div className="payment-method-large-grid">
                {paidMethodChoices.map((method) => (
                  <button type="button" key={method.id} className={method.is_paid_method === false ? 'payment-method-tile credit' : 'payment-method-tile'} onClick={() => addPaymentLine(method)}>
                    {method.name}
                    <small>{method.is_paid_method === false ? 'Unpaid balance' : 'Pay purchase / overpay balance'}</small>
                  </button>
                ))}
              </div>

              <div className="quick-payment-row">
                {creditMethod && <button type="button" className="secondary-button" onClick={() => { setPaymentLines([{ id: crypto.randomUUID(), paymentMethodId: creditMethod.id, paymentMethodName: creditMethod.name, amount: total, isPaidMethod: false, affectsCashflow: false }]); }}>Purchase on Credit</button>}
                {paidMethodChoices.filter((method) => method.is_paid_method !== false).map((method) => (
                  <button key={method.id} type="button" className="secondary-button" onClick={() => { setPaymentLines([{ id: crypto.randomUUID(), paymentMethodId: method.id, paymentMethodName: method.name, amount: total, isPaidMethod: true, affectsCashflow: true }]); }}>
                    Pay Purchase by {method.name}
                  </button>
                ))}
                {paidMethodChoices.filter((method) => method.is_paid_method !== false).map((method) => (
                  <button key={`${method.id}-full-balance`} type="button" className="secondary-button" disabled={!partyCustomerId || fullBalancePaymentAmount <= 0} onClick={() => { setPaymentLines([{ id: crypto.randomUUID(), paymentMethodId: method.id, paymentMethodName: method.name, amount: fullBalancePaymentAmount, isPaidMethod: true, affectsCashflow: true }]); }}>
                    Clear Full Balance by {method.name}
                  </button>
                ))}
              </div>

              <div className="table-wrap compact-table payment-lines-table">
                <table>
                  <thead><tr><th>Method</th><th>Amount</th><th>Effect</th><th></th></tr></thead>
                  <tbody>
                    {paymentLines.map((line) => (
                      <tr key={line.id}>
                        <td>{line.paymentMethodName}</td>
                        <td><input type="number" step="0.01" value={line.amount} onFocus={selectAllText} onChange={(e) => setPaymentLines((rows) => rows.map((row) => row.id === line.id ? { ...row, amount: Number(e.target.value) } : row))} /></td>
                        <td>{line.isPaidMethod === false ? 'Outstanding only' : 'Cashflow out'}</td>
                        <td><button type="button" className="link-button" onClick={() => setPaymentLines((rows) => rows.filter((row) => row.id !== line.id))}>Remove</button></td>
                      </tr>
                    ))}
                    {paymentLines.length === 0 && <tr><td colSpan="4" className="empty-cell">Select a payment type or use a quick button.</td></tr>}
                  </tbody>
                </table>
              </div>

              <div className="payment-popup-footer payment-screen-footer">
                <button type="button" className="secondary-button" onClick={() => setPaymentLines([])}>Clear payments</button>
                <button type="button" className="primary-button" onClick={() => setShowPaymentPanel(false)}>Done</button>
              </div>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}


function JobDocumentForm({ tabId = '', onClose, onSaved, onNumberReady }) {
  const savedDraft = tabId ? safeReadJson(documentDraftKey(tabId), null) : null;
  const [customers, setCustomers] = useState([]);
  const [customerId, setCustomerId] = useState(savedDraft?.customerId || '');
  const [customerSearch, setCustomerSearch] = useState(savedDraft?.customerSearch || '');
  const [customerMenuOpen, setCustomerMenuOpen] = useState(false);
  const [jobNo, setJobNo] = useState(savedDraft?.jobNo || '');
  const [documentDate, setDocumentDate] = useState(savedDraft?.documentDate || todayInputDate());
  const [deviceType, setDeviceType] = useState(savedDraft?.deviceType || 'Laptop');
  const [deviceSpecs, setDeviceSpecs] = useState(savedDraft?.deviceSpecs || '');
  const [problem, setProblem] = useState(savedDraft?.problem || '');
  const [accessories, setAccessories] = useState(savedDraft?.accessories || '');
  const [estimatedDays, setEstimatedDays] = useState(savedDraft?.estimatedDays || 3);
  const [jobStatus, setJobStatus] = useState(savedDraft?.jobStatus || 'received');
  const [notes, setNotes] = useState(savedDraft?.notes || '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    loadCustomersForJob();
    if (jobNo) onNumberReady?.(jobNo);
    else prepareJobNumber();
  }, []);

  useEffect(() => {
    if (!tabId) return;
    window.localStorage.setItem(documentDraftKey(tabId), JSON.stringify({
      documentType: 'job', jobNo, documentDate, customerId, customerSearch, deviceType,
      deviceSpecs, problem, accessories, estimatedDays, jobStatus, notes
    }));
  }, [tabId, jobNo, documentDate, customerId, customerSearch, deviceType, deviceSpecs, problem, accessories, estimatedDays, jobStatus, notes]);

  async function prepareJobNumber() {
    const { data, error: numberError } = await supabase.rpc('next_job_no');
    if (numberError) setError(numberError.message);
    else {
      setJobNo(data || '');
      onNumberReady?.(data || 'Job');
    }
  }

  async function loadCustomersForJob() {
    const { data, error: customerError } = await supabase
      .from('customers')
      .select('id, name, phone, address, due_balance, store_credit_balance')
      .order('name', { ascending: true })
      .limit(1000);
    if (customerError) setError(customerError.message);
    else setCustomers(data || []);
  }

  const filteredCustomers = customers.filter((customer) => {
    const clean = customerSearch.trim().toLowerCase();
    const text = `${customer.name || ''} ${customer.phone || ''} ${customer.address || ''}`.toLowerCase();
    return !clean || text.includes(clean);
  }).slice(0, 50);

  function selectCustomer(customer) {
    setCustomerId(customer.id);
    setCustomerSearch(customer.name || '');
    setCustomerMenuOpen(false);
  }

  async function quickAddCustomer() {
    const name = window.prompt('Customer name');
    if (!name?.trim()) return;
    const { data, error: createError } = await supabase
      .from('customers')
      .insert({ name: name.trim(), is_customer: true, is_supplier: false })
      .select('id, name, phone, address, due_balance, store_credit_balance')
      .single();
    if (createError) setError(createError.message);
    else {
      setCustomers((current) => [...current, data].sort((a, b) => a.name.localeCompare(b.name)));
      selectCustomer(data);
    }
  }

  async function saveJob(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    if (!customerId) {
      setError('Select a customer before saving the job.');
      setBusy(false);
      return;
    }
    try {
      const { data, error: saveError } = await supabase.rpc('save_job_document_v22', {
        p_customer_id: customerId,
        p_job_no: jobNo,
        p_document_date: documentDate,
        p_device_type: deviceType,
        p_device_specs: deviceSpecs,
        p_problem: problem,
        p_accessories: accessories,
        p_estimated_days: Number(estimatedDays || 0),
        p_job_status: jobStatus,
        p_notes: notes
      });
      if (saveError) throw saveError;
      setMessage(`Job saved: ${data?.job_no || jobNo}`);
      if (tabId) window.localStorage.removeItem(documentDraftKey(tabId));
      onSaved();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="document-form-panel job-form-panel">
      <div className="section-title-row">
        <div>
          <h3>New Job / Repair Intake</h3>
          <p>Use this when you take a customer device for repair/checking and need a job number for pickup/follow-up.</p>
        </div>
        <button className="secondary-button" onClick={onClose}>Close</button>
      </div>
      {message && <div className="notice">{message}</div>}
      {error && <div className="error-box">{error}</div>}
      <form onSubmit={saveJob} className="trade-in-form-grid job-form-grid">
        <label>Job number<input value={jobNo} onFocus={selectAllText} onChange={(e) => setJobNo(e.target.value)} required /></label>
        <label>Date<input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} /></label>
        <label>Customer
          <div className="supplier-combo-field" tabIndex={-1} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setCustomerMenuOpen(false); }} onKeyDown={(e) => { if (e.key === 'Escape') setCustomerMenuOpen(false); }}>
            <div className="inline-field">
              <input value={customerSearch} onFocus={() => setCustomerMenuOpen(true)} onChange={(e) => { setCustomerSearch(e.target.value); setCustomerId(''); setCustomerMenuOpen(true); }} placeholder="Type customer name or phone" />
              <button type="button" className="small-button" onClick={quickAddCustomer}>New</button>
            </div>
            {customerMenuOpen && (
              <div className="supplier-suggestion-menu">
                {filteredCustomers.map((customer) => (
                  <button type="button" key={customer.id} onClick={() => selectCustomer(customer)}>
                    <strong>{customer.name}</strong>
                    <span>{customer.phone || '-'}</span>
                    <small>{customer.address || ''}</small>
                  </button>
                ))}
                {filteredCustomers.length === 0 && <div className="empty-suggestion">No match. Use New to add.</div>}
              </div>
            )}
          </div>
        </label>
        <label>Device type<input value={deviceType} onFocus={selectAllText} onChange={(e) => setDeviceType(e.target.value)} placeholder="Laptop, PC, printer..." /></label>
        <label className="wide-field">Specs / identification<textarea value={deviceSpecs} onFocus={selectAllText} onChange={(e) => setDeviceSpecs(e.target.value)} placeholder="Example: Dell 5480, i5 7th gen, 8GB, 256GB SSD, serial/service tag" required /></label>
        <label className="wide-field">Problem / requested work<textarea value={problem} onFocus={selectAllText} onChange={(e) => setProblem(e.target.value)} placeholder="Example: no display, keyboard issue, Windows install" required /></label>
        <label className="wide-field">Accessories received<textarea value={accessories} onFocus={selectAllText} onChange={(e) => setAccessories(e.target.value)} placeholder="Charger, bag, RAM cover, battery, none..." /></label>
        <label>Estimated days<input type="number" value={estimatedDays} onFocus={selectAllText} onChange={(e) => setEstimatedDays(e.target.value)} /></label>
        <label>Status
          <select value={jobStatus} onChange={(e) => setJobStatus(e.target.value)}>
            <option value="received">Received</option>
            <option value="checking">Checking</option>
            <option value="waiting_parts">Waiting parts</option>
            <option value="ready">Ready</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
        <label className="wide-field">Notes<textarea value={notes} onFocus={selectAllText} onChange={(e) => setNotes(e.target.value)} placeholder="Customer instructions, password note, agreed estimate, etc." /></label>
        <button className="primary-button" disabled={busy}>{busy ? 'Saving...' : 'Save Job'}</button>
      </form>
    </div>
  );
}


function quotationLineTotal(line) {
  const gross = numberValue(line.qty) * numberValue(line.unit_price);
  const discount = line.discount_type === 'percent' ? gross * numberValue(line.discount_value) / 100 : numberValue(line.discount_value);
  return Math.max(gross - discount, 0);
}

function emptyQuotationLine() {
  return {
    id: crypto.randomUUID(),
    product_id: '',
    item_code: '',
    description: '',
    qty: 1,
    unit_price: 0,
    unit_cost: 0,
    discount_type: 'amount',
    discount_value: 0,
    line_total: 0
  };
}

function QuotationDocumentForm({ document = null, tabId = '', onClose, onSaved, onNumberReady }) {
  const isEditing = Boolean(document?.id);
  const rawSavedDraft = tabId ? safeReadJson(documentDraftKey(tabId), null) : null;
  const savedDraft = rawSavedDraft && (!isEditing || rawSavedDraft.editDocumentId === document?.id) ? rawSavedDraft : null;
  const isDraftForQuote = savedDraft?.documentType === 'quotation';

  const [documentNo, setDocumentNo] = useState((isDraftForQuote ? savedDraft?.documentNo : '') || document?.document_no || '');
  const [externalNo, setExternalNo] = useState((isDraftForQuote ? savedDraft?.externalNo : '') || document?.external_document_no || '');
  const [documentDate, setDocumentDate] = useState((isDraftForQuote ? savedDraft?.documentDate : '') || (document?.document_date || document?.created_at || '').slice(0, 10) || todayInputDate());
  const [customerId, setCustomerId] = useState((isDraftForQuote ? savedDraft?.customerId : '') || document?.customer_id || '');
  const [customerSearch, setCustomerSearch] = useState((isDraftForQuote ? savedDraft?.customerSearch : '') || document?.party_name || '');
  const [customerMenuOpen, setCustomerMenuOpen] = useState(false);
  const [customers, setCustomers] = useState([]);
  const [notes, setNotes] = useState((isDraftForQuote ? savedDraft?.notes : '') || document?.notes || '');

  const [productSearch, setProductSearch] = useState('');
  const [categories, setCategories] = useState([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState('all');
  const [categoryProducts, setCategoryProducts] = useState([]);
  const [selectedLineProduct, setSelectedLineProduct] = useState(null);
  const [lineDraft, setLineDraft] = useState({ qty: 1, unit_price: 0, unit_cost: 0, discount_type: 'amount', discount_value: 0 });
  const [lines, setLines] = useState(isDraftForQuote && Array.isArray(savedDraft?.lines) ? savedDraft.lines : [emptyQuotationLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    loadCustomersForQuotation();
    loadCategoriesForQuotation();
    if (isEditing) loadExistingQuotationItems();
    if (documentNo) onNumberReady?.(documentNo);
    else prepareQuotationNumber();
  }, []);

  useEffect(() => {
    if (categories.length) loadCategoryProductsForQuotation();
  }, [categories, selectedCategoryId, productSearch]);

  useEffect(() => {
    if (!tabId) return;
    window.localStorage.setItem(documentDraftKey(tabId), JSON.stringify({
      documentType: 'quotation',
      editDocumentId: document?.id || '',
      documentNo,
      externalNo,
      documentDate,
      customerId,
      customerSearch,
      notes,
      lines
    }));
  }, [tabId, document?.id, documentNo, externalNo, documentDate, customerId, customerSearch, notes, lines]);

  const total = lines.reduce((sum, line) => sum + quotationLineTotal(line), 0);

  async function prepareQuotationNumber() {
    const { data, error: numberError } = await supabase.rpc('next_document_no', { p_document_type: 'quotation' });
    if (numberError) setError(numberError.message);
    else if (data) {
      setDocumentNo(data);
      onNumberReady?.(data);
    }
  }

  async function loadCustomersForQuotation() {
    const { data, error: customerError } = await supabase.from('customers').select('id, name, phone, address').order('name').limit(1500);
    if (customerError) setError(customerError.message);
    else setCustomers(data || []);
  }

  async function loadCategoriesForQuotation() {
    const { data, error: categoryError } = await supabase
      .from('categories')
      .select('id, name, parent_id, path')
      .order('path', { ascending: true });
    if (categoryError) setError(categoryError.message);
    else setCategories(data || []);
  }

  async function loadCategoryProductsForQuotation() {
    let query = supabase
      .from('product_stock_view')
      .select('*')
      .eq('is_active', true)
      .order('item_code', { ascending: true })
      .limit(1200);

    const clean = productSearch.trim();
    if (clean) {
      query = query.or(`item_code.ilike.%${clean}%,name.ilike.%${clean}%,barcode.ilike.%${clean}%`);
    } else if (selectedCategoryId === 'uncategorized') {
      query = query.is('category_id', null);
    } else {
      const ids = categoryDescendantIds(categories, selectedCategoryId);
      if (ids.length) query = query.in('category_id', ids);
    }

    const { data, error: productsError } = await query;
    if (productsError) setError(productsError.message);
    else setCategoryProducts(data || []);
  }

  async function loadExistingQuotationItems() {
    if (!document?.id || (isDraftForQuote && savedDraft?.lines?.length)) return;
    const { data, error: itemError } = await supabase
      .from('document_items')
      .select('*')
      .eq('document_id', document.id)
      .order('created_at', { ascending: true });
    if (itemError) {
      setError(itemError.message);
      return;
    }
    const mapped = (data || []).map((item) => ({
      id: item.id || crypto.randomUUID(),
      product_id: item.product_id || '',
      item_code: item.item_code || '',
      description: item.description || '',
      qty: numberValue(item.qty, 1),
      unit_price: numberValue(item.unit_price),
      unit_cost: numberValue(item.unit_cost),
      discount_type: item.discount_type || 'amount',
      discount_value: numberValue(item.discount_value),
      line_total: numberValue(item.line_total)
    }));
    setLines(mapped.length ? mapped : [emptyQuotationLine()]);
  }

  const filteredCustomers = customers.filter((customer) => {
    const clean = customerSearch.trim().toLowerCase();
    const text = `${customer.name || ''} ${customer.phone || ''} ${customer.address || ''}`.toLowerCase();
    return !clean || text.includes(clean);
  }).slice(0, 80);

  function selectCustomer(customer) {
    setCustomerId(customer.id);
    setCustomerSearch(customer.name || '');
    setCustomerMenuOpen(false);
  }

  async function quickAddCustomer() {
    const name = window.prompt('Customer name');
    if (!name?.trim()) return;
    const { data, error: addError } = await supabase.from('customers').insert({ name: name.trim(), is_customer: true }).select('id, name, phone, address').single();
    if (addError) setError(addError.message);
    else {
      setCustomers((current) => [...current, data].sort((a, b) => a.name.localeCompare(b.name)));
      selectCustomer(data);
    }
  }

  function startAddProductToQuote(product) {
    setSelectedLineProduct(product);
    setLineDraft({
      qty: 1,
      unit_price: numberValue(product.selling_price),
      unit_cost: numberValue(product.avg_cost),
      discount_type: 'amount',
      discount_value: 0
    });
  }

  function confirmAddProductToQuote() {
    if (!selectedLineProduct) return;
    const qty = numberValue(lineDraft.qty);
    const unitPrice = numberValue(lineDraft.unit_price);
    if (qty <= 0) {
      setError('Quantity must be greater than zero.');
      return;
    }
    const newLine = {
      id: crypto.randomUUID(),
      product_id: selectedLineProduct.product_id,
      item_code: selectedLineProduct.item_code,
      description: selectedLineProduct.name,
      qty,
      unit_price: unitPrice,
      unit_cost: numberValue(lineDraft.unit_cost),
      discount_type: lineDraft.discount_type || 'amount',
      discount_value: numberValue(lineDraft.discount_value),
      line_total: quotationLineTotal({ ...lineDraft, qty, unit_price: unitPrice })
    };
    const current = lines.length === 1 && !lines[0].product_id && !lines[0].description ? [] : lines;
    setLines([...current, newLine]);
    setProductSearch('');
    setSelectedLineProduct(null);
    setLineDraft({ qty: 1, unit_price: 0, unit_cost: 0, discount_type: 'amount', discount_value: 0 });
  }

  function updateLine(lineId, patch) {
    setLines((current) => current.map((line) => {
      if (line.id !== lineId) return line;
      const next = { ...line, ...patch };
      next.line_total = quotationLineTotal(next);
      return next;
    }));
  }

  function removeLine(lineId) {
    const next = lines.filter((line) => line.id !== lineId);
    setLines(next.length ? next : [emptyQuotationLine()]);
  }

  async function saveQuotation(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    const validLines = lines.filter((line) => line.product_id && numberValue(line.qty) > 0);
    if (!validLines.length) {
      setError('Add at least one product to the quotation.');
      setBusy(false);
      return;
    }
    try {
      if (!documentNo.trim()) throw new Error('Quotation number is required. Close and open New again if it did not load.');
      const header = {
        document_no: documentNo.trim(),
        external_document_no: externalNo.trim() || null,
        document_type: 'quotation',
        status: document?.status === 'converted' ? 'converted' : 'draft',
        customer_id: customerId || null,
        supplier_id: null,
        payment_method_id: null,
        payment_method_name: null,
        total_amount: total,
        paid_amount: 0,
        balance_amount: total,
        currency: 'LKR',
        document_date: documentDate || todayInputDate(),
        notes: notes.trim() || ''
      };
      const itemPayload = validLines.map((line) => ({
        product_id: line.product_id,
        item_code: line.item_code,
        description: line.description,
        qty: numberValue(line.qty),
        unit_price: numberValue(line.unit_price),
        unit_cost: numberValue(line.unit_cost),
        discount_type: numberValue(line.discount_value) ? line.discount_type : 'none',
        discount_value: numberValue(line.discount_value),
        line_total: quotationLineTotal(line)
      }));

      let docId = document?.id || '';
      if (isEditing) {
        const { error: updateError } = await supabase.from('documents').update(header).eq('id', document.id);
        if (updateError) throw updateError;
        const { error: deleteItemError } = await supabase.from('document_items').delete().eq('document_id', document.id);
        if (deleteItemError) throw deleteItemError;
        docId = document.id;
      } else {
        const { data: docData, error: insertError } = await supabase.from('documents').insert(header).select('id, document_no').single();
        if (insertError) throw insertError;
        docId = docData.id;
      }

      const { error: itemError } = await supabase.from('document_items').insert(itemPayload.map((item) => ({ ...item, document_id: docId })));
      if (itemError) throw itemError;
      setMessage(`Quotation saved: ${documentNo}.`);
      if (tabId) window.localStorage.removeItem(documentDraftKey(tabId));
      onSaved();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="document-form-panel quotation-form-panel">
      <div className="section-title-row">
        <div>
          <h3>{isEditing ? `Edit ${documentNo}` : 'New Quotation'}</h3>
          <p>Quotations save to Documents, do not need payment, and do not update stock. Convert the quotation to Sales when the customer confirms.</p>
        </div>
        <button className="secondary-button" onClick={onClose}>Close</button>
      </div>
      {message && <div className="notice">{message}</div>}
      {error && <div className="error-box">{error}</div>}
      <form onSubmit={saveQuotation}>
        <div className="purchase-form-grid">
          <label>Quotation number<input value={documentNo} onFocus={selectAllText} onChange={(e) => setDocumentNo(e.target.value)} required /></label>
          <label>Customer / profile
            <div className="supplier-combo-field" tabIndex={-1} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setCustomerMenuOpen(false); }} onKeyDown={(e) => { if (e.key === 'Escape') setCustomerMenuOpen(false); }}>
              <div className="inline-field">
                <input value={customerSearch} onFocus={() => setCustomerMenuOpen(true)} onChange={(e) => { setCustomerSearch(e.target.value); setCustomerId(''); setCustomerMenuOpen(true); }} placeholder="Walk-in or type customer name" />
                <button type="button" className="small-button" onClick={quickAddCustomer}>New</button>
              </div>
              {customerMenuOpen && (
                <div className="supplier-suggestion-menu">
                  <button type="button" onClick={() => { setCustomerId(''); setCustomerSearch(''); setCustomerMenuOpen(false); }}>
                    <strong>Walk-in customer</strong><span>-</span><small>No saved balance</small>
                  </button>
                  {filteredCustomers.map((customer) => (
                    <button type="button" key={customer.id} onClick={() => selectCustomer(customer)}>
                      <strong>{customer.name}</strong>
                      <span>{customer.phone || '-'}</span>
                      <small>{customer.address || 'Customer profile'}</small>
                    </button>
                  ))}
                  {filteredCustomers.length === 0 && <div className="empty-suggestion">No match. Use New to add.</div>}
                </div>
              )}
            </div>
          </label>
          <label>Reference no<input value={externalNo} onFocus={selectAllText} onChange={(e) => setExternalNo(e.target.value)} placeholder="Optional" /></label>
          <label>Date<input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} /></label>
          <label className="wide-field">Notes<input value={notes} onFocus={selectAllText} onChange={(e) => setNotes(e.target.value)} placeholder="Quotation notes or validity" /></label>
        </div>

        <div className="document-edit-layout">
          <div className="document-product-tree-panel">
            <div className="inventory-search-bar compact-search">
              <input value={productSearch} onFocus={selectAllText} onChange={(e) => setProductSearch(e.target.value)} placeholder="Product code / name / barcode" />
              <button type="button" className="secondary-button" onClick={() => { setProductSearch(''); setSelectedCategoryId('all'); }}>Clear</button>
            </div>
            <DocumentProductTree
              categories={categories}
              products={categoryProducts}
              selectedCategoryId={selectedCategoryId}
              setSelectedCategoryId={(id) => { setSelectedCategoryId(id); setProductSearch(''); }}
              onProductClick={startAddProductToQuote}
              searchText={productSearch}
            />
          </div>

          <div className="document-lines-panel">
            <div className="document-lines-toolbar">
              <span className="count-label">Quotation items: {lines.filter((line) => line.product_id).length}</span>
              <strong>Total: {money(total)}</strong>
            </div>
            <div className="table-wrap purchase-items-wrap">
              <table>
                <thead>
                  <tr><th>Code</th><th>Name</th><th>Qty</th><th>Price</th><th>Disc.</th><th>Type</th><th>Total</th><th></th></tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.id}>
                      <td>{line.item_code || '-'}</td>
                      <td>{line.description || '-'}</td>
                      <td><input className="mini-input" type="number" step="0.001" value={line.qty} onFocus={selectAllText} onChange={(e) => updateLine(line.id, { qty: e.target.value })} /></td>
                      <td><input className="mini-input" type="number" step="0.01" value={line.unit_price} onFocus={selectAllText} onChange={(e) => updateLine(line.id, { unit_price: e.target.value })} /></td>
                      <td><input className="mini-input" type="number" step="0.01" value={line.discount_value} onFocus={selectAllText} onChange={(e) => updateLine(line.id, { discount_value: e.target.value })} /></td>
                      <td><select value={line.discount_type} onChange={(e) => updateLine(line.id, { discount_type: e.target.value })}><option value="amount">Amount</option><option value="percent">%</option></select></td>
                      <td>{money(quotationLineTotal(line))}</td>
                      <td><button type="button" className="small-button danger" onClick={() => removeLine(line.id)}>Remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {selectedLineProduct && (
          <div className="modal-backdrop">
            <div className="modal-card compact-modal">
              <h3>Add quotation item</h3>
              <p><strong>{selectedLineProduct.item_code}</strong> — {selectedLineProduct.name}</p>
              <label>Selling price
                <input type="number" step="0.01" value={lineDraft.unit_price} onFocus={selectAllText} onChange={(e) => setLineDraft({ ...lineDraft, unit_price: e.target.value })} autoFocus />
              </label>
              <label>Quantity
                <input type="number" step="0.001" value={lineDraft.qty} onFocus={selectAllText} onChange={(e) => setLineDraft({ ...lineDraft, qty: e.target.value })} />
              </label>
              <label>Discount
                <input type="number" step="0.01" value={lineDraft.discount_value} onFocus={selectAllText} onChange={(e) => setLineDraft({ ...lineDraft, discount_value: e.target.value })} />
              </label>
              <label>Discount type
                <select value={lineDraft.discount_type} onChange={(e) => setLineDraft({ ...lineDraft, discount_type: e.target.value })}>
                  <option value="amount">Amount</option>
                  <option value="percent">%</option>
                </select>
              </label>
              <div className="modal-actions">
                <button type="button" className="secondary-button" onClick={() => setSelectedLineProduct(null)}>Cancel</button>
                <button type="button" className="primary-button" onClick={confirmAddProductToQuote}>Add item</button>
              </div>
            </div>
          </div>
        )}

        <div className="document-total-row">
          <span>Quotation total</span>
          <strong>{money(total)}</strong>
        </div>
        <div className="form-footer-actions">
          <button type="button" className="secondary-button" onClick={onClose}>Close</button>
          <button className="primary-button" disabled={busy}>{busy ? 'Saving...' : isEditing ? 'Save Quotation Changes' : 'Save Quotation'}</button>
        </div>
      </form>
    </div>
  );
}

function TradeInIntakeForm({ tabId = '', onClose, onSaved, onNumberReady }) {
  const savedDraft = tabId ? safeReadJson(documentDraftKey(tabId), null) : null;
  const [documentNo, setDocumentNo] = useState(savedDraft?.documentNo || '');
  const [documentDate, setDocumentDate] = useState(savedDraft?.documentDate || todayInputDate());
  const [customerId, setCustomerId] = useState(savedDraft?.customerId || '');
  const [customerSearch, setCustomerSearch] = useState(savedDraft?.customerSearch || '');
  const [customerMenuOpen, setCustomerMenuOpen] = useState(false);
  const [customers, setCustomers] = useState([]);
  const [description, setDescription] = useState(savedDraft?.description || '');
  const [estimatedValue, setEstimatedValue] = useState(savedDraft?.estimatedValue || 0);
  const [externalNo, setExternalNo] = useState(savedDraft?.externalNo || '');
  const [notes, setNotes] = useState(savedDraft?.notes || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    loadCustomersForTradeIn();
    if (documentNo) onNumberReady?.(documentNo);
    else prepareTradeInNumber();
  }, []);

  useEffect(() => {
    if (!tabId) return;
    window.localStorage.setItem(documentDraftKey(tabId), JSON.stringify({ documentType: 'trade_in', documentNo, documentDate, customerId, customerSearch, description, estimatedValue, externalNo, notes }));
  }, [tabId, documentNo, documentDate, customerId, customerSearch, description, estimatedValue, externalNo, notes]);

  async function prepareTradeInNumber() {
    const { data, error: numberError } = await supabase.rpc('next_document_no', { p_document_type: 'trade_in' });
    if (numberError) setError(numberError.message);
    else if (data) {
      setDocumentNo(data);
      onNumberReady?.(data);
    }
  }

  async function loadCustomersForTradeIn() {
    const { data, error: customerError } = await supabase.from('customers').select('id, name, phone, address, due_balance, store_credit_balance').order('name').limit(1500);
    if (customerError) setError(customerError.message);
    else setCustomers(data || []);
  }

  const filteredCustomers = customers.filter((customer) => {
    const clean = customerSearch.trim().toLowerCase();
    const text = `${customer.name || ''} ${customer.phone || ''} ${customer.address || ''}`.toLowerCase();
    return !clean || text.includes(clean);
  }).slice(0, 80);

  function selectCustomer(customer) {
    setCustomerId(customer.id);
    setCustomerSearch(customer.name || '');
    setCustomerMenuOpen(false);
  }

  async function quickAddCustomer() {
    const name = window.prompt('Customer name');
    if (!name?.trim()) return;
    const { data, error: addError } = await supabase.from('customers').insert({ name: name.trim(), is_customer: true, is_supplier: true }).select('id, name, phone, address, due_balance, store_credit_balance').single();
    if (addError) setError(addError.message);
    else {
      setCustomers((current) => [...current, data].sort((a, b) => a.name.localeCompare(b.name)));
      selectCustomer(data);
    }
  }

  async function saveTradeIn(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    if (!customerId) {
      setError('Select customer/profile first. The estimated value has to be stored under his outstanding balance.');
      setBusy(false);
      return;
    }
    if (numberValue(estimatedValue) <= 0) {
      setError('Estimated value must be greater than zero.');
      setBusy(false);
      return;
    }
    try {
      const { data, error: saveError } = await supabase.rpc('save_trade_in_intake_v18', {
        p_customer_id: customerId,
        p_document_no: documentNo,
        p_external_no: externalNo,
        p_document_date: documentDate,
        p_description: description || 'Trade-in / buyback intake',
        p_estimated_value: numberValue(estimatedValue),
        p_notes: notes
      });
      if (saveError) throw saveError;
      setMessage(`Buyback intake saved: ${data?.document_no || documentNo}`);
      if (tabId) window.localStorage.removeItem(documentDraftKey(tabId));
      onSaved();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="document-form-panel trade-in-form-panel">
      <div className="section-title-row">
        <div>
          <h3>New Trade-in / Buyback Intake</h3>
          <p>Use this when the customer gives an item now, you give a rough value, but you will split/record actual parts later. No stock is added now.</p>
        </div>
        <button className="secondary-button" onClick={onClose}>Close</button>
      </div>
      {message && <div className="notice">{message}</div>}
      {error && <div className="error-box">{error}</div>}
      <form onSubmit={saveTradeIn} className="trade-in-form-grid">
        <label>Document number<input value={documentNo} onFocus={selectAllText} onChange={(e) => setDocumentNo(e.target.value)} required /></label>
        <label>Date<input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} /></label>
        <label>Customer / profile
          <div className="supplier-combo-field" tabIndex={-1} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setCustomerMenuOpen(false); }} onKeyDown={(e) => { if (e.key === 'Escape') setCustomerMenuOpen(false); }}>
            <div className="inline-field">
              <input value={customerSearch} onFocus={() => setCustomerMenuOpen(true)} onChange={(e) => { setCustomerSearch(e.target.value); setCustomerId(''); setCustomerMenuOpen(true); }} placeholder="Type customer name or phone" />
              <button type="button" className="small-button" onClick={quickAddCustomer}>New</button>
            </div>
            {customerMenuOpen && (
              <div className="supplier-suggestion-menu">
                {filteredCustomers.map((customer) => (
                  <button type="button" key={customer.id} onClick={() => selectCustomer(customer)}>
                    <strong>{customer.name}</strong>
                    <span>{customer.phone || '-'}</span>
                    <small>Outstanding: {money(numberValue(customer.due_balance) - numberValue(customer.store_credit_balance))}</small>
                  </button>
                ))}
                {filteredCustomers.length === 0 && <div className="empty-suggestion">No match. Use New to add.</div>}
              </div>
            )}
          </div>
        </label>
        <label>External/reference no<input value={externalNo} onFocus={selectAllText} onChange={(e) => setExternalNo(e.target.value)} placeholder="Optional" /></label>
        <label className="wide-field">Item description<textarea value={description} onFocus={selectAllText} onChange={(e) => setDescription(e.target.value)} placeholder="Example: Used desktop PC, i5 6th gen, no VGA, rough value only" required /></label>
        <label>Estimated value<input type="number" step="0.01" value={estimatedValue} onFocus={selectAllText} onChange={(e) => setEstimatedValue(e.target.value)} required /></label>
        <label className="wide-field">Notes<textarea value={notes} onFocus={selectAllText} onChange={(e) => setNotes(e.target.value)} placeholder="Later you can create product/purchase lines from this PC when parts are decided." /></label>
        <div className="trade-in-explain-box wide-field">
          <strong>Effect when saved:</strong>
          <span>No stock is added. No cashflow happens. The customer outstanding balance becomes more negative by {money(estimatedValue)}, meaning the shop owes this value to the customer.</span>
        </div>
        <button className="primary-button" disabled={busy}>{busy ? 'Saving...' : 'Save Buyback Intake'}</button>
      </form>
    </div>
  );
}

const PRODUCT_SEARCH_FIELDS = [
  { value: 'any', label: 'Any' },
  { value: 'code', label: 'SKU / Code' },
  { value: 'name', label: 'Name' },
  { value: 'barcode', label: 'Barcode' }
];

const PRODUCT_STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' }
];

function emptyProductForm(categoryId = '') {
  return {
    id: null,
    name: '',
    category_id: categoryId === 'all' || categoryId === 'uncategorized' ? '' : categoryId,
    item_code: '',
    barcode: '',
    avg_cost: 0,
    markup: 0,
    selling_price: 0,
    min_stock_level: 1,
    status: 'active'
  };
}

function numberValue(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const cleaned = String(value).replace(/,/g, '').replace(/LKR/gi, '').trim();
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function markupPercent(cost, price) {
  const c = numberValue(cost);
  const p = numberValue(price);
  if (c <= 0) return 0;
  return ((p - c) / c) * 100;
}

function priceFromMarkup(cost, markup) {
  const c = numberValue(cost);
  const m = numberValue(markup);
  return c + (c * m / 100);
}

function formatPercent(value) {
  return `${Number(value || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function firstCell(row, aliases) {
  const normalized = new Map(Object.keys(row).map((key) => [normalizeHeader(key), row[key]]));
  for (const alias of aliases) {
    const key = normalizeHeader(alias);
    if (normalized.has(key)) return normalized.get(key);
  }
  return '';
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadTextFile(filename, content, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function applySearchToProductQuery(query, searchBy, keyword) {
  const clean = keyword.trim();
  if (!clean) return query;
  const value = clean.replace(/,/g, ' ');
  if (searchBy === 'name') return query.ilike('name', `%${value}%`);
  if (searchBy === 'code') return query.ilike('item_code', `%${value}%`);
  if (searchBy === 'barcode') return query.ilike('barcode', `%${value}%`);
  return query.or(`item_code.ilike.%${value}%,name.ilike.%${value}%,barcode.ilike.%${value}%`);
}

function categoryDisplayName(category) {
  return category?.path || category?.name || 'Uncategorized';
}

function categoryDepth(category) {
  return category?.path ? Math.max(category.path.split('/').length - 1, 0) : 0;
}

function categoryDescendantIds(categories, selectedCategoryId) {
  if (!selectedCategoryId || selectedCategoryId === 'all' || selectedCategoryId === 'uncategorized') return [];
  const selected = categories.find((cat) => cat.id === selectedCategoryId);
  if (!selected) return [selectedCategoryId];
  const basePath = selected.path || selected.name;
  return categories
    .filter((cat) => cat.id === selectedCategoryId || (basePath && (cat.path || cat.name || '').startsWith(`${basePath}/`)))
    .map((cat) => cat.id);
}

function categoryCountsWithParents(categories, rows) {
  const counts = {};
  const lookup = new Map(categories.map((cat) => [cat.id, cat]));
  rows.forEach((row) => {
    const categoryId = row.category_id;
    if (!categoryId) {
      counts.uncategorized = (counts.uncategorized || 0) + 1;
      return;
    }

    counts[categoryId] = (counts[categoryId] || 0) + 1;
    let current = lookup.get(categoryId);
    const visited = new Set([categoryId]);
    while (current?.parent_id && !visited.has(current.parent_id)) {
      counts[current.parent_id] = (counts[current.parent_id] || 0) + 1;
      visited.add(current.parent_id);
      current = lookup.get(current.parent_id);
    }
  });
  return counts;
}

async function getOrCreateCategoryPath(path) {
  const cleanPath = String(path || '').split('/').map((part) => part.trim()).filter(Boolean).join('/');
  if (!cleanPath) return null;
  const { data, error } = await supabase.rpc('get_or_create_category_path', { p_path: cleanPath });
  if (error) throw error;
  return data;
}

function ProductsPage() {
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState('all');
  const [searchBy, setSearchBy] = useState('any');
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState('category');
  const [showForm, setShowForm] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [form, setForm] = useState(emptyProductForm());
  const [updateImportStock, setUpdateImportStock] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { loadCategories(); }, []);
  useEffect(() => {
    const timeout = setTimeout(() => loadProducts(), 180);
    return () => clearTimeout(timeout);
  }, [selectedCategoryId, searchBy, search, filterMode, categories.length]);

  async function loadCategories() {
    const { data, error: categoryError } = await supabase.from('categories').select('id, name, parent_id, path').order('path', { ascending: true });
    if (categoryError) setError(categoryError.message);
    else setCategories(data || []);
  }

  async function loadProducts() {
    setError('');
    let query = supabase
      .from('product_stock_view')
      .select('*')
      .order('category_path', { ascending: true })
      .order('item_code', { ascending: true })
      .limit(1000);

    const cleanSearch = search.trim();
    const usingLiveSearch = filterMode === 'search' && cleanSearch.length > 0;

    if (!usingLiveSearch) {
      if (selectedCategoryId === 'uncategorized') query = query.is('category_id', null);
      else if (selectedCategoryId !== 'all') {
        const ids = categoryDescendantIds(categories, selectedCategoryId);
        query = query.in('category_id', ids.length ? ids : [selectedCategoryId]);
      }
    }

    if (usingLiveSearch) query = applySearchToProductQuery(query, searchBy, cleanSearch);

    const { data, error: productError } = await query;
    if (productError) setError(productError.message);
    else {
      const nextRows = data || [];
      setProducts(nextRows);
      setSelectedProduct((current) => current && nextRows.some((row) => row.product_id === current.product_id) ? current : null);
    }
  }

  async function openNewProduct() {
    setEditingProduct(null);
    setMessage('');
    setError('');
    const nextForm = emptyProductForm(selectedCategoryId);
    const { data, error: codeError } = await supabase.rpc('next_product_code');
    if (!codeError && data) nextForm.item_code = data;
    setForm(nextForm);
    setShowForm(true);
  }

  function openEditProduct(product) {
    setEditingProduct(product);
    setForm({
      id: product.product_id,
      name: product.name || '',
      category_id: product.category_id || '',
      item_code: product.item_code || '',
      barcode: product.barcode || '',
      avg_cost: numberValue(product.avg_cost),
      markup: markupPercent(product.avg_cost, product.selling_price),
      selling_price: numberValue(product.selling_price),
      min_stock_level: numberValue(product.min_stock_level, 1),
      status: product.status || (product.is_active ? 'active' : 'inactive')
    });
    setShowForm(true);
    setMessage('');
    setError('');
  }

  async function createCategory() {
    const path = window.prompt('New category/group path. Use / for nested groups. Example: Accessories/Cables');
    if (!path?.trim()) return;
    try {
      await getOrCreateCategoryPath(path);
      setMessage('Category added.');
      await loadCategories();
    } catch (err) {
      setError(err.message || String(err));
    }
  }

  async function saveProduct(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');

    const payload = {
      item_code: form.item_code.trim(),
      name: form.name.trim(),
      category_id: form.category_id || null,
      barcode: form.barcode.trim() || null,
      avg_cost: numberValue(form.avg_cost),
      selling_price: numberValue(form.selling_price),
      min_stock_level: numberValue(form.min_stock_level, 1),
      status: form.status,
      is_active: form.status === 'active',
      online_visible: false
    };

    let result;
    if (editingProduct) {
      result = await supabase.from('products').update(payload).eq('id', editingProduct.product_id).select('id').single();
    } else {
      result = await supabase.from('products').insert(payload).select('id').single();
    }

    if (result.error) {
      setError(result.error.message);
      setBusy(false);
      return;
    }

    if (!editingProduct) {
      await supabase.from('stock_balances').upsert({ product_id: result.data.id, sellable_qty: 0 }, { onConflict: 'product_id' });
    }

    setBusy(false);
    setShowForm(false);
    setEditingProduct(null);
    setForm(emptyProductForm(selectedCategoryId));
    setMessage(editingProduct ? 'Product updated.' : 'Product added with zero stock. Stock will increase from purchase documents later.');
    loadProducts();
  }

  async function deactivateProduct(product) {
    if (!window.confirm(`Set ${product.name} as inactive?`)) return;
    const { error: updateError } = await supabase
      .from('products')
      .update({ status: 'inactive', is_active: false })
      .eq('id', product.product_id);
    if (updateError) setError(updateError.message);
    else {
      setMessage('Product set as inactive.');
      loadProducts();
    }
  }

  async function handleImportFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setBusy(true);
    setError('');
    setMessage('Reading file...');

    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      if (!rows.length) throw new Error('The selected file has no rows.');

      const categoryPaths = [...new Set(rows
        .map((row) => String(firstCell(row, ['category', 'productgroup', 'group', 'product group', 'group name'])).trim())
        .filter(Boolean))];

      const categoryMap = new Map();
      for (const categoryPath of categoryPaths) {
        const categoryId = await getOrCreateCategoryPath(categoryPath);
        categoryMap.set(categoryPath.toLowerCase(), categoryId);
      }

      let imported = 0;
      let skipped = 0;
      for (const row of rows) {
        const itemCode = String(firstCell(row, ['sku', 'code', 'item code', 'product code', 'product_code'])).trim();
        const name = String(firstCell(row, ['name', 'product name', 'description', 'item name'])).trim();
        if (!itemCode || !name) {
          skipped += 1;
          continue;
        }

        const categoryName = String(firstCell(row, ['category', 'productgroup', 'group', 'product group', 'group name'])).trim();
        const categoryId = categoryName ? categoryMap.get(categoryName.toLowerCase()) || null : null;
        const cost = numberValue(firstCell(row, ['cost', 'cost price', 'average cost', 'avg cost']), 0);
        const qtyRaw = firstCell(row, ['quantity', 'qty', 'stock', 'stock quantity', 'sellable stock']);
        const qty = numberValue(qtyRaw, 0);
        const totalValue = numberValue(firstCell(row, ['total', 'stock value', 'total cost']), 0);
        const importedMarkup = numberValue(firstCell(row, ['markup', 'mark up', 'markup percent', 'markup %']), 0);
        let price = numberValue(firstCell(row, ['price', 'sale price', 'selling price', 'selling_price']), 0);
        if (price <= 0 && importedMarkup > 0 && cost > 0) price = priceFromMarkup(cost, importedMarkup);
        if (price <= 0 && totalValue > 0 && qty > 0) price = totalValue / qty;

        const statusRaw = String(firstCell(row, ['status', 'active'])).trim().toLowerCase();
        const status = ['inactive', 'disabled', 'false', '0', 'no'].includes(statusRaw) ? 'inactive' : 'active';
        const barcode = String(firstCell(row, ['barcode', 'bar code'])).trim();
        const lowStock = numberValue(firstCell(row, ['low stock', 'low stock level', 'min stock', 'minimum stock']), 1);

        const { data: productData, error: productError } = await supabase
          .from('products')
          .upsert({
            item_code: itemCode,
            name,
            category_id: categoryId,
            barcode: barcode || null,
            avg_cost: cost,
            selling_price: price,
            min_stock_level: lowStock,
            status,
            is_active: status === 'active',
            online_visible: false
          }, { onConflict: 'item_code' })
          .select('id')
          .single();

        if (productError) throw productError;

        if (updateImportStock && qtyRaw !== '') {
          const { error: stockError } = await supabase
            .from('stock_balances')
            .upsert({ product_id: productData.id, sellable_qty: qty }, { onConflict: 'product_id' });
          if (stockError) throw stockError;
        } else {
          await supabase.from('stock_balances').upsert({ product_id: productData.id }, { onConflict: 'product_id' });
        }

        imported += 1;
      }

      setMessage(`Import complete. Imported/updated ${imported} products. Skipped ${skipped} rows.`);
      await loadCategories();
      await loadProducts();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  function exportProducts() {
    const headers = ['SKU/Code', 'Name', 'Category', 'Barcode', 'Cost', 'Markup %', 'Price', 'Quantity', 'Low Stock Level', 'Status'];
    const lines = [headers.map(csvEscape).join(',')];
    products.forEach((product) => {
      const row = [
        product.item_code,
        product.name,
        product.category_path || product.category_name || '',
        product.barcode || '',
        numberValue(product.avg_cost),
        markupPercent(product.avg_cost, product.selling_price).toFixed(2),
        numberValue(product.selling_price),
        numberValue(product.sellable_qty),
        numberValue(product.min_stock_level, 1),
        product.status || (product.is_active ? 'active' : 'inactive')
      ];
      lines.push(row.map(csvEscape).join(','));
    });
    downloadTextFile('products-export.csv', lines.join('\n'));
  }

  const totalCostValue = products.reduce((sum, row) => sum + numberValue(row.sellable_qty) * numberValue(row.avg_cost), 0);
  const totalSaleValue = products.reduce((sum, row) => sum + numberValue(row.sellable_qty) * numberValue(row.selling_price), 0);
  const categoryCounts = categoryCountsWithParents(categories, products);

  return (
    <section className="products-screen">
      <div className="action-toolbar compact-toolbar">
        <button className="toolbar-button" onClick={() => { loadCategories(); loadProducts(); }}><span>↻</span>Refresh</button>
        <button className="toolbar-button" onClick={createCategory}><span>□＋</span>New group</button>
        <button className="toolbar-button bright" onClick={openNewProduct}><span>＋</span>New product</button>
        <button className="toolbar-button" disabled={!selectedProduct} onClick={() => selectedProduct && openEditProduct(selectedProduct)}><span>✎</span>Edit selected</button>
        <button className="toolbar-button" disabled={!selectedProduct} onClick={() => selectedProduct && deactivateProduct(selectedProduct)}><span>▥</span>Set inactive</button>
        <label className="toolbar-button file-toolbar-button">
          <span>↓</span>Import
          <input type="file" accept=".csv,.xlsx,.xls" onChange={handleImportFile} />
        </label>
        <button className="toolbar-button" onClick={exportProducts}><span>↑</span>Export</button>
      </div>

      <div className="inventory-layout">
        <CategoryTree
          categories={categories}
          selectedCategoryId={selectedCategoryId}
          setSelectedCategoryId={(id) => { setSelectedCategoryId(id); setFilterMode('category'); }}
          counts={categoryCounts}
          totalCount={products.length}
        />

        <div className="inventory-main">
          <div className="inventory-search-bar">
            <select value={searchBy} onChange={(e) => { setSearchBy(e.target.value); if (search.trim()) setFilterMode('search'); }}>
              {PRODUCT_SEARCH_FIELDS.map((field) => <option key={field.value} value={field.value}>{field.label}</option>)}
            </select>
            <input value={search} onFocus={selectAllText} onChange={(e) => { setSearch(e.target.value); setFilterMode(e.target.value.trim() ? 'search' : 'category'); }} placeholder="Live search by selected field" />
            <button className="secondary-button" onClick={() => { setSearch(''); setSearchBy('any'); setFilterMode('category'); setSelectedCategoryId('all'); }}>Clear</button>
            <span className="count-label">{filterMode === 'search' && search.trim() ? 'Live search across all products' : 'Category filter'} · Products count: {products.length}</span>
          </div>

          <div className="mini-stats-row">
            <StatCard label="Total cost value" value={money(totalCostValue)} />
            <StatCard label="Total selling value" value={money(totalSaleValue)} />
            <StatCard label="Expected gross margin" value={money(totalSaleValue - totalCostValue)} />
          </div>

          <label className="checkbox-line">
            <input type="checkbox" checked={updateImportStock} onChange={(e) => setUpdateImportStock(e.target.checked)} />
            When importing, update quantity from file if a quantity column exists.
          </label>

          {message && <div className="notice">{message}</div>}
          {error && <div className="error-box">{error}</div>}

          {showForm && (
            <div className="panel-card product-form-panel">
              <div className="section-title-row">
                <h3>{editingProduct ? 'Edit product' : 'New product'}</h3>
                <button className="secondary-button" onClick={() => setShowForm(false)}>Close</button>
              </div>
              <form className="product-form-grid" onSubmit={saveProduct}>
                <label>Name<input value={form.name} onFocus={selectAllText} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
                <label>Category
                  <select value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}>
                    <option value="">No category</option>
                    {categories.map((cat) => <option key={cat.id} value={cat.id}>{categoryDisplayName(cat)}</option>)}
                  </select>
                </label>
                <label>SKU / Code<input value={form.item_code} onFocus={selectAllText} onChange={(e) => setForm({ ...form, item_code: e.target.value })} required /></label>
                <label>Barcode optional<input value={form.barcode} onFocus={selectAllText} onChange={(e) => setForm({ ...form, barcode: e.target.value })} /></label>
                <label>Cost
                  <input type="number" step="0.01" value={form.avg_cost} onFocus={selectAllText} onChange={(e) => {
                    const avg_cost = Number(e.target.value);
                    setForm({ ...form, avg_cost, selling_price: priceFromMarkup(avg_cost, form.markup) });
                  }} />
                </label>
                <label>Markup %
                  <input type="number" step="0.01" value={form.markup} onFocus={selectAllText} onChange={(e) => {
                    const markup = Number(e.target.value);
                    setForm({ ...form, markup, selling_price: priceFromMarkup(form.avg_cost, markup) });
                  }} />
                </label>
                <label>Selling price
                  <input type="number" step="0.01" value={form.selling_price} onFocus={selectAllText} onChange={(e) => {
                    const selling_price = Number(e.target.value);
                    setForm({ ...form, selling_price, markup: markupPercent(form.avg_cost, selling_price) });
                  }} />
                </label>
                <label>Low stock level<input type="number" step="1" value={form.min_stock_level} onFocus={selectAllText} onChange={(e) => setForm({ ...form, min_stock_level: Number(e.target.value) })} /></label>
                <label>Status
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                    {PRODUCT_STATUS_OPTIONS.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
                  </select>
                </label>
                <div className="form-note">
                  Quantity is not entered for a new product. It stays zero until a Purchase / Stock Receiving document updates it.
                </div>
                <button className="primary-button" disabled={busy}>{busy ? 'Saving...' : 'Save product'}</button>
              </form>
            </div>
          )}

          <div className="panel-card table-wrap inventory-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>SKU / Code</th>
                  <th>Name</th>
                  <th>Category</th>
                  <th>Barcode</th>
                  <th>Cost</th>
                  <th>Markup</th>
                  <th>Price</th>
                  <th>Quantity</th>
                  <th>Low</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.product_id} onClick={() => setSelectedProduct(product)} className={`${selectedProduct?.product_id === product.product_id ? 'selected-row ' : ''}${numberValue(product.sellable_qty) <= numberValue(product.min_stock_level, 1) ? 'low-stock-row' : ''}`}>
                    <td><strong>{product.item_code}</strong></td>
                    <td>{product.name}</td>
                    <td>{product.category_path || product.category_name || '-'}</td>
                    <td>{product.barcode || '-'}</td>
                    <td>{money(product.avg_cost)}</td>
                    <td>{formatPercent(markupPercent(product.avg_cost, product.selling_price))}</td>
                    <td>{money(product.selling_price)}</td>
                    <td>{numberValue(product.sellable_qty)}</td>
                    <td>{numberValue(product.min_stock_level, 1)}</td>
                    <td><span className={product.status === 'inactive' || !product.is_active ? 'status-pill inactive' : 'status-pill active'}>{product.status || (product.is_active ? 'active' : 'inactive')}</span></td>
                    <td>
                      <button className="small-button" onClick={(e) => { e.stopPropagation(); setSelectedProduct(product); openEditProduct(product); }}>Edit</button>
                      <button className="small-button danger" onClick={(e) => { e.stopPropagation(); setSelectedProduct(product); deactivateProduct(product); }}>Inactive</button>
                    </td>
                  </tr>
                ))}
                {products.length === 0 && <EmptyRow colSpan={11} text="No products found." />}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}


function DocumentProductTree({ categories, products, selectedCategoryId, setSelectedCategoryId, onProductClick, searchText = '' }) {
  const [expanded, setExpanded] = useState(() => new Set(['root']));
  const hasSearch = searchText.trim().length > 0;

  const children = useMemo(() => {
    const map = new Map();
    categories.forEach((cat) => {
      const parent = cat.parent_id || 'root';
      if (!map.has(parent)) map.set(parent, []);
      map.get(parent).push(cat);
    });
    for (const list of map.values()) list.sort((a, b) => (a.path || a.name).localeCompare(b.path || b.name));
    return map;
  }, [categories]);

  const productsByCategory = useMemo(() => {
    const map = new Map();
    products.forEach((product) => {
      const key = product.category_id || 'uncategorized';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(product);
    });
    for (const list of map.values()) list.sort((a, b) => String(a.item_code || '').localeCompare(String(b.item_code || '')));
    return map;
  }, [products]);

  useEffect(() => {
    if (!hasSearch) return;
    const next = new Set(['root']);
    products.forEach((product) => {
      const category = categories.find((cat) => cat.id === product.category_id);
      if (!category?.path) return;
      const parts = category.path.split('/').filter(Boolean);
      let current = '';
      parts.forEach((part) => {
        current = current ? `${current}/${part}` : part;
        const matched = categories.find((cat) => cat.path === current);
        if (matched?.id) next.add(matched.id);
      });
    });
    if ((productsByCategory.get('uncategorized') || []).length) next.add('uncategorized');
    setExpanded(next);
  }, [hasSearch, products, categories, productsByCategory]);

  const toggleExpanded = (id) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const hasProductsInBranch = (category) => {
    if ((productsByCategory.get(category.id) || []).length) return true;
    const childCats = children.get(category.id) || [];
    return childCats.some((child) => hasProductsInBranch(child));
  };

  function renderProduct(product) {
    return (
      <button type="button" key={product.product_id} className="tree-product-item" onClick={() => onProductClick(product)}>
        <span>◆</span>
        <strong>{product.item_code}</strong>
        <em>{product.name}</em>
      </button>
    );
  }

  function renderCategory(category, depth = 0) {
    const directProducts = productsByCategory.get(category.id) || [];
    const childCats = children.get(category.id) || [];
    if (!directProducts.length && !childCats.some((child) => hasProductsInBranch(child))) return null;
    const active = selectedCategoryId === category.id;
    const isExpanded = expanded.has(category.id);
    const hasChildren = childCats.length > 0 || directProducts.length > 0;
    return (
      <div key={category.id} className="tree-folder-block" style={{ marginLeft: `${depth * 14}px` }}>
        <div className={active ? 'tree-folder-row active' : 'tree-folder-row'}>
          <button type="button" className="tree-expand-button" onClick={() => hasChildren && toggleExpanded(category.id)}>{hasChildren ? (isExpanded ? '−' : '+') : ''}</button>
          <button type="button" className="tree-folder" onClick={() => setSelectedCategoryId(category.id)}>
            <strong>▰</strong>
            {category.name}
          </button>
        </div>
        {isExpanded && (
          <div className="tree-folder-children">
            {childCats.map((child) => renderCategory(child, depth + 1))}
            {directProducts.map(renderProduct)}
          </div>
        )}
      </div>
    );
  }

  const uncategorizedProducts = productsByCategory.get('uncategorized') || [];
  const rootCategories = children.get('root') || [];
  const rootExpanded = expanded.has('root');

  return (
    <div className="document-product-tree">
      <div className={selectedCategoryId === 'all' ? 'tree-root-row active' : 'tree-root-row'}>
        <button type="button" className="tree-expand-button" onClick={() => toggleExpanded('root')}>{rootExpanded ? '−' : '+'}</button>
        <button type="button" className="tree-root" onClick={() => setSelectedCategoryId('all')}>
          ▰ Products <small>{products.length}</small>
        </button>
      </div>
      {rootExpanded && (
        <div className="tree-folder-children">
          {rootCategories.map((cat) => renderCategory(cat, 0))}
          {uncategorizedProducts.length > 0 && (
            <div className="tree-folder-block">
              <div className={selectedCategoryId === 'uncategorized' ? 'tree-folder-row active' : 'tree-folder-row'}>
                <button type="button" className="tree-expand-button" onClick={() => toggleExpanded('uncategorized')}>{expanded.has('uncategorized') ? '−' : '+'}</button>
                <button type="button" className="tree-folder" onClick={() => setSelectedCategoryId('uncategorized')}><strong>▰</strong> Uncategorized</button>
              </div>
              {expanded.has('uncategorized') && uncategorizedProducts.map(renderProduct)}
            </div>
          )}
          {products.length === 0 && <div className="muted-box">No products match this category/search.</div>}
        </div>
      )}
    </div>
  );
}

function CategoryTree({ categories, selectedCategoryId, setSelectedCategoryId, counts, totalCount }) {
  const [expanded, setExpanded] = useState(() => new Set(['root']));

  const childrenByParent = categories.reduce((map, category) => {
    const key = category.parent_id || 'root';
    if (!map[key]) map[key] = [];
    map[key].push(category);
    return map;
  }, {});

  Object.values(childrenByParent).forEach((list) => {
    list.sort((a, b) => categoryDisplayName(a).localeCompare(categoryDisplayName(b)));
  });

  const toggleExpanded = (id) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  function selectCategory(id) {
    setSelectedCategoryId(id);
    if (id && id !== 'all') {
      setExpanded((current) => {
        const next = new Set(current);
        next.add('root');
        const category = categories.find((cat) => cat.id === id);
        if (category?.path) {
          const parts = category.path.split('/').filter(Boolean);
          let currentPath = '';
          parts.forEach((part) => {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            const match = categories.find((cat) => cat.path === currentPath);
            if (match?.id) next.add(match.id);
          });
        }
        return next;
      });
    }
  }

  function renderCategory(category) {
    const children = childrenByParent[category.id] || [];
    const depth = categoryDepth(category);
    const isExpanded = expanded.has(category.id);
    const hasChildren = children.length > 0;
    return (
      <div key={category.id}>
        <div className={selectedCategoryId === category.id ? 'category-node-row active' : 'category-node-row'}>
          <button type="button" className="category-expand-button" style={{ marginLeft: `${depth * 18}px` }} onClick={() => hasChildren && toggleExpanded(category.id)}>{hasChildren ? (isExpanded ? '−' : '+') : ''}</button>
          <button
            className={selectedCategoryId === category.id ? 'category-node child active' : 'category-node child'}
            title={categoryDisplayName(category)}
            onClick={() => selectCategory(category.id)}
          >
            <span>📁</span><strong>{category.name}</strong><em>{counts[category.id] || 0}</em>
          </button>
        </div>
        {isExpanded && children.map(renderCategory)}
      </div>
    );
  }

  const roots = childrenByParent.root || [];
  const rootExpanded = expanded.has('root');

  return (
    <aside className="category-tree">
      <div className={selectedCategoryId === 'all' ? 'category-node-row active' : 'category-node-row'}>
        <button type="button" className="category-expand-button" onClick={() => toggleExpanded('root')}>{rootExpanded ? '−' : '+'}</button>
        <button className={selectedCategoryId === 'all' ? 'category-node active' : 'category-node'} onClick={() => selectCategory('all')}>
          <span>📁</span><strong>Products</strong><em>{totalCount}</em>
        </button>
      </div>
      {rootExpanded && roots.map(renderCategory)}
      {rootExpanded && (
        <div className={selectedCategoryId === 'uncategorized' ? 'category-node-row active' : 'category-node-row'}>
          <button type="button" className="category-expand-button"></button>
          <button className={selectedCategoryId === 'uncategorized' ? 'category-node child active' : 'category-node child'} onClick={() => selectCategory('uncategorized')}>
            <span>📁</span><strong>Uncategorized</strong><em>{counts.uncategorized || 0}</em>
          </button>
        </div>
      )}
    </aside>
  );
}

function StockPage() {
  const [rows, setRows] = useState([]);
  const [categories, setCategories] = useState([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState('all');
  const [searchBy, setSearchBy] = useState('any');
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState('category');
  const [stockView, setStockView] = useState('all');
  const [error, setError] = useState('');

  useEffect(() => { loadCategories(); }, []);
  useEffect(() => {
    const timeout = setTimeout(() => loadStock(), 180);
    return () => clearTimeout(timeout);
  }, [selectedCategoryId, stockView, searchBy, search, filterMode, categories.length]);

  async function loadCategories() {
    const { data, error: categoryError } = await supabase.from('categories').select('id, name, parent_id, path').order('path', { ascending: true });
    if (categoryError) setError(categoryError.message);
    else setCategories(data || []);
  }

  async function loadStock() {
    setError('');
    let query = supabase
      .from('product_stock_view')
      .select('*')
      .order('category_path', { ascending: true })
      .order('item_code', { ascending: true })
      .limit(1000);

    const cleanSearch = search.trim();
    const usingLiveSearch = filterMode === 'search' && cleanSearch.length > 0;

    if (!usingLiveSearch) {
      if (selectedCategoryId === 'uncategorized') query = query.is('category_id', null);
      else if (selectedCategoryId !== 'all') {
        const ids = categoryDescendantIds(categories, selectedCategoryId);
        query = query.in('category_id', ids.length ? ids : [selectedCategoryId]);
      }
    }

    if (usingLiveSearch) query = applySearchToProductQuery(query, searchBy, cleanSearch);

    const { data, error: stockError } = await query;
    if (stockError) {
      setError(stockError.message);
      return;
    }

    let filtered = data || [];
    if (stockView === 'in_stock') filtered = filtered.filter((row) => numberValue(row.sellable_qty) > 0);
    if (stockView === 'zero') filtered = filtered.filter((row) => numberValue(row.sellable_qty) === 0);
    if (stockView === 'negative') filtered = filtered.filter((row) => numberValue(row.sellable_qty) < 0);
    if (stockView === 'low') filtered = filtered.filter((row) => numberValue(row.sellable_qty) > 0 && numberValue(row.sellable_qty) <= numberValue(row.min_stock_level, 1));
    if (stockView === 'in_transit') filtered = filtered.filter((row) => numberValue(row.in_transit_qty) > 0);
    if (stockView === 'reserved') filtered = filtered.filter((row) => numberValue(row.reserved_qty) > 0);
    if (stockView === 'damaged') filtered = filtered.filter((row) => numberValue(row.damaged_qty) > 0);
    if (stockView === 'unavailable') filtered = filtered.filter((row) => numberValue(row.available_qty) <= 0);
    if (stockView === 'inactive') filtered = filtered.filter((row) => row.status === 'inactive' || !row.is_active);
    setRows(filtered);
  }

  const totalCostValue = rows.reduce((sum, row) => sum + numberValue(row.sellable_qty) * numberValue(row.avg_cost), 0);
  const totalSaleValue = rows.reduce((sum, row) => sum + numberValue(row.sellable_qty) * numberValue(row.selling_price), 0);
  const totalAvailableSaleValue = rows.reduce((sum, row) => sum + numberValue(row.available_qty) * numberValue(row.selling_price), 0);
  const totalInTransitValue = rows.reduce((sum, row) => sum + numberValue(row.in_transit_qty) * numberValue(row.avg_cost), 0);
  const totalReserved = rows.reduce((sum, row) => sum + numberValue(row.reserved_qty), 0);
  const categoryCounts = categoryCountsWithParents(categories, rows);

  return (
    <section className="products-screen">
      <div className="action-toolbar compact-toolbar">
        <button className="toolbar-button" onClick={() => { loadCategories(); loadStock(); }}><span>↻</span>Refresh</button>
        <button className="toolbar-button"><span>▣</span>Stock adjustment</button>
        <button className="toolbar-button"><span>⇣</span>Receive purchase</button>
        <button className="toolbar-button"><span>⏳</span>Transit docs</button>
        <button className="toolbar-button"><span>▤</span>Reserve docs</button>
      </div>

      <div className="inventory-layout">
        <CategoryTree
          categories={categories}
          selectedCategoryId={selectedCategoryId}
          setSelectedCategoryId={(id) => { setSelectedCategoryId(id); setFilterMode('category'); }}
          counts={categoryCounts}
          totalCount={rows.length}
        />

        <div className="inventory-main">
          <div className="inventory-search-bar stock-search-bar">
            <select value={searchBy} onChange={(e) => { setSearchBy(e.target.value); if (search.trim()) setFilterMode('search'); }}>
              {PRODUCT_SEARCH_FIELDS.map((field) => <option key={field.value} value={field.value}>{field.label}</option>)}
            </select>
            <input value={search} onFocus={selectAllText} onChange={(e) => { setSearch(e.target.value); setFilterMode(e.target.value.trim() ? 'search' : 'category'); }} placeholder="Live search by selected field" />
            <button className="secondary-button" onClick={() => { setSearch(''); setSearchBy('any'); setFilterMode('category'); setSelectedCategoryId('all'); }}>Clear</button>
            <span className="count-label">{filterMode === 'search' && search.trim() ? 'Live search across all stock' : 'Category filter'} · Rows: {rows.length}</span>
          </div>

          <div className="stock-filter-row">
            {STOCK_FILTERS.map((filter) => (
              <button
                key={filter.value}
                className={stockView === filter.value ? 'stock-filter active' : 'stock-filter'}
                title={filter.description}
                onClick={() => setStockView(filter.value)}
              >
                {filter.label}
              </button>
            ))}
          </div>

          <div className="mini-stats-row stock-stats-grid">
            <StatCard label="Sellable stock cost" value={money(totalCostValue)} />
            <StatCard label="Sellable stock sale value" value={money(totalSaleValue)} />
            <StatCard label="Available sale value" value={money(totalAvailableSaleValue)} />
            <StatCard label="In-transit value" value={money(totalInTransitValue)} />
            <StatCard label="Reserved quantity" value={totalReserved} />
          </div>

          <div className="notice slim-notice">
            Qty means sellable physical stock in the shop. Available means Qty minus Reserved. In Transit means incoming stock from Stock in Transit documents. Warranty / Damaged means non-sellable returned or damaged items.
          </div>

          {error && <div className="error-box">{error}</div>}

          <div className="panel-card table-wrap inventory-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>SKU / Code</th>
                  <th>Name</th>
                  <th>Qty</th>
                  <th>Reserved</th>
                  <th>Available</th>
                  <th>In Transit</th>
                  <th>Warranty / Damaged</th>
                  <th>Cost</th>
                  <th>Price</th>
                  <th>Total Cost</th>
                  <th>Total Sale</th>
                  <th>Low Level</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const isLow = numberValue(row.sellable_qty) > 0 && numberValue(row.sellable_qty) <= numberValue(row.min_stock_level, 1);
                  return (
                    <tr key={row.product_id} className={isLow ? 'low-stock-row' : ''}>
                      <td><strong>{row.item_code}</strong></td>
                      <td>{row.name}</td>
                      <td>{numberValue(row.sellable_qty)}</td>
                      <td>{numberValue(row.reserved_qty)}</td>
                      <td>{numberValue(row.available_qty)}</td>
                      <td>{numberValue(row.in_transit_qty)}</td>
                      <td>{numberValue(row.damaged_qty)}</td>
                      <td>{money(row.avg_cost)}</td>
                      <td>{money(row.selling_price)}</td>
                      <td>{money(numberValue(row.sellable_qty) * numberValue(row.avg_cost))}</td>
                      <td>{money(numberValue(row.sellable_qty) * numberValue(row.selling_price))}</td>
                      <td>{numberValue(row.min_stock_level, 1)}</td>
                      <td><span className={row.status === 'inactive' || !row.is_active ? 'status-pill inactive' : 'status-pill active'}>{row.status || (row.is_active ? 'active' : 'inactive')}</span></td>
                    </tr>
                  );
                })}
                {rows.length === 0 && <EmptyRow colSpan={13} text="No stock rows found." />}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}


function CustomersSuppliersPage() {
  const [rows, setRows] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [transactions, setTransactions] = useState([]);
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', address: '', is_customer: true, is_supplier: false });
  const [paymentForm, setPaymentForm] = useState({ amount: '', method_id: '', direction: 'in', note: '' });
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => { loadRows(); loadPaymentMethods(); }, []);
  useEffect(() => {
    if (selectedId) loadTransactions(selectedId);
    else setTransactions([]);
  }, [selectedId]);

  const selected = rows.find((row) => row.id === selectedId);
  const selectedOutstanding = selected ? Number(selected.due_balance || 0) - Number(selected.store_credit_balance || 0) : 0;

  useEffect(() => {
    if (!selected) return;
    const direction = selectedOutstanding < 0 ? 'out' : 'in';
    setPaymentForm((current) => ({
      ...current,
      direction,
      amount: Math.abs(selectedOutstanding) > 0.005 ? String(Math.abs(selectedOutstanding)) : current.amount || '',
      note: direction === 'out' ? 'Balance refund' : 'Balance payment'
    }));
  }, [selectedId, selectedOutstanding]);

  async function loadRows() {
    setError('');
    const { data, error: rowError } = await supabase
      .from('customers')
      .select('id, name, phone, address, due_balance, store_credit_balance, is_customer, is_supplier')
      .order('name', { ascending: true })
      .limit(1500);
    if (rowError) setError(rowError.message);
    else setRows(data || []);
  }

  async function loadPaymentMethods() {
    const { data, error: methodError } = await supabase
      .from('payment_methods')
      .select('id, name, is_paid_method, affects_cashflow, is_active')
      .eq('is_active', true)
      .eq('is_paid_method', true)
      .order('name');
    if (methodError) setError(methodError.message);
    else {
      setPaymentMethods(data || []);
      if ((data || []).length && !paymentForm.method_id) setPaymentForm((f) => ({ ...f, method_id: data[0].id }));
    }
  }

  async function loadTransactions(partyId) {
    setError('');
    const profile = rows.find((row) => row.id === partyId);
    let supplierIds = [];
    if (profile) {
      const { data: supplierMatches, error: supplierMatchError } = await supabase
        .from('suppliers')
        .select('id, name, phone')
        .ilike('name', profile.name || '');
      if (!supplierMatchError) {
        supplierIds = (supplierMatches || [])
          .filter((supplier) => !profile.phone || !supplier.phone || supplier.phone === profile.phone)
          .map((supplier) => supplier.id);
      }
    }

    const { data: customerDocs, error: docError } = await supabase
      .from('documents')
      .select('id, document_no, document_type, status, total_amount, paid_amount, balance_amount, document_date, created_at, notes, payment_methods(name)')
      .eq('customer_id', partyId)
      .order('created_at', { ascending: false })
      .limit(300);
    if (docError) {
      setError(docError.message);
      return;
    }

    let supplierDocs = [];
    if (supplierIds.length) {
      const { data, error: supplierDocError } = await supabase
        .from('documents')
        .select('id, document_no, document_type, status, total_amount, paid_amount, balance_amount, document_date, created_at, notes, payment_methods(name)')
        .in('supplier_id', supplierIds)
        .order('created_at', { ascending: false })
        .limit(300);
      if (supplierDocError) setError(supplierDocError.message);
      supplierDocs = data || [];
    }

    const byId = new Map();
    [...(customerDocs || []), ...supplierDocs].forEach((doc) => byId.set(doc.id, doc));
    const docs = Array.from(byId.values());
    const docIds = docs.map((doc) => doc.id);
    let flows = [];
    if (docIds.length) {
      const { data: cashRows, error: cashError } = await supabase
        .from('cashflow_entries')
        .select('id, document_id, entry_type, amount, account_name, description, created_at, payment_methods(name)')
        .in('document_id', docIds)
        .order('created_at', { ascending: false });
      if (cashError) setError(cashError.message);
      flows = cashRows || [];
    }
    const merged = [
      ...docs.map((doc) => ({ kind: 'document', date: doc.document_date || doc.created_at, ...doc })),
      ...flows.map((flow) => ({ kind: 'payment', date: flow.created_at, ...flow }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date));
    setTransactions(merged);
  }

  async function addRow(event) {
    event.preventDefault();
    setError('');
    setMessage('');
    const payload = {
      name: form.name.trim(),
      phone: form.phone.trim() || null,
      address: form.address.trim() || null,
      is_customer: !!form.is_customer,
      is_supplier: !!form.is_supplier
    };
    const { data, error: insertError } = await supabase
      .from('customers')
      .insert(payload)
      .select('id, name, phone, address, due_balance, store_credit_balance, is_customer, is_supplier')
      .single();
    if (insertError) setError(insertError.message);
    else {
      if (payload.is_supplier) {
        await supabase.from('suppliers').insert({ name: payload.name, phone: payload.phone, address: payload.address });
      }
      setForm({ name: '', phone: '', address: '', is_customer: true, is_supplier: false });
      setRows((current) => [...current, data].sort((a, b) => a.name.localeCompare(b.name)));
      setSelectedId(data.id);
      setShowAddForm(false);
      setMessage('Profile saved.');
    }
  }

  async function saveBalancePayment(event) {
    event.preventDefault();
    setError('');
    setMessage('');
    if (!selectedId) {
      setError('Select a customer/supplier first.');
      return;
    }
    if (Number(paymentForm.amount || 0) <= 0) {
      setError('Enter payment amount.');
      return;
    }
    const { data, error: payError } = await supabase.rpc('save_customer_balance_payment', {
      p_customer_id: selectedId,
      p_payment_method_id: paymentForm.method_id || null,
      p_amount: Number(paymentForm.amount || 0),
      p_direction: paymentForm.direction,
      p_note: paymentForm.note || null
    });
    if (payError) {
      setError(payError.message);
      return;
    }
    setPaymentForm((current) => ({ ...current, amount: '', note: '' }));
    setMessage(`Balance updated. New outstanding: ${data?.new_outstanding < 0 ? '-' : ''}${money(Math.abs(Number(data?.new_outstanding || 0)))}`);
    await loadRows();
    await loadTransactions(selectedId);
  }

  const filteredRows = rows.filter((row) => {
    const outstanding = Number(row.due_balance || 0) - Number(row.store_credit_balance || 0);
    const text = `${row.name || ''} ${row.phone || ''} ${row.address || ''}`.toLowerCase();
    if (search.trim() && !text.includes(search.trim().toLowerCase())) return false;
    if (filter === 'positive' && outstanding <= 0) return false;
    if (filter === 'negative' && outstanding >= 0) return false;
    if (filter === 'zero' && Math.abs(outstanding) > 0.005) return false;
    if (filter === 'customers' && row.is_customer === false) return false;
    if (filter === 'suppliers' && row.is_supplier !== true) return false;
    if (filter === 'both' && !(row.is_supplier === true && row.is_customer !== false)) return false;
    return true;
  });

  const totalPositive = rows.reduce((sum, row) => {
    const value = Number(row.due_balance || 0) - Number(row.store_credit_balance || 0);
    return value > 0 ? sum + value : sum;
  }, 0);
  const totalNegative = rows.reduce((sum, row) => {
    const value = Number(row.due_balance || 0) - Number(row.store_credit_balance || 0);
    return value < 0 ? sum + Math.abs(value) : sum;
  }, 0);

  if (selected) {
    const actionLabel = selectedOutstanding < 0 ? 'Refund / pay customer' : 'Receive payment';
    return (
      <section className="page-section party-detail-page">
        <div className="page-actions">
          <div>
            <button className="link-button back-link" onClick={() => setSelectedId('')}>← Back to list</button>
            <h3>{selected.name}</h3>
            <p>{selected.phone || 'No phone'} {selected.address ? `• ${selected.address}` : ''}</p>
          </div>
          <button className="secondary-button" onClick={() => loadTransactions(selected.id)}>Refresh</button>
        </div>
        {error && <div className="error-box">{error}</div>}
        {message && <div className="notice success">{message}</div>}

        <div className="stats-grid compact">
          <StatCard label="Outstanding Balance" value={`${selectedOutstanding < 0 ? '-' : ''}${money(Math.abs(selectedOutstanding))}`} />
          <StatCard label="Profile Type" value={`${selected.is_customer !== false ? 'Customer' : ''}${selected.is_supplier ? `${selected.is_customer !== false ? ' / ' : ''}Supplier` : ''}`} />
          <StatCard label="Transactions" value={transactions.filter((row) => row.kind === 'document').length} />
        </div>

        <div className="party-detail-grid-v17">
          <form className="panel-card balance-payment-form" onSubmit={saveBalancePayment}>
            <h3>{actionLabel}</h3>
            <p className="muted-text">Positive outstanding means they owe the shop. Negative outstanding means the shop owes them.</p>
            <div className="form-grid two-cols">
              <label>Action
                <select value={paymentForm.direction} onChange={(e) => setPaymentForm({ ...paymentForm, direction: e.target.value })}>
                  <option value="in">Receive payment</option>
                  <option value="out">Refund / pay customer</option>
                </select>
              </label>
              <label>Payment method
                <select value={paymentForm.method_id} onChange={(e) => setPaymentForm({ ...paymentForm, method_id: e.target.value })}>
                  {paymentMethods.map((method) => <option key={method.id} value={method.id}>{method.name}</option>)}
                </select>
              </label>
              <label>Amount
                <input type="number" step="0.01" value={paymentForm.amount} onFocus={selectAllText} onChange={(e) => setPaymentForm({ ...paymentForm, amount: e.target.value })} />
              </label>
              <label>Note
                <input value={paymentForm.note} onFocus={selectAllText} onChange={(e) => setPaymentForm({ ...paymentForm, note: e.target.value })} />
              </label>
            </div>
            <div className="button-row">
              <button type="button" className="secondary-button" onClick={() => setPaymentForm((current) => ({ ...current, amount: String(Math.abs(selectedOutstanding)), direction: selectedOutstanding < 0 ? 'out' : 'in' }))}>Use full balance</button>
              <button className="primary-button">Save movement</button>
            </div>
          </form>

          <div className="panel-card transaction-panel-full">
            <h3>Transaction history</h3>
            <div className="table-wrap compact-table">
              <table>
                <thead><tr><th>Date</th><th>Type</th><th>Document</th><th>Description</th><th>Debit</th><th>Credit</th></tr></thead>
                <tbody>
                  {transactions.map((row) => {
                    const isPayment = row.kind === 'payment';
                    const amount = Number(row.amount ?? row.total_amount ?? 0);
                    const debit = !isPayment && amount > 0 ? amount : (isPayment && row.entry_type === 'cash_out' ? amount : 0);
                    const credit = !isPayment && amount < 0 ? Math.abs(amount) : (isPayment && row.entry_type === 'cash_in' ? amount : 0);
                    return (
                      <tr key={`${row.kind}-${row.id}`}>
                        <td>{fmtDate(row.date)}</td>
                        <td>{isPayment ? row.entry_type : documentTypeLabel(row.document_type)}</td>
                        <td>{row.document_no || '-'}</td>
                        <td>{row.description || row.notes || row.status || '-'}</td>
                        <td>{debit ? money(debit) : '-'}</td>
                        <td>{credit ? money(credit) : '-'}</td>
                      </tr>
                    );
                  })}
                  {transactions.length === 0 && <EmptyRow colSpan={6} text="No transactions for this profile." />}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="page-section customers-list-page">
      <div className="page-actions">
        <div>
          <h3>Customers & Suppliers</h3>
          <p>One profile can be a customer, supplier, or both. Click a row to open its transactions and balance payment page.</p>
        </div>
        <button className="primary-button" onClick={() => setShowAddForm(true)}>+ Add profile</button>
      </div>
      {error && <div className="error-box">{error}</div>}
      {message && <div className="notice success">{message}</div>}
      <div className="stats-grid compact">
        <StatCard label="Profiles" value={rows.length} />
        <StatCard label="Positive Outstanding" value={money(totalPositive)} />
        <StatCard label="Negative Outstanding" value={`-${money(totalNegative)}`} />
      </div>

      <div className="panel-card list-filter-bar">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, phone, or address" />
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All profiles</option>
          <option value="customers">Customers</option>
          <option value="suppliers">Suppliers</option>
          <option value="both">Customer + Supplier</option>
          <option value="positive">Positive balance</option>
          <option value="negative">Negative balance</option>
          <option value="zero">Zero balance</option>
        </select>
      </div>

      <div className="panel-card table-wrap party-list-table">
        <table>
          <thead><tr><th>Name</th><th>Phone</th><th>Address</th><th>Type</th><th>Outstanding Balance</th></tr></thead>
          <tbody>
            {filteredRows.map((row) => {
              const outstanding = Number(row.due_balance || 0) - Number(row.store_credit_balance || 0);
              return (
                <tr key={row.id} onClick={() => setSelectedId(row.id)} className="clickable-row">
                  <td><strong>{row.name}</strong></td>
                  <td>{row.phone || '-'}</td>
                  <td>{row.address || '-'}</td>
                  <td>{row.is_supplier ? 'Supplier' : ''}{row.is_supplier && row.is_customer !== false ? ' / ' : ''}{row.is_customer !== false ? 'Customer' : ''}</td>
                  <td className={outstanding < 0 ? 'negative-balance' : outstanding > 0 ? 'positive-balance' : ''}>{outstanding < 0 ? '-' : ''}{money(Math.abs(outstanding))}</td>
                </tr>
              );
            })}
            {filteredRows.length === 0 && <EmptyRow colSpan={5} text="No profiles found." />}
          </tbody>
        </table>
      </div>

      {showAddForm && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h3>Add Customer / Supplier</h3>
            <form onSubmit={addRow}>
              <label>Name</label>
              <input value={form.name} onFocus={selectAllText} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              <label>Phone</label>
              <input value={form.phone} onFocus={selectAllText} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              <label>Address</label>
              <textarea value={form.address} onFocus={selectAllText} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              <label className="checkbox-label"><input type="checkbox" checked={form.is_customer} onChange={(e) => setForm({ ...form, is_customer: e.target.checked })} /> Customer</label>
              <label className="checkbox-label"><input type="checkbox" checked={form.is_supplier} onChange={(e) => setForm({ ...form, is_supplier: e.target.checked })} /> Supplier</label>
              <div className="modal-actions">
                <button type="button" className="secondary-button" onClick={() => setShowAddForm(false)}>Cancel</button>
                <button className="primary-button">Save profile</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}


function CashflowPage() {
  const [entries, setEntries] = useState([]);
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [filters, setFilters] = useState({ search: '', type: 'all', documentType: 'all', paymentMethodId: 'all' });
  const [showAdd, setShowAdd] = useState(false);
  const [manualForm, setManualForm] = useState({ entry_type: 'cash_out', payment_method_id: '', amount: '', description: '' });
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => { loadEntries(); loadPaymentMethods(); }, []);

  async function loadEntries() {
    setError('');
    const { data, error: cashError } = await supabase
      .from('cashflow_entries')
      .select('id, entry_type, account_name, amount, description, created_at, payment_method_id, payment_methods(name), documents(document_no, document_type)')
      .order('created_at', { ascending: false })
      .limit(500);
    if (cashError) setError(cashError.message);
    else setEntries(data || []);
  }

  async function loadPaymentMethods() {
    const { data, error: methodError } = await supabase
      .from('payment_methods')
      .select('id, name, is_paid_method, affects_cashflow, is_active')
      .eq('is_active', true)
      .eq('affects_cashflow', true)
      .order('name');
    if (methodError) setError(methodError.message);
    else {
      setPaymentMethods(data || []);
      if ((data || []).length) setManualForm((form) => ({ ...form, payment_method_id: form.payment_method_id || data[0].id }));
    }
  }

  async function saveManualMovement(event) {
    event.preventDefault();
    setError('');
    setMessage('');
    const amount = Number(manualForm.amount || 0);
    if (amount <= 0) {
      setError('Enter amount greater than zero.');
      return;
    }
    const method = paymentMethods.find((item) => item.id === manualForm.payment_method_id);
    const { error: insertError } = await supabase.from('cashflow_entries').insert({
      entry_type: manualForm.entry_type,
      account_name: method?.name || 'Cash Drawer',
      payment_method_id: manualForm.payment_method_id || null,
      amount,
      description: manualForm.description || (manualForm.entry_type === 'cash_out' ? 'Manual expense / cash out' : 'Manual cash in')
    });
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setManualForm((form) => ({ ...form, amount: '', description: '' }));
    setShowAdd(false);
    setMessage('Cashflow entry saved.');
    loadEntries();
  }

  const filteredEntries = entries.filter((entry) => {
    const docType = entry.documents?.document_type || '';
    const text = `${entry.description || ''} ${entry.account_name || ''} ${entry.payment_methods?.name || ''} ${entry.documents?.document_no || ''} ${docType}`.toLowerCase();
    if (filters.search.trim() && !text.includes(filters.search.trim().toLowerCase())) return false;
    if (filters.type !== 'all' && entry.entry_type !== filters.type) return false;
    if (filters.documentType !== 'all' && docType !== filters.documentType) return false;
    if (filters.paymentMethodId !== 'all' && entry.payment_method_id !== filters.paymentMethodId) return false;
    return true;
  });

  const cashIn = filteredEntries.filter((row) => row.entry_type === 'cash_in').reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const cashOut = filteredEntries.filter((row) => row.entry_type === 'cash_out').reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const nonCash = filteredEntries.filter((row) => row.entry_type === 'non_cash').reduce((sum, row) => sum + Number(row.amount || 0), 0);

  return (
    <section className="page-section cashflow-v17">
      <div className="page-actions">
        <div>
          <h3>Cashflow</h3>
          <p>Sales, purchase payments, refunds, customer balance payments, and manual expenses appear here.</p>
        </div>
        <button className="primary-button" onClick={() => setShowAdd(true)}>+ Add Expense / Cash Movement</button>
      </div>
      {error && <div className="error-box">{error}</div>}
      {message && <div className="notice success">{message}</div>}
      <div className="stats-grid compact">
        <StatCard label="Cash In" value={money(cashIn)} />
        <StatCard label="Cash Out" value={money(cashOut)} />
        <StatCard label="Net" value={money(cashIn - cashOut)} />
        <StatCard label="Non-cash" value={money(nonCash)} />
      </div>

      <div className="panel-card list-filter-bar cashflow-filter-bar">
        <input value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} placeholder="Search document, account, description" />
        <select value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })}>
          <option value="all">All cash types</option>
          <option value="cash_in">Cash in</option>
          <option value="cash_out">Cash out</option>
          <option value="non_cash">Non-cash</option>
        </select>
        <select value={filters.documentType} onChange={(e) => setFilters({ ...filters, documentType: e.target.value })}>
          <option value="all">All documents</option>
          <option value="invoice">Sales</option>
          <option value="purchase">Purchases</option>
          <option value="stock_in_transit">Stock in Transit</option>
          <option value="customer_payment">Customer payments</option>
          <option value="expense">Expenses</option>
        </select>
        <select value={filters.paymentMethodId} onChange={(e) => setFilters({ ...filters, paymentMethodId: e.target.value })}>
          <option value="all">All payments</option>
          {paymentMethods.map((method) => <option key={method.id} value={method.id}>{method.name}</option>)}
        </select>
      </div>

      <div className="panel-card table-wrap">
        <table>
          <thead>
            <tr><th>Date</th><th>Type</th><th>Account</th><th>Payment</th><th>Document</th><th>Doc Type</th><th>Description</th><th>Amount</th></tr>
          </thead>
          <tbody>
            {filteredEntries.map((entry) => (
              <tr key={entry.id}>
                <td>{fmtDate(entry.created_at)}</td>
                <td>{entry.entry_type}</td>
                <td>{entry.account_name}</td>
                <td>{entry.payment_methods?.name || '-'}</td>
                <td>{entry.documents?.document_no || '-'}</td>
                <td>{documentTypeLabel(entry.documents?.document_type)}</td>
                <td>{entry.description || '-'}</td>
                <td className={entry.entry_type === 'cash_out' ? 'negative-balance' : entry.entry_type === 'cash_in' ? 'positive-balance' : ''}>{money(entry.amount)}</td>
              </tr>
            ))}
            {filteredEntries.length === 0 && <EmptyRow colSpan={8} text="No cashflow entries found." />}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <div className="modal-backdrop">
          <div className="modal-card compact-modal">
            <h3>Add Expense / Cash Movement</h3>
            <form onSubmit={saveManualMovement}>
              <label>Type
                <select value={manualForm.entry_type} onChange={(e) => setManualForm({ ...manualForm, entry_type: e.target.value })}>
                  <option value="cash_out">Cash out / Expense</option>
                  <option value="cash_in">Cash in / Other income</option>
                </select>
              </label>
              <label>Payment account
                <select value={manualForm.payment_method_id} onChange={(e) => setManualForm({ ...manualForm, payment_method_id: e.target.value })}>
                  {paymentMethods.map((method) => <option key={method.id} value={method.id}>{method.name}</option>)}
                </select>
              </label>
              <label>Amount
                <input type="number" step="0.01" value={manualForm.amount} onFocus={selectAllText} onChange={(e) => setManualForm({ ...manualForm, amount: e.target.value })} />
              </label>
              <label>Description
                <input value={manualForm.description} onFocus={selectAllText} onChange={(e) => setManualForm({ ...manualForm, description: e.target.value })} placeholder="Rent, tea, transport, bank charge, etc." />
              </label>
              <div className="modal-actions">
                <button type="button" className="secondary-button" onClick={() => setShowAdd(false)}>Cancel</button>
                <button className="primary-button">Save entry</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}


function ReportsPage() {
  const cards = [
    'Sales reports', 'Profit margin', 'Payment type by customer', 'Invoice list', 'Purchase list', 'Refunds',
    'Cashflow reports', 'Customer due balances', 'Store credit balances', 'Stock value', 'Stock in transit', 'Warranty / damaged stock'
  ];
  return (
    <section className="page-section">
      <div className="report-grid">
        {cards.map((card) => (
          <div className="panel-card report-card" key={card}>
            <h3>{card}</h3>
            <p>Filters will include date range, product, item code, customer, supplier, user, payment type, document type, and status.</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function OnlineOrdersPage() {
  return (
    <section className="page-section">
      <div className="panel-card">
        <h3>Online Orders</h3>
        <p>The online store will be a separate app later. This page will show synced website orders and reserved stock.</p>
        <ul>
          <li>New order</li>
          <li>Pending payment</li>
          <li>Confirmed / reserved</li>
          <li>Ready for pickup</li>
          <li>Completed / cancelled / refunded</li>
        </ul>
      </div>
    </section>
  );
}


function PaymentTypesPage() {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ name: '', is_paid_method: true, affects_cashflow: true });
  const [error, setError] = useState('');

  useEffect(() => { loadRows(); }, []);

  async function loadRows() {
    setError('');
    const { data, error: rowError } = await supabase.from('payment_methods').select('*').order('name');
    if (rowError) setError(rowError.message);
    else setRows(data || []);
  }

  async function addPayment(event) {
    event.preventDefault();
    setError('');
    const payload = {
      name: form.name.trim(),
      is_paid_method: form.is_paid_method,
      affects_cashflow: form.is_paid_method ? form.affects_cashflow : false,
      is_active: true
    };
    const { error: insertError } = await supabase.from('payment_methods').insert(payload);
    if (insertError) setError(insertError.message);
    else {
      setForm({ name: '', is_paid_method: true, affects_cashflow: true });
      loadRows();
    }
  }

  async function toggleActive(row) {
    const { error: updateError } = await supabase.from('payment_methods').update({ is_active: !row.is_active }).eq('id', row.id);
    if (updateError) setError(updateError.message);
    else loadRows();
  }

  return (
    <section className="page-section two-column">
      <div className="panel-card form-card">
        <h3>Add Payment Type</h3>
        <p>Paid methods settle the invoice now. Unpaid methods create customer due balance.</p>
        {error && <div className="error-box">{error}</div>}
        <form onSubmit={addPayment}>
          <label>Name</label>
          <input value={form.name} onFocus={selectAllText} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Example: QR Payment" required />

          <label>Payment status behavior</label>
          <select
            value={form.is_paid_method ? 'paid' : 'unpaid'}
            onChange={(e) => setForm({ ...form, is_paid_method: e.target.value === 'paid', affects_cashflow: e.target.value === 'paid' ? form.affects_cashflow : false })}
          >
            <option value="paid">Mark document as paid</option>
            <option value="unpaid">Mark document as unpaid / credit</option>
          </select>

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={form.affects_cashflow}
              disabled={!form.is_paid_method}
              onChange={(e) => setForm({ ...form, affects_cashflow: e.target.checked })}
            />
            Affects cash/bank cashflow
          </label>
          <button className="primary-button full-width">Save</button>
        </form>
      </div>
      <div className="panel-card table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Paid/Unpaid</th><th>Affects Cashflow</th><th>Active</th><th>Action</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.name}</td>
                <td>{row.is_paid_method === false ? 'Unpaid / Credit' : 'Paid'}</td>
                <td>{row.affects_cashflow ? 'Yes' : 'No'}</td>
                <td>{row.is_active ? 'Yes' : 'No'}</td>
                <td><button className="small-button" onClick={() => toggleActive(row)}>{row.is_active ? 'Disable' : 'Enable'}</button></td>
              </tr>
            ))}
            {rows.length === 0 && <EmptyRow colSpan={5} text="No payment types." />}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function UsersSecurityPage() {
  const [staff, setStaff] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => { loadStaff(); }, []);

  async function loadStaff() {
    const { data, error: staffError } = await supabase.from('staff').select('*').order('full_name');
    if (staffError) setError('Run supabase/sql/002_structure_updates.sql to create the staff table.');
    else setStaff(data || []);
  }

  return (
    <section className="page-section">
      <div className="panel-card">
        <h3>Users & Security</h3>
        <p>Create login users in Supabase Auth, then add one row in the staff table with their Auth UUID.</p>
        {error && <div className="notice">{error}</div>}
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Role</th><th>Active</th><th>Auth User ID</th></tr></thead>
            <tbody>
              {staff.map((row) => <tr key={row.id}><td>{row.full_name}</td><td>{row.role}</td><td>{row.is_active ? 'Yes' : 'No'}</td><td>{row.auth_user_id}</td></tr>)}
              {staff.length === 0 && <EmptyRow colSpan={4} text="No staff records yet." />}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function MyCompanyPage() {
  return (
    <section className="page-section">
      <div className="settings-grid">
        <div className="panel-card form-card">
          <h3>Company Details</h3>
          <label>Shop name</label><input placeholder="Computer shop name" />
          <label>Phone</label><input placeholder="Phone number" />
          <label>Address</label><textarea placeholder="Shop address" />
          <label>Currency</label><input value="LKR" readOnly />
        </div>
        <div className="panel-card form-card">
          <h3>Invoice Customization</h3>
          <label>Invoice footer</label><textarea placeholder="Warranty / return policy note" />
          <label>Paper size</label><select><option>A4 Invoice</option><option>Thermal Receipt</option></select>
          <label><input type="checkbox" /> Show item code</label>
          <label><input type="checkbox" /> Show serial number</label>
          <label><input type="checkbox" /> Show warranty</label>
          <button className="primary-button full-width">Save Settings</button>
        </div>
      </div>
    </section>
  );
}

function FilterInput({ label, value, onChange, placeholder = '' }) {
  return (
    <label>
      {label}
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </label>
  );
}

function SplitTables({ titleA, tableA, titleB, tableB }) {
  return (
    <div className="split-tables">
      <div className="split-panel">
        <h3>{titleA}</h3>
        <div className="table-wrap large-table">{tableA}</div>
      </div>
      <div className="split-divider">•••</div>
      <div className="split-panel">
        <h3>{titleB}</h3>
        <div className="table-wrap item-table">{tableB}</div>
      </div>
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="stat-card">
      <p>{label}</p>
      <strong>{value}</strong>
    </div>
  );
}

function SummaryLine({ label, value, strong }) {
  return (
    <div className={strong ? 'summary-line strong' : 'summary-line'}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function EmptyRow({ colSpan, text }) {
  return <tr><td colSpan={colSpan} className="empty-cell">{text}</td></tr>;
}

function FullScreenMessage({ title, message }) {
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>{title}</h1>
        <p>{message}</p>
      </div>
    </div>
  );
}
