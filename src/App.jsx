import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './lib/supabaseClient';
import * as XLSX from 'xlsx';

const NAV_ITEMS = [
  { key: 'pos', label: 'POS', icon: '▦', group: 'Checkout', permission: 'pos_sales' },
  { key: 'dashboard', label: 'Dashboard', icon: '▤', group: 'Checkout', permission: 'view_dashboard' },
  { key: 'cod_orders', label: 'COD Orders', icon: '\uD83D\uDE9A', group: 'Orders & Service', permission: 'manage_cod_orders' },
  { key: 'online_orders', label: 'Online Orders', icon: '◉', group: 'Orders & Service', permission: 'manage_online_orders' },
  { key: 'jobs', label: 'Jobs & Repairs', icon: '⌁', group: 'Orders & Service', permission: 'manage_jobs' },
  { key: 'tech_assistant', label: 'Tech Assistant', icon: 'AI', group: 'Orders & Service', permission: 'use_ai_assistant' },
  { key: 'documents', label: 'Documents', icon: '▰', group: 'Records & Stock', permission: 'view_documents' },
  { key: 'customers_suppliers', label: 'Customers & Suppliers', icon: '♟', group: 'Records & Stock', permission: 'manage_parties' },
  { key: 'products', label: 'Products', icon: '◇', group: 'Records & Stock', permission: 'manage_products' },
  { key: 'stock', label: 'Stock', icon: '▣', group: 'Records & Stock', permission: 'view_stock' },
  { key: 'warranty', label: 'Warranty', icon: '◆', group: 'Records & Stock', permission: 'manage_warranty' },
  { key: 'cashflow', label: 'Cashflow', icon: '↕', group: 'Finance & Reports', permission: 'manage_cashflow' },
  { key: 'reports', label: 'Reporting', icon: '▥', group: 'Finance & Reports', permission: 'view_reports' },
  { key: 'accounting', label: 'Accounting', icon: 'Σ', group: 'Finance & Reports', adminOnly: true },
  { key: 'settings', label: 'Settings', icon: '⚙', group: 'Settings', adminOnly: true }
];

const STAFF_PERMISSION_GROUPS = [
  {
    label: 'Checkout',
    items: [
      { key: 'pos_sales', label: 'Use POS and save sales', default: true },
      { key: 'change_sale_price', label: 'Override item selling prices', default: false },
      { key: 'apply_discounts', label: 'Apply bill and item discounts', default: false },
      { key: 'process_returns', label: 'Process returns and exchanges', default: false },
      { key: 'void_sales', label: 'Void open bills', default: true },
      { key: 'create_quotes', label: 'Create quotations', default: true },
      { key: 'view_dashboard', label: 'View dashboard totals', default: false }
    ]
  },
  {
    label: 'Orders and service',
    items: [
      { key: 'manage_cod_orders', label: 'Manage COD orders', default: true },
      { key: 'manage_online_orders', label: 'Manage online orders', default: true },
      { key: 'manage_jobs', label: 'Manage jobs and repairs', default: true },
      { key: 'manage_warranty', label: 'Manage warranty claims', default: true },
      { key: 'use_ai_assistant', label: 'Use Gemini technical assistant', default: true }
    ]
  },
  {
    label: 'Records and inventory',
    items: [
      { key: 'view_documents', label: 'View and print documents', default: true },
      { key: 'manage_inventory_documents', label: 'Create/edit purchases, transit, trade-ins and adjustments', default: false },
      { key: 'delete_documents', label: 'Delete supported documents', default: false },
      { key: 'manage_parties', label: 'Manage customers, suppliers and their payments', default: true },
      { key: 'manage_products', label: 'Add, edit and deactivate products', default: false },
      { key: 'view_stock', label: 'View stock quantities and values', default: true }
    ]
  },
  {
    label: 'Finance',
    items: [
      { key: 'manage_cashflow', label: 'View and add cashflow entries', default: false },
      { key: 'view_reports', label: 'View profit, payment and sales reports', default: false }
    ]
  }
];

const DEFAULT_STAFF_PERMISSIONS = Object.fromEntries(
  STAFF_PERMISSION_GROUPS.flatMap((group) => group.items).map((permission) => [permission.key, permission.default])
);
const POS_DEVICE_TOKEN_KEY = 'computer_shop_trusted_device_token_v38';
const APP_LOGO_URL = '/gslogo.jpeg';

function createClientId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') globalThis.crypto.getRandomValues(bytes);
  else {
    const seed = `${Date.now()}-${Math.random()}-${Math.random()}`;
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor((seed.charCodeAt(index % seed.length) * Math.random()) % 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function getOrCreateDeviceToken() {
  let token = window.localStorage.getItem(POS_DEVICE_TOKEN_KEY);
  if (!token) {
    token = `${createClientId()}-${createClientId()}`;
    window.localStorage.setItem(POS_DEVICE_TOKEN_KEY, token);
  }
  return token;
}

function browserDeviceName() {
  const platform = navigator.userAgentData?.platform || navigator.platform || 'Computer';
  const browser = /Edg\//.test(navigator.userAgent) ? 'Edge' : /Chrome\//.test(navigator.userAgent) ? 'Chrome' : /Firefox\//.test(navigator.userAgent) ? 'Firefox' : 'Browser';
  return `${platform} • ${browser}`;
}

function staffCan(staff, permission) {
  return !!staff && (staff.role === 'admin' || staff.permissions?.[permission] === true);
}

const DOCUMENT_TYPES = [
  { value: '', label: 'All document types' },
  { value: 'invoice', label: 'Sales Invoice' },
  { value: 'refund', label: 'Refund' },
  { value: 'quotation', label: 'Quotation' },
  { value: 'purchase', label: 'Purchase' },
  { value: 'stock_in_transit', label: 'Stock in Transit' },
  { value: 'stock_adjustment', label: 'Stock Adjustment' },
  { value: 'trade_in', label: 'Trade-In' },
  { value: 'job', label: 'Job' },
  { value: 'customer_payment', label: 'Customer Payment' },
  { value: 'supplier_payment', label: 'Supplier Payment' },
  { value: 'expense', label: 'Expense' },
  { value: 'other_income', label: 'Other Income' },
  { value: 'account_transfer', label: 'Account Transfer' },
  { value: 'online_order', label: 'Online Order' },
  { value: 'cod_order', label: 'COD Order' }
];

const DOCUMENT_QUICK_FILTERS = [
  { value: '', label: 'All' },
  { value: 'invoice', label: 'Sales' },
  { value: 'purchase', label: 'Purchases' },
  { value: 'stock_in_transit', label: 'In Transit' },
  { value: 'quotation', label: 'Quotes' }
];

const PAYMENT_OPTIONS = ['Cash', 'Card', 'Bank 1', 'Bank 2', 'Credit'];

const WARRANTY_CLAIM_STATUSES = [
  { value: 'received', label: 'Received' },
  { value: 'checking', label: 'Checking' },
  { value: 'sent_supplier', label: 'Sent to Supplier' },
  { value: 'ready', label: 'Ready for Customer' },
  { value: 'repaired', label: 'Repaired' },
  { value: 'replaced', label: 'Replaced' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'completed', label: 'Completed' }
];

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
const REALTIME_SYNC_EVENT = 'shop-pos:database-change';
const REALTIME_TABLES = [
  'documents',
  'document_items',
  'customers',
  'suppliers',
  'products',
  'stock_balances',
  'stock_movements',
  'categories',
  'brands',
  'payment_methods',
  'cashflow_entries',
  'company_settings',
  'app_settings',
  'product_assemblies',
  'product_assembly_items',
  'warranty_records',
  'warranty_claims',
  'warranty_claim_events',
  'accounting_accounts',
  'accounting_journal_entries',
  'accounting_journal_lines',
  'accounting_opening_balances',
  'accounting_settings'
];

function useRealtimeRefresh(tables, refresh, debounceMs = 280) {
  const refreshRef = useRef(refresh);
  const tableKey = tables.join('|');

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    const watchedTables = new Set(tableKey.split('|').filter(Boolean));
    let timeoutId = 0;
    const handleDatabaseChange = (event) => {
      const detail = event.detail || {};
      if (!watchedTables.has(detail.table)) return;
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => refreshRef.current?.(detail), debounceMs);
    };

    window.addEventListener(REALTIME_SYNC_EVENT, handleDatabaseChange);
    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener(REALTIME_SYNC_EVENT, handleDatabaseChange);
    };
  }, [tableKey, debounceMs]);
}

const emptyBill = (name = 'Bill 1') => ({
  id: createClientId(),
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
  useExistingCustomerCredit: false,
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

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

const DEFAULT_COMPANY_SETTINGS = {
  id: true,
  shop_name: 'Computer Shop',
  phone: '',
  address: '',
  email: '',
  registration_no: '',
  header_subtitle: '',
  currency: 'LKR',
  invoice_footer: '',
  logo_path: '',
  paper_size: 'A5',
  page_margin_mm: 8,
  show_item_code: true,
  show_serial_number: false,
  show_warranty: false,
  show_payment_movements: false
};

const DEFAULT_APP_SETTINGS = {
  id: true,
  allow_negative_pos_stock: false,
  show_pos_stock_badges: true,
  confirm_pos_sale: false,
  default_payment_method_id: '',
  updated_at: null
};

function companyLogoUrl(settings) {
  if (!settings?.logo_path) return APP_LOGO_URL;
  const publicUrl = supabase.storage.from('company-assets').getPublicUrl(settings.logo_path).data.publicUrl || '';
  return settings.updated_at ? `${publicUrl}?v=${encodeURIComponent(settings.updated_at)}` : publicUrl;
}

async function fetchCompanySettings() {
  const { data, error } = await supabase.from('company_settings').select('*').eq('id', true).maybeSingle();
  if (error) throw error;
  return { ...DEFAULT_COMPANY_SETTINGS, ...(data || {}) };
}

async function fetchAppSettings() {
  const { data, error } = await supabase.rpc('get_app_settings_v41');
  if (error) throw error;
  return { ...DEFAULT_APP_SETTINGS, ...(data || {}), default_payment_method_id: data?.default_payment_method_id || '' };
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleDateString('en-LK');
}

function documentTypeLabel(value) {
  return DOCUMENT_TYPES.find((item) => item.value === value)?.label || value || '-';
}

function documentOutstandingBalance(document) {
  if (document?.document_type !== 'invoice') return null;
  if (document.party_outstanding_after !== undefined && document.party_outstanding_after !== null) {
    return numberValue(document.party_outstanding_after);
  }
  if (document.party && (document.party.due_balance !== undefined || document.party.store_credit_balance !== undefined)) {
    return numberValue(document.party.due_balance) - numberValue(document.party.store_credit_balance);
  }
  return null;
}

function signedMoney(value) {
  const amount = numberValue(value);
  return `${amount < 0 ? '-' : ''}${money(Math.abs(amount))}`;
}

function InfoTip({ text }) {
  return (
    <span className="info-tip" tabIndex="0" aria-label={text}>
      i
      <span className="info-tip-content" role="tooltip">{text}</span>
    </span>
  );
}

function AppLogo({ className = '' }) {
  return <span className={`${className} app-logo-mark`.trim()}><img src={APP_LOGO_URL} alt="Computer Shop logo" /></span>;
}

function QuickCustomerModal({ initialName = '', alsoSupplier = false, onClose, onCreated }) {
  const [form, setForm] = useState({ name: initialName.trim(), city: '', phone: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function createCustomer(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const { data, error: createError } = await supabase
      .from('customers')
      .insert({
        name: form.name.trim(),
        address: form.city.trim(),
        phone: form.phone.trim(),
        is_customer: true,
        is_supplier: alsoSupplier
      })
      .select('id, name, phone, address, due_balance, store_credit_balance')
      .single();
    setBusy(false);
    if (createError) { setError(createError.message); return; }
    onCreated?.(data);
  }

  return (
    <div className="modal-backdrop quick-customer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <div className="modal-card quick-customer-modal">
        <div className="section-title-row"><div><h3>New Customer</h3><p>Add the contact details needed for this document.</p></div><button type="button" className="secondary-button" onClick={onClose}>Close</button></div>
        {error && <div className="error-box">{error}</div>}
        <form onSubmit={createCustomer}>
          <label>Name<input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
          <label>City<input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="Town or city" required /></label>
          <label>Phone number<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} inputMode="tel" placeholder="07X XXX XXXX" required /></label>
          <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? 'Saving...' : 'Add Customer'}</button></div>
        </form>
      </div>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(null);
  const [activePage, setActivePage] = useState('pos');
  const [loadingSession, setLoadingSession] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [securityState, setSecurityState] = useState(null);
  const [securityLoading, setSecurityLoading] = useState(false);
  const [securityError, setSecurityError] = useState('');
  const [activeStaff, setActiveStaff] = useState(null);
  const [realtimeStatus, setRealtimeStatus] = useState('paused');
  const [appSettings, setAppSettings] = useState(DEFAULT_APP_SETTINGS);
  const deviceToken = useMemo(() => getOrCreateDeviceToken(), []);

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

  async function loadSecurityState() {
    if (!session?.user?.id) return;
    setSecurityLoading(true);
    setSecurityError('');
    const { data, error } = await supabase.rpc('get_pos_security_state_v38', { p_device_token: deviceToken });
    setSecurityLoading(false);
    if (error) {
      setSecurityError(`${error.message}. Run Supabase migrations 038 and 039.`);
      setSecurityState(null);
      setActiveStaff(null);
      return;
    }
    setSecurityState(data || {});
    setActiveStaff(data?.active_staff || null);
  }

  useEffect(() => {
    if (!session?.user?.id) {
      setSecurityState(null);
      setActiveStaff(null);
      setSecurityError('');
      return;
    }
    loadSecurityState();
  }, [session?.user?.id]);

  useEffect(() => {
    if (!session?.user?.id) { setAppSettings(DEFAULT_APP_SETTINGS); return; }
    fetchAppSettings().then(setAppSettings).catch(() => setAppSettings(DEFAULT_APP_SETTINGS));
  }, [session?.user?.id]);

  useRealtimeRefresh(['app_settings'], () => {
    if (session?.user?.id) {
      fetchAppSettings().then(setAppSettings).catch(() => {});
      loadSecurityState();
    }
  });

  useEffect(() => {
    if (!session?.user?.id) return;
    // Fallback for projects where pg_cron is unavailable. This RPC is
    // idempotent and returns today's existing snapshot after the first call.
    supabase.rpc('ensure_daily_app_backup_v31').then(() => {});
  }, [session?.user?.id]);

  async function lockPos() {
    await supabase.rpc('lock_pos_staff_session_v38');
    setActiveStaff(null);
    setSecurityState((current) => ({ ...(current || {}), active_staff: null }));
  }

  async function logoutDevice() {
    await supabase.rpc('lock_pos_staff_session_v38');
    await supabase.auth.signOut();
  }

  useEffect(() => {
    if (!activeStaff?.id) return undefined;
    let lastActivityAt = Date.now();
    let lastServerTouchAt = Date.now();
    let lockStarted = false;
    const autoLockMs = Math.max(Number(securityState?.auto_lock_minutes || 5), 1) * 60 * 1000;

    const registerActivity = () => {
      lastActivityAt = Date.now();
      if (Date.now() - lastServerTouchAt >= 45000) {
        lastServerTouchAt = Date.now();
        supabase.rpc('touch_pos_staff_session_v38').then(({ error }) => {
          if (error && !lockStarted) {
            lockStarted = true;
            setActiveStaff(null);
            setSecurityState((current) => ({ ...(current || {}), active_staff: null }));
          }
        });
      }
    };

    const interval = window.setInterval(() => {
      if (!lockStarted && Date.now() - lastActivityAt >= autoLockMs) {
        lockStarted = true;
        lockPos();
      }
    }, 1000);
    window.addEventListener('pointerdown', registerActivity, { passive: true });
    window.addEventListener('keydown', registerActivity);
    window.addEventListener('touchstart', registerActivity, { passive: true });
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('pointerdown', registerActivity);
      window.removeEventListener('keydown', registerActivity);
      window.removeEventListener('touchstart', registerActivity);
    };
  }, [activeStaff?.id, securityState?.auto_lock_minutes]);

  useEffect(() => {
    if (!session?.user?.id || !activeStaff?.id) {
      setRealtimeStatus('paused');
      return undefined;
    }

    setRealtimeStatus('connecting');
    const channel = supabase.channel(`shop-pos-live-${createClientId()}`);
    REALTIME_TABLES.forEach((table) => {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
        window.dispatchEvent(new CustomEvent(REALTIME_SYNC_EVENT, {
          detail: {
            table,
            eventType: payload.eventType,
            committedAt: payload.commit_timestamp || new Date().toISOString()
          }
        }));
      });
    });
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') setRealtimeStatus('live');
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setRealtimeStatus('error');
      else if (status === 'CLOSED') setRealtimeStatus('paused');
    });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [session?.user?.id, activeStaff?.id]);

  const visibleNavItems = useMemo(() => NAV_ITEMS.filter((item) => (
    item.adminOnly ? activeStaff?.role === 'admin' : staffCan(activeStaff, item.permission)
  )), [activeStaff]);

  useEffect(() => {
    if (!activeStaff || !visibleNavItems.length) return;
    if (!visibleNavItems.some((item) => item.key === activePage)) setActivePage(visibleNavItems[0].key);
  }, [activeStaff?.id, visibleNavItems.map((item) => item.key).join('|')]);

  const currentPage = visibleNavItems.find((item) => item.key === activePage) || visibleNavItems[0] || NAV_ITEMS[0];
  const mobileQuickNav = visibleNavItems.filter((item) => ['pos', 'documents', 'cod_orders', 'jobs'].includes(item.key));

  useEffect(() => {
    document.body.classList.toggle('mobile-navigation-open', sidebarOpen);
    return () => document.body.classList.remove('mobile-navigation-open');
  }, [sidebarOpen]);

  if (loadingSession) return <FullScreenMessage title="Loading" message="Checking login session..." />;
  if (!session) return <AuthScreen />;
  if (securityLoading && !securityState) return <FullScreenMessage title="Security" message="Checking this device..." />;
  if (securityError) return <SecurityLoadError message={securityError} onRetry={loadSecurityState} onLogout={() => supabase.auth.signOut()} />;
  if (!securityState?.device_trusted || !activeStaff) {
    return (
      <PosSecurityGate
        session={session}
        state={securityState || {}}
        deviceToken={deviceToken}
        onRefresh={loadSecurityState}
        onUnlocked={(staff) => {
          setActiveStaff(staff);
          setSecurityState((current) => ({ ...(current || {}), active_staff: staff }));
        }}
        onLogout={() => supabase.auth.signOut()}
      />
    );
  }

  return (
    <div className={sidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"}>
      <button type="button" className={`mobile-nav-scrim ${sidebarOpen ? 'visible' : ''}`} aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />
      <aside className={`${sidebarOpen ? 'sidebar open' : 'sidebar'} ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="brand-block">
          <AppLogo className="brand-logo" />
          <div>
            <h1>Computer Shop</h1>
            <p>LKR • No Tax</p>
          </div>
        </div>

        <button type="button" className="mobile-nav-close" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}>Close</button>
        <nav className="nav-list">
          {visibleNavItems.map((item, index) => (
            <div className="nav-entry" key={item.key}>
              {(index === 0 || visibleNavItems[index - 1].group !== item.group) && <div className="nav-section-label">{item.group}</div>}
              <button
                className={activePage === item.key ? 'nav-item active' : 'nav-item'}
                onClick={() => {
                  setActivePage(item.key);
                  setSidebarOpen(false);
                }}
              >
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-label">{item.label}</span>
              </button>
            </div>
          ))}
        </nav>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <button className="mobile-menu mobile-only-menu" aria-label="Open navigation" aria-expanded={sidebarOpen} title="Navigation" onClick={() => setSidebarOpen((current) => !current)}>Menu</button>
          <button className="mobile-menu always-show" title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>☰</button>
          <div>
            <h2>{currentPage.label}</h2>
            <p>Trusted device</p>
          </div>
          <div className="topbar-session-actions">
            <div className={`realtime-sync-badge ${realtimeStatus}`} title="Automatically refreshes shared changes from other devices"><span className="realtime-sync-dot" /><strong>{realtimeStatus === 'live' ? 'Live sync' : realtimeStatus === 'connecting' ? 'Connecting' : realtimeStatus === 'error' ? 'Sync retrying' : 'Sync paused'}</strong></div>
            <div className="active-operator-badge"><span className="operator-dot" /><div><strong>{activeStaff.full_name}</strong><small>{activeStaff.role === 'admin' ? 'Admin' : 'Staff'} active</small></div></div>
            <button className="secondary-button" onClick={lockPos}>Lock / Switch</button>
            <button className="secondary-button" onClick={logoutDevice}>Logout Device</button>
          </div>
        </header>

        {activePage === 'pos' && <POSScreen permissions={activeStaff.permissions || {}} isAdmin={activeStaff.role === 'admin'} appSettings={appSettings} />}
        {activePage === 'dashboard' && <Dashboard />}
        {activePage === 'documents' && <DocumentsPage permissions={activeStaff.permissions || {}} isAdmin={activeStaff.role === 'admin'} onOpenPOS={() => setActivePage('pos')} onOpenParties={() => setActivePage('customers_suppliers')} onOpenCashflow={() => setActivePage('cashflow')} onOpenJobs={() => setActivePage('jobs')} />}
        {activePage === 'cod_orders' && <CodOrdersPage />}
        {activePage === 'jobs' && <JobsPage />}
        {activePage === 'tech_assistant' && <TechAssistantPage />}
        {activePage === 'products' && <ProductsPage />}
        {activePage === 'stock' && <StockPage onOpenDocuments={() => setActivePage('documents')} />}
        {activePage === 'warranty' && <WarrantyPage />}
        {activePage === 'reports' && <ReportsPage />}
        {activePage === 'cashflow' && <CashflowPage />}
        {activePage === 'accounting' && <AccountingPage activeStaff={activeStaff} />}
        {activePage === 'customers_suppliers' && <CustomersSuppliersPage />}
        {activePage === 'online_orders' && <OnlineOrdersPage />}
        {activePage === 'settings' && <SettingsPage activeStaff={activeStaff} appSettings={appSettings} autoLockMinutes={securityState.auto_lock_minutes || 5} onSettingsSaved={setAppSettings} onAutoLockChanged={(minutes) => setSecurityState((current) => ({ ...current, auto_lock_minutes: minutes }))} />}
        <nav className="mobile-bottom-navigation" aria-label="Quick navigation">
          {mobileQuickNav.map((item) => <button type="button" key={item.key} className={activePage === item.key ? 'active' : ''} onClick={() => { setActivePage(item.key); setSidebarOpen(false); }}><span>{item.icon}</span><strong>{item.label === 'COD Orders' ? 'COD' : item.label === 'Jobs & Repairs' ? 'Jobs' : item.label}</strong></button>)}
          <button type="button" onClick={() => setSidebarOpen(true)}><span>+</span><strong>More</strong></button>
        </nav>
      </main>
    </div>
  );
}

function SecurityLoadError({ message, onRetry, onLogout }) {
  return (
    <div className="security-screen">
      <div className="security-card">
        <div className="security-mark">!</div>
        <h1>Security setup needed</h1>
        <p>{message}</p>
        <div className="security-actions"><button className="primary-button" onClick={onRetry}>Try Again</button><button className="secondary-button" onClick={onLogout}>Logout</button></div>
      </div>
    </div>
  );
}

function PosSecurityGate({ session, state, deviceToken, onRefresh, onUnlocked, onLogout }) {
  const [staffRows, setStaffRows] = useState([]);
  const [selectedStaffId, setSelectedStaffId] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [fullName, setFullName] = useState(session?.user?.user_metadata?.full_name || session?.user?.email?.split('@')[0] || 'Owner');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const deviceName = browserDeviceName();

  useEffect(() => {
    if (!state.device_trusted) return;
    supabase.rpc('list_pos_unlock_staff_v38', { p_device_token: deviceToken }).then(({ data, error: listError }) => {
      if (listError) setError(listError.message);
      else {
        setStaffRows(data || []);
        setSelectedStaffId((current) => current || data?.[0]?.id || '');
      }
    });
  }, [state.device_trusted, deviceToken]);

  async function completeInitialSetup(event) {
    event.preventDefault();
    if (pin !== confirmPin) { setError('PIN confirmation does not match.'); return; }
    setBusy(true); setError('');
    const { error: setupError } = await supabase.rpc('bootstrap_pos_security_v38', {
      p_full_name: fullName.trim(), p_pin: pin, p_device_token: deviceToken, p_device_name: deviceName
    });
    setBusy(false);
    if (setupError) setError(setupError.message); else { setPin(''); setConfirmPin(''); await onRefresh(); }
  }

  async function trustDevice(event) {
    event.preventDefault();
    if (state.admin_pin_required && pin !== confirmPin) { setError('PIN confirmation does not match.'); return; }
    setBusy(true); setError('');
    const { error: trustError } = await supabase.rpc('trust_current_pos_device_v38', {
      p_device_token: deviceToken, p_device_name: deviceName, p_admin_pin: state.admin_pin_required ? pin : null
    });
    setBusy(false);
    if (trustError) setError(trustError.message); else { setPin(''); setConfirmPin(''); await onRefresh(); }
  }

  async function unlock(event) {
    event.preventDefault();
    if (!selectedStaffId) { setError('Select a user.'); return; }
    setBusy(true); setError('');
    const { data, error: unlockError } = await supabase.rpc('unlock_pos_staff_v38', {
      p_device_token: deviceToken, p_staff_id: selectedStaffId, p_pin: pin
    });
    setBusy(false);
    if (unlockError) { setError(unlockError.message); setPin(''); }
    else onUnlocked(data);
  }

  if (state.setup_required) {
    return (
      <div className="security-screen"><form className="security-card" onSubmit={completeInitialSetup}>
        <AppLogo className="security-mark security-logo" /><h1>Set up the owner</h1><p>This email account will authorize trusted devices. Create your personal 4-digit admin PIN.</p>
        {error && <div className="error-box">{error}</div>}
        <label>Admin name<input value={fullName} onChange={(e) => setFullName(e.target.value)} required /></label>
        <div className="security-pin-pair"><label>4-digit PIN<input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength="4" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} required /></label><label>Confirm PIN<input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength="4" value={confirmPin} onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 4))} required /></label></div>
        <button className="primary-button security-primary" disabled={busy}>{busy ? 'Setting up...' : 'Set Up Trusted Device'}</button>
        <button type="button" className="link-button" onClick={onLogout}>Use another email login</button>
      </form></div>
    );
  }

  if (!state.device_trusted) {
    return (
      <div className="security-screen"><form className="security-card" onSubmit={trustDevice}>
        <div className="security-mark">✓</div><h1>Trust this device</h1><p>{deviceName}</p><small>After this one-time email login, active users can unlock this browser using their personal PIN.</small>
        {error && <div className="error-box">{error}</div>}
        {!state.can_trust_device && <div className="error-box">This email is not linked to an active admin. Sign in with the owner email that completed security setup.</div>}
        {state.admin_pin_required && <div className="security-pin-pair"><label>New 4-digit admin PIN<input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength="4" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} required /></label><label>Confirm PIN<input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength="4" value={confirmPin} onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 4))} required /></label></div>}
        <button className="primary-button security-primary" disabled={busy || !state.can_trust_device}>{busy ? 'Please wait...' : 'Trust This Device'}</button>
        <button type="button" className="link-button" onClick={onLogout}>Logout</button>
      </form></div>
    );
  }

  return (
    <div className="security-screen"><form className="security-card unlock-card" onSubmit={unlock}>
      <div className="security-lock-heading"><AppLogo className="security-mark security-logo" /><div><h1>Who is using the POS?</h1><p>{state.device_name || deviceName} · Locks after {state.auto_lock_minutes || 5} minutes inactive</p></div></div>
      {error && <div className="error-box">{error}</div>}
      <div className="staff-unlock-grid">{staffRows.map((staff) => <button type="button" key={staff.id} className={selectedStaffId === staff.id ? 'staff-unlock-option selected' : 'staff-unlock-option'} onClick={() => { setSelectedStaffId(staff.id); setPin(''); setError(''); }}><span>{staff.full_name.slice(0, 1).toUpperCase()}</span><strong>{staff.full_name}</strong><small>{staff.role === 'admin' ? 'Admin' : 'Staff'}</small></button>)}</div>
      {!staffRows.length && <div className="muted-box">No users with PINs are available. Unlock with the admin after setting a PIN.</div>}
      <label className="unlock-pin-label">4-digit PIN<input autoFocus type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength="4" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="••••" required /></label>
      <button className="primary-button security-primary" disabled={busy || !selectedStaffId || pin.length !== 4}>{busy ? 'Checking...' : 'Unlock POS'}</button>
      <button type="button" className="link-button" onClick={onLogout}>Logout trusted device</button>
    </form></div>
  );
}

function AuthScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');

    const result = await supabase.auth.signInWithPassword({ email, password });

    if (result.error) setMessage(result.error.message);
    setBusy(false);
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={handleSubmit}>
        <AppLogo className="auth-logo" />
        <h1>Computer Shop POS</h1>
        <p>Use the owner email and password to authorize this browser. Daily users will unlock it with their PIN.</p>

        <label>Email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />

        <label>Password</label>
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required minLength={6} />

        {message && <div className="notice">{message}</div>}

        <button className="primary-button" disabled={busy}>
          {busy ? 'Please wait...' : 'Login'}
        </button>
      </form>
    </div>
  );
}

async function prepareAssistantImage(file) {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(file.type)) throw new Error('Use a JPG, PNG or WebP image.');
  if (file.size > 12 * 1024 * 1024) throw new Error('The image is too large. Choose one below 12 MB.');

  const source = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read that image.'));
    reader.readAsDataURL(file);
  });
  const image = await new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error('Could not open that image.'));
    element.src = source;
  });
  const maximumSide = 1600;
  const scale = Math.min(1, maximumSide / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  const mimeType = file.type === 'image/png' && file.size < 1.5 * 1024 * 1024 ? 'image/png' : 'image/jpeg';
  const compressed = canvas.toDataURL(mimeType, mimeType === 'image/jpeg' ? 0.82 : undefined);
  const data = compressed.split(',')[1] || '';
  if (!data) throw new Error('Could not prepare that image.');
  return { name: file.name, mimeType, data, preview: compressed };
}

function TechAssistantPage() {
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState('');
  const [image, setImage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [model, setModel] = useState('Gemini');
  const fileInputRef = useRef(null);
  const conversationRef = useRef(null);

  useEffect(() => {
    conversationRef.current?.scrollTo({ top: conversationRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  async function selectImage(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError('');
    try {
      setImage(await prepareAssistantImage(file));
    } catch (imageError) {
      setImage(null);
      setError(imageError.message || String(imageError));
    }
  }

  function clearImage() {
    setImage(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function askAssistant(event) {
    event.preventDefault();
    const cleanQuestion = question.trim();
    if (!cleanQuestion) { setError('Enter a technical question first.'); return; }
    if (busy) return;

    const userMessage = { id: createClientId(), role: 'user', text: cleanQuestion, imageName: image?.name || '' };
    const requestHistory = messages.slice(-8).map((message) => ({ role: message.role, text: message.text }));
    setMessages((current) => [...current, userMessage]);
    setQuestion('');
    setBusy(true);
    setError('');
    try {
      const { data, error: functionError } = await supabase.functions.invoke('tech-assistant', {
        body: {
          question: cleanQuestion,
          history: requestHistory,
          image: image ? { mimeType: image.mimeType, data: image.data } : null
        }
      });
      if (functionError) {
        let functionMessage = '';
        try {
          const details = await functionError.context?.json();
          functionMessage = details?.error || '';
        } catch {
          functionMessage = '';
        }
        throw new Error(functionMessage || functionError.message);
      }
      if (!data?.answer) throw new Error(data?.error || 'Gemini returned an empty answer.');
      setModel(data.model || 'Gemini');
      setMessages((current) => [...current, { id: createClientId(), role: 'assistant', text: data.answer }]);
      clearImage();
    } catch (assistantError) {
      setError(`${assistantError.message || String(assistantError)}${String(assistantError.message || assistantError).includes('Failed to send') ? ' Deploy the tech-assistant Edge Function and set GEMINI_API_KEY.' : ''}`);
    } finally {
      setBusy(false);
    }
  }

  function resetConversation() {
    setMessages([]);
    setQuestion('');
    setError('');
    clearImage();
  }

  const quickPrompts = [
    'Which battery is compatible with this laptop model and what must I verify?',
    'Help diagnose a laptop that powers on but has no display.',
    'Identify this part from its label and explain compatible replacements.',
    'Give me the best YouTube search phrase for disassembling this laptop.'
  ];

  return (
    <section className="page-section tech-assistant-page">
      <div className="tech-assistant-header">
        <div><span className="tech-assistant-kicker">Gemini technical tool</span><h3>Tech Assistant</h3><p>Ask about laptop parts, compatible replacements, troubleshooting and repair procedures. Add a clear label photo when available.</p></div>
        <button type="button" className="secondary-button" onClick={resetConversation}>New Conversation</button>
      </div>

      <div className="tech-assistant-layout">
        <aside className="panel-card tech-assistant-guide">
          <h4>Useful questions</h4>
          <div className="tech-prompt-list">{quickPrompts.map((prompt) => <button type="button" key={prompt} onClick={() => setQuestion(prompt)}>{prompt}</button>)}</div>
          <div className="tech-assistant-safety"><strong>Verify before fitting</strong><span>Confirm the exact model, part number, voltage, connector, polarity and dimensions. AI answers can be incomplete or wrong.</span></div>
          <small>Do not include customer names, phone numbers, invoices or other private information. Free-tier Gemini requests may be used by Google to improve its products.</small>
        </aside>

        <div className="panel-card tech-chat-card">
          <div className="tech-chat-status"><div><span className="realtime-sync-dot" /><strong>{model}</strong></div><small>Technical guidance, not a replacement for manufacturer service documentation</small></div>
          <div className="tech-conversation" ref={conversationRef}>
            {!messages.length && <div className="tech-chat-empty"><span>AI</span><h4>What are you repairing?</h4><p>Enter the full laptop model or upload a readable photo of the battery or part label.</p></div>}
            {messages.map((message) => <article key={message.id} className={`tech-message ${message.role}`}>
              <div className="tech-message-heading"><strong>{message.role === 'user' ? 'You' : 'Tech Assistant'}</strong>{message.imageName && <small>Photo: {message.imageName}</small>}</div>
              <div className="tech-message-text">{message.text}</div>
              {message.role === 'user' && <a className="tech-video-link" href={`https://www.youtube.com/results?search_query=${encodeURIComponent(`${message.text} disassembly repair`)}`} target="_blank" rel="noreferrer">Search YouTube for videos</a>}
            </article>)}
            {busy && <article className="tech-message assistant loading"><div className="tech-message-heading"><strong>Tech Assistant</strong></div><div className="tech-thinking"><span /><span /><span /> Checking the details...</div></article>}
          </div>

          {error && <div className="error-box tech-assistant-error">{error}</div>}
          <form className="tech-assistant-composer" onSubmit={askAssistant}>
            {image && <div className="tech-image-preview"><img src={image.preview} alt="Selected technical reference" /><div><strong>{image.name}</strong><small>Compressed securely before sending</small></div><button type="button" className="secondary-button" onClick={clearImage}>Remove</button></div>}
            <textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Example: Dell Latitude 5490, original battery says WDX0R 11.4V. What replacements are compatible?" maxLength={2000} />
            <div className="tech-composer-actions">
              <label className="secondary-button tech-photo-button">Add Photo<input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={selectImage} /></label>
              <small>{question.length}/2000</small>
              <button className="primary-button" disabled={busy || !question.trim()}>{busy ? 'Asking Gemini...' : 'Ask Gemini'}</button>
            </div>
          </form>
        </div>
      </div>
    </section>
  );
}




function POSScreen({ permissions = {}, isAdmin = false, appSettings = DEFAULT_APP_SETTINGS } = {}) {
  const can = (permission) => isAdmin || permissions?.[permission] === true;
  const allowNegativeStock = appSettings.allow_negative_pos_stock === true;
  const savedBills = safeReadJson(POS_DRAFTS_KEY, null);
  const initialBills = Array.isArray(savedBills?.bills) && savedBills.bills.length ? savedBills.bills : [emptyBill()];
  const [bills, setBills] = useState(initialBills);
  const [activeBillId, setActiveBillId] = useState(savedBills?.activeBillId || initialBills[0]?.id);
  const [search, setSearch] = useState('');
  const [products, setProducts] = useState([]);
  const [assemblies, setAssemblies] = useState([]);
  const [assemblyPreview, setAssemblyPreview] = useState(null);
  const [selectedPosProduct, setSelectedPosProduct] = useState(null);
  const [posProductDraft, setPosProductDraft] = useState({ qty: 1, unitPrice: 0 });
  const [companySettings, setCompanySettings] = useState(DEFAULT_COMPANY_SETTINGS);
  const [savedInvoiceReceipt, setSavedInvoiceReceipt] = useState(null);
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
  const [showReturnLookup, setShowReturnLookup] = useState(false);
  const [returnSearch, setReturnSearch] = useState('');
  const [returnInvoice, setReturnInvoice] = useState(null);
  const [returnItems, setReturnItems] = useState([]);
  const [returnInvoiceMatches, setReturnInvoiceMatches] = useState([]);
  const [returnPartyFilter, setReturnPartyFilter] = useState('eligible');
  const [returnBusy, setReturnBusy] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ name: '', phone: '', address: '' });
  const posGridRef = useRef(null);
  const returnLookupRequestRef = useRef(0);
  const [posLeftPercent, setPosLeftPercent] = useState(() => Number(window.localStorage.getItem('computer_shop_pos_split_left_percent') || 52));
  const [isResizingPos, setIsResizingPos] = useState(false);
  const [mobilePosPanel, setMobilePosPanel] = useState('products');

  const activeBill = bills.find((bill) => bill.id === activeBillId) || bills[0] || emptyBill();
  const selectedCustomer = customers.find((row) => row.id === activeBill.customerId);
  const visiblePaymentMethods = paymentMethods
    .filter((method) => (
      !method.name.toLowerCase().includes('store credit')
      && (selectedCustomer || method.is_paid_method !== false)
    ))
    .sort((a, b) => {
      if (a.id === appSettings.default_payment_method_id) return -1;
      if (b.id === appSettings.default_payment_method_id) return 1;
      return a.name.localeCompare(b.name);
    });
  const currentOutstanding = selectedCustomer ? numberValue(selectedCustomer.due_balance) - numberValue(selectedCustomer.store_credit_balance) : 0;
  const paymentLines = Array.isArray(activeBill.paymentLines) ? activeBill.paymentLines : [];

  const subtotal = useMemo(() => activeBill.items.reduce((sum, item) => sum + Number(item.lineTotal || 0), 0), [activeBill.items]);
  const cartDiscount = activeBill.cartDiscountType === 'percent'
    ? subtotal * (Number(activeBill.cartDiscountValue || 0) / 100)
    : Number(activeBill.cartDiscountValue || 0);
  const total = subtotal < 0 ? subtotal + Math.abs(cartDiscount) : subtotal - cartDiscount;
  const useExistingCustomerCredit = activeBill.useExistingCustomerCredit === true;
  const balanceUsedForCurrentBill = useExistingCustomerCredit
    ? total > 0 && currentOutstanding < 0
      ? Math.min(Math.abs(currentOutstanding), Math.abs(total))
      : total < 0 && currentOutstanding > 0
        ? Math.min(currentOutstanding, Math.abs(total))
        : 0
    : 0;
  // POS payment lines belong to this bill only. Existing shop credit may offset
  // the bill, but old customer debt is paid from Customers & Suppliers.
  const amountToSettleCurrentBill = Math.max(Math.abs(roundMoney(total)) - balanceUsedForCurrentBill, 0);

  const categoryChildren = useMemo(() => {
    if (posCategoryId === 'assemblies') return [];
    return categories
      .filter((cat) => (posCategoryId === 'root' ? !cat.parent_id : cat.parent_id === posCategoryId))
      .sort((a, b) => categoryDisplayName(a).localeCompare(categoryDisplayName(b)));
  }, [categories, posCategoryId]);

  const currentCategory = categories.find((cat) => cat.id === posCategoryId);
  const breadcrumb = useMemo(() => {
    if (posCategoryId === 'assemblies') return [{ id: 'root', name: 'Products' }, { id: 'assemblies', name: 'PC Assemblies' }];
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
    loadPosAssemblies();
    loadCustomers();
    loadPaymentMethods();
    fetchCompanySettings().then(setCompanySettings).catch(() => {});
  }, []);

  useRealtimeRefresh(['products', 'stock_balances', 'stock_movements', 'categories', 'product_assemblies', 'product_assembly_items'], () => {
    loadCategories();
    loadProducts();
    loadPosAssemblies();
  });
  useRealtimeRefresh(['documents', 'document_items', 'customers', 'cashflow_entries'], () => {
    loadCustomers();
    if (showReturnLookup) loadReturnInvoiceOptions();
  });
  useRealtimeRefresh(['payment_methods'], loadPaymentMethods);
  useRealtimeRefresh(['company_settings'], () => fetchCompanySettings().then(setCompanySettings).catch(() => {}));

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
          id: createClientId(),
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
    if (!showReturnLookup) return undefined;
    const timeout = setTimeout(() => loadReturnInvoiceOptions(), 180);
    return () => clearTimeout(timeout);
  }, [showReturnLookup, returnSearch, returnPartyFilter, activeBill.customerId]);

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

  async function loadCategories() {
    const { data, error } = await supabase.from('categories').select('id, name, parent_id, path').order('path', { ascending: true });
    if (error) setMessage(error.message);
    else setCategories(data || []);
  }

  async function loadProducts() {
    const clean = search.trim().replace(/,/g, ' ');
    if (posCategoryId === 'assemblies') {
      setProducts([]);
      return;
    }
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

  async function loadPosAssemblies() {
    const { data, error } = await supabase.from('product_assembly_pos_view').select('*').eq('is_active', true).order('assembly_code');
    if (error) setMessage(error.message); else setAssemblies(data || []);
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

  function openPosProductPicker(product) {
    const trackInventory = product.track_inventory !== false;
    const availableQty = Number(product.available_qty || 0);
    const alreadyInCart = activeBill.items
      .filter((item) => item.product_id === product.product_id && !item.isReturn && Number(item.qty || 0) > 0)
      .reduce((sum, item) => sum + Number(item.qty || 0), 0);
    if (!allowNegativeStock && trackInventory && availableQty - alreadyInCart <= 0) {
      setMessage(`${product.item_code || product.name}: maximum available quantity is ${availableQty}.`);
      return;
    }
    setMessage('');
    setSelectedPosProduct(product);
    setPosProductDraft({ qty: 1, unitPrice: Number(product.selling_price || 0) });
  }

  function addProduct(product, requestedQty = 1, requestedUnitPrice = null) {
    const trackInventory = product.track_inventory !== false;
    const availableQty = Number(product.available_qty || 0);
    if (!allowNegativeStock && trackInventory && availableQty <= 0) {
      setMessage(`${product.item_code || product.name} has no available stock.`);
      return;
    }
    const alreadyInCart = activeBill.items
      .filter((item) => item.product_id === product.product_id && !item.isReturn && Number(item.qty || 0) > 0)
      .reduce((sum, item) => sum + Number(item.qty || 0), 0);
    const remainingQty = trackInventory && !allowNegativeStock ? Math.max(availableQty - alreadyInCart, 0) : Number.POSITIVE_INFINITY;
    if (!allowNegativeStock && trackInventory && remainingQty <= 0) {
      setMessage(`${product.item_code || product.name}: maximum available quantity is ${availableQty}.`);
      return false;
    }
    const cleanRequestedQty = Math.max(Number(requestedQty || 0), 0);
    const qty = trackInventory && !allowNegativeStock ? Math.min(cleanRequestedQty, remainingQty) : cleanRequestedQty;
    const unitPrice = Number(requestedUnitPrice ?? product.selling_price ?? 0);
    if (qty <= 0) {
      setMessage('Quantity must be greater than zero.');
      return false;
    }
    // Products selected normally may merge only with another normal line. Assembly
    // component lines stay separate so additions/upgrades do not inherit their discount.
    const existing = activeBill.items.find((item) => (
      item.product_id === product.product_id
      && !item.isReturn
      && !item.assemblyGroupId
      && roundMoney(item.unitPrice) === roundMoney(unitPrice)
      && Number(item.qty || 0) > 0
    ));
    if (existing) {
      const nextQty = Number(existing.qty || 0) + qty;
      updateItem(existing.id, { qty: nextQty, availableQty, trackInventory });
      updateActiveBill({ selectedItemId: existing.id });
      if (!allowNegativeStock && trackInventory && cleanRequestedQty > remainingQty) setMessage(`${product.item_code || product.name}: quantity limited to available stock (${availableQty}).`);
      return true;
    }
    const item = recalcItem({
      id: createClientId(),
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
      availableQty,
      trackInventory,
      lineTotal: unitPrice * qty
    });
    updateActiveBill({ items: [...activeBill.items, item], selectedItemId: item.id });
    if (!allowNegativeStock && trackInventory && cleanRequestedQty > remainingQty) setMessage(`${product.item_code || product.name}: quantity limited to available stock (${availableQty}).`);
    return true;
  }

  function confirmPosProduct(event) {
    event.preventDefault();
    if (!selectedPosProduct) return;
    const added = addProduct(selectedPosProduct, posProductDraft.qty, posProductDraft.unitPrice);
    if (added) {
      setSelectedPosProduct(null);
      setPosProductDraft({ qty: 1, unitPrice: 0 });
      setMobilePosPanel('bill');
    }
  }

  function addAssemblyToCart(assembly) {
    const components = Array.isArray(assembly?.components) ? assembly.components : [];
    if (!components.length) { setMessage('This assembly has no components.'); return; }
    const shortages = allowNegativeStock ? [] : components.filter((component) => {
      if (component.track_inventory === false) return false;
      const alreadyInCart = activeBill.items.filter((item) => item.product_id === component.product_id && !item.isReturn && Number(item.qty || 0) > 0).reduce((sum, item) => sum + Number(item.qty || 0), 0);
      return alreadyInCart + numberValue(component.qty) > numberValue(component.available_qty);
    });
    if (shortages.length) {
      setMessage(`Cannot add ${assembly.name}. Not enough stock: ${shortages.map((item) => `${item.item_code} needs ${numberValue(item.qty)}, available ${numberValue(item.available_qty)}`).join('; ')}.`);
      return;
    }

    const groupId = createClientId();
    const componentGrosses = components.map((component) => (
      roundMoney(numberValue(component.qty) * numberValue(component.selling_price))
    ));
    const componentGrossTotal = roundMoney(componentGrosses.reduce((sum, value) => sum + value, 0));
    const assemblyDiscountTotal = Math.min(
      Math.max(roundMoney(numberValue(assembly.discount_amount)), 0),
      componentGrossTotal
    );
    let remainingDiscount = assemblyDiscountTotal;
    const nextItems = components.map((component, index) => {
      const qty = numberValue(component.qty);
      const isLastComponent = index === components.length - 1;
      // Use clean whole-rupee amounts where possible. The final component receives
      // the rounding remainder so all component discounts exactly match the package.
      const proportionalDiscount = componentGrossTotal > 0
        ? assemblyDiscountTotal * componentGrosses[index] / componentGrossTotal
        : 0;
      const lineDiscount = isLastComponent
        ? roundMoney(remainingDiscount)
        : Math.min(Math.round(proportionalDiscount), remainingDiscount);
      remainingDiscount = roundMoney(remainingDiscount - lineDiscount);
      return recalcItem({
        id: createClientId(), product_id: component.product_id, item_code: component.item_code,
        name: component.name, qty, unitPrice: numberValue(component.selling_price), unitCost: numberValue(component.avg_cost),
        discountType: 'amount', discountValue: lineDiscount,
        isReturn: false, returnCondition: 'sellable', availableQty: numberValue(component.available_qty),
        trackInventory: component.track_inventory !== false,
        assemblyGroupId: groupId, assemblyId: assembly.id, assemblyCode: assembly.assembly_code,
        assemblyName: assembly.name, lineTotal: 0
      });
    });
    updateActiveBill({ items: [...activeBill.items, ...nextItems], selectedItemId: nextItems[0]?.id || '' });
    setAssemblyPreview(null);
    setMobilePosPanel('bill');
    setMessage(`${assembly.name} added with ${components.length} separate component lines and ${money(assemblyDiscountTotal)} allocated discount.`);
  }

  function recalcItem(item) {
    const gross = Number(item.qty || 0) * Number(item.unitPrice || 0);
    const discount = item.discountType === 'percent'
      ? Math.abs(gross) * (Number(item.discountValue || 0) / 100)
      : Number(item.discountValue || 0);
    return { ...item, lineTotal: gross < 0 ? gross + discount : gross - discount };
  }

  function updateItem(itemId, patch) {
    const currentItem = activeBill.items.find((item) => item.id === itemId);
    let safePatch = patch;
    if (!allowNegativeStock && currentItem && currentItem.trackInventory !== false && Object.prototype.hasOwnProperty.call(patch, 'qty') && Number(patch.qty) >= 0 && !currentItem.isReturn) {
      const availableQty = Number(currentItem.availableQty ?? products.find((product) => product.product_id === currentItem.product_id)?.available_qty ?? Infinity);
      const otherQty = activeBill.items
        .filter((item) => item.id !== itemId && item.product_id === currentItem.product_id && !item.isReturn && Number(item.qty || 0) > 0)
        .reduce((sum, item) => sum + Number(item.qty || 0), 0);
      const maxForLine = Math.max(availableQty - otherQty, 0);
      if (Number(patch.qty) > maxForLine) {
        safePatch = { ...patch, qty: maxForLine };
        setMessage(`${currentItem.item_code || currentItem.name}: quantity limited to available stock (${availableQty}).`);
      }
    }
    const items = activeBill.items.map((item) => item.id === itemId ? recalcItem({ ...item, ...safePatch }) : item);
    updateActiveBill({ items });
  }

  async function loadReturnInvoiceOptions() {
    const requestId = ++returnLookupRequestRef.current;
    setReturnBusy(true);
    let query = supabase
      .from('documents')
      .select('id, document_no, document_date, created_at, customer_id, total_amount, customers:customers!documents_customer_id_fkey(id, name, phone)')
      .eq('document_type', 'invoice')
      .order('document_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(40);

    if (activeBill.customerId) {
      if (returnPartyFilter === 'customer') query = query.eq('customer_id', activeBill.customerId);
      else if (returnPartyFilter === 'walkin') query = query.is('customer_id', null);
      else query = query.or(`customer_id.eq.${activeBill.customerId},customer_id.is.null`);
    } else {
      query = query.is('customer_id', null);
    }

    const cleanSearch = returnSearch.trim();
    if (cleanSearch) query = query.ilike('document_no', `%${cleanSearch}%`);
    const { data, error } = await query;
    if (requestId !== returnLookupRequestRef.current) return [];
    setReturnBusy(false);
    if (error) {
      setReturnInvoiceMatches([]);
      setMessage(error.message);
      return [];
    }
    setReturnInvoiceMatches(data || []);
    return data || [];
  }

  async function findReturnInvoice(event) {
    event?.preventDefault();
    setMessage('');
    const matches = await loadReturnInvoiceOptions();
    if (!matches.length) setMessage(`No ${selectedCustomer ? `${selectedCustomer.name} or Walk-in` : 'Walk-in'} invoices match that number.`);
  }

  async function chooseReturnInvoice(invoice) {
    if (!invoice) return;
    if (activeBill.customerId && invoice.customer_id && activeBill.customerId !== invoice.customer_id) {
      setMessage(`Choose an invoice belonging to ${selectedCustomer?.name || 'the selected customer'} or Walk-in Customer.`);
      return;
    }
    if (!activeBill.customerId && invoice.customer_id) {
      setMessage('Select that invoice customer on the POS bill first. Walk-in mode only shows Walk-in invoices.');
      return;
    }
    setReturnBusy(true); setMessage('');
    const { data: soldRows, error: itemError } = await supabase.from('document_items').select('*').eq('document_id', invoice.id).gt('qty', 0).order('created_at');
    if (itemError) { setReturnBusy(false); setMessage(itemError.message); return; }
    const soldProductIds = [...new Set((soldRows || []).map((row) => row.product_id).filter(Boolean))];
    const { data: productTypes, error: productTypeError } = soldProductIds.length
      ? await supabase.from('products').select('id, track_inventory').in('id', soldProductIds)
      : { data: [], error: null };
    if (productTypeError) { setReturnBusy(false); setMessage(productTypeError.message); return; }
    const trackInventoryMap = new Map((productTypes || []).map((row) => [row.id, row.track_inventory !== false]));
    const sourceIds = (soldRows || []).map((row) => row.id);
    const { data: priorReturns, error: returnError } = sourceIds.length
      ? await supabase.from('document_items').select('source_document_item_id, qty').in('source_document_item_id', sourceIds)
      : { data: [], error: null };
    if (returnError) { setReturnBusy(false); setMessage('Run migration 036 before using invoice returns.'); return; }
    const returnedByItem = new Map();
    (priorReturns || []).forEach((row) => returnedByItem.set(row.source_document_item_id, numberValue(returnedByItem.get(row.source_document_item_id)) + Math.abs(numberValue(row.qty))));
    setReturnInvoice(invoice);
    setReturnItems((soldRows || []).map((row) => ({ ...row, trackInventory: trackInventoryMap.get(row.product_id) !== false, selected: false, returnQty: 1, damaged: false, reason: '', remainingQty: Math.max(numberValue(row.qty) - numberValue(returnedByItem.get(row.id)), 0) })));
    setReturnBusy(false);
  }

  async function addInvoiceReturns(exchangeSameItem = false) {
    if (!can('process_returns')) { setMessage('The active user does not have permission to process returns.'); return; }
    const chosen = returnItems.filter((row) => row.selected && numberValue(row.returnQty) > 0 && numberValue(row.returnQty) <= numberValue(row.remainingQty));
    if (!chosen.length) { setMessage('Select at least one return item and quantity.'); return; }
    if (activeBill.customerId && returnInvoice.customer_id && activeBill.customerId !== returnInvoice.customer_id) { setMessage('This bill already belongs to a different customer. Open a new bill for this return.'); return; }
    setReturnBusy(true);
    const productIds = [...new Set(chosen.map((row) => row.product_id).filter(Boolean))];
    const { data: stockRows, error: stockError } = productIds.length ? await supabase.from('product_stock_view').select('product_id, available_qty, track_inventory').in('product_id', productIds) : { data: [], error: null };
    if (stockError) { setReturnBusy(false); setMessage(stockError.message); return; }
    const stockMap = new Map((stockRows || []).map((row) => [row.product_id, { availableQty: numberValue(row.available_qty), trackInventory: row.track_inventory !== false }]));
    if (exchangeSameItem) {
      const unavailable = chosen.find((row) => {
        const stock = stockMap.get(row.product_id);
        return stock?.trackInventory !== false && numberValue(stock?.availableQty) < numberValue(row.returnQty);
      });
      if (unavailable) { setReturnBusy(false); setMessage(`${unavailable.item_code || unavailable.description}: not enough sellable stock for exchange.`); return; }
    }
    const added = [];
    chosen.forEach((row) => {
      const qty = numberValue(row.returnQty);
      const proportionalDiscount = row.discount_type === 'amount' ? roundMoney(numberValue(row.discount_value) * qty / Math.abs(numberValue(row.qty))) : numberValue(row.discount_value);
      const stock = stockMap.get(row.product_id);
      const shared = { product_id: row.product_id, item_code: row.item_code, name: row.description, unitPrice: numberValue(row.unit_price), unitCost: numberValue(row.unit_cost), discountType: row.discount_type || 'none', discountValue: proportionalDiscount, trackInventory: stock?.trackInventory !== false };
      added.push(recalcItem({ id: createClientId(), ...shared, qty: -qty, isReturn: true, returnCondition: row.damaged ? 'warranty_damaged' : 'sellable', sourceDocumentItemId: row.id, returnReason: row.reason || '', sourceInvoiceNo: returnInvoice.document_no }));
      if (exchangeSameItem) added.push(recalcItem({ id: createClientId(), ...shared, qty, isReturn: false, returnCondition: 'sellable', availableQty: numberValue(stock?.availableQty), sourceDocumentItemId: null, returnReason: '' }));
    });
    updateActiveBill({ items: [...activeBill.items, ...added], customerId: activeBill.customerId || returnInvoice.customer_id || '', selectedItemId: added[0]?.id || '', paymentLines: [], notes: `${activeBill.notes || ''}${activeBill.notes ? '\n' : ''}${exchangeSameItem ? 'Exchange' : 'Return'} from ${returnInvoice.document_no}` });
    setShowReturnLookup(false); setReturnInvoice(null); setReturnItems([]); setReturnInvoiceMatches([]); setReturnSearch(''); setReturnBusy(false);
    setMessage(`${exchangeSameItem ? 'Exchange' : 'Return'} items from ${returnInvoice.document_no} added to POS.`);
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

  function voidCurrentBill() {
    if (!can('void_sales')) { setMessage('The active user does not have permission to void bills.'); return; }
    const hasDraftContent = activeBill.items.length > 0 || paymentLines.length > 0 || numberValue(activeBill.cartDiscountValue) !== 0;
    if (hasDraftContent && !window.confirm('Void this unsaved bill? Its items, discounts, and payment lines will be removed.')) return;
    closeBill();
    setMessage('Current unsaved bill was voided.');
  }

  function setCustomer(customerId) {
    const customer = customers.find((row) => row.id === customerId);
    const safePaymentLines = customerId ? paymentLines : paymentLines.filter((line) => line.isPaidMethod !== false);
    updateActiveBill({ customerId, customerName: customer?.name || '', paymentLines: safePaymentLines });
    if (!customerId && safePaymentLines.length !== paymentLines.length) {
      setPaymentDraft((current) => current.filter((line) => line.isPaidMethod !== false));
      setMessage('Credit payment was removed because walk-in customers cannot keep a balance.');
    }
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

  function currentBillTarget(shouldUseCustomerCredit = useExistingCustomerCredit) {
    const balanceUsed = shouldUseCustomerCredit
      ? total > 0 && currentOutstanding < 0
        ? Math.min(Math.abs(currentOutstanding), Math.abs(total))
        : total < 0 && currentOutstanding > 0
          ? Math.min(currentOutstanding, Math.abs(total))
          : 0
      : 0;
    return {
      amount: Math.max(Math.abs(roundMoney(total)) - balanceUsed, 0),
      direction: total >= 0 ? 'in' : 'out',
      label: total >= 0 ? 'Current bill amount to collect' : 'Current bill amount to refund',
      balanceUsed
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
    if (method?.is_paid_method === false && !selectedCustomer) {
      setMessage('Select a customer before using Credit or keeping any balance.');
      setShowCustomerPanel(true);
      return;
    }
    const target = currentBillTarget();
    const currentTotal = paymentLineTotal();
    const remaining = Math.max(target.amount - currentTotal, 0);
    const requestedAmount = amountOverride !== null
      ? Number(amountOverride || 0)
      : Number(lineAmountInput || remaining || target.amount || 0);
    const amount = Math.min(requestedAmount, remaining);
    if (!method || amount <= 0) return;
    if (requestedAmount > remaining + 0.005) setMessage('POS payments cannot exceed the current bill. Record old-balance payments from Customers & Suppliers.');
    const line = {
      id: createClientId(),
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
    const target = currentBillTarget(false);
    if (!method) return;
    if (target.amount <= 0) {
      updateActiveBill({ paymentLines: [] });
      setMessage('This document has no payment amount.');
      return;
    }
    const line = {
      id: createClientId(),
      paymentMethodId: method.id,
      paymentMethodName: method.name,
      amount: target.amount,
      direction: target.direction,
      isPaidMethod: method.is_paid_method !== false,
      affectsCashflow: method.affects_cashflow !== false
    };
    updateActiveBill({ paymentLines: [line], useExistingCustomerCredit: false });
    setShowPaymentPanel(false);
    setMessage(`Payment set: ${method.name} ${money(target.amount)}.`);
  }

  function quickPayAndSave(methodName) {
    const method = paymentMethodByName(methodName);
    const target = currentBillTarget(false);
    if (!method) {
      setMessage(`${methodName} payment type is not active.`);
      return;
    }
    if (target.amount <= 0) {
      updateActiveBill({ paymentLines: [], useExistingCustomerCredit: false });
      saveInvoice([], { useExistingCustomerCredit: false });
      return;
    }
    const line = {
      id: createClientId(),
      paymentMethodId: method.id,
      paymentMethodName: method.name,
      amount: target.amount,
      direction: target.direction,
      isPaidMethod: method.is_paid_method !== false,
      affectsCashflow: method.affects_cashflow !== false
    };
    updateActiveBill({ paymentLines: [line], useExistingCustomerCredit: false });
    saveInvoice([line], { useExistingCustomerCredit: false });
  }

  function backToSaleFromPayment() {
    updateActiveBill({ paymentLines: paymentDraft });
    setShowPaymentPanel(false);
  }

  async function saveCurrentBillAsQuotation() {
    if (!can('create_quotes')) { setMessage('The active user does not have permission to create quotations.'); return; }
    setMessage('');
    if (!activeBill.items.length) {
      setMessage('Add at least one item before saving quotation.');
      return;
    }
    setSaving(true);
    try {
      const quoteItems = activeBill.items.map((item) => ({
        product_id: item.product_id,
        item_code: item.item_code,
        description: item.assemblyCode ? `[${item.assemblyCode} ${item.assemblyName}] ${item.name}` : item.name,
        qty: Number(item.qty || 0),
        unit_price: Number(item.unitPrice || 0),
        unit_cost: Number(item.unitCost || 0),
        discount_type: item.discountValue ? item.discountType : 'none',
        discount_value: Number(item.discountValue || 0),
        line_total: Number(item.lineTotal || 0)
      }));
      const { data: doc, error: quoteError } = await supabase.rpc('save_quotation_v24', {
        p_header: {
          document_no: '',
          customer_id: activeBill.customerId || '',
          document_date: todayInputDate(),
          notes: activeBill.notes || 'Created from POS quote shortcut'
        },
        p_items: quoteItems
      });
      if (quoteError) throw quoteError;
      setMessage(`Quotation saved: ${doc?.document_no || ''}.`);
      if (window.confirm('Quotation saved. Clear this POS bill now?')) closeBill();
    } catch (err) {
      setMessage(err.message || String(err));
    } finally {
      setSaving(false);
    }
  }

  async function saveInvoice(paymentLinesOverride = null, options = {}) {
    const linesForSave = paymentLinesOverride || paymentLines;
    const useCreditForSave = options.useExistingCustomerCredit ?? useExistingCustomerCredit;
    const saveTarget = currentBillTarget(useCreditForSave);
    setMessage('');
    if (!activeBill.items.length) {
      setMessage('Add at least one item.');
      return;
    }
    if (!linesForSave.length && saveTarget.amount > 0.005) {
      openPaymentPanel();
      setMessage('Select payment details before saving.');
      return;
    }
    if (paymentLineTotal(linesForSave) > saveTarget.amount + 0.005) {
      setMessage('Payment exceeds the current bill. Use Customers & Suppliers to record a payment against previous outstanding balance.');
      openPaymentPanel();
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
    if (appSettings.confirm_pos_sale && !window.confirm(`Save this invoice for ${money(total)}?`)) return;

    setSaving(true);
    const payload = {
      document_no: activeBill.documentNo,
      customer_id: activeBill.customerId || null,
      cart_discount_type: activeBill.cartDiscountType,
      cart_discount_value: Number(activeBill.cartDiscountValue || 0),
      use_existing_customer_credit: useCreditForSave,
      notes: activeBill.notes || ''
    };
    const itemsPayload = activeBill.items.map((item) => ({
      product_id: item.product_id,
      item_code: item.item_code,
      description: item.assemblyCode ? `[${item.assemblyCode} ${item.assemblyName}] ${item.name}` : item.name,
      qty: Number(item.qty || 0),
      unit_price: Number(item.unitPrice || 0),
      unit_cost: Number(item.unitCost || 0),
      discount_type: item.discountValue ? item.discountType : 'none',
      discount_value: Number(item.discountValue || 0),
      return_condition: item.isReturn ? item.returnCondition || 'sellable' : null,
      source_document_item_id: item.isReturn ? item.sourceDocumentItemId || null : null,
      return_reason: item.isReturn ? item.returnReason || null : null
    }));
    const paymentPayload = linesForSave.map((line) => ({
      payment_method_id: line.paymentMethodId,
      payment_method_name: line.paymentMethodName,
      amount: Number(line.amount || 0),
      direction: line.direction || 'in'
    }));

    let { data, error } = await supabase.rpc('save_pos_invoice_v41', {
      p_header: payload,
      p_items: itemsPayload,
      p_payments: paymentPayload
    });
    if (error && /save_pos_invoice_v41|schema cache|could not find the function/i.test(error.message || '')) {
      ({ data, error } = await supabase.rpc('save_pos_invoice_v37', {
        p_header: payload,
        p_items: itemsPayload,
        p_payments: paymentPayload
      }));
    }
    if (error) {
      setSaving(false);
      setMessage(error.message);
      return;
    }
    if (activeBill.sourceQuoteId && data?.id) {
      await supabase
        .from('documents')
        .update({ status: 'converted', linked_document_id: data.id, notes: `${activeBill.notes || ''}\nConverted to invoice ${data.document_no || activeBill.documentNo}`.trim() })
        .eq('id', activeBill.sourceQuoteId);
    }
    let savedDocument = {
      id: data?.id,
      document_no: data?.document_no || activeBill.documentNo,
      document_type: 'invoice',
      status: Math.abs(resultingOutstanding) <= 0.005 ? 'completed' : 'unpaid',
      total_amount: total,
      paid_amount: Math.min(Math.max(total, 0), paidIn),
      balance_amount: Math.max(resultingOutstanding, 0),
      document_date: new Date().toISOString(),
      notes: activeBill.notes || '',
      payment_method_name: linesForSave.map((line) => line.paymentMethodName).filter(Boolean).join(' + '),
      party: selectedCustomer || null,
      party_outstanding_after: resultingOutstanding
    };
    let savedItems = itemsPayload.map((item) => ({ ...item, line_total: recalcItem({ qty: item.qty, unitPrice: item.unit_price, discountType: item.discount_type, discountValue: item.discount_value }).lineTotal }));
    let savedFlows = [];
    if (data?.id) {
      const [documentRes, itemRes, flowRes] = await Promise.all([
        supabase.from('documents').select('*').eq('id', data.id).maybeSingle(),
        supabase.from('document_items').select('*').eq('document_id', data.id).order('created_at'),
        supabase.from('cashflow_entries').select('id, entry_type, account_name, amount, description, created_at, payment_method_id, payment_methods(name)').eq('document_id', data.id).order('created_at')
      ]);
      if (documentRes.data) savedDocument = { ...savedDocument, ...documentRes.data, payment_method_name: savedDocument.payment_method_name, party: selectedCustomer || null, party_outstanding_after: resultingOutstanding };
      if (!itemRes.error && itemRes.data) savedItems = itemRes.data;
      if (!flowRes.error && flowRes.data) savedFlows = flowRes.data;
    }
    setSavedInvoiceReceipt({ document: savedDocument, items: savedItems, flows: savedFlows });
    setSaving(false);
    setMessage(`Invoice saved: ${data?.document_no || activeBill.documentNo}${activeBill.sourceQuoteNo ? ` from quotation ${activeBill.sourceQuoteNo}` : ''}.`);
    await loadCustomers();
    await loadPosAssemblies();
    await loadProducts();
    closeBill();
  }

  const customerBalanceText = selectedCustomer
    ? currentOutstanding === 0
      ? 'Outstanding balance: LKR 0.00'
      : `Outstanding balance: ${currentOutstanding < 0 ? '-' : ''}${money(Math.abs(currentOutstanding))}`
    : 'Walk-in customer';

  const primaryBankMethod = visiblePaymentMethods.find((method) => method.name.trim().toLowerCase() === 'bank 1')
    || visiblePaymentMethods.find((method) => method.name.trim().toLowerCase() === 'bank')
    || visiblePaymentMethods.find((method) => method.name.toLowerCase().includes('bank'));
  const quickMethods = [paymentMethodByName('Cash'), primaryBankMethod, paymentMethodByName('Credit')]
    .filter((method, index, rows) => method && rows.findIndex((row) => row?.id === method.id) === index);
  const currentTarget = currentBillTarget();
  const remainingCurrent = Math.max(currentTarget.amount - paymentLineTotal(), 0);
  const modalNet = paymentNetForBalance(paymentDraft);
  const modalProjectedOutstanding = currentOutstanding + total - modalNet.paidIn + modalNet.refundOut;
  const cleanAssemblySearch = search.trim().toLowerCase();
  const visiblePosAssemblies = assemblies.filter((assembly) => {
    if (posCategoryId !== 'assemblies' && !cleanAssemblySearch) return false;
    return !cleanAssemblySearch || `${assembly.assembly_code} ${assembly.name} ${assembly.barcode || ''}`.toLowerCase().includes(cleanAssemblySearch);
  });

  return (
    <section className="page-section pos-page pos-page-v16">
      {message && <div className={message.toLowerCase().includes('saved') ? 'notice success' : message.toLowerCase().includes('available stock') || message.toLowerCase().includes('maximum available') || message.toLowerCase().includes('quantity limited') ? 'notice stock-limit-notice' : 'error-box'}>{message}</div>}

      <div className="pos-command-bar">
        <div className="pos-command-group sale-command-group">
          <span className="pos-command-label">Sale</span>
          <div className="pos-command-buttons">
            <button className="pos-action" onClick={() => document.querySelector('.pos-search-input')?.focus()}>⌕<span>Search</span></button>
            <button className="pos-action" disabled={!can('manage_parties')} title={!can('manage_parties') ? 'Permission required to add customers' : ''} onClick={() => setShowCustomerPanel(!showCustomerPanel)}>♙<span>Customer</span></button>
            <button className="pos-action" disabled={!can('apply_discounts')} title={!can('apply_discounts') ? 'Permission required' : ''} onClick={() => updateActiveBill({ cartDiscountType: activeBill.cartDiscountType === 'amount' ? 'percent' : 'amount' })}>%<span>Discount</span></button>
            <button className="pos-action" onClick={addBill}>＋<span>New Sale</span></button>
            <button className="pos-action" disabled={!can('process_returns')} title={!can('process_returns') ? 'Permission required' : ''} onClick={() => { setShowReturnLookup(true); setReturnInvoice(null); setReturnItems([]); setReturnInvoiceMatches([]); setReturnSearch(''); setReturnPartyFilter(activeBill.customerId ? 'eligible' : 'walkin'); }}>↩<span>Return</span></button>
            <button className="pos-action" disabled={!can('create_quotes')} title={!can('create_quotes') ? 'Permission required' : ''} onClick={saveCurrentBillAsQuotation}>Q<span>Quote</span></button>
            <button className="pos-action" onClick={() => saveInvoice()} disabled={saving}>✓<span>{saving ? 'Saving...' : 'Save Sale'}</span></button>
          </div>
        </div>
        <div className="pos-command-group payment-command-group">
          <span className="pos-command-label">Payment</span>
          <div className="pos-command-buttons">
            <button className="pos-action green payment-main-action" onClick={() => openPaymentPanel()}>F10<span>Payment</span></button>
            {quickMethods.map((method) => (
              <button key={method.id} className={method.is_paid_method === false ? 'pos-action credit' : 'pos-action pay-quick'} onClick={() => quickPayAndSave(method.name)}>
                {method.name === 'Cash' ? 'F12' : '✓'}<span>{method.name}</span>
              </button>
            ))}
          </div>
        </div>
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
        <button className="danger-button void-bill-button" disabled={!can('void_sales')} title={!can('void_sales') ? 'Permission required' : ''} onClick={voidCurrentBill}>Void Bill</button>
      </div>

      <div className="pos-customer-strip pos-customer-strip-v16">
        <label>Invoice No.<input value={activeBill.documentNo || ''} placeholder="Assigned on save" onFocus={selectAllText} onChange={(e) => updateActiveBill({ documentNo: e.target.value })} /></label>
        <label>Customer
          <select value={activeBill.customerId || ''} onChange={(e) => setCustomer(e.target.value)}>
            <option value="">Walk-in customer</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>{customer.name}{customer.phone ? ` - ${customer.phone}` : ''}</option>
            ))}
          </select>
        </label>
        <div className={`customer-balance-chip balance-chip-v16 ${currentOutstanding < 0 ? 'has-credit' : currentOutstanding > 0 ? 'has-due' : ''}`}><strong>{customerBalanceText}</strong><small>Details and credit use are available in F10 Payment.</small></div>
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

      <div className="pos-mobile-panel-tabs" role="tablist" aria-label="POS workspace">
        <button type="button" role="tab" aria-selected={mobilePosPanel === 'products'} className={mobilePosPanel === 'products' ? 'active' : ''} onClick={() => setMobilePosPanel('products')}><span>Products</span><small>Find and add items</small></button>
        <button type="button" role="tab" aria-selected={mobilePosPanel === 'bill'} className={mobilePosPanel === 'bill' ? 'active' : ''} onClick={() => setMobilePosPanel('bill')}><span>Current Bill</span><small>{activeBill.items.length} item{activeBill.items.length === 1 ? '' : 's'} Â· {money(total)}</small></button>
      </div>

      <div
        ref={posGridRef}
        className="pos-grid pos-grid-v16 resizable-pos-grid"
        style={{ '--pos-left': `${posLeftPercent}%`, '--pos-right': `${100 - posLeftPercent}%` }}
      >
        <div className={`panel-card bill-panel left-bill-panel ${mobilePosPanel === 'bill' ? 'mobile-panel-active' : 'mobile-panel-hidden'}`}>
          <div className="pos-line-toolbar">
            <button className="secondary-button" onClick={() => removeItem()}>Delete</button>
          </div>

          <div className="pos-bill-area pos-bill-cards compact-bill-cards">
            {activeBill.items.map((item, index) => (
              <div key={item.id} className={item.assemblyGroupId ? 'pos-assembly-line-wrap' : ''}>
                {item.assemblyGroupId && activeBill.items[index - 1]?.assemblyGroupId !== item.assemblyGroupId && <div className="pos-assembly-group-header"><span>{'\uD83D\uDDA5\uFE0F'}</span><div><strong>{item.assemblyCode} · {item.assemblyName}</strong><small>Assembly components</small></div></div>}
                <div
                className={`pos-bill-card compact ${item.isReturn ? 'return-row' : ''} ${activeBill.selectedItemId === item.id ? 'selected' : ''}`}
                onClick={() => updateActiveBill({ selectedItemId: item.id })}
              >
                <div className="bill-card-main">
                  <strong>{item.item_code}</strong>
                  <span>{item.name}</span>
                  <b>{money(item.lineTotal)}</b>
                </div>
                <div className="bill-card-controls compact-controls">
                  <label>Qty<input type="number" max={!allowNegativeStock && !item.isReturn && item.trackInventory !== false && Number.isFinite(Number(item.availableQty)) ? item.availableQty : undefined} value={item.qty} onFocus={selectAllText} onChange={(e) => updateItem(item.id, { qty: Number(e.target.value) })} /></label>
                  <label>Price<input type="number" disabled={!can('change_sale_price')} title={!can('change_sale_price') ? 'Price override permission required' : ''} value={item.unitPrice} onFocus={selectAllText} onChange={(e) => updateItem(item.id, { unitPrice: Number(e.target.value) })} /></label>
                  <label>Disc.<input type="number" disabled={!can('apply_discounts')} value={item.discountValue} onFocus={selectAllText} onChange={(e) => updateItem(item.id, { discountValue: Number(e.target.value) })} /></label>
                  <label>Type
                    <select disabled={!can('apply_discounts')} value={item.discountType} onChange={(e) => updateItem(item.id, { discountType: e.target.value })}>
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
              </div>
            ))}
            {activeBill.items.length === 0 && <div className="empty-pos-bill">No items</div>}
          </div>

          <div className="checkout-box aronium-total-box">
            <div className="discount-row">
              <select disabled={!can('apply_discounts')} value={activeBill.cartDiscountType} onChange={(e) => updateActiveBill({ cartDiscountType: e.target.value })}>
                <option value="amount">Bill discount amount</option>
                <option value="percent">Bill discount %</option>
              </select>
              <input type="number" disabled={!can('apply_discounts')} value={activeBill.cartDiscountValue} onFocus={selectAllText} onChange={(e) => updateActiveBill({ cartDiscountValue: Number(e.target.value) })} />
            </div>
            <SummaryLine label="Subtotal" value={money(subtotal)} />
            <SummaryLine label="Discount" value={money(cartDiscount)} />
            <SummaryLine label="Document total" value={money(total)} strong />
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

        <div className={`panel-card product-search-panel right-product-panel pos-category-panel ${mobilePosPanel === 'products' ? 'mobile-panel-active' : 'mobile-panel-hidden'}`}>
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

          {!search.trim() && (posCategoryId === 'root' || categoryChildren.length > 0) && (
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
              {posCategoryId === 'root' && <button className="pos-category-tile assembly-category-tile" onClick={() => { setSearch(''); setPosCategoryId('assemblies'); }}><strong>PC Assemblies</strong><small>Complete builds · {assemblies.length} templates</small></button>}
            </div>
          )}

          {visiblePosAssemblies.length > 0 && <div className="pos-assembly-tiles">{visiblePosAssemblies.map((assembly) => <button key={assembly.id} className={`pos-assembly-tile ${numberValue(assembly.buildable_qty) <= 0 ? 'no-stock-tile' : ''}`} onClick={() => setAssemblyPreview(assembly)}><span>{'\uD83D\uDDA5\uFE0F'}</span><strong>{assembly.assembly_code}</strong><b>{assembly.name}</b><small>{money(assembly.selling_price)} · Buildable {numberValue(assembly.buildable_qty)}</small>{numberValue(assembly.buildable_qty) <= 0 && <em>Missing stock</em>}</button>)}</div>}

          <div className="search-results tile-results pos-product-tiles">
            {products.map((product) => {
              const availableQty = Number(product.available_qty || 0);
              const trackInventory = product.track_inventory !== false;
              const unavailable = !allowNegativeStock && trackInventory && availableQty <= 0;
              return (
                <button
                  key={product.product_id}
                  className={`product-result product-tile ${unavailable ? 'no-stock-tile' : ''} ${!trackInventory ? 'non-stock-tile' : ''}`}
                  disabled={unavailable}
                  onClick={() => openPosProductPicker(product)}
                  title={`${product.name} · ${money(product.selling_price)} · ${trackInventory ? (availableQty > 0 ? `Available ${availableQty}` : 'No stock') : 'Non-stock item'}`}
                >
                  <span className="pos-product-name">{product.name}</span>
                  <strong className="pos-product-price">{money(product.selling_price)}</strong>
                  {appSettings.show_pos_stock_badges !== false && <small className={`pos-product-stock ${!trackInventory ? 'non-stock' : availableQty <= 0 ? 'empty' : availableQty <= 2 ? 'low' : ''}`}>
                    {!trackInventory ? 'Non-stock · Always available' : availableQty > 0 ? `Available: ${availableQty}` : availableQty < 0 ? `Stock: ${availableQty}` : 'No stock'}
                  </small>}
                </button>
              );
            })}
            {products.length === 0 && visiblePosAssemblies.length === 0 && search.trim() && <div className="muted-box">No matching products or assemblies.</div>}
            {products.length === 0 && posCategoryId !== 'assemblies' && !search.trim() && categoryChildren.length === 0 && <div className="muted-box">No products inside this category.</div>}
            {posCategoryId === 'assemblies' && !visiblePosAssemblies.length && <div className="muted-box">No active PC assemblies. Create one from Products → PC Assemblies.</div>}
          </div>
        </div>
      </div>

      {savedInvoiceReceipt && <div className="payment-screen-backdrop">
        <div className="pos-save-success-card">
          <div className="pos-save-success-icon">✓</div>
          <div className="pos-save-success-copy">
            <span>Invoice saved successfully</span>
            <h3>{savedInvoiceReceipt.document.document_no}</h3>
            <p>{money(savedInvoiceReceipt.document.total_amount)} has been saved to Documents. Choose what you want to do next.</p>
          </div>
          <div className="pos-save-success-actions">
            <button className="primary-button" onClick={() => printAccountingDocument(savedInvoiceReceipt.document, savedInvoiceReceipt.items, savedInvoiceReceipt.flows, companySettings)}>Print A5 Invoice</button>
            <button className="secondary-button" onClick={async () => {
              try {
                await downloadAccountingDocumentPdf(savedInvoiceReceipt.document, savedInvoiceReceipt.items, savedInvoiceReceipt.flows, companySettings);
                setMessage(`PDF downloaded: ${savedInvoiceReceipt.document.document_no}.pdf`);
              } catch (pdfError) {
                setMessage(pdfError.message || String(pdfError));
              }
            }}>Save PDF</button>
            <button className="secondary-button" onClick={() => setSavedInvoiceReceipt(null)}>Continue to New Sale</button>
          </div>
        </div>
      </div>}

      {showReturnLookup && <div className="modal-backdrop return-lookup-backdrop"><div className="modal-card return-lookup-modal">
        <div className="section-title-row"><div><h3>Return or Exchange from Invoice</h3><p>Choose an invoice for {selectedCustomer?.name || 'Walk-in Customer'}, then return at the original sold price.</p></div><button className="secondary-button" onClick={() => setShowReturnLookup(false)}>Close</button></div>
        {selectedCustomer ? <div className="return-party-filter" aria-label="Invoice customer filter">
          <button type="button" className={returnPartyFilter === 'eligible' ? 'active' : ''} onClick={() => { setReturnPartyFilter('eligible'); setReturnInvoice(null); setReturnItems([]); }}>{selectedCustomer.name} + Walk-in</button>
          <button type="button" className={returnPartyFilter === 'customer' ? 'active' : ''} onClick={() => { setReturnPartyFilter('customer'); setReturnInvoice(null); setReturnItems([]); }}>{selectedCustomer.name} only</button>
          <button type="button" className={returnPartyFilter === 'walkin' ? 'active' : ''} onClick={() => { setReturnPartyFilter('walkin'); setReturnInvoice(null); setReturnItems([]); }}>Walk-in only</button>
        </div> : <div className="return-eligibility-note">Walk-in Customer is selected, so only Walk-in invoices are shown. Select a named customer in POS to also see that customer's invoices.</div>}
        <form className="return-invoice-search" onSubmit={findReturnInvoice}><label>Original invoice number<input value={returnSearch} onChange={(event) => { setReturnSearch(event.target.value); setReturnInvoice(null); setReturnItems([]); }} placeholder="Type any part, such as 15, 150 or 1509" autoFocus /></label><button className="primary-button" disabled={returnBusy}>{returnBusy ? 'Searching...' : 'Search Invoices'}</button></form>
        <div className="return-invoice-results" aria-live="polite">
          {returnInvoiceMatches.map((invoice) => <button type="button" key={invoice.id} className={returnInvoice?.id === invoice.id ? 'selected' : ''} onClick={() => chooseReturnInvoice(invoice)} disabled={returnBusy && returnInvoice?.id !== invoice.id}>
            <strong>{invoice.document_no}</strong><span>{invoice.customers?.name || 'Walk-in Customer'}</span><small>{fmtDate(invoice.document_date)} · {money(invoice.total_amount)}</small>
          </button>)}
          {!returnBusy && !returnInvoiceMatches.length && <div className="return-no-results">No eligible invoices found.</div>}
        </div>
        {returnInvoice && <><div className="return-source-summary"><div><strong>{returnInvoice.document_no}</strong><small>{returnInvoice.customers?.name || 'Walk-in Customer'}</small></div><span>{fmtDate(returnInvoice.document_date)} · {money(returnInvoice.total_amount)}</span></div><div className="table-wrap return-item-table"><table><thead><tr><th>Return</th><th>Code</th><th>Item</th><th>Paid value</th><th>Available</th><th>Qty</th><th>Damaged</th><th>Reason</th></tr></thead><tbody>{returnItems.map((row) => <tr key={row.id} className={row.remainingQty <= 0 ? 'disabled-row' : ''}><td><input type="checkbox" disabled={row.remainingQty <= 0} checked={row.selected} onChange={(event) => setReturnItems((current) => current.map((item) => item.id === row.id ? { ...item, selected: event.target.checked } : item))} /></td><td>{row.item_code}</td><td>{row.description}{row.trackInventory === false && <small className="non-stock-inline">Non-stock item</small>}</td><td>{money(Math.abs(numberValue(row.line_total)) / Math.max(Math.abs(numberValue(row.qty)), 1))}</td><td>{row.remainingQty}</td><td><input type="number" min="0.001" max={row.remainingQty} step="0.001" disabled={!row.selected} value={row.returnQty} onChange={(event) => setReturnItems((current) => current.map((item) => item.id === row.id ? { ...item, returnQty: Math.min(numberValue(event.target.value), item.remainingQty) } : item))} /></td><td>{row.trackInventory === false ? <span className="muted-text">Not applicable</span> : <label className="return-damaged-check"><input type="checkbox" disabled={!row.selected} checked={row.damaged} onChange={(event) => setReturnItems((current) => current.map((item) => item.id === row.id ? { ...item, damaged: event.target.checked } : item))} /> Damaged</label>}</td><td><input disabled={!row.selected} value={row.reason} onChange={(event) => setReturnItems((current) => current.map((item) => item.id === row.id ? { ...item, reason: event.target.value } : item))} placeholder="Optional" /></td></tr>)}{!returnItems.length && <EmptyRow colSpan={8} text="No sold items found." />}</tbody></table></div><div className="return-stock-help"><span><b>Damaged off:</b> add tracked items to sellable stock.</span><span><b>Non-stock items:</b> accounting only; inventory is unchanged.</span></div><div className="modal-actions"><button className="secondary-button" disabled={returnBusy} onClick={() => addInvoiceReturns(false)}>Add Return to POS</button><button className="primary-button" disabled={returnBusy} onClick={() => addInvoiceReturns(true)}>Exchange Same Item</button></div></>}
      </div></div>}

      {selectedPosProduct && <div className="modal-backdrop">
        <form className="modal-card item-entry-modal" onSubmit={confirmPosProduct}>
          <div className="item-entry-heading"><div><span>Add to current bill</span><h3>{selectedPosProduct.name}</h3><p>{selectedPosProduct.item_code || 'Product'} · {selectedPosProduct.track_inventory === false ? 'Non-stock item' : `Available ${numberValue(selectedPosProduct.available_qty)}`}</p></div><button type="button" className="secondary-button" onClick={() => setSelectedPosProduct(null)}>Close</button></div>
          <div className="item-entry-fields">
            <label>Selling price<input type="number" min="0" step="0.01" disabled={!can('change_sale_price')} title={!can('change_sale_price') ? 'Price override permission required' : ''} value={posProductDraft.unitPrice} onFocus={selectAllText} onChange={(e) => setPosProductDraft({ ...posProductDraft, unitPrice: e.target.value })} autoFocus={can('change_sale_price')} /></label>
            <label>Quantity<input type="number" min="0.001" max={selectedPosProduct.track_inventory === false || allowNegativeStock ? undefined : Math.max(numberValue(selectedPosProduct.available_qty) - activeBill.items.filter((item) => item.product_id === selectedPosProduct.product_id && !item.isReturn && numberValue(item.qty) > 0).reduce((sum, item) => sum + numberValue(item.qty), 0), 0)} step="0.001" value={posProductDraft.qty} onFocus={selectAllText} onChange={(e) => setPosProductDraft({ ...posProductDraft, qty: e.target.value })} autoFocus={!can('change_sale_price')} /></label>
          </div>
          <div className="item-entry-total"><span>Line total</span><strong>{money(numberValue(posProductDraft.qty) * numberValue(posProductDraft.unitPrice))}</strong></div>
          <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setSelectedPosProduct(null)}>Cancel</button><button type="submit" className="primary-button">Add Item</button></div>
        </form>
      </div>}

      {assemblyPreview && <div className="payment-screen-backdrop">
        <div className="payment-screen-card assembly-preview-modal">
          <div className="section-title-row assembly-form-title"><div><h3>{assemblyPreview.assembly_code} · {assemblyPreview.name}</h3><p>Review every component before adding the complete build.</p></div><button className="secondary-button" onClick={() => setAssemblyPreview(null)}>Close</button></div>
          <div className="assembly-preview-summary"><StatCard label="Listed component total" value={money(assemblyPreview.component_price)} /><StatCard label="Assembly discount" value={money(assemblyPreview.discount_amount)} /><StatCard label="Final package price" value={money(assemblyPreview.selling_price)} /><StatCard label="Buildable now" value={numberValue(assemblyPreview.buildable_qty)} /></div>
          <div className="table-wrap"><table><thead><tr><th>Code</th><th>Component</th><th>Required</th><th>Available</th><th>Unit price</th></tr></thead><tbody>{(assemblyPreview.components || []).map((component) => <tr key={component.product_id} className={numberValue(component.available_qty) < numberValue(component.qty) ? 'low-stock-row' : ''}><td>{component.item_code}</td><td>{component.name}</td><td>{numberValue(component.qty)}</td><td>{numberValue(component.available_qty)}</td><td>{money(component.selling_price)}</td></tr>)}</tbody></table></div>
          <div className="modal-actions"><button className="secondary-button" onClick={() => setAssemblyPreview(null)}>Cancel</button><button className="primary-button" disabled={!allowNegativeStock && numberValue(assemblyPreview.buildable_qty) <= 0} onClick={() => addAssemblyToCart(assemblyPreview)}>Add Complete Build</button></div>
        </div>
      </div>}

      {showPaymentPanel && (
        <div className="payment-screen-backdrop pos-payment-page">
          <div className="payment-screen-card pos-payment-workspace">
            <div className="payment-screen-left">
              <div className="payment-bill-heading"><span>Current sale</span><h3>{activeBill.documentNo || activeBill.name}</h3><small>{selectedCustomer?.name || 'Walk-in Customer'}</small></div>
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
                {selectedCustomer && <SummaryLine label={currentOutstanding < 0 ? 'Available customer credit' : 'Previous outstanding'} value={`${currentOutstanding < 0 ? '-' : ''}${money(Math.abs(currentOutstanding))}`} />}
                {selectedCustomer && currentOutstanding < 0 && total > 0 && (
                  <label className="pos-credit-choice payment-credit-choice">
                    <input type="checkbox" checked={useExistingCustomerCredit} onChange={(event) => { updateActiveBill({ useExistingCustomerCredit: event.target.checked, paymentLines: [] }); setPaymentDraft([]); }} />
                    Use customer credit for this bill only
                  </label>
                )}
                {selectedCustomer && currentOutstanding > 0 && total < 0 && (
                  <label className="pos-credit-choice payment-credit-choice">
                    <input type="checkbox" checked={useExistingCustomerCredit} onChange={(event) => { updateActiveBill({ useExistingCustomerCredit: event.target.checked, paymentLines: [] }); setPaymentDraft([]); }} />
                    Use this return to reduce previous outstanding
                  </label>
                )}
                {selectedCustomer && balanceUsedForCurrentBill > 0 && (
                  <SummaryLine
                    label={total >= 0 ? 'Customer credit applied' : 'Previous due reduced'}
                    value={money(balanceUsedForCurrentBill)}
                  />
                )}
                <SummaryLine label={currentTarget.direction === 'out' ? 'Current bill refund' : 'Current bill to collect'} value={money(amountToSettleCurrentBill)} strong />
              </div>
            </div>

            <div className="payment-screen-main">
              <div className="payment-screen-header">
                <div><span>POS</span><h3>Payment</h3><small>Split payments and customer-credit use are handled here.</small></div>
                <button className="secondary-button payment-back-button" onClick={backToSaleFromPayment}>← Back to Sale</button>
              </div>

              <div className="payment-method-large-grid">
                {visiblePaymentMethods.map((method) => (
                  <button key={method.id} className={method.is_paid_method === false ? 'payment-method-tile credit' : 'payment-method-tile'} onClick={() => addPaymentLine(method)}>
                    {method.name}
                    <small>{method.is_paid_method === false ? 'Add unpaid balance' : 'Receive / refund'}</small>
                  </button>
                ))}
              </div>
              {!selectedCustomer && <div className="payment-party-hint">Walk-in sales must be paid in full. Select a customer to use Credit, carry a balance, or process a refund.</div>}
              {selectedCustomer && <div className="payment-party-hint">Payments entered here apply only to this document. Use Customers &amp; Suppliers for a separate payment against old debt.</div>}

              <div className="payment-screen-summary">
                {selectedCustomer && balanceUsedForCurrentBill > 0 && (
                  <SummaryLine
                    label={total >= 0 ? 'Outstanding balance used' : 'Outstanding due used'}
                    value={money(balanceUsedForCurrentBill)}
                  />
                )}
                <SummaryLine label={currentTarget.direction === 'out' ? 'Total refund target' : 'Total collection target'} value={money(currentTarget.amount)} strong />
                <SummaryLine label="Payment lines total" value={money(paymentLineTotal())} />
                <SummaryLine label="Remaining to settle" value={money(remainingCurrent)} />
                <SummaryLine label="Outstanding after save" value={`${modalProjectedOutstanding < 0 ? '-' : ''}${money(Math.abs(modalProjectedOutstanding))}`} />
              </div>

              <div className="payment-custom-row">
                <label>Custom amount for next line
                  <input type="number" min="0" max={remainingCurrent} step="0.01" value={lineAmountInput} onFocus={selectAllText} onChange={(e) => setLineAmountInput(e.target.value)} placeholder={String(remainingCurrent || currentTarget.amount)} />
                </label>
                <small>Leave empty to add the remaining current-bill amount. Split payments cannot exceed this bill.</small>
              </div>

              <div className="table-wrap compact-table payment-lines-table">
                <table>
                  <thead><tr><th>Method</th><th>Direction</th><th>Amount</th><th></th></tr></thead>
                  <tbody>
                    {paymentDraft.map((line) => (
                      <tr key={line.id}>
                        <td>{line.paymentMethodName}{line.isPaidMethod === false ? ' / Credit' : ''}</td>
                        <td>{line.direction === 'out' ? 'Refund / out' : 'Receive / in'}</td>
                        <td><input type="number" min="0" max={currentTarget.amount} step="0.01" value={line.amount} onFocus={selectAllText} onChange={(e) => setPaymentDraft((rows) => rows.map((row) => row.id === line.id ? { ...row, amount: Math.min(Math.max(Number(e.target.value), 0), currentTarget.amount) } : row))} /></td>
                        <td><button className="link-button" onClick={() => setPaymentDraft((rows) => rows.filter((row) => row.id !== line.id))}>Remove</button></td>
                      </tr>
                    ))}
                    {paymentDraft.length === 0 && <tr><td colSpan="4" className="empty-cell">Select a payment type to add a line.</td></tr>}
                  </tbody>
                </table>
              </div>

              <div className="payment-popup-footer payment-screen-footer">
                <button className="secondary-button" onClick={() => setPaymentDraft([])}>Clear payment lines</button>
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

  useEffect(() => { loadStats(); }, []);
  useRealtimeRefresh(['products', 'customers', 'suppliers', 'documents', 'cashflow_entries'], loadStats);

  async function loadStats() {
    setError('');
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [productsRes, customersRes, suppliersRes, docsRes, cashRes] = await Promise.all([
      supabase.from('products').select('id', { count: 'exact', head: true }),
      supabase.from('customers').select('id', { count: 'exact', head: true }),
      supabase.from('suppliers').select('id', { count: 'exact', head: true }),
      supabase.from('documents').select('id', { count: 'exact', head: true }).neq('document_type', 'cod_order'),
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

function DocumentsPage({ permissions = {}, isAdmin = false, onOpenPOS, onOpenParties, onOpenCashflow, onOpenJobs } = {}) {
  const can = (permission) => isAdmin || permissions?.[permission] === true;
  const canManageDocumentType = (type) => {
    if (['purchase', 'stock_in_transit', 'stock_adjustment', 'trade_in'].includes(type)) return can('manage_inventory_documents');
    if (type === 'quotation') return can('create_quotes');
    if (type === 'job') return can('manage_jobs');
    if (type === 'cod_order') return can('manage_cod_orders');
    if (['customer_payment', 'supplier_payment'].includes(type)) return can('manage_parties');
    if (['expense', 'other_income'].includes(type)) return can('manage_cashflow');
    return false;
  };
  const [documents, setDocuments] = useState([]);
  const [selected, setSelected] = useState(null);
  const [items, setItems] = useState([]);
  const [companySettings, setCompanySettings] = useState(DEFAULT_COMPANY_SETTINGS);
  const [filters, setFilters] = useState({ product: '', customer: '', number: '', user: '', type: '', paid: '', periodFrom: '', periodTo: '' });
  const [parties, setParties] = useState([]);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [documentTabs, setDocumentTabs] = useState(() => {
    const savedTabs = safeReadJson(DOCUMENT_DRAFT_TABS_KEY, []);
    const draftTabs = Array.isArray(savedTabs) ? savedTabs.filter((tab) => tab.id && (tab.kind === 'new_purchase_like' || tab.kind === 'trade_in_intake' || tab.kind === 'stock_adjustment' || tab.kind === 'job_intake' || tab.kind === 'cod_order' || tab.kind === 'edit_document') && canManageDocumentType(tab.documentType || tab.document?.document_type)) : [];
    return [{ id: 'view', kind: 'view', label: 'View documents' }, ...draftTabs];
  });
  const [activeDocumentTabId, setActiveDocumentTabId] = useState('view');
  const [busyAction, setBusyAction] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    loadDocuments();
    loadDocumentFilterParties();
    fetchCompanySettings().then(setCompanySettings).catch(() => {});
  }, []);

  useRealtimeRefresh(['documents', 'document_items', 'payment_methods', 'cashflow_entries'], () => {
    loadDocuments(true);
    if (selected?.id) selectDocument(selected);
  });
  useRealtimeRefresh(['customers', 'suppliers'], () => {
    loadDocumentFilterParties();
    loadDocuments(true);
  });
  useRealtimeRefresh(['company_settings'], () => fetchCompanySettings().then(setCompanySettings).catch(() => {}));

  useEffect(() => {
    const timeout = setTimeout(() => loadDocuments(), 300);
    return () => clearTimeout(timeout);
  }, [filters]);

  useEffect(() => {
    const draftTabs = documentTabs
      .filter((tab) => tab.kind === 'new_purchase_like' || tab.kind === 'trade_in_intake' || tab.kind === 'stock_adjustment' || tab.kind === 'job_intake' || tab.kind === 'cod_order' || tab.kind === 'edit_document')
      .map((tab) => ({
        id: tab.id,
        kind: tab.kind,
        documentType: tab.documentType || tab.document?.document_type,
        label: tab.label,
        document: tab.kind === 'edit_document' ? tab.document : undefined
      }));
    window.localStorage.setItem(DOCUMENT_DRAFT_TABS_KEY, JSON.stringify(draftTabs));
  }, [documentTabs]);

  async function loadDocuments(preserveSelection = false) {
    setError('');
    if (!preserveSelection) setMessage('');

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
      .select('id, document_no, job_no, job_status, external_document_no, document_type, status, total_amount, paid_amount, balance_amount, currency, document_date, created_at, shipping_method, expected_arrival_date, linked_document_id, supplier_id, customer_id, payment_method_id, notes, order_source, order_taken_by, created_by_staff_id, updated_by_staff_id, recipient_name, delivery_phone, delivery_address, delivery_service, tracking_number, delivery_charge, delivery_charge_paid, delivery_fee_mode, cod_collect_amount, cod_received_amount, cod_stock_reserved, dispatched_at, delivered_at, settled_at, returned_at, return_reason')
      .neq('document_type', 'cod_order')
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
    const staffIds = [...new Set(filtered.flatMap((doc) => [doc.created_by_staff_id, doc.updated_by_staff_id]).filter(Boolean))];

    const [customerLookupRes, supplierLookupRes, paymentLookupRes, staffLookupRes] = await Promise.all([
      customerIds.length ? supabase.from('customers').select('id, name').in('id', customerIds) : Promise.resolve({ data: [] }),
      supplierIds.length ? supabase.from('suppliers').select('id, name').in('id', supplierIds) : Promise.resolve({ data: [] }),
      paymentIds.length ? supabase.from('payment_methods').select('id, name').in('id', paymentIds) : Promise.resolve({ data: [] }),
      staffIds.length ? supabase.from('staff_directory_v38').select('id, full_name').in('id', staffIds) : Promise.resolve({ data: [] })
    ]);

    const customerMap = new Map((customerLookupRes.data || []).map((row) => [row.id, row.name]));
    const supplierMap = new Map((supplierLookupRes.data || []).map((row) => [row.id, row.name]));
    const paymentMap = new Map((paymentLookupRes.data || []).map((row) => [row.id, row.name]));
    const staffMap = new Map((staffLookupRes.data || []).map((row) => [row.id, row.full_name]));

    filtered = filtered.map((doc) => ({
      ...doc,
      party_name: customerMap.get(doc.customer_id) || supplierMap.get(doc.supplier_id) || doc.recipient_name || '',
      payment_method_name: paymentMap.get(doc.payment_method_id) || '',
      user_name: staffMap.get(doc.created_by_staff_id) || '',
      updated_by_name: staffMap.get(doc.updated_by_staff_id) || ''
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
    if (filters.user.trim()) {
      const userKey = filters.user.trim().toLowerCase();
      filtered = filtered.filter((doc) => `${doc.user_name || ''} ${doc.updated_by_name || ''}`.toLowerCase().includes(userKey));
    }

    setDocuments(filtered);
    if (preserveSelection) {
      setSelected((current) => current ? filtered.find((row) => row.id === current.id) || null : null);
      setItems((current) => selected?.id && filtered.some((row) => row.id === selected.id) ? current : []);
    } else {
      setSelected(null);
      setItems([]);
    }
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

  async function printSelectedDocument(autoPrint = true) {
    if (!selected) {
      setError('Select a document first.');
      return;
    }
    const popup = window.open('', '_blank', 'width=920,height=980');
    if (!popup) {
      window.alert('Allow pop-ups for this site to print or save documents as PDF.');
      return;
    }
    popup.document.write('<!doctype html><title>Preparing document</title><body style="font-family:Arial;padding:30px">Preparing document preview...</body>');
    setError('');
    try {
      const [itemRes, flowRes, partyRes] = await Promise.all([
        supabase.from('document_items').select('*').eq('document_id', selected.id).order('created_at'),
        supabase.from('cashflow_entries').select('id, entry_type, account_name, amount, description, created_at, payment_method_id, payment_methods(name)').eq('document_id', selected.id).order('created_at'),
        selected.customer_id
          ? supabase.from('customers').select('id, name, phone, address, due_balance, store_credit_balance').eq('id', selected.customer_id).maybeSingle()
          : selected.supplier_id
            ? supabase.from('suppliers').select('id, name, phone, address').eq('id', selected.supplier_id).maybeSingle()
            : Promise.resolve({ data: null, error: null })
      ]);
      if (itemRes.error) throw itemRes.error;
      if (flowRes.error) throw flowRes.error;
      if (partyRes.error) throw partyRes.error;
      popup.document.open();
      await printAccountingDocument({
        ...selected,
        party: partyRes.data || (selected.party_name ? { name: selected.party_name } : null)
      }, itemRes.data || [], flowRes.data || [], companySettings, { popup, autoPrint });
    } catch (printError) {
      popup.close();
      setError(printError.message || String(printError));
    }
  }

  async function saveSelectedDocumentPdf() {
    if (!selected) {
      setError('Select a document first.');
      return;
    }
    setError('');
    try {
      const [itemRes, flowRes, partyRes] = await Promise.all([
        supabase.from('document_items').select('*').eq('document_id', selected.id).order('created_at'),
        supabase.from('cashflow_entries').select('id, entry_type, account_name, amount, description, created_at, payment_method_id, payment_methods(name)').eq('document_id', selected.id).order('created_at'),
        selected.customer_id
          ? supabase.from('customers').select('id, name, phone, address, due_balance, store_credit_balance').eq('id', selected.customer_id).maybeSingle()
          : selected.supplier_id
            ? supabase.from('suppliers').select('id, name, phone, address').eq('id', selected.supplier_id).maybeSingle()
            : Promise.resolve({ data: null, error: null })
      ]);
      if (itemRes.error) throw itemRes.error;
      if (flowRes.error) throw flowRes.error;
      if (partyRes.error) throw partyRes.error;
      await downloadAccountingDocumentPdf({ ...selected, party: partyRes.data || (selected.party_name ? { name: selected.party_name } : null) }, itemRes.data || [], flowRes.data || [], companySettings);
      setMessage(`PDF downloaded: ${selected.document_no}.pdf`);
    } catch (pdfError) {
      setError(pdfError.message || String(pdfError));
    }
  }

  function openAddDocument(type) {
    setShowAddMenu(false);
    if (!canManageDocumentType(type)) {
      setError('The active user does not have permission to create this document type.');
      return;
    }
    if (type === 'customer_payment' || type === 'supplier_payment') {
      onOpenParties?.();
      return;
    }
    if (type === 'expense' || type === 'other_income') {
      onOpenCashflow?.();
      return;
    }
    if (type === 'purchase' || type === 'stock_in_transit') {
      const tab = {
        id: createClientId(),
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
        id: createClientId(),
        kind: 'trade_in_intake',
        documentType: type,
        label: 'New Trade-In'
      };
      setDocumentTabs((current) => [...current, tab]);
      setActiveDocumentTabId(tab.id);
      return;
    }
    if (type === 'stock_adjustment') {
      const tab = {
        id: createClientId(),
        kind: 'stock_adjustment',
        documentType: type,
        label: 'New Stock Adjustment'
      };
      setDocumentTabs((current) => [...current, tab]);
      setActiveDocumentTabId(tab.id);
      return;
    }
    if (type === 'job') {
      onOpenJobs?.();
      return;
    }
    if (type === 'quotation') {
      const tab = {
        id: createClientId(),
        kind: 'quotation_document',
        documentType: type,
        label: 'New Quotation'
      };
      setDocumentTabs((current) => [...current, tab]);
      setActiveDocumentTabId(tab.id);
      return;
    }
    if (type === 'cod_order') {
      const tab = {
        id: createClientId(),
        kind: 'cod_order',
        documentType: type,
        label: 'New COD Order'
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
    if (!['purchase', 'stock_in_transit', 'quotation', 'cod_order'].includes(selected.document_type)) {
      setError('Full tab editing is available for Purchase, Stock in Transit, Quotation, and COD Order documents.');
      return;
    }
    if (!canManageDocumentType(selected.document_type)) {
      setError('The active user does not have permission to edit this document.');
      return;
    }
    const existing = documentTabs.find((tab) => tab.kind === 'edit_document' && tab.document?.id === selected.id);
    if (existing) {
      setActiveDocumentTabId(existing.id);
      return;
    }
    const tab = {
      id: createClientId(),
      kind: 'edit_document',
      document: selected,
      label: selected.document_no || 'Edit document'
    };
    setDocumentTabs((current) => [...current, tab]);
    setActiveDocumentTabId(tab.id);
  }

  async function convertTransitToPurchase() {
    if (!can('manage_inventory_documents')) { setError('Inventory-document permission required.'); return; }
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
    if (!can('pos_sales')) { setError('POS sales permission required.'); return; }
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
    if (!can('manage_inventory_documents')) { setError('Inventory-document permission required.'); return; }
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
    if (!can('delete_documents')) { setError('Document deletion permission required.'); return; }
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
          <button className="toolbar-button bright" disabled={!DOCUMENT_TYPES.some((type) => type.value && canManageDocumentType(type.value))} onClick={() => setShowAddMenu(!showAddMenu)}><span>＋</span>Add</button>
          {showAddMenu && (
            <div className="add-menu">
              {DOCUMENT_TYPES.filter((type) => type.value && type.value !== 'cod_order' && canManageDocumentType(type.value)).map((type) => (
                <button key={type.value} onClick={() => openAddDocument(type.value)}>{type.label}</button>
              ))}
            </div>
          )}
        </div>
        <button className="toolbar-button" disabled={!selected} onClick={() => printSelectedDocument(true)}><span>▣</span>Print</button>
        <button className="toolbar-button" disabled={!selected} onClick={() => printSelectedDocument(false)}><span>◫</span>Print preview</button>
        <button className="toolbar-button" disabled={!selected} onClick={saveSelectedDocumentPdf}><span>⌁</span>Save as PDF</button>
        <button className="toolbar-button" disabled={!selected || !canManageDocumentType(selected?.document_type)} onClick={openEditDocument}><span>✎</span>Edit</button>
        <button className="toolbar-button" disabled={!selected || busyAction || !can('delete_documents')} onClick={deleteSelectedDocument}><span>▥</span>Delete</button>
        <button className="toolbar-button" disabled={!canApplyStock || busyAction || !can('manage_inventory_documents')} onClick={applySelectedDocumentStock}><span>✓</span>Apply Stock</button>
        <button className="toolbar-button bright" disabled={!canConvertTransit || busyAction || !can('manage_inventory_documents')} onClick={convertTransitToPurchase}><span>⇢</span>Convert to Purchase</button>
        <button className="toolbar-button bright" disabled={!canConvertQuote || busyAction || !can('pos_sales')} onClick={convertQuotationToInvoice}><span>⇢</span>Convert Quote to Sales</button>
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
      <div className="document-quick-filters" aria-label="Frequently used document filters">
        <span>Quick view</span>
        {DOCUMENT_QUICK_FILTERS.map((filter) => (
          <button
            key={filter.value || 'all'}
            type="button"
            className={filters.type === filter.value ? 'active' : ''}
            onClick={() => setFilters((current) => ({ ...current, type: filter.value }))}
          >
            {filter.label}
          </button>
        ))}
      </div>
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
            {DOCUMENT_TYPES.filter((type) => type.value !== 'cod_order').map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
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
                <th>Created by</th>
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
                    <td>{document.user_name || '-'}</td>
                    <td>{fmtDate(document.document_date || document.created_at)}</td>
                    <td>{document.payment_method_name || '-'}</td>
                    <td>{money(document.total_amount)}</td>
                    <td>{document.document_type === 'cod_order' ? codStatusLabel(document.status) : document.status === 'converted' && ['stock_in_transit', 'quotation'].includes(document.document_type) ? 'Converted ✓' : document.status}</td>
                  </tr>
                );
              })}
              {documents.length === 0 && <EmptyRow colSpan={12} text="No documents found." />}
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
        {documentTabs.filter((tab) => tab.kind === 'new_purchase_like' || tab.kind === 'edit_document' || tab.kind === 'trade_in_intake' || tab.kind === 'stock_adjustment' || tab.kind === 'job_intake' || tab.kind === 'quotation_document' || tab.kind === 'cod_order').map((tab) => {
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
              {tab.kind === 'edit_document' && tab.document.document_type === 'cod_order' && (
                <CodOrderForm
                  document={tab.document}
                  tabId={tab.id}
                  onNumberReady={(number) => setDocumentTabs((current) => current.map((item) => (item.id === tab.id ? { ...item, label: number || item.label } : item)))}
                  onClose={() => closeDocumentTab(tab.id)}
                  onSaved={() => { closeDocumentTab(tab.id); loadDocuments(); }}
                />
              )}
              {tab.kind === 'edit_document' && !['quotation', 'cod_order'].includes(tab.document.document_type) && (
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
              {tab.kind === 'stock_adjustment' && (
                <StockAdjustmentForm
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
              {tab.kind === 'cod_order' && (
                <CodOrderForm
                  tabId={tab.id}
                  onNumberReady={(number) => setDocumentTabs((current) => current.map((item) => (item.id === tab.id ? { ...item, label: number || item.label } : item)))}
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
  if (document?.document_type === 'cod_order') {
    if (document.status === 'converted') return 'Paid';
    if (document.status === 'returned' || document.status === 'cancelled') return '-';
    return 'COD pending';
  }
  if (Number(document.balance_amount || 0) <= 0) return 'Paid';
  if (Number(document.paid_amount || 0) > 0) return 'Partial';
  return 'Unpaid';
}

function documentPrefix(type) {
  if (type === 'invoice' || type === 'sale') return '100';
  if (type === 'cod_order') return '120';
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
  if (type === 'other_income') return '950';
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
    id: createClientId(),
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
  const [paymentAmountInput, setPaymentAmountInput] = useState('');

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

  async function loadExistingDocumentItemsAndPayments() {
    if (!document?.id) return;
    const [itemRes, cashRes] = await Promise.all([
      supabase.from('document_items').select('*').eq('document_id', document.id).order('created_at', { ascending: true }),
      supabase.from('cashflow_entries').select('id, entry_type, account_name, payment_method_id, amount').eq('document_id', document.id).order('created_at', { ascending: true })
    ]);

    if (itemRes.error) setError(itemRes.error.message);
    else {
      const loadedLines = (itemRes.data || []).map((item) => ({
        id: item.id || createClientId(),
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
          id: row.id || createClientId(),
          paymentMethodId: row.payment_method_id,
          paymentMethodName: row.account_name || 'Payment',
          amount: numberValue(row.amount),
          isPaidMethod: row.entry_type !== 'non_cash',
          affectsCashflow: row.entry_type !== 'non_cash'
        }));
      if (existingLines.length) setPaymentLines(existingLines);
      else if (Number(document?.paid_amount || 0) > 0 && document?.payment_method_id) {
        setPaymentLines([{ id: createClientId(), paymentMethodId: document.payment_method_id, paymentMethodName: 'Payment', amount: Number(document.paid_amount || 0), isPaidMethod: true, affectsCashflow: true }]);
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
      .eq('track_inventory', true)
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
      id: createClientId(),
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
    if (method.is_paid_method === false && !supplierId && !partyCustomerId) {
      setError('Select a supplier/customer profile before putting this purchase on Credit.');
      setSupplierMenuOpen(true);
      return;
    }
    const fullSettlementTarget = Math.max(total - previousOutstanding, 0);
    const remaining = Math.max(fullSettlementTarget - paidMethodAmount(paymentLines), 0);
    const creditRemaining = Math.max(total - totalPaymentLines(paymentLines), 0);
    const suggestedAmount = method.is_paid_method === false ? creditRemaining : remaining;
    const amount = Number(amountOverride !== null ? amountOverride : paymentAmountInput || suggestedAmount || 0);
    if (amount <= 0) return;
    const line = {
      id: createClientId(),
      paymentMethodId: method.id,
      paymentMethodName: method.name,
      amount,
      isPaidMethod: method.is_paid_method !== false,
      affectsCashflow: method.affects_cashflow !== false
    };
    setPaymentLines((current) => [...current, line]);
    setPaymentAmountInput('');
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

    if (!supplierId && !partyCustomerId) {
      setSupplierMenuOpen(true);
      setError('Select a supplier/customer profile before saving any purchase or stock-in-transit document.');
      setBusy(false);
      return;
    }

    if (!paymentLines.length) {
      setShowPaymentPanel(true);
      setError('Select payment details before saving the document. Use Credit if nothing is paid now.');
      setBusy(false);
      return;
    }

    try {
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
          <label>Document number<input value={documentNo} placeholder="Assigned on save" onFocus={selectAllText} onChange={(e) => setDocumentNo(e.target.value)} /></label>
          <label>Supplier / Profile <span className="required-mark">*</span>
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
            <div className="modal-card item-entry-modal">
              <div className="item-entry-heading"><div><span>Add purchase item</span><h3>{selectedLineProduct.name}</h3><p>{selectedLineProduct.item_code}</p></div><button type="button" className="secondary-button" onClick={() => setSelectedLineProduct(null)}>Close</button></div>
              <div className="item-entry-fields">
                <label>Purchase price<input type="number" min="0" step="0.01" value={lineDraft.unit_cost} onFocus={selectAllText} onChange={(e) => setLineDraft({ ...lineDraft, unit_cost: e.target.value })} autoFocus /></label>
                <label>Quantity<input type="number" min="0.001" step="0.001" value={lineDraft.qty} onFocus={selectAllText} onChange={(e) => setLineDraft({ ...lineDraft, qty: e.target.value })} /></label>
              </div>
              <div className="item-entry-total"><span>Line total</span><strong>{money(numberValue(lineDraft.qty) * numberValue(lineDraft.unit_cost))}</strong></div>
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

              <div className="purchase-payment-entry">
                <label>Amount for next payment
                  <input type="number" min="0.01" step="0.01" value={paymentAmountInput} onFocus={selectAllText} onChange={(e) => setPaymentAmountInput(e.target.value)} placeholder={String(Math.max(total - previousOutstanding - paidOut, 0) || Math.max(total - paymentLineTotalValue, 0))} autoFocus />
                </label>
                <div><strong>{paymentAmountInput ? money(paymentAmountInput) : 'Use suggested amount'}</strong><small>Enter an amount, then click Cash, Bank, Card, Credit, or another method below. Leave it empty to use the remaining balance.</small></div>
              </div>

              <div className="payment-method-large-grid purchase-method-grid">
                {paidMethodChoices.map((method) => (
                  <button type="button" key={method.id} disabled={method.is_paid_method === false && !supplierId && !partyCustomerId} className={method.is_paid_method === false ? 'payment-method-tile credit' : 'payment-method-tile'} onClick={() => addPaymentLine(method)}>
                    {method.name}
                    <small>{method.is_paid_method === false ? 'Keep as unpaid balance' : 'Add this payment amount'}</small>
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
                    {paymentLines.length === 0 && <tr><td colSpan="4" className="empty-cell">Enter an amount above, then select a payment method.</td></tr>}
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


function JobDocumentForm({ document = null, tabId = '', onClose, onSaved, onNumberReady }) {
  const isEditing = Boolean(document?.id);
  const savedDraft = tabId && !isEditing ? safeReadJson(documentDraftKey(tabId), null) : null;
  const [customers, setCustomers] = useState([]);
  const [customerId, setCustomerId] = useState(savedDraft?.customerId || document?.customer_id || '');
  const [customerSearch, setCustomerSearch] = useState(savedDraft?.customerSearch || document?.customers?.name || document?.party_name || '');
  const [customerMenuOpen, setCustomerMenuOpen] = useState(false);
  const [showQuickCustomer, setShowQuickCustomer] = useState(false);
  const [jobNo, setJobNo] = useState(savedDraft?.jobNo || document?.job_no || '');
  const [documentDate, setDocumentDate] = useState(savedDraft?.documentDate || (document?.document_date || '').slice(0, 10) || todayInputDate());
  const [deviceType, setDeviceType] = useState(savedDraft?.deviceType || document?.device_type || 'Laptop');
  const [deviceSpecs, setDeviceSpecs] = useState(savedDraft?.deviceSpecs || document?.device_specs || '');
  const [problem, setProblem] = useState(savedDraft?.problem || document?.job_problem || '');
  const [accessories, setAccessories] = useState(savedDraft?.accessories || document?.job_accessories || '');
  const [estimatedDays, setEstimatedDays] = useState(savedDraft?.estimatedDays ?? document?.estimated_days ?? 3);
  const [jobStatus, setJobStatus] = useState(savedDraft?.jobStatus || document?.job_status || document?.status || 'received');
  const [notes, setNotes] = useState(savedDraft?.notes || document?.notes || '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    loadCustomersForJob();
    if (jobNo) onNumberReady?.(jobNo);
  }, []);

  useEffect(() => {
    if (!tabId) return;
    window.localStorage.setItem(documentDraftKey(tabId), JSON.stringify({
      documentType: 'job', jobNo, documentDate, customerId, customerSearch, deviceType,
      deviceSpecs, problem, accessories, estimatedDays, jobStatus, notes
    }));
  }, [tabId, jobNo, documentDate, customerId, customerSearch, deviceType, deviceSpecs, problem, accessories, estimatedDays, jobStatus, notes]);

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

  function quickAddCustomer() { setShowQuickCustomer(true); }

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
      let data;
      let saveError;
      if (isEditing) {
        const now = new Date().toISOString();
        const result = await supabase.from('documents').update({
          job_no: jobNo.trim() || document.job_no,
          customer_id: customerId,
          document_date: documentDate,
          device_type: deviceType.trim() || null,
          device_specs: deviceSpecs.trim() || null,
          job_problem: problem.trim() || null,
          job_accessories: accessories.trim() || null,
          estimated_days: Number(estimatedDays || 0),
          job_status: jobStatus,
          status: jobStatus,
          job_ready_at: ['ready', 'completed'].includes(jobStatus) ? document.job_ready_at || now : document.job_ready_at,
          job_completed_at: jobStatus === 'completed' ? document.job_completed_at || now : null,
          notes: notes.trim() || null,
          updated_at: now
        }).eq('id', document.id).select('id, document_no, job_no').single();
        data = result.data;
        saveError = result.error;
      } else {
        const result = await supabase.rpc('save_job_document_v22', {
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
        data = result.data;
        saveError = result.error;
      }
      if (saveError) throw saveError;
      setMessage(`Job ${isEditing ? 'updated' : 'saved'}: ${data?.job_no || jobNo}`);
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
          <h3>{isEditing ? `Edit Job ${jobNo}` : 'New Job Intake'}</h3>
          <p>{isEditing ? 'Update the device, customer, problem, accessories, or expected completion details.' : 'Use this when you take a customer device for repair/checking and need a job number for pickup/follow-up.'}</p>
        </div>
        <button className="secondary-button" onClick={onClose}>Close</button>
      </div>
      {message && <div className="notice">{message}</div>}
      {error && <div className="error-box">{error}</div>}
      <form onSubmit={saveJob} className="trade-in-form-grid job-form-grid">
        <label>Job number<input value={jobNo} placeholder="Assigned on save" onFocus={selectAllText} onChange={(e) => setJobNo(e.target.value)} /></label>
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
        <button className="primary-button" disabled={busy}>{busy ? 'Saving...' : isEditing ? 'Save Job Changes' : 'Save Job'}</button>
      </form>
      {showQuickCustomer && <QuickCustomerModal initialName={customerSearch} onClose={() => setShowQuickCustomer(false)} onCreated={(customer) => { setCustomers((current) => [...current, customer].sort((a, b) => a.name.localeCompare(b.name))); selectCustomer(customer); setShowQuickCustomer(false); }} />}
    </div>
  );
}

const JOB_STATUS_OPTIONS = [
  { value: 'received', label: 'Received' },
  { value: 'checking', label: 'Checking' },
  { value: 'waiting_parts', label: 'Waiting for parts' },
  { value: 'ready', label: 'Ready for collection' },
  { value: 'completed', label: 'Completed / handed over' },
  { value: 'cancelled', label: 'Cancelled' }
];

function jobStatusLabel(status) {
  return JOB_STATUS_OPTIONS.find((item) => item.value === status)?.label || status || 'Received';
}

function nextJobAction(job) {
  const status = job?.job_status || job?.status || 'received';
  if (status === 'received') return { status: 'checking', label: 'Start Checking' };
  if (status === 'checking' || status === 'waiting_parts') return { status: 'ready', label: 'Mark Ready' };
  if (status === 'ready') return { status: 'completed', label: 'Complete & Hand Over' };
  return null;
}

function JobsPage() {
  const [jobs, setJobs] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [filter, setFilter] = useState('active');
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingJob, setEditingJob] = useState(null);
  const [statusDraft, setStatusDraft] = useState('received');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { loadJobs(); }, []);
  useRealtimeRefresh(['documents', 'customers'], () => loadJobs(selectedId));

  async function loadJobs(preferredId = '') {
    setLoading(true);
    setError('');
    const { data, error: loadError } = await supabase
      .from('documents')
      .select('id, document_no, job_no, document_type, status, job_status, customer_id, document_date, device_type, device_specs, job_problem, job_accessories, estimated_days, notes, created_at, updated_at, job_ready_at, job_completed_at, customers:customers!documents_customer_id_fkey(id, name, phone, address)')
      .eq('document_type', 'job')
      .order('document_date', { ascending: false })
      .limit(1500);
    if (loadError) {
      const needsWorkflowMigration = /job_ready_at|job_completed_at|job_status/i.test(loadError.message || '');
      setError(`${loadError.message}${needsWorkflowMigration ? '. Run migration 032_jobs_workflow.sql if it has not been applied.' : ''}`);
      setLoading(false);
      return;
    }
    const rows = data || [];
    setJobs(rows);
    const wanted = preferredId || selectedId;
    const nextId = rows.some((row) => row.id === wanted) ? wanted : rows[0]?.id || '';
    setSelectedId(nextId);
    const nextSelected = rows.find((row) => row.id === nextId);
    if (nextSelected) setStatusDraft(nextSelected.job_status || nextSelected.status || 'received');
    setLoading(false);
  }

  const filteredJobs = jobs.filter((job) => {
    const status = job.job_status || job.status || 'received';
    if (filter === 'active' && ['completed', 'cancelled'].includes(status)) return false;
    if (filter !== 'all' && filter !== 'active' && status !== filter) return false;
    const clean = search.trim().toLowerCase();
    if (!clean) return true;
    return `${job.job_no || ''} ${job.document_no || ''} ${job.customers?.name || ''} ${job.customers?.phone || ''} ${job.device_type || ''} ${job.device_specs || ''} ${job.job_problem || ''}`.toLowerCase().includes(clean);
  });
  const selected = jobs.find((job) => job.id === selectedId) || null;
  const nextAction = nextJobAction(selected);
  const activeCount = jobs.filter((job) => !['completed', 'cancelled'].includes(job.job_status || job.status)).length;
  const readyCount = jobs.filter((job) => (job.job_status || job.status) === 'ready').length;
  const waitingCount = jobs.filter((job) => (job.job_status || job.status) === 'waiting_parts').length;

  function selectJob(job) {
    setSelectedId(job.id);
    setStatusDraft(job.job_status || job.status || 'received');
    setMessage('');
    setError('');
  }

  async function updateJobStatus(status) {
    if (!selected || !status) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const { error: updateError } = await supabase.rpc('update_job_status_v32', {
        p_document_id: selected.id,
        p_job_status: status
      });
      if (updateError) throw updateError;
      setMessage(`${selected.job_no} marked as ${jobStatusLabel(status)}.`);
      setStatusDraft(status);
      await loadJobs(selected.id);
    } catch (updateError) {
      setError(`${updateError.message || String(updateError)}. Run migration 032_jobs_workflow.sql if it has not been applied.`);
    } finally {
      setBusy(false);
    }
  }

  function closeJobForm() {
    setShowForm(false);
    setEditingJob(null);
  }

  return (
    <section className="page-section jobs-page">
      <div className="page-actions jobs-page-heading">
        <div><h3>Jobs &amp; Repairs</h3><p>Receive devices, follow repair progress, and see what is waiting or ready for collection.</p></div>
        <button className="primary-button" onClick={() => { setEditingJob(null); setShowForm(true); }}>+ New Job</button>
      </div>
      {message && <div className="notice success">{message}</div>}
      {error && <div className="error-box">{error}</div>}

      <div className="jobs-summary-grid">
        <StatCard label="Active jobs" value={activeCount} />
        <StatCard label="Waiting for parts" value={waitingCount} />
        <StatCard label="Ready for collection" value={readyCount} />
        <StatCard label="Completed" value={jobs.filter((job) => (job.job_status || job.status) === 'completed').length} />
      </div>

      <div className="jobs-toolbar">
        <div className="jobs-filter-tabs">
          {[['active', 'Active'], ['received', 'Received'], ['checking', 'Checking'], ['waiting_parts', 'Waiting Parts'], ['ready', 'Ready'], ['completed', 'Completed'], ['all', 'All']].map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}
        </div>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search job no, customer, phone, device, problem…" />
      </div>

      <div className="jobs-workspace">
        <div className="panel-card jobs-list-card">
          <div className="jobs-list-heading"><strong>{filteredJobs.length} jobs</strong><button className="secondary-button" disabled={loading} onClick={() => loadJobs()}>{loading ? 'Loading…' : 'Refresh'}</button></div>
          <div className="table-wrap jobs-table-wrap">
            <table>
              <thead><tr><th>Job</th><th>Customer</th><th>Device</th><th>Received</th><th>Status</th></tr></thead>
              <tbody>
                {filteredJobs.map((job) => <tr key={job.id} className={selected?.id === job.id ? 'selected-row' : ''} onClick={() => selectJob(job)}>
                  <td><strong>{job.job_no || job.document_no}</strong><small>{job.document_no}</small></td>
                  <td><strong>{job.customers?.name || 'No customer'}</strong><small>{job.customers?.phone || ''}</small></td>
                  <td><strong>{job.device_type || 'Device'}</strong><small>{job.device_specs || '-'}</small></td>
                  <td>{fmtDate(job.document_date)}</td>
                  <td><span className={`job-status-badge ${job.job_status || job.status}`}>{jobStatusLabel(job.job_status || job.status)}</span></td>
                </tr>)}
                {!loading && filteredJobs.length === 0 && <EmptyRow colSpan={5} text="No jobs match this view." />}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel-card job-detail-card">
          {selected ? <>
            <div className="job-detail-heading"><div><span>Job number</span><h2>{selected.job_no || selected.document_no}</h2><p>{selected.customers?.name || 'No customer'} · {selected.customers?.phone || 'No phone'}</p></div><span className={`job-status-badge large ${selected.job_status || selected.status}`}>{jobStatusLabel(selected.job_status || selected.status)}</span></div>
            <div className="job-detail-grid">
              <div><span>Device</span><strong>{selected.device_type || '-'}</strong><p>{selected.device_specs || 'No identification recorded.'}</p></div>
              <div><span>Problem / requested work</span><p>{selected.job_problem || 'No problem description.'}</p></div>
              <div><span>Accessories received</span><p>{selected.job_accessories || 'None recorded.'}</p></div>
              <div><span>Timing</span><p>Received {fmtDate(selected.document_date)} · Estimate {numberValue(selected.estimated_days)} days{selected.job_completed_at ? ` · Completed ${fmtDate(selected.job_completed_at)}` : ''}</p></div>
              {selected.notes && <div><span>Notes</span><p>{selected.notes}</p></div>}
            </div>
            {nextAction && <button className="primary-button job-next-button" disabled={busy} onClick={() => updateJobStatus(nextAction.status)}>{busy ? 'Updating…' : nextAction.label}</button>}
            <div className="job-status-control"><label>Change status<select value={statusDraft} onChange={(e) => setStatusDraft(e.target.value)}>{JOB_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><button className="secondary-button" disabled={busy || statusDraft === (selected.job_status || selected.status)} onClick={() => updateJobStatus(statusDraft)}>Update Status</button></div>
            <div className="job-detail-actions"><button className="secondary-button" onClick={() => { setEditingJob(selected); setShowForm(true); }}>Edit Job Details</button>{!['completed', 'cancelled'].includes(selected.job_status || selected.status) && <button className="danger-button" disabled={busy} onClick={() => updateJobStatus('cancelled')}>Cancel Job</button>}</div>
          </> : <div className="muted-box">Select a job to view its details.</div>}
        </div>
      </div>

      {showForm && <div className="modal-backdrop jobs-form-backdrop"><div className="modal-card jobs-form-modal"><JobDocumentForm document={editingJob} onClose={closeJobForm} onSaved={async () => { const id = editingJob?.id || ''; closeJobForm(); await loadJobs(id); setMessage(editingJob ? 'Job details updated.' : 'New job saved.'); }} /></div></div>}
    </section>
  );
}


function quotationLineTotal(line) {
  const gross = numberValue(line.qty) * numberValue(line.unit_price);
  const discount = line.discount_type === 'percent' ? gross * numberValue(line.discount_value) / 100 : numberValue(line.discount_value);
  return Math.max(gross - discount, 0);
}

function emptyQuotationLine() {
  return {
    id: createClientId(),
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
  const [showQuickCustomer, setShowQuickCustomer] = useState(false);
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
      id: item.id || createClientId(),
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

  function quickAddCustomer() { setShowQuickCustomer(true); }

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
      id: createClientId(),
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
        const { error: itemError } = await supabase.from('document_items').insert(itemPayload.map((item) => ({ ...item, document_id: docId })));
        if (itemError) throw itemError;
      } else {
        const { data: docData, error: insertError } = await supabase.rpc('save_quotation_v24', {
          p_header: header,
          p_items: itemPayload
        });
        if (insertError) throw insertError;
        docId = docData?.id || '';
        setDocumentNo(docData?.document_no || '');
      }

      setMessage(`Quotation saved: ${isEditing ? documentNo : 'new number assigned'}.`);
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
          <label>Quotation number<input value={documentNo} placeholder="Assigned on save" onFocus={selectAllText} onChange={(e) => setDocumentNo(e.target.value)} /></label>
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
            <div className="modal-card item-entry-modal">
              <div className="item-entry-heading"><div><span>Add quotation item</span><h3>{selectedLineProduct.name}</h3><p>{selectedLineProduct.item_code}</p></div><button type="button" className="secondary-button" onClick={() => setSelectedLineProduct(null)}>Close</button></div>
              <div className="item-entry-fields">
                <label>Selling price<input type="number" min="0" step="0.01" value={lineDraft.unit_price} onFocus={selectAllText} onChange={(e) => setLineDraft({ ...lineDraft, unit_price: e.target.value })} autoFocus /></label>
                <label>Quantity<input type="number" min="0.001" step="0.001" value={lineDraft.qty} onFocus={selectAllText} onChange={(e) => setLineDraft({ ...lineDraft, qty: e.target.value })} /></label>
              </div>
              <div className="item-entry-total"><span>Line total</span><strong>{money(numberValue(lineDraft.qty) * numberValue(lineDraft.unit_price))}</strong></div>
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
      {showQuickCustomer && <QuickCustomerModal initialName={customerSearch} onClose={() => setShowQuickCustomer(false)} onCreated={(customer) => { setCustomers((current) => [...current, customer].sort((a, b) => a.name.localeCompare(b.name))); selectCustomer(customer); setShowQuickCustomer(false); }} />}
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
  const [showQuickCustomer, setShowQuickCustomer] = useState(false);
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
  }, []);

  useEffect(() => {
    if (!tabId) return;
    window.localStorage.setItem(documentDraftKey(tabId), JSON.stringify({ documentType: 'trade_in', documentNo, documentDate, customerId, customerSearch, description, estimatedValue, externalNo, notes }));
  }, [tabId, documentNo, documentDate, customerId, customerSearch, description, estimatedValue, externalNo, notes]);

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

  function quickAddCustomer() { setShowQuickCustomer(true); }

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
        p_description: description || 'Trade-In intake',
        p_estimated_value: numberValue(estimatedValue),
        p_notes: notes
      });
      if (saveError) throw saveError;
      setMessage(`Trade-In saved: ${data?.document_no || documentNo}`);
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
          <h3>New Trade-In</h3>
          <p>Use this when the customer gives an item now, you give a rough value, but you will split/record actual parts later. No stock is added now.</p>
        </div>
        <button className="secondary-button" onClick={onClose}>Close</button>
      </div>
      {message && <div className="notice">{message}</div>}
      {error && <div className="error-box">{error}</div>}
      <form onSubmit={saveTradeIn} className="trade-in-form-grid">
        <label>Document number<input value={documentNo} placeholder="Assigned on save" onFocus={selectAllText} onChange={(e) => setDocumentNo(e.target.value)} /></label>
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
        <button className="primary-button" disabled={busy}>{busy ? 'Saving...' : 'Save Trade-In'}</button>
      </form>
      {showQuickCustomer && <QuickCustomerModal initialName={customerSearch} alsoSupplier onClose={() => setShowQuickCustomer(false)} onCreated={(customer) => { setCustomers((current) => [...current, customer].sort((a, b) => a.name.localeCompare(b.name))); selectCustomer(customer); setShowQuickCustomer(false); }} />}
    </div>
  );
}

function codStatusLabel(status) {
  return ({
    awaiting_packing: 'Awaiting packing',
    packed: 'Packed',
    dispatched: 'Dispatched',
    awaiting_settlement: 'Delivered / Awaiting payment',
    converted: 'Paid / Converted to sale',
    returned: 'Returned',
    cancelled: 'Cancelled'
  })[status] || status || '-';
}

function emptyCodLine() {
  return {
    id: createClientId(),
    product_id: '',
    item_code: '',
    description: '',
    qty: 1,
    unit_price: 0,
    unit_cost: 0,
    discount_type: 'none',
    discount_value: 0,
    line_total: 0
  };
}

function codLineTotal(line) {
  const gross = numberValue(line.qty) * numberValue(line.unit_price);
  const discount = line.discount_type === 'percent'
    ? gross * (numberValue(line.discount_value) / 100)
    : line.discount_type === 'amount' ? numberValue(line.discount_value) : 0;
  return Math.max(gross - discount, 0);
}

function escapePrintHtml(value) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(value ?? '').replace(/[&<>"']/g, (character) => map[character]);
}

async function imageUrlToDataUrl(url) {
  if (!url) return '';
  const response = await fetch(url);
  if (!response.ok) throw new Error('Could not load the company logo for PDF.');
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read the company logo for PDF.'));
    reader.readAsDataURL(blob);
  });
}

function safePdfFilename(value) {
  return String(value || 'document').replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '') || 'document';
}

function cashflowReportRangeLabel(filters = {}) {
  const range = cashflowDateRange(filters.datePreset, filters.dateFrom, filters.dateTo);
  const inclusiveEnd = range.end ? new Date(range.end.getTime() - 1) : null;
  if (range.start && inclusiveEnd) return `${fmtDate(range.start)} - ${fmtDate(inclusiveEnd)}`;
  if (range.start) return `From ${fmtDate(range.start)}`;
  if (inclusiveEnd) return `Up to ${fmtDate(inclusiveEnd)}`;
  return 'All time';
}

function cashflowReportFilename(filters = {}) {
  const range = cashflowDateRange(filters.datePreset, filters.dateFrom, filters.dateTo);
  const datePart = (value) => value ? localDateInput(value) : '';
  const inclusiveEnd = range.end ? new Date(range.end.getTime() - 1) : null;
  if (range.start || inclusiveEnd) return safePdfFilename(`Cashflow_${datePart(range.start) || 'Start'}_${datePart(inclusiveEnd) || 'Today'}`);
  return 'Cashflow_All_Time';
}

async function createCashflowReportPdf(entries = [], filters = {}, companySettings = DEFAULT_COMPANY_SETTINGS, options = {}) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const settings = { ...DEFAULT_COMPANY_SETTINGS, ...(companySettings || {}) };
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a5' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 7;
  const rows = [...entries].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const externalRows = rows.filter((row) => row.documents?.document_type !== 'account_transfer');
  const cashIn = externalRows.filter((row) => row.entry_type === 'cash_in').reduce((sum, row) => sum + numberValue(row.amount), 0);
  const cashOut = externalRows.filter((row) => row.entry_type === 'cash_out').reduce((sum, row) => sum + numberValue(row.amount), 0);
  const nonCash = rows.filter((row) => row.entry_type === 'non_cash').reduce((sum, row) => sum + numberValue(row.amount), 0);
  const rangeLabel = cashflowReportRangeLabel(filters);
  const typeLabel = filters.type === 'cash_in' ? 'Cash in' : filters.type === 'cash_out' ? 'Cash out' : filters.type === 'non_cash' ? 'Non-cash' : 'All cash types';
  const documentLabel = filters.documentType === 'all' ? 'All documents' : documentTypeLabel(filters.documentType);
  const paymentLabel = filters.paymentMethodId === 'all' ? 'All payment types' : rows.find((row) => row.payment_method_id === filters.paymentMethodId)?.payment_methods?.name || 'Selected payment type';
  const filterDetails = [typeLabel, documentLabel, paymentLabel, filters.search?.trim() ? `Search: ${filters.search.trim()}` : ''].filter(Boolean).join(' | ');

  let logoData = '';
  const logoUrl = companyLogoUrl(settings);
  if (logoUrl) {
    try { logoData = await imageUrlToDataUrl(logoUrl); } catch { logoData = ''; }
  }
  let companyX = margin;
  if (logoData) {
    const logoFormat = logoData.startsWith('data:image/png') ? 'PNG' : logoData.startsWith('data:image/webp') ? 'WEBP' : 'JPEG';
    pdf.addImage(logoData, logoFormat, margin, margin, 14, 14, undefined, 'FAST');
    companyX += 18;
  }
  pdf.setTextColor(23, 32, 42);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(12);
  pdf.text(String(settings.shop_name || 'Computer Shop'), companyX, margin + 4);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(5.8);
  const companyLines = [settings.header_subtitle, settings.address, [settings.phone, settings.email].filter(Boolean).join(' | ')].filter(Boolean);
  if (companyLines.length) pdf.text(pdf.splitTextToSize(companyLines.join('\n'), 65), companyX, margin + 7.5);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10.5);
  pdf.text('CASHFLOW STATEMENT', pageWidth - margin, margin + 4, { align: 'right' });
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(6.5);
  pdf.text(rangeLabel, pageWidth - margin, margin + 8, { align: 'right' });
  pdf.setDrawColor(22, 136, 189);
  pdf.setLineWidth(.65);
  pdf.line(margin, margin + 17, pageWidth - margin, margin + 17);
  pdf.setTextColor(78, 91, 100);
  pdf.setFontSize(5.2);
  pdf.text(pdf.splitTextToSize(filterDetails, pageWidth - margin * 2), margin, margin + 21);

  const summaryY = margin + 25;
  const summaryGap = 2;
  const summaryWidth = (pageWidth - margin * 2 - summaryGap * 3) / 4;
  [
    ['Cash In', money(cashIn)],
    ['Cash Out', money(cashOut)],
    ['Net Cashflow', signedMoney(cashIn - cashOut)],
    ['Non-cash', money(nonCash)]
  ].forEach(([label, value], index) => {
    const x = margin + index * (summaryWidth + summaryGap);
    pdf.setFillColor(index === 2 ? 232 : 245, index === 2 ? 246 : 247, index === 2 ? 251 : 248);
    pdf.setDrawColor(index === 2 ? 22 : 215, index === 2 ? 136 : 221, index === 2 ? 189 : 226);
    pdf.rect(x, summaryY, summaryWidth, 12, 'FD');
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(5.2);
    pdf.setTextColor(82, 96, 105);
    pdf.text(label, x + 2, summaryY + 3.3);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(6.5);
    pdf.setTextColor(23, 32, 42);
    pdf.text(pdf.splitTextToSize(value, summaryWidth - 4), x + 2, summaryY + 8);
  });

  const tableRows = rows.map((entry) => {
    const type = entry.entry_type === 'cash_in' ? 'In' : entry.entry_type === 'cash_out' ? 'Out' : 'Non-cash';
    const account = entry.payment_methods?.name || entry.account_name || '-';
    const amountPrefix = entry.entry_type === 'cash_out' ? '-' : entry.entry_type === 'cash_in' ? '+' : '';
    return [
      new Date(entry.created_at).toLocaleString('en-LK', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }),
      type,
      account,
      entry.documents?.document_no || '-',
      entry.description || '-',
      `${amountPrefix}${money(entry.amount)}`
    ];
  });
  autoTable(pdf, {
    startY: summaryY + 15,
    head: [['Date', 'Type', 'Account', 'Document', 'Description', 'Amount']],
    body: tableRows.length ? tableRows : [['-', '-', '-', '-', 'No cashflow entries match these filters.', '-']],
    margin: { left: margin, right: margin, bottom: 12 },
    showHead: 'everyPage',
    rowPageBreak: 'avoid',
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 5.8, cellPadding: 1.35, overflow: 'linebreak', textColor: [23, 32, 42], lineColor: [214, 221, 226], lineWidth: .12, valign: 'middle' },
    headStyles: { fillColor: [30, 43, 52], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 5.7 },
    alternateRowStyles: { fillColor: [248, 250, 251] },
    columnStyles: {
      0: { cellWidth: 21 },
      1: { cellWidth: 13 },
      2: { cellWidth: 19 },
      3: { cellWidth: 19 },
      4: { cellWidth: 'auto' },
      5: { cellWidth: 25, halign: 'right', fontStyle: 'bold' }
    }
  });

  const pageCount = pdf.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    pdf.setPage(page);
    pdf.setDrawColor(214, 221, 226);
    pdf.setLineWidth(.15);
    pdf.line(margin, pageHeight - 8, pageWidth - margin, pageHeight - 8);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(5.5);
    pdf.setTextColor(100, 112, 120);
    pdf.text(`Generated ${new Date().toLocaleString('en-LK')}`, margin, pageHeight - 4.5);
    pdf.text(`Page ${page} of ${pageCount}`, pageWidth - margin, pageHeight - 4.5, { align: 'right' });
  }
  if (options.output === 'blob') return pdf.output('blob');
  pdf.save(`${cashflowReportFilename(filters)}.pdf`);
  return null;
}

const DEFAULT_INVOICE_POLICY = `Warranty: Duration is shown beside each item. Warranty is void if the sticker is broken, removed or tampered with, or for physical damage and chip burns.
Returns: Valid returns within 7 days are eligible for exchange or refund when the item is in its original, unaltered condition.
After 7 days: Faulty items within warranty may be replaced or exchanged for items of equal value. No cash refunds.`;

function invoicePolicyText(settings) {
  return String(settings?.invoice_footer || '').trim() || DEFAULT_INVOICE_POLICY;
}

function documentPaymentSummary(document, flows = []) {
  const grouped = new Map();
  (flows || []).forEach((flow) => {
    const label = flow.payment_methods?.name || flow.account_name || (flow.entry_type === 'non_cash' ? 'Credit' : 'Payment');
    grouped.set(label, roundMoney(numberValue(grouped.get(label)) + Math.abs(numberValue(flow.amount))));
  });
  if (!grouped.size && document?.payment_method_name && numberValue(document?.paid_amount) > 0) grouped.set(document.payment_method_name, Math.abs(numberValue(document.paid_amount)));
  return [...grouped.entries()].map(([label, amount]) => ({ label, amount }));
}

async function downloadAccountingDocumentPdf(document, items = [], flows = [], companySettings = DEFAULT_COMPANY_SETTINGS, options = {}) {
  if (!document) return;
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const settings = { ...DEFAULT_COMPANY_SETTINGS, ...(companySettings || {}) };
  const outstandingBalance = documentOutstandingBalance(document);
  const paperFormat = settings.paper_size === 'A4' ? 'a4' : 'a5';
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: paperFormat });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = Math.min(Math.max(numberValue(settings.page_margin_mm, 8), 4), 20);
  const logoUrl = companyLogoUrl(settings);
  let logoData = '';
  if (logoUrl) {
    try { logoData = await imageUrlToDataUrl(logoUrl); } catch { logoData = ''; }
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
  pdf.text(String(settings.shop_name || 'Computer Shop'), companyX, margin + 5);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7.5);
  const companyLines = [settings.header_subtitle, settings.address, [settings.phone, settings.email].filter(Boolean).join(' | '), settings.registration_no ? `Reg: ${settings.registration_no}` : ''].filter(Boolean);
  const companyText = pdf.splitTextToSize(companyLines.join('\n'), Math.max(pageWidth * .53 - companyX + margin, 45));
  pdf.text(companyText, companyX, margin + 9);

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.text(documentTypeLabel(document.document_type).toUpperCase(), pageWidth - margin, margin + 5, { align: 'right' });
  pdf.setFontSize(9);
  pdf.text(String(document.document_no || ''), pageWidth - margin, margin + 10, { align: 'right' });
  pdf.setDrawColor(22, 136, 189);
  pdf.setLineWidth(.7);
  pdf.line(margin, margin + 21, pageWidth - margin, margin + 21);

  const partyName = document.party?.name || document.recipient_name || '-';
  const partyInfo = [document.party?.phone, document.party?.address].filter(Boolean).join(' | ');
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  const metaY = margin + 27;
  pdf.text(`Date: ${fmtDate(document.document_date || document.created_at)}`, margin, metaY);
  pdf.text(`Status: ${document.status || '-'}`, pageWidth / 2, metaY);
  pdf.text(`Customer / Supplier: ${partyName}`, margin, metaY + 5);
  let cursorY = metaY + 10;
  if (partyInfo) {
    pdf.setTextColor(82, 96, 105);
    pdf.text(pdf.splitTextToSize(partyInfo, pageWidth - margin * 2), margin, cursorY);
    cursorY += 5;
    pdf.setTextColor(23, 32, 42);
  }
  if (document.notes) {
    const noteLines = pdf.splitTextToSize(`Notes: ${document.notes}`, pageWidth - margin * 2);
    pdf.setFillColor(244, 248, 250);
    pdf.rect(margin, cursorY, pageWidth - margin * 2, noteLines.length * 3.4 + 4, 'F');
    pdf.text(noteLines, margin + 2, cursorY + 4);
    cursorY += noteLines.length * 3.4 + 7;
  }

  if (items.length) {
    const headers = [];
    if (settings.show_item_code) headers.push('Code');
    headers.push('Description', 'Qty', 'Unit price', 'Discount', 'Total');
    const rows = items.map((item) => {
      const descriptionDetails = [item.description || '-', settings.show_serial_number && item.serial_number ? `Serial: ${item.serial_number}` : '', settings.show_warranty && item.warranty ? `Warranty: ${item.warranty}` : ''].filter(Boolean).join('\n');
      const row = [];
      if (settings.show_item_code) row.push(item.item_code || '-');
      row.push(descriptionDetails, String(numberValue(item.qty)), money(item.unit_price || item.unit_cost), numberValue(item.discount_value) ? item.discount_type === 'percent' ? `${numberValue(item.discount_value)}%` : money(item.discount_value) : '-', money(item.line_total));
      return row;
    });
    autoTable(pdf, {
      startY: cursorY,
      head: [headers],
      body: rows,
      margin: { left: margin, right: margin },
      showHead: 'firstPage',
      rowPageBreak: 'avoid',
      theme: 'grid',
      styles: { font: 'helvetica', fontSize: paperFormat === 'a5' ? 6.7 : 7.5, cellPadding: 1.7, textColor: [23, 32, 42], lineColor: [214, 221, 226], lineWidth: .15 },
      headStyles: { fillColor: [237, 243, 246], textColor: [23, 32, 42], fontStyle: 'bold' },
      columnStyles: settings.show_item_code
        ? { 0: { cellWidth: 17 }, 1: { cellWidth: 'auto' }, 2: { halign: 'right', cellWidth: 10 }, 3: { halign: 'right', cellWidth: 24 }, 4: { halign: 'right', cellWidth: 18 }, 5: { halign: 'right', cellWidth: 25 } }
        : { 0: { cellWidth: 'auto' }, 1: { halign: 'right', cellWidth: 10 }, 2: { halign: 'right', cellWidth: 24 }, 3: { halign: 'right', cellWidth: 18 }, 4: { halign: 'right', cellWidth: 25 } }
    });
    cursorY = (pdf.lastAutoTable?.finalY || cursorY) + 2;
  }

  const totalValue = numberValue(document.total_amount ?? document.paid_amount);
  const isRefund = totalValue < 0;
  const isExchange = Math.abs(totalValue) < .005 && items.some((item) => numberValue(item.qty) < 0) && items.some((item) => numberValue(item.qty) > 0);
  const paymentRows = documentPaymentSummary(document, flows);
  pdf.setFontSize(4.1);
  const policyLines = pdf.splitTextToSize(invoicePolicyText(settings), pageWidth - margin * 2 - 4);
  const paymentHeight = 15.8 + Math.max(paymentRows.length, 1) * 2.5 + (outstandingBalance === null ? 0 : 3);
  const policyHeight = Math.max(policyLines.length * 1.55 + 4.5, 9);
  const footerHeight = 4.5 + policyHeight;
  const footerTop = pageHeight - margin - footerHeight;
  if (cursorY + paymentHeight + 4 > footerTop) {
    pdf.addPage();
    cursorY = margin;
  }
  const totalsX = pageWidth - margin - 66;
  let summaryY = cursorY;
  pdf.setTextColor(23, 32, 42);
  pdf.setFontSize(7.2);
  pdf.setFont('helvetica', 'bold');
  pdf.text(isExchange ? 'Exchange total' : isRefund ? 'Return total' : 'Total', totalsX, summaryY + 3);
  pdf.text(money(totalValue), pageWidth - margin, summaryY + 3, { align: 'right' });
  summaryY += 4;
  pdf.setDrawColor(150, 158, 164);
  pdf.setLineWidth(.2);
  pdf.line(totalsX, summaryY, pageWidth - margin, summaryY);
  pdf.setFontSize(6.2);
  pdf.text('Payment method', totalsX, summaryY + 2.5);
  summaryY += 5.8;
  pdf.setFont('helvetica', 'normal');
  if (paymentRows.length) {
    paymentRows.forEach((row) => {
      pdf.text(String(row.label), totalsX + 2, summaryY);
      pdf.text(money(row.amount), pageWidth - margin, summaryY, { align: 'right' });
      summaryY += 2.5;
    });
  } else {
    pdf.text(isExchange ? 'No payment - even exchange' : 'Credit / unpaid', totalsX + 2, summaryY);
    summaryY += 2.5;
  }
  pdf.setFont('helvetica', 'bold');
  pdf.text(isRefund ? 'Refunded amount' : 'Paid amount', totalsX, summaryY + .6);
  pdf.text(money(Math.abs(numberValue(document.paid_amount))), pageWidth - margin, summaryY + .6, { align: 'right' });
  summaryY += 3;
  pdf.text(isRefund ? 'Refund due' : 'Amount due', totalsX, summaryY + .6);
  pdf.text(money(Math.abs(numberValue(document.balance_amount))), pageWidth - margin, summaryY + .6, { align: 'right' });
  summaryY += 3;
  if (outstandingBalance !== null) {
    pdf.setDrawColor(110, 120, 126);
    pdf.line(totalsX, summaryY, pageWidth - margin, summaryY);
    pdf.text('Outstanding balance', totalsX, summaryY + 2.5);
    pdf.text(signedMoney(outstandingBalance), pageWidth - margin, summaryY + 2.5, { align: 'right' });
    summaryY += 3;
  }

  const signatureY = footerTop;
  const signatureWidth = (pageWidth - margin * 2 - 18) / 2;
  pdf.setDrawColor(85, 92, 98);
  pdf.setLineWidth(.25);
  pdf.line(margin + 3, signatureY, margin + 3 + signatureWidth, signatureY);
  pdf.line(pageWidth - margin - 3 - signatureWidth, signatureY, pageWidth - margin - 3, signatureY);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(5.5);
  pdf.text('Authorized By', margin + 3 + signatureWidth / 2, signatureY + 3, { align: 'center' });
  pdf.text('Customer Signature', pageWidth - margin - 3 - signatureWidth / 2, signatureY + 3, { align: 'center' });

  const policyY = footerTop + 4.5;
  pdf.setFillColor(247, 248, 249);
  pdf.setDrawColor(215, 220, 224);
  pdf.rect(margin, policyY, pageWidth - margin * 2, policyHeight, 'FD');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(4.4);
  pdf.setTextColor(68, 76, 82);
  pdf.text('STORE POLICIES', margin + 2, policyY + 2.5);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(4.1);
  pdf.text(policyLines, margin + 2, policyY + 4.2);

  const pageCount = pdf.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    pdf.setPage(page);
    pdf.setDrawColor(214, 221, 226);
    pdf.line(margin, pageHeight - margin + 1, pageWidth - margin, pageHeight - margin + 1);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(6.5);
    pdf.setTextColor(100, 112, 120);
    pdf.text(`${settings.shop_name || 'Computer Shop'} - Page ${page} of ${pageCount}`, pageWidth / 2, pageHeight - margin + 4, { align: 'center' });
  }
  if (options.output === 'blob') return pdf.output('blob');
  pdf.save(`${safePdfFilename(document.document_no)}.pdf`);
  return null;
}

function writePrintWindow(popup, title, body, companySettings = DEFAULT_COMPANY_SETTINGS, autoPrint = true) {
  const settings = { ...DEFAULT_COMPANY_SETTINGS, ...(companySettings || {}) };
  const paperSize = settings.paper_size === 'A4' ? 'A4' : 'A5';
  const paperWidth = paperSize === 'A4' ? '210mm' : '148mm';
  const paperMinHeight = paperSize === 'A4' ? '297mm' : '210mm';
  const pageMargin = Math.min(Math.max(numberValue(settings.page_margin_mm, 8), 4), 20);
  popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapePrintHtml(title)}</title><style>
    @page{size:${paperSize} portrait;margin:${pageMargin}mm}
    *{box-sizing:border-box}html,body{margin:0;padding:0}body{font-family:Arial,Helvetica,sans-serif;color:#17202a;background:#d8dde1;font-size:10.5px;line-height:1.35}.print-toolbar{position:sticky;top:0;z-index:5;display:flex;justify-content:center;gap:8px;padding:10px;background:#20252a}.print-toolbar button{border:0;border-radius:4px;background:#1688bd;color:#fff;padding:9px 14px;font-weight:700;cursor:pointer}.print-toolbar button.secondary{background:#4a535a}.sheet{width:${paperWidth};min-height:${paperMinHeight};margin:14px auto;padding:${pageMargin}mm;background:#fff;box-shadow:0 8px 28px rgba(0,0,0,.22)}.brand-row{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;padding-bottom:10px;border-bottom:2px solid #1688bd}.brand-block-print{display:flex;align-items:center;gap:10px;min-width:0}.brand-logo-print{width:50px;height:50px;object-fit:contain;flex:0 0 auto}.brand-copy h1{margin:0;font-size:20px;line-height:1.08}.brand-copy p{margin:3px 0 0;color:#53636d;white-space:pre-line}.doc-heading{text-align:right;flex:0 0 auto}.doc-heading h2{margin:0;font-size:16px;text-transform:uppercase}.doc-heading strong{display:block;margin-top:4px;font-size:13px}.document-meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin:10px 0}.document-meta>div{min-height:42px;padding:6px 8px;border:1px solid #d6dde2}.document-meta span{display:block;margin-bottom:2px;color:#6b7880;font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}.document-meta strong,.document-meta small{display:block;overflow-wrap:anywhere}.document-meta small{margin-top:2px;color:#58666f}.notes-print{margin:8px 0;padding:7px 9px;border-left:3px solid #1688bd;background:#f4f8fa;white-space:pre-wrap}.print-section-title{margin:10px 0 5px;font-size:11px;text-transform:uppercase}table{width:100%;border-collapse:collapse;table-layout:auto}thead{display:table-row-group}tr{break-inside:avoid}th,td{padding:5px 4px;border:1px solid #d6dde2;vertical-align:top}th{background:#edf3f6;font-size:8px;text-transform:uppercase;letter-spacing:.03em}.description-cell{white-space:normal;overflow-wrap:anywhere}.item-detail{display:block;margin-top:2px;color:#65747d;font-size:8px}.num{text-align:right;white-space:nowrap}.invoice-summary-block{break-inside:avoid;page-break-inside:avoid;margin-top:10px}.invoice-footer-block{break-inside:avoid;page-break-inside:avoid;margin-top:22px}.totals-print{width:min(250px,72%);margin:0 0 0 auto}.totals-print>div{display:flex;justify-content:space-between;gap:14px;padding:3px 0}.totals-print .grand{font-size:13px;font-weight:800;border-bottom:1px solid #8e989e}.totals-print .payment-heading{padding:7px 0 5px!important;font-weight:800}.totals-print .outstanding{margin-top:3px;padding-top:6px;border-top:1px solid #59646b;font-weight:800}.signature-row{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin:22px 8px 8px}.signature-row div{padding-top:5px;border-top:1px dotted #343a3e;text-align:center}.terms-print.compact-policy{margin-top:7px;padding:5px 6px;border:1px solid #d6dde2;background:#f7f8f9;white-space:pre-line;color:#4f5f68;font-size:6.2px;line-height:1.22}.terms-print.compact-policy strong{display:block;margin-bottom:2px;font-size:6.5px}.print-footer{margin-top:6px;padding-top:4px;border-top:1px solid #d6dde2;text-align:center;color:#6a7780;font-size:7px}.label-recipient{padding:12px;border:2px solid #17202a}.label-recipient h1{margin:0 0 7px;font-size:23px}.label-phone{font-size:20px;font-weight:800;margin:7px 0}.label-address{min-height:72px;font-size:16px;line-height:1.45}.label-info{display:flex;justify-content:space-between;gap:14px;padding:8px 0;border-top:1px solid #59646b;font-size:14px}.label-tracking{margin-top:9px;padding:10px;border:2px dashed #17202a;text-align:center;font-size:16px;font-weight:800;overflow-wrap:anywhere}
    @media(max-width:700px){body{background:#fff}.sheet{width:100%;min-height:0;margin:0;box-shadow:none}.print-toolbar{position:static}}
    @media print{body{background:#fff}.print-toolbar{display:none!important}.sheet{width:auto;min-height:0;margin:0;padding:0;box-shadow:none}}
  </style></head><body><div class="print-toolbar"><button onclick="window.print()">Print</button><button class="secondary" onclick="window.close()">Close Preview</button></div><main class="sheet">${body}</main>${autoPrint ? '<script>window.onload=()=>window.print();</script>' : ''}</body></html>`);
  popup.document.close();
}

function printableCompanyHeader(settings, documentTitle, documentNo) {
  const company = { ...DEFAULT_COMPANY_SETTINGS, ...(settings || {}) };
  const logoUrl = companyLogoUrl(company);
  const contactLines = [company.header_subtitle, company.address, [company.phone, company.email].filter(Boolean).join(' · '), company.registration_no ? `Reg: ${company.registration_no}` : ''].filter(Boolean);
  return `<div class="brand-row"><div class="brand-block-print">${logoUrl ? `<img class="brand-logo-print" src="${escapePrintHtml(logoUrl)}" alt="Logo">` : ''}<div class="brand-copy"><h1>${escapePrintHtml(company.shop_name || 'Computer Shop')}</h1><p>${escapePrintHtml(contactLines.join('\n'))}</p></div></div><div class="doc-heading"><h2>${escapePrintHtml(documentTitle)}</h2><strong>${escapePrintHtml(documentNo || '')}</strong></div></div>`;
}

function showPdfBlobPreview(popup, blob, title, autoPrint = false) {
  const pdfUrl = URL.createObjectURL(blob);
  popup.document.open();
  popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapePrintHtml(title)}</title><style>*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden;font-family:Arial;background:#222}.pdf-preview-toolbar{height:58px;display:flex;align-items:center;justify-content:center;gap:10px;background:#20252a;border-bottom:1px solid #42484d}.pdf-preview-toolbar button{min-width:110px;padding:10px 16px;border:0;border-radius:4px;background:#1688bd;color:#fff;font-weight:800;cursor:pointer}.pdf-preview-toolbar button.secondary{background:#4a535a}.pdf-frame{display:block;width:100%;height:calc(100% - 58px);border:0;background:#d8dde1}</style></head><body><div class="pdf-preview-toolbar"><button id="printPdf">Print</button><button class="secondary" onclick="window.close()">Close Preview</button></div><iframe id="pdfFrame" class="pdf-frame" src="${escapePrintHtml(pdfUrl)}" title="${escapePrintHtml(title)}"></iframe><script>const frame=document.getElementById('pdfFrame');const printPdf=()=>{try{frame.contentWindow.focus();frame.contentWindow.print();}catch(error){window.print();}};document.getElementById('printPdf').onclick=printPdf;${autoPrint ? "frame.onload=()=>setTimeout(printPdf,350);" : ''}</script></body></html>`);
  popup.document.close();
  window.setTimeout(() => URL.revokeObjectURL(pdfUrl), 300000);
}

async function printAccountingDocument(document, items = [], flows = [], companySettings = DEFAULT_COMPANY_SETTINGS, options = {}) {
  if (!document) return;
  const popup = options.popup || window.open('', '_blank', 'width=920,height=980');
  if (!popup) {
    window.alert('Allow pop-ups for this site to print or save documents as PDF.');
    return;
  }
  try {
    popup.document.open();
    popup.document.write('<!doctype html><title>Preparing PDF</title><body style="margin:0;background:#20252a;color:#fff;font-family:Arial;display:grid;place-items:center;height:100vh">Preparing the exact PDF preview...</body>');
    popup.document.close();
    const blob = await downloadAccountingDocumentPdf(document, items, flows, companySettings, { output: 'blob' });
    const title = `${document.document_no} - ${documentTypeLabel(document.document_type)}`;
    const shouldAutoPrint = options.autoPrint !== false;
    showPdfBlobPreview(popup, blob, title, shouldAutoPrint);
  } catch (printError) {
    popup.document.open();
    popup.document.write(`<!doctype html><title>Print failed</title><body style="font-family:Arial;padding:30px"><h2>Could not prepare PDF preview</h2><p>${escapePrintHtml(printError.message || String(printError))}</p></body>`);
    popup.document.close();
    return;
  }
}

async function createCodLabelsPdf(orders = [], companySettings = DEFAULT_COMPANY_SETTINGS, options = {}) {
  const { jsPDF } = await import('jspdf');
  const settings = { ...DEFAULT_COMPANY_SETTINGS, ...(companySettings || {}) };
  const printableOrders = (orders || []).filter(Boolean);
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a5' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const pagePadding = 5;
  const slotHeight = (pageHeight - pagePadding * 2) / 3;
  const contentWidth = pageWidth - pagePadding * 2;

  printableOrders.forEach((order, index) => {
    if (index > 0 && index % 3 === 0) pdf.addPage('a5', 'portrait');
    const slot = index % 3;
    const y = pagePadding + slot * slotHeight;
    const boxY = y + 1.2;
    const boxHeight = slotHeight - 2.4;
    const headerHeight = 11;
    const middleX = pagePadding + contentWidth / 2;
    const fromName = settings.shop_name || 'Computer Shop';
    const fromAddress = settings.address || '-';
    const fromPhone = settings.phone || '-';
    const toName = order.recipient_name || 'Customer';
    const toAddress = order.delivery_address || '-';
    const toPhone = order.delivery_phone || '-';
    const tracking = order.tracking_number || 'Not assigned';
    const courier = order.delivery_service || 'Courier pending';

    pdf.setDrawColor(45, 52, 57);
    pdf.setLineWidth(.35);
    pdf.rect(pagePadding, boxY, contentWidth, boxHeight);
    pdf.setFillColor(244, 247, 248);
    pdf.rect(pagePadding, boxY, contentWidth, headerHeight, 'F');
    pdf.line(pagePadding, boxY + headerHeight, pageWidth - pagePadding, boxY + headerHeight);
    pdf.line(middleX, boxY + headerHeight, middleX, boxY + boxHeight);

    pdf.setTextColor(23, 32, 42);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(7.8);
    pdf.text(`COD ${String(order.document_no || '')}`, pagePadding + 2.5, boxY + 4.4);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(5.8);
    pdf.text(`${courier} | Tracking: ${tracking}`, pagePadding + 2.5, boxY + 8.1);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8.2);
    pdf.text(money(order.cod_collect_amount || order.total_amount), pageWidth - pagePadding - 2.5, boxY + 5.7, { align: 'right' });

    const addressTop = boxY + headerHeight + 4;
    const columnWidth = contentWidth / 2 - 6;
    const drawAddress = (label, name, address, phone, x) => {
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(5.4);
      pdf.setTextColor(88, 100, 108);
      pdf.text(label, x, addressTop);
      pdf.setTextColor(23, 32, 42);
      pdf.setFontSize(8.2);
      pdf.text(pdf.splitTextToSize(String(name), columnWidth).slice(0, 2), x, addressTop + 4.2);
      const nameLines = pdf.splitTextToSize(String(name), columnWidth).slice(0, 2).length;
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(7.1);
      const addressLines = pdf.splitTextToSize(String(address), columnWidth).slice(0, 6);
      const addressY = addressTop + 4.2 + nameLines * 3.4;
      pdf.text(addressLines, x, addressY);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(7.2);
      pdf.text(String(phone), x, Math.min(addressY + addressLines.length * 3.15 + 2.5, boxY + boxHeight - 3));
    };
    drawAddress('FROM', fromName, fromAddress, fromPhone, pagePadding + 3);
    drawAddress('TO', toName, toAddress, toPhone, middleX + 3);

    if (slot < 2) {
      pdf.setDrawColor(140, 148, 154);
      pdf.setLineDashPattern([1.2, 1.2], 0);
      pdf.line(pagePadding, y + slotHeight, pageWidth - pagePadding, y + slotHeight);
      pdf.setLineDashPattern([], 0);
    }
  });

  if (!printableOrders.length) {
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(12);
    pdf.text('No COD orders selected', pageWidth / 2, 20, { align: 'center' });
  }
  if (options.output === 'blob') return pdf.output('blob');
  pdf.save(`COD_Labels_${todayInputDate()}.pdf`);
  return null;
}

async function createCodBillPdf(order, items = [], companySettings = DEFAULT_COMPANY_SETTINGS, options = {}) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const settings = { ...DEFAULT_COMPANY_SETTINGS, ...(companySettings || {}) };
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a5' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 8;
  let logoData = '';
  const logoUrl = companyLogoUrl(settings);
  if (logoUrl) {
    try { logoData = await imageUrlToDataUrl(logoUrl); } catch { logoData = ''; }
  }
  let companyX = margin;
  if (logoData) {
    const logoFormat = logoData.startsWith('data:image/png') ? 'PNG' : logoData.startsWith('data:image/webp') ? 'WEBP' : 'JPEG';
    pdf.addImage(logoData, logoFormat, margin, margin, 16, 16, undefined, 'FAST');
    companyX += 20;
  }
  pdf.setTextColor(23, 32, 42);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(13);
  pdf.text(String(settings.shop_name || 'Computer Shop'), companyX, margin + 4.5);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(6.3);
  const companyLines = [settings.header_subtitle, settings.address, [settings.phone, settings.email].filter(Boolean).join(' | ')].filter(Boolean);
  if (companyLines.length) pdf.text(pdf.splitTextToSize(companyLines.join('\n'), 64), companyX, margin + 8);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10.5);
  pdf.text('COD ORDER BILL', pageWidth - margin, margin + 4.5, { align: 'right' });
  pdf.setFontSize(8.5);
  pdf.text(String(order.document_no || ''), pageWidth - margin, margin + 9, { align: 'right' });
  pdf.setDrawColor(22, 136, 189);
  pdf.setLineWidth(.65);
  pdf.line(margin, margin + 20, pageWidth - margin, margin + 20);

  let cursorY = margin + 26;
  const metaRows = [
    ['Date', fmtDate(order.document_date || order.created_at), 'Status', codStatusLabel(order.status)],
    ['Recipient', order.recipient_name || '-', 'Phone', order.delivery_phone || '-'],
    ['Courier', order.delivery_service || 'Not selected', 'Tracking', order.tracking_number || 'Not assigned']
  ];
  metaRows.forEach(([leftLabel, leftValue, rightLabel, rightValue]) => {
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(5.4); pdf.setTextColor(92, 103, 111);
    pdf.text(leftLabel.toUpperCase(), margin, cursorY);
    pdf.text(rightLabel.toUpperCase(), pageWidth / 2 + 2, cursorY);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7); pdf.setTextColor(23, 32, 42);
    pdf.text(pdf.splitTextToSize(String(leftValue), pageWidth / 2 - margin - 5), margin, cursorY + 3.6);
    pdf.text(pdf.splitTextToSize(String(rightValue), pageWidth / 2 - margin - 5), pageWidth / 2 + 2, cursorY + 3.6);
    cursorY += 8;
  });
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(5.4); pdf.setTextColor(92, 103, 111);
  pdf.text('DELIVERY ADDRESS', margin, cursorY);
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7); pdf.setTextColor(23, 32, 42);
  const addressLines = pdf.splitTextToSize(String(order.delivery_address || '-'), pageWidth - margin * 2);
  pdf.text(addressLines, margin, cursorY + 3.7);
  cursorY += addressLines.length * 3.2 + 6;
  if (order.notes) {
    const noteLines = pdf.splitTextToSize(`Notes: ${order.notes}`, pageWidth - margin * 2 - 4);
    pdf.setFillColor(244, 248, 250);
    pdf.rect(margin, cursorY, pageWidth - margin * 2, noteLines.length * 3 + 4, 'F');
    pdf.text(noteLines, margin + 2, cursorY + 3.8);
    cursorY += noteLines.length * 3 + 7;
  }

  const headers = [];
  if (settings.show_item_code) headers.push('Code');
  headers.push('Description', 'Qty', 'Unit price', 'Total');
  const rows = (items || []).map((item) => {
    const row = [];
    if (settings.show_item_code) row.push(item.item_code || '-');
    row.push(item.description || '-', String(numberValue(item.qty)), money(item.unit_price), money(item.line_total ?? numberValue(item.qty) * numberValue(item.unit_price)));
    return row;
  });
  autoTable(pdf, {
    startY: cursorY,
    head: [headers],
    body: rows.length ? rows : [[...(settings.show_item_code ? ['-'] : []), 'No items', '-', '-', '-']],
    margin: { left: margin, right: margin, bottom: 13 },
    showHead: 'everyPage',
    rowPageBreak: 'avoid',
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 6.6, cellPadding: 1.6, textColor: [23, 32, 42], lineColor: [214, 221, 226], lineWidth: .14 },
    headStyles: { fillColor: [237, 243, 246], textColor: [23, 32, 42], fontStyle: 'bold' },
    columnStyles: settings.show_item_code
      ? { 0: { cellWidth: 17 }, 1: { cellWidth: 'auto' }, 2: { cellWidth: 10, halign: 'right' }, 3: { cellWidth: 25, halign: 'right' }, 4: { cellWidth: 26, halign: 'right' } }
      : { 0: { cellWidth: 'auto' }, 1: { cellWidth: 10, halign: 'right' }, 2: { cellWidth: 25, halign: 'right' }, 3: { cellWidth: 26, halign: 'right' } }
  });
  cursorY = (pdf.lastAutoTable?.finalY || cursorY) + 5;
  const orderTotal = numberValue(order.total_amount);
  const collectTotal = numberValue(order.cod_collect_amount || order.total_amount);
  const collectDifference = roundMoney(collectTotal - orderTotal);
  const summaryHeight = collectDifference ? 16 : 12;
  const policyLines = pdf.splitTextToSize(invoicePolicyText(settings), pageWidth - margin * 2 - 4);
  const policyHeight = Math.max(policyLines.length * 1.55 + 4.5, 9);
  const requiredHeight = summaryHeight + 18 + policyHeight;
  if (cursorY + requiredHeight > pageHeight - margin - 7) { pdf.addPage('a5', 'portrait'); cursorY = margin; }
  const totalsX = pageWidth - margin - 68;
  pdf.setDrawColor(110, 120, 126); pdf.setLineWidth(.2); pdf.line(totalsX, cursorY, pageWidth - margin, cursorY);
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(6.4); pdf.setTextColor(23, 32, 42);
  pdf.text('Order total', totalsX, cursorY + 4); pdf.text(money(orderTotal), pageWidth - margin, cursorY + 4, { align: 'right' });
  let summaryY = cursorY + 4;
  if (collectDifference) {
    summaryY += 4;
    pdf.text('Delivery charge in COD', totalsX, summaryY); pdf.text(money(collectDifference), pageWidth - margin, summaryY, { align: 'right' });
  }
  summaryY += 4.5;
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.6);
  pdf.text('COD TO COLLECT', totalsX, summaryY); pdf.text(money(collectTotal), pageWidth - margin, summaryY, { align: 'right' });
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(5.6); pdf.setTextColor(82, 96, 105);
  pdf.text('Payment will be collected by the courier on delivery.', totalsX, summaryY + 4);

  const signatureY = summaryY + 12;
  const signatureWidth = (pageWidth - margin * 2 - 20) / 2;
  pdf.setDrawColor(85, 92, 98);
  pdf.line(margin + 3, signatureY, margin + 3 + signatureWidth, signatureY);
  pdf.line(pageWidth - margin - 3 - signatureWidth, signatureY, pageWidth - margin - 3, signatureY);
  pdf.setTextColor(23, 32, 42); pdf.setFontSize(5.4);
  pdf.text('Authorized By', margin + 3 + signatureWidth / 2, signatureY + 3, { align: 'center' });
  pdf.text('Customer Signature', pageWidth - margin - 3 - signatureWidth / 2, signatureY + 3, { align: 'center' });
  const policyY = signatureY + 6;
  pdf.setFillColor(247, 248, 249); pdf.setDrawColor(215, 220, 224);
  pdf.rect(margin, policyY, pageWidth - margin * 2, policyHeight, 'FD');
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(4.3); pdf.setTextColor(68, 76, 82);
  pdf.text('STORE POLICIES', margin + 2, policyY + 2.5);
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(4);
  pdf.text(policyLines, margin + 2, policyY + 4.2);

  const pageCount = pdf.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    pdf.setPage(page);
    pdf.setDrawColor(214, 221, 226); pdf.line(margin, pageHeight - margin + 1, pageWidth - margin, pageHeight - margin + 1);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(5.8); pdf.setTextColor(100, 112, 120);
    pdf.text(`${settings.shop_name || 'Computer Shop'} - Page ${page} of ${pageCount}`, pageWidth / 2, pageHeight - margin + 4, { align: 'center' });
  }
  if (options.output === 'blob') return pdf.output('blob');
  pdf.save(`${safePdfFilename(order.document_no)}-COD-Bill.pdf`);
  return null;
}

async function printCodLabels(orders, companySettings = DEFAULT_COMPANY_SETTINGS, options = {}) {
  const popup = options.popup || window.open('', '_blank', 'width=920,height=980');
  if (!popup) { window.alert('Allow pop-ups for this site to print COD labels.'); return; }
  try {
    popup.document.open();
    popup.document.write('<!doctype html><title>Preparing COD labels</title><body style="margin:0;background:#20252a;color:#fff;font-family:Arial;display:grid;place-items:center;height:100vh">Preparing three-per-A5 COD labels...</body>');
    popup.document.close();
    const blob = await createCodLabelsPdf(orders, companySettings, { output: 'blob' });
    showPdfBlobPreview(popup, blob, `COD Labels - ${orders.length} order${orders.length === 1 ? '' : 's'}`, options.autoPrint !== false);
  } catch (printError) {
    popup.document.open();
    popup.document.write(`<!doctype html><title>Print failed</title><body style="font-family:Arial;padding:30px"><h2>Could not prepare COD labels</h2><p>${escapePrintHtml(printError.message || String(printError))}</p></body>`);
    popup.document.close();
  }
}

async function printCodDocument(order, items, mode = 'label', companySettings = DEFAULT_COMPANY_SETTINGS, options = {}) {
  if (!order) return;
  if (mode === 'label') { await printCodLabels([order], companySettings, options); return; }
  const popup = options.popup || window.open('', '_blank', 'width=920,height=980');
  if (!popup) { window.alert('Allow pop-ups for this site to print COD bills.'); return; }
  try {
    popup.document.open();
    popup.document.write('<!doctype html><title>Preparing COD bill</title><body style="margin:0;background:#20252a;color:#fff;font-family:Arial;display:grid;place-items:center;height:100vh">Preparing A5 COD bill...</body>');
    popup.document.close();
    const blob = await createCodBillPdf(order, items, companySettings, { output: 'blob' });
    showPdfBlobPreview(popup, blob, `${order.document_no} - COD Order Bill`, options.autoPrint !== false);
  } catch (printError) {
    popup.document.open();
    popup.document.write(`<!doctype html><title>Print failed</title><body style="font-family:Arial;padding:30px"><h2>Could not prepare COD bill</h2><p>${escapePrintHtml(printError.message || String(printError))}</p></body>`);
    popup.document.close();
  }
}

function openCourierTracking(service) {
  const url = service === 'SLPOST'
    ? 'https://bepost.lk/p/Search/'
    : service === 'Pronto' ? 'https://prontolanka.lk/' : '';
  if (!url) {
    window.alert('Select SLPOST or Pronto first.');
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

function CodOrderForm({ document = null, tabId = '', onClose, onSaved, onNumberReady }) {
  const isEditing = Boolean(document?.id);
  const savedDraft = tabId ? safeReadJson(documentDraftKey(tabId), null) : null;
  const useDraft = savedDraft?.documentType === 'cod_order' && (!isEditing || savedDraft.editDocumentId === document?.id);
  const initial = useDraft ? savedDraft : {};
  const [documentNo, setDocumentNo] = useState(initial.documentNo || document?.document_no || '');
  const [documentDate, setDocumentDate] = useState(initial.documentDate || (document?.document_date || document?.created_at || '').slice(0, 10) || todayInputDate());
  const [orderSource, setOrderSource] = useState(initial.orderSource || document?.order_source || 'WhatsApp');
  const [orderTakenBy, setOrderTakenBy] = useState(initial.orderTakenBy || document?.order_taken_by || '');
  const [recipientName, setRecipientName] = useState(initial.recipientName || document?.recipient_name || '');
  const [deliveryPhone, setDeliveryPhone] = useState(initial.deliveryPhone || document?.delivery_phone || '');
  const [deliveryAddress, setDeliveryAddress] = useState(initial.deliveryAddress || document?.delivery_address || '');
  const [deliveryService, setDeliveryService] = useState(initial.deliveryService || document?.delivery_service || '');
  const [trackingNumber, setTrackingNumber] = useState(initial.trackingNumber || document?.tracking_number || '');
  const [deliveryCharge, setDeliveryCharge] = useState(initial.deliveryCharge ?? document?.delivery_charge ?? 0);
  const [deliveryFeeMode, setDeliveryFeeMode] = useState(initial.deliveryFeeMode || document?.delivery_fee_mode || 'deduct_on_settlement');
  const [codCollectAmount, setCodCollectAmount] = useState(initial.codCollectAmount ?? document?.cod_collect_amount ?? '');
  const [notes, setNotes] = useState(initial.notes || document?.notes || '');
  const [lines, setLines] = useState(useDraft && Array.isArray(initial.lines) && initial.lines.length ? initial.lines : []);
  const [staff, setStaff] = useState([]);
  const [productSearch, setProductSearch] = useState('');
  const [products, setProducts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stockMessage, setStockMessage] = useState('');

  const total = lines.reduce((sum, line) => sum + codLineTotal(line), 0);

  useEffect(() => {
    loadCodSupport();
    if (isEditing && !lines.length) loadCodItems();
    if (documentNo) onNumberReady?.(documentNo);
  }, []);

  useEffect(() => {
    const timeout = setTimeout(() => loadCodProducts(), 180);
    return () => clearTimeout(timeout);
  }, [productSearch]);

  useEffect(() => {
    if (!tabId) return;
    window.localStorage.setItem(documentDraftKey(tabId), JSON.stringify({
      documentType: 'cod_order', editDocumentId: document?.id || '', documentNo, documentDate,
      orderSource, orderTakenBy, recipientName, deliveryPhone, deliveryAddress, deliveryService,
      trackingNumber, deliveryCharge, deliveryFeeMode, codCollectAmount, notes, lines
    }));
  }, [tabId, document?.id, documentNo, documentDate, orderSource, orderTakenBy, recipientName, deliveryPhone, deliveryAddress, deliveryService, trackingNumber, deliveryCharge, deliveryFeeMode, codCollectAmount, notes, lines]);

  useEffect(() => {
    const nextCollectAmount = deliveryFeeMode === 'paid_on_handover'
      ? total + numberValue(deliveryCharge)
      : total;
    setCodCollectAmount(nextCollectAmount);
  }, [total, deliveryCharge, deliveryFeeMode]);

  async function loadCodSupport() {
    const [staffRes, userRes] = await Promise.all([
      supabase.from('staff_directory_v38').select('id, auth_user_id, full_name, role').eq('is_active', true).order('full_name'),
      supabase.auth.getUser()
    ]);
    if (staffRes.error) setError(staffRes.error.message);
    else {
      const rows = staffRes.data || [];
      setStaff(rows);
      if (!orderTakenBy) {
        const current = rows.find((row) => row.auth_user_id === userRes.data?.user?.id);
        if (current) setOrderTakenBy(current.id);
      }
    }
  }

  async function loadCodProducts() {
    let query = supabase.from('product_stock_view').select('*').eq('is_active', true).order('item_code').limit(60);
    const clean = productSearch.trim().replace(/,/g, ' ');
    if (clean) query = query.or(`item_code.ilike.%${clean}%,name.ilike.%${clean}%,barcode.ilike.%${clean}%`);
    const { data, error: productError } = await query;
    if (productError) setError(productError.message);
    else setProducts(data || []);
  }

  async function loadCodItems() {
    const { data, error: itemError } = await supabase.from('document_items').select('*').eq('document_id', document.id).order('created_at');
    if (itemError) setError(itemError.message);
    else {
      const loaded = data || [];
      const productIds = [...new Set(loaded.map((item) => item.product_id).filter(Boolean))];
      const stockRes = productIds.length
        ? await supabase.from('product_stock_view').select('product_id, available_qty, track_inventory').in('product_id', productIds)
        : { data: [], error: null };
      if (stockRes.error) {
        setError(stockRes.error.message);
        return;
      }
      const stockMap = new Map((stockRes.data || []).map((row) => [row.product_id, row]));
      setLines(loaded.map((item) => {
        const stock = stockMap.get(item.product_id);
        const trackInventory = stock?.track_inventory !== false;
        return {
          ...item,
          id: item.id || createClientId(),
          track_inventory: trackInventory,
          max_available_qty: trackInventory ? numberValue(stock?.available_qty) + (document?.cod_stock_reserved ? numberValue(item.qty) : 0) : null
        };
      }));
    }
  }

  function addCodProduct(product) {
    const trackInventory = product.track_inventory !== false;
    const availableQty = Math.max(numberValue(product.available_qty), 0);
    if (trackInventory && availableQty <= 0) {
      setStockMessage(`${product.item_code || product.name} has no available stock.`);
      return;
    }
    setLines((current) => {
      const existing = current.find((line) => line.product_id === product.product_id);
      if (existing) {
        if (existing.track_inventory === false) {
          return current.map((line) => line.id === existing.id ? { ...line, qty: numberValue(line.qty) + 1 } : line);
        }
        const maxQty = numberValue(existing.max_available_qty, availableQty);
        const nextQty = Math.min(numberValue(existing.qty) + 1, maxQty);
        if (nextQty === numberValue(existing.qty)) setStockMessage(`${product.item_code || product.name}: maximum available quantity is ${maxQty}.`);
        return current.map((line) => line.id === existing.id ? { ...line, qty: nextQty } : line);
      }
      return [...current, {
        ...emptyCodLine(),
        product_id: product.product_id,
        item_code: product.item_code || '',
        description: product.name || '',
        unit_price: numberValue(product.selling_price),
        unit_cost: numberValue(product.avg_cost),
        track_inventory: trackInventory,
        max_available_qty: trackInventory ? availableQty : null,
        line_total: numberValue(product.selling_price)
      }];
    });
  }

  function updateCodLine(lineId, patch) {
    setLines((current) => current.map((line) => {
      if (line.id !== lineId) return line;
      if (line.track_inventory !== false && Object.prototype.hasOwnProperty.call(patch, 'qty')) {
        const maxQty = numberValue(line.max_available_qty, numberValue(line.qty));
        if (numberValue(patch.qty) > maxQty) {
          setStockMessage(`${line.item_code || line.description}: quantity limited to available stock (${maxQty}).`);
          return { ...line, ...patch, qty: maxQty };
        }
      }
      return { ...line, ...patch };
    }));
  }

  async function saveCodOrder(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const validLines = lines.filter((line) => line.product_id && numberValue(line.qty) > 0);
    if (!validLines.length) {
      setError('Add at least one product to the COD order.');
      setBusy(false);
      return;
    }
    const header = {
      document_no: documentNo.trim(), document_date: documentDate, order_source: orderSource,
      order_taken_by: orderTakenBy, recipient_name: recipientName, delivery_phone: deliveryPhone,
      delivery_address: deliveryAddress, delivery_service: deliveryService, tracking_number: trackingNumber,
      delivery_charge: numberValue(deliveryCharge), delivery_fee_mode: deliveryFeeMode,
      cod_collect_amount: codCollectAmount === '' ? total : numberValue(codCollectAmount), notes
    };
    const itemPayload = validLines.map((line) => ({
      product_id: line.product_id, item_code: line.item_code, description: line.description,
      qty: numberValue(line.qty), unit_price: numberValue(line.unit_price), unit_cost: numberValue(line.unit_cost),
      discount_type: numberValue(line.discount_value) ? line.discount_type : 'none',
      discount_value: numberValue(line.discount_value), line_total: codLineTotal(line)
    }));
    const rpcName = isEditing ? 'replace_cod_order_v24' : 'save_cod_order_v24';
    const args = isEditing
      ? { p_document_id: document.id, p_header: header, p_items: itemPayload }
      : { p_header: header, p_items: itemPayload };
    const { data, error: saveError } = await supabase.rpc(rpcName, args);
    setBusy(false);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    if (tabId) window.localStorage.removeItem(documentDraftKey(tabId));
    onNumberReady?.(data?.document_no || documentNo);
    onSaved?.(data);
  }

  return (
    <div className="document-form-panel cod-order-form">
      <div className="section-title-row cod-form-title-row">
        <div>
          <h3>{isEditing ? `Edit COD Order ${documentNo}` : 'New COD Order'}</h3>
          <p>Saving reserves stock only. It does not create a sale or cashflow until payment is received.</p>
        </div>
        <button type="button" className="secondary-button" onClick={onClose}>Close</button>
      </div>
      {error && <div className="error-box">{error}</div>}
      {stockMessage && <div className="notice stock-limit-notice">{stockMessage}</div>}
      <form onSubmit={saveCodOrder}>
        <div className="purchase-form-grid cod-header-grid">
          <label>Order number<input value={documentNo} placeholder="Assigned on save" onChange={(e) => setDocumentNo(e.target.value)} /></label>
          <label>Order date<input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} /></label>
          <label>Order source<select value={orderSource} onChange={(e) => setOrderSource(e.target.value)}><option>WhatsApp</option><option>Phone call</option><option>Facebook</option><option>Website</option><option>Other</option></select></label>
          <label>Order taken by<select value={orderTakenBy} onChange={(e) => setOrderTakenBy(e.target.value)}><option value="">Not selected</option>{staff.map((row) => <option key={row.id} value={row.id}>{row.full_name}</option>)}</select></label>
          <label>Customer / recipient<input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} required /></label>
          <label>Contact number<input value={deliveryPhone} onChange={(e) => setDeliveryPhone(e.target.value)} required /></label>
          <label className="wide-field">Delivery address<textarea value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)} required /></label>
          <label>Delivery service<select value={deliveryService} onChange={(e) => setDeliveryService(e.target.value)}><option value="">Select later</option><option value="SLPOST">SLPOST</option><option value="Pronto">Pronto</option></select></label>
          <label>Tracking number<input value={trackingNumber} placeholder="Add after dispatch" onChange={(e) => setTrackingNumber(e.target.value)} /></label>
          <label>Courier delivery charge<input type="number" step="0.01" value={deliveryCharge} onChange={(e) => setDeliveryCharge(e.target.value)} /></label>
          <label>Delivery fee handling<select value={deliveryFeeMode} onChange={(e) => setDeliveryFeeMode(e.target.value)}><option value="deduct_on_settlement">Deduct when COD settles</option><option value="paid_on_handover">Pay when handed to courier</option></select></label>
          <label>COD amount to collect<input type="number" step="0.01" value={codCollectAmount} readOnly /><small>{deliveryFeeMode === 'paid_on_handover' ? 'Order total + courier charge' : 'Order total; courier charge is deducted at settlement'}</small></label>
          <label className="wide-field">Notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        </div>

        <div className="cod-product-picker panel-card">
          <input value={productSearch} onChange={(e) => setProductSearch(e.target.value)} placeholder="Search product code, name, or barcode" />
          <div className="cod-product-results">
            {products.map((product) => { const trackInventory = product.track_inventory !== false; return <button type="button" key={product.product_id} className={!trackInventory ? 'non-stock-result' : ''} disabled={trackInventory && numberValue(product.available_qty) <= 0} onClick={() => addCodProduct(product)}><strong>{product.item_code}</strong><span>{product.name}</span><small>{money(product.selling_price)} | {trackInventory ? `Available: ${numberValue(product.available_qty)}` : 'Non-stock · Always available'}</small></button>; })}
          </div>
        </div>

        <div className="table-wrap cod-lines-table">
          <table>
            <thead><tr><th>Code</th><th>Product</th><th>Qty</th><th>Price</th><th>Discount</th><th>Type</th><th>Total</th><th></th></tr></thead>
            <tbody>
              {lines.map((line) => <tr key={line.id}>
                <td>{line.item_code}</td><td>{line.description}</td>
                <td><input type="number" min="0.001" max={line.track_inventory === false ? undefined : line.max_available_qty || undefined} step="0.001" value={line.qty} onChange={(e) => updateCodLine(line.id, { qty: e.target.value })} /><small>{line.track_inventory === false ? 'No stock limit' : `Max ${numberValue(line.max_available_qty, line.qty)}`}</small></td>
                <td><input type="number" step="0.01" value={line.unit_price} onChange={(e) => updateCodLine(line.id, { unit_price: e.target.value })} /></td>
                <td><input type="number" step="0.01" value={line.discount_value || 0} onChange={(e) => updateCodLine(line.id, { discount_value: e.target.value })} /></td>
                <td><select value={line.discount_type || 'none'} onChange={(e) => updateCodLine(line.id, { discount_type: e.target.value })}><option value="none">None</option><option value="amount">Amount</option><option value="percent">Percent</option></select></td>
                <td>{money(codLineTotal(line))}</td>
                <td><button type="button" className="link-button" onClick={() => setLines((current) => current.filter((item) => item.id !== line.id))}>Remove</button></td>
              </tr>)}
              {!lines.length && <EmptyRow colSpan={8} text="Add products to this COD order." />}
            </tbody>
          </table>
        </div>
        <div className="cod-form-footer"><strong>Order total: {money(total)}</strong><strong>COD to collect: {money(codCollectAmount === '' ? total : codCollectAmount)}</strong><button className="primary-button" disabled={busy}>{busy ? 'Saving...' : isEditing ? 'Save COD Changes' : 'Save COD Order'}</button></div>
      </form>
    </div>
  );
}

function CodOrdersPage() {
  const [orders, setOrders] = useState([]);
  const [selected, setSelected] = useState(null);
  const [items, setItems] = useState([]);
  const [companySettings, setCompanySettings] = useState(DEFAULT_COMPANY_SETTINGS);
  const [staff, setStaff] = useState([]);
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [filters, setFilters] = useState({ search: '', status: 'active' });
  const [labelSelection, setLabelSelection] = useState([]);
  const [formMode, setFormMode] = useState('');
  const [action, setAction] = useState({ tracking: '', service: '', paymentMethodId: '', feePaidNow: 0, receivedAmount: 0, returnReason: '', returnFee: 0 });
  const [busy, setBusy] = useState(false);
  const [checkingTracking, setCheckingTracking] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    loadCodOrders();
    loadCodLookups();
    fetchCompanySettings().then(setCompanySettings).catch(() => {});
  }, []);

  useRealtimeRefresh(['documents', 'document_items', 'stock_balances'], () => {
    loadCodOrders();
    if (selected?.id) loadSelectedCodItems(selected.id);
  });
  useRealtimeRefresh(['payment_methods'], loadCodLookups);
  useRealtimeRefresh(['company_settings'], () => fetchCompanySettings().then(setCompanySettings).catch(() => {}));

  async function loadCodLookups() {
    const [staffRes, paymentRes] = await Promise.all([
      supabase.from('staff_directory_v38').select('id, full_name').eq('is_active', true).order('full_name'),
      supabase.from('payment_methods').select('id, name, is_paid_method, affects_cashflow').eq('is_active', true).eq('is_paid_method', true).eq('affects_cashflow', true).order('name')
    ]);
    if (!staffRes.error) setStaff(staffRes.data || []);
    if (!paymentRes.error) {
      setPaymentMethods(paymentRes.data || []);
      if (paymentRes.data?.[0]) setAction((current) => ({ ...current, paymentMethodId: current.paymentMethodId || paymentRes.data[0].id }));
    }
  }

  async function loadCodOrders() {
    setError('');
    const { data, error: loadError } = await supabase.from('documents')
      .select('id, document_no, document_type, status, total_amount, paid_amount, balance_amount, document_date, created_at, linked_document_id, payment_method_id, notes, order_source, order_taken_by, recipient_name, delivery_phone, delivery_address, delivery_service, tracking_number, delivery_charge, delivery_charge_paid, delivery_fee_mode, cod_collect_amount, cod_received_amount, cod_stock_reserved, dispatched_at, delivered_at, settled_at, returned_at, return_reason, courier_status, courier_status_checked_at, courier_tracking_data')
      .eq('document_type', 'cod_order').order('created_at', { ascending: false }).limit(500);
    if (loadError) setError(loadError.message);
    else {
      setOrders(data || []);
      setSelected((current) => current ? (data || []).find((row) => row.id === current.id) || null : null);
      setLabelSelection((current) => current.filter((id) => (data || []).some((row) => row.id === id)));
    }
  }

  async function selectCodOrder(order) {
    setSelected(order);
    setMessage('');
    setError('');
    const remainingFee = Math.max(numberValue(order.delivery_charge) - numberValue(order.delivery_charge_paid), 0);
    setAction((current) => ({
      ...current,
      tracking: order.tracking_number || '',
      service: order.delivery_service || '',
      feePaidNow: order.delivery_fee_mode === 'paid_on_handover' ? remainingFee : 0,
      receivedAmount: Math.max(numberValue(order.cod_collect_amount || order.total_amount) - remainingFee, 0),
      returnReason: '',
      returnFee: numberValue(order.delivery_charge)
    }));
    await loadSelectedCodItems(order.id);
  }

  async function loadSelectedCodItems(documentId) {
    const { data, error: itemError } = await supabase.from('document_items').select('*').eq('document_id', documentId).order('created_at');
    if (itemError) setError(itemError.message); else setItems(data || []);
  }

  async function runStatus(status) {
    if (!selected) return;
    if (status === 'cancelled' && !window.confirm(`Cancel ${selected.document_no} and release its reserved stock?`)) return;
    setBusy(true); setError(''); setMessage('');
    const feeNow = status === 'dispatched' ? numberValue(action.feePaidNow) : 0;
    const { error: statusError } = await supabase.rpc('update_cod_order_status_v24', {
      p_document_id: selected.id, p_status: status, p_tracking_number: action.tracking || null,
      p_delivery_service: action.service || null, p_payment_method_id: feeNow > 0 ? action.paymentMethodId : null,
      p_delivery_fee_paid_now: feeNow
    });
    setBusy(false);
    if (statusError) setError(statusError.message);
    else {
      if (feeNow > 0) setAction((current) => ({ ...current, feePaidNow: 0, receivedAmount: numberValue(current.receivedAmount) + feeNow }));
      setMessage(`${selected.document_no}: ${codStatusLabel(status)}.`);
      await loadCodOrders();
    }
  }

  async function settleOrder() {
    if (!selected || !window.confirm(`Mark payment received and convert ${selected.document_no} to a sales invoice?`)) return;
    setBusy(true); setError(''); setMessage('');
    const { data, error: settleError } = await supabase.rpc('settle_cod_order_v24', {
      p_document_id: selected.id, p_payment_method_id: action.paymentMethodId,
      p_amount_received: numberValue(action.receivedAmount), p_notes: null
    });
    setBusy(false);
    if (settleError) setError(settleError.message);
    else { setMessage(`Payment received. Sales invoice ${data?.invoice_no || ''} created.`); await loadCodOrders(); }
  }

  async function returnOrder() {
    if (!selected || !window.confirm(`Mark ${selected.document_no} returned and release its reserved stock?`)) return;
    setBusy(true); setError(''); setMessage('');
    const remainingFee = Math.max(numberValue(action.returnFee) - numberValue(selected.delivery_charge_paid), 0);
    const { error: returnError } = await supabase.rpc('return_cod_order_v24', {
      p_document_id: selected.id, p_return_reason: action.returnReason || null,
      p_payment_method_id: remainingFee > 0 ? action.paymentMethodId : null,
      p_delivery_fee_charge: numberValue(action.returnFee)
    });
    setBusy(false);
    if (returnError) setError(returnError.message);
    else { setMessage(`${selected.document_no} marked returned. Stock reservation released.`); await loadCodOrders(); }
  }

  async function deleteCodOrder() {
    if (!selected) return;
    if (!window.confirm(`Permanently delete ${selected.document_no}? Reserved stock will be released. This cannot be undone.`)) return;
    setBusy(true); setError(''); setMessage('');
    const deletedNo = selected.document_no;
    const { error: deleteError } = await supabase.rpc('delete_cod_order_v33', { p_document_id: selected.id });
    setBusy(false);
    if (deleteError) {
      setError(`${deleteError.message}. If the function is missing, run 033_inventory_documents_cod_delete.sql in Supabase.`);
      return;
    }
    setSelected(null);
    setItems([]);
    setMessage(`${deletedNo} deleted and its reserved stock released.`);
    await loadCodOrders();
  }

  async function checkCourierStatus() {
    if (!selected) return;
    const service = String(action.service || selected.delivery_service || '').trim().toUpperCase();
    const trackingNumber = String(action.tracking || selected.tracking_number || '').trim().toUpperCase();
    if (service !== 'SLPOST') { setError('Automatic tracking is currently available only for SLPOST.'); return; }
    if (!trackingNumber) { setError('Add the SLPOST tracking number first.'); return; }

    setCheckingTracking(true); setError(''); setMessage('');
    try {
      const { data, error: trackingError } = await supabase.functions.invoke('track-slpost', {
        body: { trackingNumber }
      });
      if (trackingError) {
        let functionMessage = '';
        try {
          const details = await trackingError.context?.json();
          functionMessage = details?.error || '';
        } catch {
          functionMessage = '';
        }
        throw new Error(functionMessage || trackingError.message);
      }
      if (!data?.status) throw new Error(data?.error || 'SLPOST did not return a tracking status.');

      const { data: recorded, error: recordError } = await supabase.rpc('record_cod_tracking_v25', {
        p_document_id: selected.id,
        p_tracking_number: trackingNumber,
        p_courier_status: data.status,
        p_tracking_payload: data
      });
      if (recordError) throw recordError;

      setAction((current) => ({ ...current, tracking: trackingNumber, service: 'SLPOST' }));
      setMessage(`SLPOST status: ${data.status}.${recorded?.workflow_status === 'awaiting_settlement' ? ' Order moved to Awaiting Payment.' : ''}`);
      await loadCodOrders();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setCheckingTracking(false);
    }
  }

  const activeStatuses = ['awaiting_packing', 'packed', 'dispatched', 'awaiting_settlement'];
  const filtered = orders.filter((order) => {
    if (filters.status === 'active' && !activeStatuses.includes(order.status)) return false;
    if (filters.status !== 'all' && filters.status !== 'active' && order.status !== filters.status) return false;
    const clean = filters.search.trim().toLowerCase();
    if (clean && !`${order.document_no} ${order.recipient_name} ${order.delivery_phone} ${order.delivery_address} ${order.delivery_service} ${order.tracking_number}`.toLowerCase().includes(clean)) return false;
    return true;
  });
  const pendingLabelOrders = filtered.filter((order) => ['awaiting_packing', 'packed'].includes(order.status));
  const selectedLabelOrders = orders.filter((order) => labelSelection.includes(order.id));
  function toggleLabelOrder(orderId) {
    setLabelSelection((current) => current.includes(orderId) ? current.filter((id) => id !== orderId) : [...current, orderId]);
  }
  function selectPendingLabels() {
    const ids = pendingLabelOrders.map((order) => order.id);
    setLabelSelection(ids);
    if (!ids.length) setMessage('No awaiting-packing or packed orders match the current filters.');
  }
  function printSelectedLabels() {
    if (!selectedLabelOrders.length) { setError('Select at least one COD order to print labels.'); return; }
    setError('');
    printCodLabels(selectedLabelOrders, companySettings);
  }
  const staffMap = new Map(staff.map((row) => [row.id, row.full_name]));
  const canAct = selected && !['converted', 'returned', 'cancelled'].includes(selected.status);
  const nextStatusAction = selected ? {
    awaiting_packing: { status: 'packed', label: 'Mark Packed' },
    packed: { status: 'dispatched', label: 'Mark Dispatched' },
    dispatched: { status: 'awaiting_settlement', label: 'Mark Delivered / Awaiting Payment' }
  }[selected.status] : null;
  const canSettle = selected?.status === 'awaiting_settlement';
  const canReturn = ['dispatched', 'awaiting_settlement'].includes(selected?.status);
  const canCancel = ['awaiting_packing', 'packed'].includes(selected?.status);
  const canDelete = selected && ['awaiting_packing', 'packed', 'cancelled'].includes(selected.status) && !selected.linked_document_id && numberValue(selected.delivery_charge_paid) === 0;

  if (formMode) return <section className="page-section"><CodOrderForm document={formMode === 'edit' ? selected : null} onClose={() => setFormMode('')} onSaved={async () => { setFormMode(''); await loadCodOrders(); setMessage('COD order saved and stock reserved.'); }} /></section>;

  return (
    <section className="page-section cod-orders-page">
      <div className="section-title-row"><div><h3>COD Order Queue</h3><p>Remote order entry, packing, dispatch, courier settlement, returns, labels, and bills.</p></div><button className="primary-button" onClick={() => setFormMode('new')}>+ New COD Order</button></div>
      {message && <div className="notice">{message}</div>}{error && <div className="error-box">{error}</div>}
      <div className="cod-queue-stats"><StatCard label="Awaiting packing" value={orders.filter((row) => row.status === 'awaiting_packing').length} /><StatCard label="Packed" value={orders.filter((row) => row.status === 'packed').length} /><StatCard label="Dispatched" value={orders.filter((row) => row.status === 'dispatched').length} /><StatCard label="Awaiting payment" value={orders.filter((row) => row.status === 'awaiting_settlement').length} /></div>
      <div className="panel-card cod-filter-row"><input value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} placeholder="Search order, customer, phone, address, courier, tracking" /><select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}><option value="active">All active orders</option><option value="all">All orders</option><option value="awaiting_packing">Awaiting packing</option><option value="packed">Packed</option><option value="dispatched">Dispatched</option><option value="awaiting_settlement">Awaiting payment</option><option value="converted">Paid / Converted</option><option value="returned">Returned</option><option value="cancelled">Cancelled</option></select><button className="secondary-button" onClick={loadCodOrders}>Refresh</button></div>
      <div className="panel-card cod-label-batch-bar"><div><strong>Batch COD labels</strong><span>Three labels are arranged from top to bottom on each A5 sheet.</span></div><div><button className="secondary-button" onClick={selectPendingLabels}>Select Pending</button><button className="secondary-button" disabled={!labelSelection.length} onClick={() => setLabelSelection([])}>Clear</button><button className="primary-button" disabled={!labelSelection.length} onClick={printSelectedLabels}>Print Selected ({labelSelection.length})</button></div></div>
      <div className="cod-queue-layout">
        <div className="panel-card table-wrap"><table><thead><tr><th className="cod-label-select-column">Label</th><th>Order</th><th>Status</th><th>Customer</th><th>Phone</th><th>Source</th><th>Order taker</th><th>Courier</th><th>Tracking</th><th>Courier status</th><th>COD</th></tr></thead><tbody>{filtered.map((order) => <tr key={order.id} className={selected?.id === order.id ? 'selected-row' : ''} onClick={() => selectCodOrder(order)}><td className="cod-label-select-column"><input type="checkbox" aria-label={`Select label ${order.document_no}`} checked={labelSelection.includes(order.id)} onClick={(event) => event.stopPropagation()} onChange={() => toggleLabelOrder(order.id)} /></td><td>{order.document_no}</td><td>{codStatusLabel(order.status)}</td><td>{order.recipient_name}</td><td>{order.delivery_phone}</td><td>{order.order_source || '-'}</td><td>{staffMap.get(order.order_taken_by) || '-'}</td><td>{order.delivery_service || '-'}</td><td>{order.tracking_number || '-'}</td><td>{order.courier_status || '-'}</td><td>{money(order.cod_collect_amount || order.total_amount)}</td></tr>)}{!filtered.length && <EmptyRow colSpan={11} text="No COD orders match this filter." />}</tbody></table></div>
        <section className="panel-card cod-action-panel">
          {!selected && <div className="muted-box">Select an order to view items and actions.</div>}
          {selected && <>
            <div className="cod-selected-header"><div><h3>{selected.document_no}</h3><strong>{selected.recipient_name}</strong><span>{selected.delivery_phone}</span><p>{selected.delivery_address}</p></div><div className="cod-selected-summary"><span>Order status</span><strong>{codStatusLabel(selected.status)}</strong><span>COD amount</span><strong>{money(selected.cod_collect_amount || selected.total_amount)}</strong></div></div>
            <div className="cod-action-buttons">
              <button className="secondary-button" onClick={() => printCodDocument(selected, items, 'label', companySettings)}>Print Label</button>
              <button className="secondary-button" onClick={() => printCodDocument(selected, items, 'bill', companySettings)}>Print Bill</button>
              <button className="secondary-button" onClick={() => openCourierTracking(action.service || selected.delivery_service)}>Open Tracking</button>
              <button className="secondary-button" disabled={!canAct} onClick={() => setFormMode('edit')}>Edit Order</button>
              {(canCancel || canDelete) && <span className="cod-action-spacer" aria-hidden="true" />}
              {canCancel && <button className="secondary-button cod-cancel-action" disabled={busy} onClick={() => runStatus('cancelled')}>Cancel Order</button>}
              {canDelete && <button className="danger-button cod-delete-action" disabled={busy} onClick={deleteCodOrder}>Delete Order</button>}
            </div>
            <div className="cod-selected-items"><h4>Items in this order</h4><div className="table-wrap"><table><thead><tr><th>Code</th><th>Item</th><th>Qty</th><th>Unit price</th><th>Total</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{item.item_code}</td><td>{item.description}</td><td>{Number(item.qty)}</td><td>{money(item.unit_price)}</td><td>{money(numberValue(item.qty) * numberValue(item.unit_price))}</td></tr>)}{!items.length && <EmptyRow colSpan={5} text="No items found for this order." />}</tbody></table></div></div>
            {canAct && <div className="cod-action-fields">
              <div className="cod-operational-grid"><label>Delivery service<select value={action.service} onChange={(e) => setAction({ ...action, service: e.target.value })}><option value="">Select later</option><option value="SLPOST">SLPOST</option><option value="Pronto">Pronto</option></select></label><label>Tracking number <InfoTip text="Add this after dispatch when the courier assigns the tracking number." /><input value={action.tracking} onChange={(e) => setAction({ ...action, tracking: e.target.value })} /></label><label>Payment method<select value={action.paymentMethodId} onChange={(e) => setAction({ ...action, paymentMethodId: e.target.value })}>{paymentMethods.map((method) => <option key={method.id} value={method.id}>{method.name}</option>)}</select></label><label>Delivery fee paid at handover <InfoTip text="Enter only the delivery fee paid when the parcel is handed to the courier. Fees deducted later are handled during settlement or return." /><input type="number" step="0.01" disabled={selected.status !== 'packed'} value={action.feePaidNow} onChange={(e) => setAction({ ...action, feePaidNow: e.target.value })} /></label></div>
              <div className="cod-tracking-result"><div><span>Latest courier status <InfoTip text="SLPOST can be checked manually here. Scheduled checks update dispatched orders automatically after the tracking number is saved." /></span><strong>{selected.courier_status || 'Not checked'}</strong>{selected.courier_status_checked_at && <small>Checked {new Date(selected.courier_status_checked_at).toLocaleString()}</small>}</div><button className="secondary-button" disabled={checkingTracking || String(action.service || '').toUpperCase() !== 'SLPOST' || !String(action.tracking || '').trim()} onClick={checkCourierStatus}>{checkingTracking ? 'Checking...' : 'Check SLPOST Status'}</button></div>
              {selected.courier_tracking_data && <div className="cod-tracking-details"><div><span>Accepting office</span><strong>{selected.courier_tracking_data.acceptingPostOffice || '-'}</strong></div><div><span>Accepted</span><strong>{selected.courier_tracking_data.acceptedAt || '-'}</strong></div><div><span>Delivery office</span><strong>{selected.courier_tracking_data.deliveryPostOffice || '-'}</strong></div><div><span>Received</span><strong>{selected.courier_tracking_data.receivedAt || '-'}</strong></div>{(selected.courier_tracking_data.settledPostOffice || selected.courier_tracking_data.settledAt) && <><div><span>Settled office</span><strong>{selected.courier_tracking_data.settledPostOffice || '-'}</strong></div><div><span>Settled</span><strong>{selected.courier_tracking_data.settledAt || '-'}</strong></div></>}</div>}
              {nextStatusAction && <div className="cod-status-buttons"><button disabled={busy} onClick={() => runStatus(nextStatusAction.status)}>{nextStatusAction.label}</button></div>}
              {canSettle && <div className="cod-settle-box"><strong>Courier settlement</strong><label>Net amount received<input type="number" step="0.01" value={action.receivedAmount} onChange={(e) => setAction({ ...action, receivedAmount: e.target.value })} /></label><small>Expected net: COD amount minus any unpaid delivery charge.</small><button className="primary-button" disabled={busy} onClick={settleOrder}>Payment Received - Create Sale</button></div>}
              {canReturn && <div className="cod-return-box"><strong>Returned order</strong><label>Return delivery charge <InfoTip text="This courier charge is recorded as cash out when the returned parcel is marked." /><input type="number" step="0.01" value={action.returnFee} onChange={(e) => setAction({ ...action, returnFee: e.target.value })} /></label><label>Return reason<textarea value={action.returnReason} onChange={(e) => setAction({ ...action, returnReason: e.target.value })} /></label><button className="danger-button" disabled={busy} onClick={returnOrder}>Mark Returned</button></div>}
            </div>}
            {!canAct && <div className="notice">{codStatusLabel(selected.status)}{selected.linked_document_id ? ' - linked sales invoice created.' : ''}</div>}
          </>}
        </section>
      </div>
    </section>
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
    warranty_months: 0,
    serial_required: false,
    track_inventory: true,
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

function emptyAssemblyForm() {
  return { assembly_code: '', name: '', barcode: '', discount_type: 'percent', discount_value: 0, is_active: true, items: [] };
}

function AssembliesManager() {
  const [assemblies, setAssemblies] = useState([]);
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState('');
  const [componentSearch, setComponentSearch] = useState('');
  const [editingAssembly, setEditingAssembly] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyAssemblyForm());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { loadAssemblies(); loadAssemblyProducts(); }, []);
  useRealtimeRefresh(['product_assemblies', 'product_assembly_items'], loadAssemblies);
  useRealtimeRefresh(['products', 'stock_balances'], loadAssemblyProducts);

  async function loadAssemblies() {
    setError('');
    const { data, error: loadError } = await supabase.from('product_assembly_pos_view').select('*').order('assembly_code');
    if (loadError) setError(loadError.message); else setAssemblies(data || []);
  }

  async function loadAssemblyProducts() {
    const { data, error: loadError } = await supabase.from('product_stock_view').select('*').eq('is_active', true).eq('track_inventory', true).order('item_code').limit(2000);
    if (loadError) setError(loadError.message); else setProducts(data || []);
  }

  async function openNewAssembly() {
    setEditingAssembly(null); setForm(emptyAssemblyForm()); setComponentSearch(''); setMessage(''); setError('');
    setShowForm(true);
  }

  function openEditAssembly(assembly) {
    setEditingAssembly(assembly);
    setForm({
      assembly_code: assembly.assembly_code || '', name: assembly.name || '', barcode: assembly.barcode || '',
      discount_type: assembly.discount_type || 'percent', discount_value: numberValue(assembly.discount_value), is_active: assembly.is_active !== false,
      items: (assembly.components || []).map((item, index) => ({ ...item, qty: numberValue(item.qty, 1), sort_order: index }))
    });
    setComponentSearch(''); setMessage(''); setError(''); setShowForm(true);
  }

  function addAssemblyComponent(product) {
    if (form.items.some((item) => item.product_id === product.product_id)) { setMessage(`${product.item_code} is already in this assembly.`); return; }
    setForm((current) => ({ ...current, items: [...current.items, {
      product_id: product.product_id, item_code: product.item_code, name: product.name, qty: 1,
      selling_price: numberValue(product.selling_price), avg_cost: numberValue(product.avg_cost),
      available_qty: numberValue(product.available_qty), sort_order: current.items.length
    }] }));
  }

  function updateAssemblyComponent(productId, patch) {
    setForm((current) => ({ ...current, items: current.items.map((item) => item.product_id === productId ? { ...item, ...patch } : item) }));
  }

  function removeAssemblyComponent(productId) {
    setForm((current) => ({ ...current, items: current.items.filter((item) => item.product_id !== productId) }));
  }

  async function saveAssembly(event) {
    event.preventDefault();
    if (!form.items.length) { setError('Add at least one component.'); return; }
    if (form.items.some((item) => numberValue(item.qty) <= 0)) { setError('Every component quantity must be greater than zero.'); return; }
    setBusy(true); setError(''); setMessage('');
    const { data: saved, error: saveError } = await supabase.rpc('save_product_assembly_v28', {
      p_assembly_id: editingAssembly?.id || null,
      p_header: { assembly_code: form.assembly_code.trim(), name: form.name.trim(), barcode: form.barcode.trim(), discount_type: form.discount_type, discount_value: numberValue(form.discount_value), is_active: form.is_active },
      p_items: form.items.map((item, index) => ({ product_id: item.product_id, qty: numberValue(item.qty), sort_order: index }))
    });
    setBusy(false);
    if (saveError) { setError(saveError.message); return; }
    setMessage(editingAssembly ? 'Assembly updated.' : `Assembly created: ${saved?.assembly_code || ''}.`);
    setShowForm(false); setEditingAssembly(null); setForm(emptyAssemblyForm()); await loadAssemblies();
  }

  async function toggleAssembly(assembly) {
    const nextActive = !assembly.is_active;
    const { error: updateError } = await supabase.from('product_assemblies').update({ is_active: nextActive, updated_at: new Date().toISOString() }).eq('id', assembly.id);
    if (updateError) setError(updateError.message); else { setMessage(`${assembly.name} is now ${nextActive ? 'active' : 'inactive'}.`); await loadAssemblies(); }
  }

  const cleanSearch = search.trim().toLowerCase();
  const visibleAssemblies = assemblies.filter((assembly) => !cleanSearch || `${assembly.assembly_code} ${assembly.name} ${assembly.barcode || ''}`.toLowerCase().includes(cleanSearch));
  const cleanComponentSearch = componentSearch.trim().toLowerCase();
  const componentMatches = cleanComponentSearch ? products.filter((product) => `${product.item_code} ${product.name} ${product.barcode || ''}`.toLowerCase().includes(cleanComponentSearch)).slice(0, 30) : [];
  const componentPrice = form.items.reduce((sum, item) => sum + numberValue(item.qty) * numberValue(item.selling_price), 0);
  const componentCost = form.items.reduce((sum, item) => sum + numberValue(item.qty) * numberValue(item.avg_cost), 0);
  const assemblyDiscount = form.discount_type === 'percent'
    ? componentPrice * Math.min(numberValue(form.discount_value), 100) / 100
    : Math.min(numberValue(form.discount_value), componentPrice);
  const finalPrice = Math.max(componentPrice - assemblyDiscount, 0);

  return <div className="assemblies-manager">
    <div className="action-toolbar compact-toolbar"><button className="toolbar-button" onClick={() => { loadAssemblies(); loadAssemblyProducts(); }}><span>{'\u21BB'}</span>Refresh</button><button className="toolbar-button bright" onClick={openNewAssembly}><span>+</span>New assembly</button></div>
    <div className="panel-card assembly-search-row"><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search assembly code, name or barcode" /><span>{visibleAssemblies.length} assemblies</span></div>
    {message && <div className="notice">{message}</div>}{error && <div className="error-box">{error}</div>}
    {showForm && <form className="panel-card assembly-form" onSubmit={saveAssembly}>
      <div className="section-title-row assembly-form-title"><div><h3>{editingAssembly ? `Edit ${editingAssembly.name}` : 'New PC Assembly'}</h3><p>Choose component products. The assembly itself does not carry stock.</p></div><button type="button" className="secondary-button" onClick={() => setShowForm(false)}>Close</button></div>
      <div className="purchase-form-grid assembly-header-grid"><label>Assembly code<input value={form.assembly_code} placeholder="Assigned on save" readOnly /></label><label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Gaming PC Ryzen 5" required /></label><label>Barcode optional<input value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} /></label><label>Discount type<select value={form.discount_type} onChange={(e) => setForm({ ...form, discount_type: e.target.value })}><option value="percent">Percentage</option><option value="amount">Amount</option></select></label><label>Discount {form.discount_type === 'percent' ? '%' : 'amount'}<input type="number" min="0" max={form.discount_type === 'percent' ? 100 : undefined} step="0.01" value={form.discount_value} onChange={(e) => setForm({ ...form, discount_value: e.target.value })} /></label><label>Status<select value={form.is_active ? 'active' : 'inactive'} onChange={(e) => setForm({ ...form, is_active: e.target.value === 'active' })}><option value="active">Active</option><option value="inactive">Inactive</option></select></label></div>
      <div className="assembly-component-picker"><h4>Add components</h4><input value={componentSearch} onChange={(e) => setComponentSearch(e.target.value)} placeholder="Search product code, name or barcode" /><div className="assembly-component-results">{componentMatches.map((product) => <button type="button" key={product.product_id} disabled={form.items.some((item) => item.product_id === product.product_id)} onClick={() => addAssemblyComponent(product)}><strong>{product.item_code}</strong><span>{product.name}</span><small>{money(product.selling_price)} · Available {numberValue(product.available_qty)}</small></button>)}{cleanComponentSearch && !componentMatches.length && <div className="muted-box">No matching products.</div>}</div></div>
      <div className="table-wrap assembly-lines"><table><thead><tr><th>Code</th><th>Component</th><th>Required qty</th><th>Available</th><th>Unit price</th><th>Cost</th><th></th></tr></thead><tbody>{form.items.map((item) => <tr key={item.product_id}><td>{item.item_code}</td><td>{item.name}</td><td><input type="number" min="0.001" step="0.001" value={item.qty} onChange={(e) => updateAssemblyComponent(item.product_id, { qty: e.target.value })} /></td><td>{numberValue(item.available_qty)}</td><td>{money(item.selling_price)}</td><td>{money(item.avg_cost)}</td><td><button type="button" className="small-button danger" onClick={() => removeAssemblyComponent(item.product_id)}>Remove</button></td></tr>)}{!form.items.length && <EmptyRow colSpan={7} text="Search above and add the PC components." />}</tbody></table></div>
      <div className="assembly-price-summary"><SummaryLine label="Component selling total" value={money(componentPrice)} /><SummaryLine label="Assembly discount" value={money(assemblyDiscount)} /><SummaryLine label="Component cost" value={money(componentCost)} /><SummaryLine label="Final assembly price" value={money(finalPrice)} strong /><button className="primary-button" disabled={busy}>{busy ? 'Saving...' : 'Save Assembly'}</button></div>
    </form>}
    <div className="panel-card table-wrap assembly-list-table"><table><thead><tr><th>Code</th><th>Assembly</th><th>Components</th><th>Listed total</th><th>Discount</th><th>Final price</th><th>Cost</th><th>Buildable</th><th>Status</th><th>Actions</th></tr></thead><tbody>{visibleAssemblies.map((assembly) => <tr key={assembly.id}><td><strong>{assembly.assembly_code}</strong></td><td>{assembly.name}</td><td>{(assembly.components || []).length}</td><td>{money(assembly.component_price)}</td><td>{assembly.discount_type === 'percent' ? `${numberValue(assembly.discount_value)}%` : money(assembly.discount_amount)}</td><td><strong>{money(assembly.selling_price)}</strong></td><td>{money(assembly.component_cost)}</td><td><strong>{numberValue(assembly.buildable_qty)}</strong></td><td><span className={assembly.is_active ? 'status-pill active' : 'status-pill inactive'}>{assembly.is_active ? 'active' : 'inactive'}</span></td><td><button className="small-button" onClick={() => openEditAssembly(assembly)}>Edit</button><button className="small-button danger" onClick={() => toggleAssembly(assembly)}>{assembly.is_active ? 'Inactive' : 'Activate'}</button></td></tr>)}{!visibleAssemblies.length && <EmptyRow colSpan={10} text="No assemblies found. Create your first PC build template." />}</tbody></table></div>
  </div>;
}

function ProductsPage() {
  const [productSection, setProductSection] = useState('products');
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
  useRealtimeRefresh(['products', 'stock_balances', 'stock_movements'], loadProducts);
  useRealtimeRefresh(['categories'], () => { loadCategories(); loadProducts(); });

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
      warranty_months: numberValue(product.warranty_months),
      serial_required: !!product.serial_required,
      track_inventory: product.track_inventory !== false,
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
      warranty_months: Math.max(Math.round(numberValue(form.warranty_months)), 0),
      serial_required: !!form.serial_required,
      track_inventory: form.track_inventory !== false,
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
    setMessage(editingProduct
      ? 'Product updated.'
      : form.track_inventory === false
        ? 'Non-stock product added. It can be sold without inventory quantity.'
        : 'Product added with zero stock. Stock will increase from purchase documents later.');
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
        const warrantyMonths = Math.max(Math.round(numberValue(firstCell(row, ['warranty months', 'warranty', 'warranty period']), 0)), 0);
        const serialRaw = String(firstCell(row, ['serial required', 'requires serial', 'serial number required'])).trim().toLowerCase();
        const serialRequired = ['yes', 'true', '1', 'required'].includes(serialRaw);
        const trackRaw = String(firstCell(row, ['track inventory', 'inventory tracked', 'tracked stock'])).trim().toLowerCase();
        const stocklessRaw = String(firstCell(row, ['stockless', 'non stock', 'non-stock', 'service item'])).trim().toLowerCase();
        const trackInventory = trackRaw
          ? !['no', 'false', '0', 'off', 'stockless', 'service'].includes(trackRaw)
          : !['yes', 'true', '1', 'on'].includes(stocklessRaw);

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
            warranty_months: warrantyMonths,
            serial_required: serialRequired,
            track_inventory: trackInventory,
            status,
            is_active: status === 'active',
            online_visible: false
          }, { onConflict: 'item_code' })
          .select('id')
          .single();

        if (productError) throw productError;

        if (trackInventory && updateImportStock && qtyRaw !== '') {
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
    const headers = ['SKU/Code', 'Name', 'Category', 'Barcode', 'Cost', 'Markup %', 'Price', 'Track Inventory', 'Low Stock Level', 'Warranty Months', 'Serial Required', 'Status'];
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
        product.track_inventory === false ? 'No' : 'Yes',
        numberValue(product.min_stock_level, 1),
        numberValue(product.warranty_months),
        product.serial_required ? 'Yes' : 'No',
        product.status || (product.is_active ? 'active' : 'inactive')
      ];
      lines.push(row.map(csvEscape).join(','));
    });
    downloadTextFile('products-export.csv', lines.join('\n'));
  }

  const categoryCounts = categoryCountsWithParents(categories, products);

  return (
    <section className="products-screen">
      <div className="product-section-tabs">
        <button className={productSection === 'products' ? 'active' : ''} onClick={() => setProductSection('products')}>Products</button>
        <button className={productSection === 'assemblies' ? 'active' : ''} onClick={() => setProductSection('assemblies')}>PC Assemblies</button>
      </div>
      {productSection === 'assemblies' ? <AssembliesManager /> : <>
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

          <label className="checkbox-line">
            <input type="checkbox" checked={updateImportStock} onChange={(e) => setUpdateImportStock(e.target.checked)} />
            Import stock quantity <InfoTip text="Enable only when the imported file contains opening quantities. Normal stock changes should use stock-related entries from Documents." />
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
                <label className={`checkbox-label product-inventory-toggle ${form.track_inventory === false ? 'stockless' : ''}`}><input type="checkbox" checked={form.track_inventory !== false} onChange={(e) => setForm({ ...form, track_inventory: e.target.checked })} /> <span><strong>Track inventory</strong><small>{form.track_inventory === false ? 'Non-stock item: always available in POS and no stock movements.' : 'Stock item: sales are limited to available quantity.'}</small></span><InfoTip text="Turn this off for services, installation work, and unlimited digital items. Keep it on for limited licence keys or any physical product." /></label>
                <label>Low stock level <InfoTip text="This is only the warning threshold. Current quantities are managed and viewed on the Stock page." /><input type="number" step="1" disabled={form.track_inventory === false} value={form.min_stock_level} onFocus={selectAllText} onChange={(e) => setForm({ ...form, min_stock_level: Number(e.target.value) })} /></label>
                <label>Warranty months <InfoTip text="Default warranty period used when registering a sold unit. Use 0 for products without warranty." /><input type="number" min="0" step="1" value={form.warranty_months} onFocus={selectAllText} onChange={(e) => setForm({ ...form, warranty_months: Number(e.target.value) })} /></label>
                <label className="checkbox-label product-warranty-toggle"><input type="checkbox" checked={!!form.serial_required} onChange={(e) => setForm({ ...form, serial_required: e.target.checked })} /> Serial number required for warranty</label>
                <label>Status
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                    {PRODUCT_STATUS_OPTIONS.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
                  </select>
                </label>
                <div className="form-note compact-form-note">{form.track_inventory === false ? 'This item will not appear in Stock or low-stock warnings.' : 'Stock quantity starts at zero'} <InfoTip text={form.track_inventory === false ? 'Sales and returns change accounting values only; they do not change stock.' : 'Create a Purchase, Stock in Transit, Trade-In, or Stock Adjustment from Documents to change quantity.'} /></div>
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
                  <th>Type</th>
                  <th>Low</th>
                  <th>Warranty</th>
                  <th>Serial</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.product_id} onClick={() => setSelectedProduct(product)} className={selectedProduct?.product_id === product.product_id ? 'selected-row' : ''}>
                    <td><strong>{product.item_code}</strong></td>
                    <td>{product.name}</td>
                    <td>{product.category_path || product.category_name || '-'}</td>
                    <td>{product.barcode || '-'}</td>
                    <td>{money(product.avg_cost)}</td>
                    <td>{formatPercent(markupPercent(product.avg_cost, product.selling_price))}</td>
                    <td>{money(product.selling_price)}</td>
                    <td><span className={product.track_inventory === false ? 'status-pill non-stock' : 'status-pill tracked-stock'}>{product.track_inventory === false ? 'Non-stock' : 'Stock item'}</span></td>
                    <td>{product.track_inventory === false ? '-' : numberValue(product.min_stock_level, 1)}</td>
                    <td>{numberValue(product.warranty_months) > 0 ? `${numberValue(product.warranty_months)} months` : '-'}</td>
                    <td>{product.serial_required ? 'Required' : 'Optional'}</td>
                    <td><span className={product.status === 'inactive' || !product.is_active ? 'status-pill inactive' : 'status-pill active'}>{product.status || (product.is_active ? 'active' : 'inactive')}</span></td>
                    <td>
                      <button className="small-button" onClick={(e) => { e.stopPropagation(); setSelectedProduct(product); openEditProduct(product); }}>Edit</button>
                      <button className="small-button danger" onClick={(e) => { e.stopPropagation(); setSelectedProduct(product); deactivateProduct(product); }}>Inactive</button>
                    </td>
                  </tr>
                ))}
                {products.length === 0 && <EmptyRow colSpan={13} text="No products found." />}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      </>}
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

const INVENTORY_DOCUMENT_TYPES = ['purchase', 'stock_in_transit', 'trade_in', 'stock_adjustment'];

function InventoryDocumentsPage() {
  const [documents, setDocuments] = useState([]);
  const [selected, setSelected] = useState(null);
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState({ type: '', search: '' });
  const [formMode, setFormMode] = useState(null);
  const [previewId, setPreviewId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { loadInventoryDocuments(); }, []);

  async function loadInventoryDocuments(preferredId = '') {
    setError('');
    const { data, error: loadError } = await supabase
      .from('documents')
      .select('id, document_no, external_document_no, document_type, status, total_amount, paid_amount, balance_amount, document_date, created_at, supplier_id, customer_id, linked_document_id, notes')
      .in('document_type', INVENTORY_DOCUMENT_TYPES)
      .order('document_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(500);
    if (loadError) { setError(loadError.message); return; }
    const rows = data || [];
    setDocuments(rows);
    const keepId = preferredId || selected?.id || '';
    const next = rows.find((row) => row.id === keepId) || null;
    setSelected(next);
    if (next) await loadInventoryItems(next);
    else setItems([]);
  }

  async function loadInventoryItems(document) {
    setSelected(document);
    const { data, error: itemError } = await supabase.from('document_items').select('*').eq('document_id', document.id).order('created_at');
    if (itemError) setError(itemError.message); else setItems(data || []);
  }

  async function convertTransit() {
    if (!selected || selected.document_type !== 'stock_in_transit') return;
    if (!window.confirm(`Convert ${selected.document_no} to a Purchase and receive its stock?`)) return;
    setBusy(true); setError(''); setMessage('');
    const { data, error: convertError } = await supabase.rpc('convert_stock_in_transit_to_purchase', { p_transit_doc_id: selected.id });
    setBusy(false);
    if (convertError) setError(convertError.message);
    else { setMessage(`Purchase ${data?.document_no || ''} created and stock received.`); await loadInventoryDocuments(); }
  }

  async function deletePurchaseLike() {
    if (!selected || !['purchase', 'stock_in_transit'].includes(selected.document_type)) return;
    if (!window.confirm(`Delete ${selected.document_no} and reverse its stock and payment effects?`)) return;
    setBusy(true); setError(''); setMessage('');
    const deletedNo = selected.document_no;
    const { error: deleteError } = await supabase.rpc('delete_purchase_like_document', { p_document_id: selected.id });
    setBusy(false);
    if (deleteError) setError(deleteError.message);
    else { setSelected(null); setItems([]); setMessage(`${deletedNo} deleted and its inventory effects reversed.`); await loadInventoryDocuments(); }
  }

  function closeForm(saved = false) {
    setFormMode(null);
    if (saved) { setMessage('Inventory document saved.'); loadInventoryDocuments(); }
  }

  if (formMode?.type === 'purchase' || formMode?.type === 'stock_in_transit') {
    return <section className="page-section"><PurchaseDocumentForm documentType={formMode.type} document={formMode.document || null} tabId={formMode.tabId} onClose={() => closeForm(false)} onSaved={() => closeForm(true)} /></section>;
  }
  if (formMode?.type === 'trade_in') {
    return <section className="page-section"><TradeInIntakeForm tabId={formMode.tabId} onClose={() => closeForm(false)} onSaved={() => closeForm(true)} /></section>;
  }
  if (formMode?.type === 'stock_adjustment') {
    return <section className="page-section"><StockAdjustmentForm onClose={() => closeForm(false)} onSaved={() => closeForm(true)} /></section>;
  }

  const visibleDocuments = documents.filter((document) => {
    if (filter.type && document.document_type !== filter.type) return false;
    const clean = filter.search.trim().toLowerCase();
    return !clean || `${document.document_no} ${document.external_document_no || ''} ${document.notes || ''}`.toLowerCase().includes(clean);
  });

  return (
    <section className="page-section inventory-documents-page">
      <div className="section-title-row inventory-documents-heading">
        <div><h3>Inventory Documents</h3><p>Create and manage every document that changes incoming or on-hand stock.</p></div>
        <div className="inventory-create-actions">
          <button className="primary-button" onClick={() => setFormMode({ type: 'purchase', tabId: createClientId() })}>New Purchase</button>
          <button className="secondary-button" onClick={() => setFormMode({ type: 'stock_in_transit', tabId: createClientId() })}>New Stock in Transit</button>
          <button className="secondary-button" onClick={() => setFormMode({ type: 'trade_in', tabId: createClientId() })}>New Trade-In</button>
          <button className="secondary-button" onClick={() => setFormMode({ type: 'stock_adjustment' })}>New Stock Adjustment</button>
        </div>
      </div>
      {message && <div className="notice success">{message}</div>}
      {error && <div className="error-box">{error}</div>}
      <div className="inventory-document-stats">
        <StatCard label="Purchases" value={documents.filter((row) => row.document_type === 'purchase').length} />
        <StatCard label="In Transit" value={documents.filter((row) => row.document_type === 'stock_in_transit' && row.status !== 'converted').length} />
        <StatCard label="Trade-Ins" value={documents.filter((row) => row.document_type === 'trade_in').length} />
        <StatCard label="Adjustments" value={documents.filter((row) => row.document_type === 'stock_adjustment').length} />
      </div>
      <div className="panel-card inventory-document-filters">
        <input value={filter.search} onChange={(e) => setFilter({ ...filter, search: e.target.value })} placeholder="Search document number, reference, or notes" />
        <select value={filter.type} onChange={(e) => setFilter({ ...filter, type: e.target.value })}>
          <option value="">All inventory documents</option>
          <option value="purchase">Purchases</option><option value="stock_in_transit">Stock in Transit</option><option value="trade_in">Trade-Ins</option><option value="stock_adjustment">Stock Adjustments</option>
        </select>
        <button className="secondary-button" onClick={() => loadInventoryDocuments()}>Refresh</button>
      </div>
      <div className="inventory-document-layout">
        <div className="panel-card table-wrap inventory-document-list"><table><thead><tr><th>Number</th><th>Date</th><th>Type</th><th>Reference</th><th>Status</th><th>Total</th></tr></thead><tbody>
          {visibleDocuments.map((document) => <tr key={document.id} className={selected?.id === document.id ? 'selected-row' : ''} onClick={() => loadInventoryItems(document)}><td><strong>{document.document_no}</strong></td><td>{fmtDate(document.document_date || document.created_at)}</td><td>{documentTypeLabel(document.document_type)}</td><td>{document.external_document_no || '-'}</td><td>{document.status}</td><td>{money(document.total_amount)}</td></tr>)}
          {!visibleDocuments.length && <EmptyRow colSpan={6} text="No inventory documents match this filter." />}
        </tbody></table></div>
        <div className="panel-card inventory-document-detail">
          {!selected ? <div className="muted-box">Select an inventory document to view its items and actions.</div> : <>
            <div className="inventory-document-detail-head"><div><span>{documentTypeLabel(selected.document_type)}</span><h3>{selected.document_no}</h3><small>{fmtDate(selected.document_date || selected.created_at)} · {selected.status}</small></div><div className="inventory-document-actions">
              <button className="secondary-button" onClick={() => setPreviewId(selected.id)}>Print or Save PDF</button>
              {['purchase', 'stock_in_transit'].includes(selected.document_type) && <button className="secondary-button" disabled={busy} onClick={() => setFormMode({ type: selected.document_type, document: selected, tabId: createClientId() })}>Edit</button>}
              {selected.document_type === 'stock_in_transit' && selected.status !== 'converted' && <button className="primary-button" disabled={busy} onClick={convertTransit}>Receive Stock</button>}
              {['purchase', 'stock_in_transit'].includes(selected.document_type) && <button className="danger-button" disabled={busy} onClick={deletePurchaseLike}>Delete</button>}
            </div></div>
            {selected.notes && <p className="inventory-document-notes">{selected.notes}</p>}
            <div className="table-wrap"><table><thead><tr><th>Code</th><th>Item</th><th>Qty</th><th>Cost</th><th>Total</th></tr></thead><tbody>
              {items.map((item) => <tr key={item.id}><td>{item.item_code || '-'}</td><td>{item.description}</td><td>{numberValue(item.qty)}</td><td>{money(item.unit_cost || item.unit_price)}</td><td>{money(item.line_total)}</td></tr>)}
              {!items.length && <EmptyRow colSpan={5} text="No items found." />}
            </tbody></table></div>
          </>}
        </div>
      </div>
      {previewId && <DocumentPreviewModal documentId={previewId} onClose={() => setPreviewId('')} />}
    </section>
  );
}

function StockAdjustmentForm({ onClose, onSaved }) {
  const [documentDate, setDocumentDate] = useState(todayInputDate());
  const [notes, setNotes] = useState('');
  const [search, setSearch] = useState('');
  const [products, setProducts] = useState([]);
  const [lines, setLines] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const timeout = setTimeout(async () => {
      let query = supabase.from('product_stock_view').select('product_id, item_code, name, avg_cost, sellable_qty, damaged_qty, checking_qty, available_qty, track_inventory').eq('is_active', true).eq('track_inventory', true).order('item_code').limit(80);
      const clean = search.trim().replace(/,/g, ' ');
      if (clean) query = query.or(`item_code.ilike.%${clean}%,name.ilike.%${clean}%,barcode.ilike.%${clean}%`);
      const { data, error: productError } = await query;
      if (productError) setError(productError.message); else setProducts(data || []);
    }, 180);
    return () => clearTimeout(timeout);
  }, [search]);

  function addLine(product) {
    if (lines.some((line) => line.product_id === product.product_id && line.bucket === 'sellable')) return;
    setLines((current) => [...current, { id: createClientId(), product_id: product.product_id, item_code: product.item_code, description: product.name, unit_cost: numberValue(product.avg_cost), qty: 1, bucket: 'sellable' }]);
  }

  function updateLine(id, changes) { setLines((current) => current.map((line) => line.id === id ? { ...line, ...changes } : line)); }

  async function saveAdjustment(event) {
    event.preventDefault();
    setError('');
    const valid = lines.filter((line) => numberValue(line.qty) !== 0);
    if (!valid.length) { setError('Add at least one item with a non-zero quantity change.'); return; }
    setBusy(true);
    const { data, error: saveError } = await supabase.rpc('save_stock_adjustment_v33', {
      p_header: { document_date: documentDate, notes: notes.trim() || null },
      p_items: valid.map((line) => ({ product_id: line.product_id, item_code: line.item_code, description: line.description, qty: numberValue(line.qty), unit_cost: numberValue(line.unit_cost), bucket: line.bucket }))
    });
    setBusy(false);
    if (saveError) setError(`${saveError.message}. If the function is missing, run 033_inventory_documents_cod_delete.sql in Supabase.`);
    else { onSaved?.(data); }
  }

  return (
    <form className="inventory-adjustment-form" onSubmit={saveAdjustment}>
      <div className="section-title-row"><div><h3>New Stock Adjustment</h3><p>Correct counted stock without creating a purchase or sale.</p></div><button type="button" className="secondary-button" onClick={onClose}>Close</button></div>
      {error && <div className="error-box">{error}</div>}
      <div className="panel-card inventory-adjustment-header"><label>Document number<input value="Assigned on save" readOnly /></label><label>Date<input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} /></label><label className="wide-field">Reason <InfoTip text="Explain why the physical count is being corrected. This note stays with the audit document." /><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Example: physical stock count correction" required /></label></div>
      <div className="inventory-adjustment-layout">
        <div className="panel-card adjustment-product-picker"><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products by code, name, or barcode" /><div className="adjustment-product-list">{products.map((product) => <button type="button" key={product.product_id} onClick={() => addLine(product)}><strong>{product.item_code}</strong><span>{product.name}</span><small>Available {numberValue(product.available_qty)}</small></button>)}</div></div>
        <div className="panel-card table-wrap"><table><thead><tr><th>Code</th><th>Item</th><th>Stock bucket <InfoTip text="Sellable changes normal shop stock. Damaged and Checking change their separate non-sellable quantities." /></th><th>Quantity change <InfoTip text="Use a positive number to add stock or a negative number to remove stock." /></th><th>Cost</th><th></th></tr></thead><tbody>
          {lines.map((line) => <tr key={line.id}><td><strong>{line.item_code}</strong></td><td>{line.description}</td><td><select value={line.bucket} onChange={(e) => updateLine(line.id, { bucket: e.target.value })}><option value="sellable">Sellable</option><option value="damaged">Damaged</option><option value="checking">Checking</option></select></td><td><input className="table-number-input" type="number" step="1" value={line.qty} onChange={(e) => updateLine(line.id, { qty: e.target.value })} /></td><td><input className="table-number-input" type="number" step="0.01" value={line.unit_cost} onChange={(e) => updateLine(line.id, { unit_cost: e.target.value })} /></td><td><button type="button" className="small-button danger" onClick={() => setLines((current) => current.filter((item) => item.id !== line.id))}>Remove</button></td></tr>)}
          {!lines.length && <EmptyRow colSpan={6} text="Select products from the list to build the adjustment." />}
        </tbody></table></div>
      </div>
      <div className="inventory-adjustment-save"><button className="primary-button" disabled={busy}>{busy ? 'Saving...' : 'Save Stock Adjustment'}</button></div>
    </form>
  );
}

function StockPage({ onOpenDocuments }) {
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
  useRealtimeRefresh(['products', 'stock_balances', 'stock_movements', 'documents', 'document_items'], loadStock);
  useRealtimeRefresh(['categories'], () => { loadCategories(); loadStock(); });

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
      .eq('track_inventory', true)
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
        <button className="toolbar-button" onClick={onOpenDocuments}><span>▣</span>Stock adjustment</button>
        <button className="toolbar-button" onClick={onOpenDocuments}><span>⇣</span>Receive purchase</button>
        <button className="toolbar-button" onClick={onOpenDocuments}><span>⏳</span>Transit docs</button>
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

          <div className="notice slim-notice stock-guide-note"><strong>Stock quantity guide</strong><InfoTip text="Qty is sellable physical stock. Available is Qty minus Reserved. In Transit is incoming stock not yet received. Warranty and Damaged are non-sellable quantities." /></div>

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


function DocumentPreviewModal({ documentId, onClose }) {
  const [document, setDocument] = useState(null);
  const [items, setItems] = useState([]);
  const [flows, setFlows] = useState([]);
  const [companySettings, setCompanySettings] = useState(DEFAULT_COMPANY_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    async function loadPreview() {
      setLoading(true);
      setError('');
      const { data: doc, error: docError } = await supabase.from('documents').select('*').eq('id', documentId).single();
      if (!active) return;
      if (docError) {
        setError(docError.message);
        setLoading(false);
        return;
      }
      const [itemRes, flowRes, customerRes, supplierRes, paymentRes] = await Promise.all([
        supabase.from('document_items').select('*').eq('document_id', documentId).order('created_at'),
        supabase.from('cashflow_entries').select('id, entry_type, account_name, amount, description, created_at, payment_method_id, payment_methods(name)').eq('document_id', documentId).order('created_at'),
        doc.customer_id ? supabase.from('customers').select('id, name, phone, address, due_balance, store_credit_balance').eq('id', doc.customer_id).single() : Promise.resolve({ data: null }),
        doc.supplier_id ? supabase.from('suppliers').select('id, name, phone, address').eq('id', doc.supplier_id).single() : Promise.resolve({ data: null }),
        doc.payment_method_id ? supabase.from('payment_methods').select('id, name').eq('id', doc.payment_method_id).single() : Promise.resolve({ data: null })
      ]);
      if (!active) return;
      const childError = itemRes.error || flowRes.error;
      if (childError) setError(childError.message);
      setDocument({
        ...doc,
        party: customerRes.data || supplierRes.data || null,
        payment_method_name: paymentRes.data?.name || flowRes.data?.[0]?.payment_methods?.name || ''
      });
      setItems(itemRes.data || []);
      setFlows(flowRes.data || []);
      setLoading(false);
    }
    loadPreview();
    return () => { active = false; };
  }, [documentId]);

  useEffect(() => {
    fetchCompanySettings().then(setCompanySettings).catch(() => {});
  }, []);

  const displayAmount = Math.abs(numberValue(document?.total_amount) || numberValue(document?.paid_amount));

  return (
    <div className="modal-backdrop accounting-document-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="accounting-document-modal">
        <div className="accounting-document-header">
          <div>
            <span>{document ? documentTypeLabel(document.document_type) : 'Document'}</span>
            <h2>{document?.document_no || (loading ? 'Loading document...' : 'Document')}</h2>
          </div>
          <div className="accounting-document-actions">
            <button className="secondary-button" disabled={!document} onClick={() => printAccountingDocument(document, items, flows, companySettings)}>Print</button>
            <button className="secondary-button" disabled={!document} onClick={() => downloadAccountingDocumentPdf(document, items, flows, companySettings).catch((pdfError) => setError(pdfError.message || String(pdfError)))}>Save PDF</button>
            <button className="danger-button" onClick={onClose}>Close</button>
          </div>
        </div>

        {error && <div className="error-box">{error}</div>}
        {loading && <div className="document-preview-loading">Loading document details...</div>}
        {!loading && document && <>
          <div className="accounting-document-summary">
            <div><span>Date</span><strong>{fmtDate(document.document_date || document.created_at)}</strong></div>
            <div><span>Customer / Supplier</span><strong>{document.party?.name || document.recipient_name || '-'}</strong><small>{document.party?.phone || ''}</small></div>
            <div><span>Payment</span><strong>{document.payment_method_name || '-'}</strong></div>
            <div><span>Status</span><strong>{document.status || '-'}</strong></div>
            <div className="amount-card"><span>Document amount</span><strong>{money(displayAmount)}</strong></div>
          </div>

          {document.notes && <div className="accounting-document-notes"><span>Description / Notes</span><p>{document.notes}</p></div>}

          {!!items.length && <div className="accounting-document-section">
            <h3>Items</h3>
            <div className="table-wrap"><table><thead><tr><th>Code</th><th>Description</th><th>Qty</th><th>Unit price</th><th>Discount</th><th>Total</th></tr></thead><tbody>
              {items.map((item) => <tr key={item.id}><td>{item.item_code || '-'}</td><td>{item.description}</td><td>{numberValue(item.qty)}</td><td>{money(item.unit_price || item.unit_cost)}</td><td>{numberValue(item.discount_value) ? item.discount_type === 'percent' ? `${numberValue(item.discount_value)}%` : money(item.discount_value) : '-'}</td><td>{money(item.line_total)}</td></tr>)}
            </tbody></table></div>
          </div>}

          <div className="accounting-document-section">
            <h3>Payment movements</h3>
            <div className="table-wrap"><table><thead><tr><th>Date</th><th>Direction</th><th>Account</th><th>Description</th><th>Amount</th></tr></thead><tbody>
              {flows.map((flow) => <tr key={flow.id}><td>{fmtDate(flow.created_at)}</td><td><span className={`cash-direction-pill ${flow.entry_type}`}>{flow.entry_type.replace('_', ' ')}</span></td><td>{flow.payment_methods?.name || flow.account_name || '-'}</td><td>{flow.description || '-'}</td><td className={flow.entry_type === 'cash_out' ? 'negative-balance' : flow.entry_type === 'cash_in' ? 'positive-balance' : ''}>{money(flow.amount)}</td></tr>)}
              {!flows.length && <EmptyRow colSpan={5} text="No cash movement for this document." />}
            </tbody></table></div>
          </div>
        </>}
      </div>
    </div>
  );
}

function cashflowDateRange(preset, customFrom = '', customTo = '') {
  const now = new Date();
  let start = null;
  let end = null;
  if (preset === 'today') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    end = new Date(start); end.setDate(end.getDate() + 1);
  } else if (preset === 'week') {
    const mondayOffset = (now.getDay() + 6) % 7;
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayOffset);
    end = new Date(start); end.setDate(end.getDate() + 7);
  } else if (preset === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  } else if (preset === 'custom') {
    if (customFrom) start = new Date(`${customFrom}T00:00:00`);
    if (customTo) { end = new Date(`${customTo}T00:00:00`); end.setDate(end.getDate() + 1); }
  }
  return { start, end };
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
  const [paymentForm, setPaymentForm] = useState({ amount: '', method_id: '', document_type: 'customer_payment', direction: 'in', note: '' });
  const [previewDocumentId, setPreviewDocumentId] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => { loadRows(); loadPaymentMethods(); }, []);
  useEffect(() => {
    if (selectedId) loadTransactions(selectedId);
    else setTransactions([]);
  }, [selectedId]);
  useRealtimeRefresh(['customers', 'suppliers', 'documents', 'document_items', 'cashflow_entries'], () => {
    loadRows();
    if (selectedId) loadTransactions(selectedId);
  });
  useRealtimeRefresh(['payment_methods'], loadPaymentMethods);

  const selected = rows.find((row) => row.id === selectedId);
  const selectedOutstanding = selected ? Number(selected.due_balance || 0) - Number(selected.store_credit_balance || 0) : 0;

  useEffect(() => {
    if (!selected) return;
    const direction = selectedOutstanding < 0 ? 'out' : 'in';
    const documentType = selected.is_supplier && selected.is_customer === false ? 'supplier_payment' : 'customer_payment';
    setPaymentForm((current) => ({
      ...current,
      document_type: documentType,
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
    setTransactions(docs
      .map((doc) => ({ kind: 'document', date: doc.document_date || doc.created_at, ...doc }))
      .sort((a, b) => new Date(b.date) - new Date(a.date)));
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
    const { data, error: payError } = await supabase.rpc('save_party_payment_v29', {
      p_profile_id: selectedId,
      p_document_type: paymentForm.document_type,
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
    setMessage(`${documentTypeLabel(data?.document_type)} ${data?.document_no} saved. New outstanding: ${data?.new_outstanding < 0 ? '-' : ''}${money(Math.abs(Number(data?.new_outstanding || 0)))}`);
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
    const isSupplierPayment = paymentForm.document_type === 'supplier_payment';
    const actionLabel = isSupplierPayment
      ? paymentForm.direction === 'out' ? 'Pay supplier' : 'Receive supplier refund'
      : paymentForm.direction === 'out' ? 'Refund / pay customer' : 'Receive customer payment';
    const profileType = `${selected.is_customer !== false ? 'Customer' : ''}${selected.is_supplier ? `${selected.is_customer !== false ? ' / ' : ''}Supplier` : ''}`;
    return (
      <section className="page-section party-detail-page">
        <div className="party-detail-hero panel-card">
          <div className="party-hero-identity">
            <button className="secondary-button party-back-button" onClick={() => setSelectedId('')}>← Back</button>
            <div>
              <span className="party-type-label">{profileType}</span>
              <h2>{selected.name}</h2>
              <p>{selected.phone || 'No phone'} {selected.address ? `• ${selected.address}` : ''}</p>
            </div>
          </div>
          <button className="secondary-button" onClick={() => loadTransactions(selected.id)}>Refresh</button>
        </div>
        {error && <div className="error-box">{error}</div>}
        {message && <div className="notice success">{message}</div>}

        <div className="party-summary-grid">
          <StatCard label="Outstanding Balance" value={`${selectedOutstanding < 0 ? '-' : ''}${money(Math.abs(selectedOutstanding))}`} />
          <StatCard label="Balance meaning" value={selectedOutstanding > 0 ? 'They owe the shop' : selectedOutstanding < 0 ? 'Shop owes them' : 'Settled'} />
          <StatCard label="Documents" value={transactions.length} />
        </div>

        <div className="party-detail-grid-v17">
          <form className="panel-card balance-payment-form party-payment-card" onSubmit={saveBalancePayment}>
            <div className="party-payment-heading"><span>New payment document</span><h3>{actionLabel}</h3></div>
            <p className="muted-text">Saving creates a numbered document and its linked cashflow transaction together.</p>
            <div className="party-payment-fields">
              <label>Document type
                <select value={paymentForm.document_type} onChange={(e) => {
                  const nextType = e.target.value;
                  setPaymentForm({ ...paymentForm, document_type: nextType, direction: nextType === 'supplier_payment' ? 'out' : 'in' });
                }}>
                  {selected.is_customer !== false && <option value="customer_payment">Customer Payment</option>}
                  {selected.is_supplier && <option value="supplier_payment">Supplier Payment</option>}
                </select>
              </label>
              <label>Action
                <select value={paymentForm.direction} onChange={(e) => setPaymentForm({ ...paymentForm, direction: e.target.value })}>
                  {isSupplierPayment ? <><option value="out">Pay supplier</option><option value="in">Receive refund from supplier</option></> : <><option value="in">Receive payment from customer</option><option value="out">Refund / pay customer</option></>}
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
              <button className="primary-button">Save payment document</button>
            </div>
          </form>

          <div className="panel-card transaction-panel-full">
            <div className="transaction-panel-heading"><div><h3>Document history</h3><p>Click a row or document number to view, print, or save it as PDF.</p></div><span>{transactions.length} documents</span></div>
            <div className="table-wrap compact-table">
              <table>
                <thead><tr><th>Date</th><th>Type</th><th>Document</th><th>Description</th><th>Payment</th><th>Amount</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {transactions.map((row) => (
                      <tr key={row.id} className="clickable-row" onClick={() => setPreviewDocumentId(row.id)}>
                        <td>{fmtDate(row.date)}</td>
                        <td>{documentTypeLabel(row.document_type)}</td>
                        <td><button className="document-link-button" onClick={(event) => { event.stopPropagation(); setPreviewDocumentId(row.id); }}>{row.document_no || '-'}</button></td>
                        <td className="description-cell">{row.notes || '-'}</td>
                        <td>{row.payment_methods?.name || '-'}</td>
                        <td><strong>{money(Math.abs(numberValue(row.total_amount) || numberValue(row.paid_amount)))}</strong></td>
                        <td><span className="status-pill active">{row.status || '-'}</span></td>
                        <td><button className="small-button" onClick={(event) => { event.stopPropagation(); setPreviewDocumentId(row.id); }}>View</button></td>
                      </tr>
                  ))}
                  {transactions.length === 0 && <EmptyRow colSpan={8} text="No documents for this profile." />}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        {previewDocumentId && <DocumentPreviewModal documentId={previewDocumentId} onClose={() => setPreviewDocumentId('')} />}
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
  const [cashAccounts, setCashAccounts] = useState([]);
  const [companySettings, setCompanySettings] = useState(DEFAULT_COMPANY_SETTINGS);
  const [filters, setFilters] = useState({ search: '', type: 'all', documentType: 'all', paymentMethodId: 'all', datePreset: 'today', dateFrom: '', dateTo: '' });
  const [showAdd, setShowAdd] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [manualForm, setManualForm] = useState({ entry_type: 'cash_out', payment_method_id: '', amount: '', description: '' });
  const [transferForm, setTransferForm] = useState({ from_payment_method_id: '', to_payment_method_id: '', amount: '', transfer_date: todayInputDate(), description: '' });
  const [previewDocumentId, setPreviewDocumentId] = useState('');
  const [pdfBusy, setPdfBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    loadPaymentMethods();
    loadCashAccounts();
    fetchCompanySettings().then(setCompanySettings).catch((settingsError) => setError(settingsError.message));
  }, []);
  useEffect(() => {
    const timeout = setTimeout(() => loadEntries(), 120);
    return () => clearTimeout(timeout);
  }, [filters.datePreset, filters.dateFrom, filters.dateTo]);
  useRealtimeRefresh(['cashflow_entries', 'documents'], () => { loadEntries(); loadCashAccounts(); });
  useRealtimeRefresh(['payment_methods'], () => { loadPaymentMethods(); loadCashAccounts(); });
  useRealtimeRefresh(['company_settings'], () => fetchCompanySettings().then(setCompanySettings).catch(() => {}));

  async function loadEntries() {
    setError('');
    const range = cashflowDateRange(filters.datePreset, filters.dateFrom, filters.dateTo);
    const pageSize = 1000;
    let offset = 0;
    const loadedEntries = [];
    while (true) {
      let query = supabase
        .from('cashflow_entries')
        .select('id, document_id, entry_type, account_name, amount, description, created_at, payment_method_id, payment_methods(name), documents(id, document_no, document_type, status, total_amount, paid_amount, notes)')
        .order('created_at', { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (range.start) query = query.gte('created_at', range.start.toISOString());
      if (range.end) query = query.lt('created_at', range.end.toISOString());
      const { data, error: cashError } = await query;
      if (cashError) {
        setError(cashError.message);
        return;
      }
      loadedEntries.push(...(data || []));
      if (!data || data.length < pageSize) break;
      offset += pageSize;
    }
    setEntries(loadedEntries);
  }

  async function loadPaymentMethods() {
    const { data, error: methodError } = await supabase
      .from('payment_methods')
      .select('id, name, is_paid_method, affects_cashflow, is_active, account_kind')
      .eq('is_active', true)
      .eq('affects_cashflow', true)
      .order('name');
    if (methodError) setError(methodError.message);
    else {
      setPaymentMethods(data || []);
      if ((data || []).length) setManualForm((form) => ({ ...form, payment_method_id: form.payment_method_id || data[0].id }));
      const transferable = (data || []).filter((method) => ['cash', 'bank'].includes(method.account_kind));
      setTransferForm((form) => ({
        ...form,
        from_payment_method_id: transferable.some((method) => method.id === form.from_payment_method_id) ? form.from_payment_method_id : transferable[0]?.id || '',
        to_payment_method_id: transferable.some((method) => method.id === form.to_payment_method_id && method.id !== (form.from_payment_method_id || transferable[0]?.id))
          ? form.to_payment_method_id
          : transferable.find((method) => method.id !== (form.from_payment_method_id || transferable[0]?.id))?.id || ''
      }));
    }
  }

  async function loadCashAccounts() {
    const { data, error: balanceError } = await supabase.rpc('get_cash_account_balances_v43');
    if (balanceError) {
      setError(`${balanceError.message}. Run migration 043_cash_accounts_transfers_cod_printing.sql in Supabase.`);
      return;
    }
    setCashAccounts(data || []);
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
    const { data, error: insertError } = await supabase.rpc('save_manual_cashflow_document_v29', {
      p_entry_type: manualForm.entry_type,
      p_payment_method_id: manualForm.payment_method_id || null,
      p_amount: amount,
      p_description: manualForm.description || null
    });
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setManualForm((form) => ({ ...form, amount: '', description: '' }));
    setShowAdd(false);
    setMessage(`${documentTypeLabel(data?.document_type)} ${data?.document_no} saved with its cashflow transaction.`);
    loadEntries();
  }

  async function saveAccountTransfer(event) {
    event.preventDefault();
    setError(''); setMessage('');
    const amount = numberValue(transferForm.amount);
    if (!transferForm.from_payment_method_id || !transferForm.to_payment_method_id) { setError('Select both transfer accounts.'); return; }
    if (transferForm.from_payment_method_id === transferForm.to_payment_method_id) { setError('Source and destination accounts must be different.'); return; }
    if (amount <= 0) { setError('Enter a transfer amount greater than zero.'); return; }
    const { data, error: transferError } = await supabase.rpc('save_cash_account_transfer_v43', {
      p_from_payment_method_id: transferForm.from_payment_method_id,
      p_to_payment_method_id: transferForm.to_payment_method_id,
      p_amount: amount,
      p_description: transferForm.description || null,
      p_transfer_date: transferForm.transfer_date || todayInputDate()
    });
    if (transferError) { setError(transferError.message); return; }
    setShowTransfer(false);
    setTransferForm((form) => ({ ...form, amount: '', description: '', transfer_date: todayInputDate() }));
    setMessage(`${data?.document_no}: ${money(data?.amount)} transferred from ${data?.from_account} to ${data?.to_account}.`);
    loadEntries(); loadCashAccounts();
  }

  async function exportCashflow(mode) {
    setError('');
    setMessage('');
    if (filters.datePreset === 'custom' && filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
      setError('Custom date From cannot be after To.');
      return;
    }
    const popup = mode === 'print' ? window.open('', '_blank', 'width=920,height=980') : null;
    if (mode === 'print' && !popup) {
      setError('Allow pop-ups for this site to preview and print the cashflow PDF.');
      return;
    }
    setPdfBusy(mode);
    try {
      if (popup) {
        popup.document.open();
        popup.document.write('<!doctype html><title>Preparing cashflow PDF</title><body style="margin:0;background:#20252a;color:#fff;font-family:Arial;display:grid;place-items:center;height:100vh">Preparing A5 cashflow report...</body>');
        popup.document.close();
        const blob = await createCashflowReportPdf(filteredEntries, filters, companySettings, { output: 'blob' });
        showPdfBlobPreview(popup, blob, `Cashflow - ${cashflowReportRangeLabel(filters)}`, true);
      } else {
        await createCashflowReportPdf(filteredEntries, filters, companySettings);
        setMessage(`A5 cashflow PDF downloaded for ${cashflowReportRangeLabel(filters)}.`);
      }
    } catch (pdfError) {
      setError(pdfError.message || String(pdfError));
      if (popup && !popup.closed) {
        popup.document.open();
        popup.document.write(`<!doctype html><title>PDF failed</title><body style="font-family:Arial;padding:30px"><h2>Could not prepare cashflow PDF</h2><p>${escapePrintHtml(pdfError.message || String(pdfError))}</p></body>`);
        popup.document.close();
      }
    } finally {
      setPdfBusy('');
    }
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

  const externalEntries = filteredEntries.filter((row) => row.documents?.document_type !== 'account_transfer');
  const cashIn = externalEntries.filter((row) => row.entry_type === 'cash_in').reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const cashOut = externalEntries.filter((row) => row.entry_type === 'cash_out').reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const nonCash = filteredEntries.filter((row) => row.entry_type === 'non_cash').reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const rangeLabel = filters.datePreset === 'today' ? 'Today' : filters.datePreset === 'week' ? 'This week' : filters.datePreset === 'month' ? 'This month' : filters.datePreset === 'custom' ? 'Custom range' : 'All time';
  const transferableMethods = paymentMethods.filter((method) => ['cash', 'bank'].includes(method.account_kind));
  const sourceAccount = cashAccounts.find((account) => account.payment_method_id === transferForm.from_payment_method_id);

  return (
    <section className="page-section cashflow-v17">
      <div className="page-actions">
        <div>
          <h3>Cashflow</h3>
          <p>Every cash movement is linked to a numbered source document. Click any row to inspect it.</p>
        </div>
        <div className="cashflow-heading-actions">
          <span>{rangeLabel}</span>
          <button className="secondary-button" disabled={!!pdfBusy} onClick={() => exportCashflow('print')}>{pdfBusy === 'print' ? 'Preparing...' : 'Print A5'}</button>
          <button className="secondary-button" disabled={!!pdfBusy} onClick={() => exportCashflow('download')}>{pdfBusy === 'download' ? 'Preparing...' : 'Download A5 PDF'}</button>
          <button className="secondary-button" disabled={transferableMethods.length < 2} onClick={() => setShowTransfer(true)}>Transfer Money</button>
          <button className="primary-button" onClick={() => setShowAdd(true)}>+ Add Cash Document</button>
        </div>
      </div>
      {error && <div className="error-box">{error}</div>}
      {message && <div className="notice success">{message}</div>}
      <div className="cashflow-summary-grid">
        <StatCard label="Cash In" value={money(cashIn)} />
        <StatCard label="Cash Out" value={money(cashOut)} />
        <StatCard label="Net" value={money(cashIn - cashOut)} />
        <StatCard label="Non-cash" value={money(nonCash)} />
      </div>

      <div className="panel-card cash-account-section">
        <div className="cash-account-heading"><div><h3>Cash & Bank Accounts</h3><p>Current balances from all recorded cashflow. Transfers move money between accounts without changing profit or total cash.</p></div><button className="primary-button" disabled={transferableMethods.length < 2} onClick={() => setShowTransfer(true)}>Transfer Money</button></div>
        <div className="cash-account-grid">
          {cashAccounts.filter((account) => ['cash', 'bank'].includes(account.account_kind) && (account.is_active || Math.abs(numberValue(account.balance)) > .004)).map((account) => <div className={`cash-account-card ${account.account_kind}`} key={account.payment_method_id}><span>{account.account_kind === 'cash' ? 'Cash drawer' : 'Bank account'}</span><strong>{account.payment_method_name}</strong><em className={numberValue(account.balance) < 0 ? 'negative-balance' : ''}>{signedMoney(account.balance)}</em><small>Current balance - all time</small></div>)}
          {!cashAccounts.some((account) => ['cash', 'bank'].includes(account.account_kind)) && <div className="muted-box">Run migration 043 to create Cash, Bank 1 and Bank 2 account balances.</div>}
        </div>
      </div>

      <div className="panel-card cashflow-date-filter">
        <div className="date-preset-buttons">
          {[['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['custom', 'Custom'], ['all', 'All time']].map(([value, label]) => <button key={value} className={filters.datePreset === value ? 'pill-button active' : 'pill-button'} onClick={() => setFilters({ ...filters, datePreset: value })}>{label}</button>)}
        </div>
        {filters.datePreset === 'custom' && <div className="custom-date-range"><label>From<input type="date" value={filters.dateFrom} onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })} /></label><span>to</span><label>To<input type="date" value={filters.dateTo} onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })} /></label></div>}
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
          <option value="cod_order">COD Orders</option>
          <option value="customer_payment">Customer payments</option>
          <option value="supplier_payment">Supplier payments</option>
          <option value="expense">Expenses</option>
          <option value="other_income">Other income</option>
          <option value="account_transfer">Account transfers</option>
        </select>
        <select value={filters.paymentMethodId} onChange={(e) => setFilters({ ...filters, paymentMethodId: e.target.value })}>
          <option value="all">All payments</option>
          {paymentMethods.map((method) => <option key={method.id} value={method.id}>{method.name}</option>)}
        </select>
      </div>

      <div className="panel-card table-wrap cashflow-table-card">
        <table>
          <thead>
            <tr><th>Date</th><th>Direction</th><th>Account</th><th>Payment</th><th>Document</th><th>Document type</th><th>Description</th><th>Amount</th><th></th></tr>
          </thead>
          <tbody>
            {filteredEntries.map((entry) => (
              <tr key={entry.id} className={entry.document_id ? 'clickable-row' : ''} onClick={() => entry.document_id && setPreviewDocumentId(entry.document_id)}>
                <td>{fmtDate(entry.created_at)}</td>
                <td><span className={`cash-direction-pill ${entry.entry_type}`}>{entry.entry_type.replace('_', ' ')}</span></td>
                <td>{entry.account_name}</td>
                <td>{entry.payment_methods?.name || '-'}</td>
                <td>{entry.document_id ? <button className="document-link-button" onClick={(event) => { event.stopPropagation(); setPreviewDocumentId(entry.document_id); }}>{entry.documents?.document_no || 'View document'}</button> : '-'}</td>
                <td>{documentTypeLabel(entry.documents?.document_type)}</td>
                <td className="description-cell">{entry.description || '-'}</td>
                <td className={entry.entry_type === 'cash_out' ? 'negative-balance' : entry.entry_type === 'cash_in' ? 'positive-balance' : ''}><strong>{entry.entry_type === 'cash_out' ? '-' : '+'}{money(entry.amount)}</strong></td>
                <td><button className="small-button" disabled={!entry.document_id} onClick={(event) => { event.stopPropagation(); if (entry.document_id) setPreviewDocumentId(entry.document_id); }}>View</button></td>
              </tr>
            ))}
            {filteredEntries.length === 0 && <EmptyRow colSpan={9} text="No cashflow entries found for this date range." />}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <div className="modal-backdrop">
          <div className="modal-card compact-modal">
            <h3>Add Cashflow Document</h3>
            <p className="muted-text">Cash out creates an Expense document. Cash in creates an Other Income document.</p>
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
                <button className="primary-button">Save document</button>
              </div>
            </form>
          </div>
        </div>
      )}
      {showTransfer && (
        <div className="modal-backdrop">
          <div className="modal-card cash-transfer-modal">
            <div className="section-title-row"><div><h3>Transfer Money</h3><p>Move money between Cash, Bank 1, Bank 2, or another bank account. This does not create income or expense.</p></div><button type="button" className="secondary-button" onClick={() => setShowTransfer(false)}>Close</button></div>
            <form onSubmit={saveAccountTransfer}>
              <div className="cash-transfer-grid">
                <label>From account<select value={transferForm.from_payment_method_id} onChange={(e) => { const fromId = e.target.value; const toId = transferForm.to_payment_method_id === fromId ? transferableMethods.find((method) => method.id !== fromId)?.id || '' : transferForm.to_payment_method_id; setTransferForm({ ...transferForm, from_payment_method_id: fromId, to_payment_method_id: toId }); }}>{transferableMethods.map((method) => <option key={method.id} value={method.id}>{method.name}</option>)}</select><small>Available: {sourceAccount ? signedMoney(sourceAccount.balance) : '-'}</small></label>
                <label>To account<select value={transferForm.to_payment_method_id} onChange={(e) => setTransferForm({ ...transferForm, to_payment_method_id: e.target.value })}>{transferableMethods.filter((method) => method.id !== transferForm.from_payment_method_id).map((method) => <option key={method.id} value={method.id}>{method.name}</option>)}</select></label>
                <label>Transfer date<input type="date" value={transferForm.transfer_date} onChange={(e) => setTransferForm({ ...transferForm, transfer_date: e.target.value })} /></label>
                <label>Amount<input type="number" min="0.01" step="0.01" value={transferForm.amount} onFocus={selectAllText} onChange={(e) => setTransferForm({ ...transferForm, amount: e.target.value })} required /></label>
                <label className="wide-field">Description<input value={transferForm.description} onChange={(e) => setTransferForm({ ...transferForm, description: e.target.value })} placeholder="Example: Daily cash deposit" /></label>
              </div>
              <div className="cash-transfer-effect"><div><span>Source</span><strong>-{money(transferForm.amount)}</strong></div><div><span>Destination</span><strong>+{money(transferForm.amount)}</strong></div><div><span>Total cash change</span><strong>{money(0)}</strong></div></div>
              <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setShowTransfer(false)}>Cancel</button><button className="primary-button">Save Transfer</button></div>
            </form>
          </div>
        </div>
      )}
      {previewDocumentId && <DocumentPreviewModal documentId={previewDocumentId} onClose={() => setPreviewDocumentId('')} />}
    </section>
  );
}


function localDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function WarrantyPage() {
  const [section, setSection] = useState('claims');
  const [records, setRecords] = useState([]);
  const [claims, setClaims] = useState([]);
  const [products, setProducts] = useState([]);
  const [events, setEvents] = useState([]);
  const [selectedClaimId, setSelectedClaimId] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [showRegister, setShowRegister] = useState(false);
  const [invoiceSearch, setInvoiceSearch] = useState('');
  const [invoiceMatches, setInvoiceMatches] = useState([]);
  const [registerInvoice, setRegisterInvoice] = useState(null);
  const [registerItems, setRegisterItems] = useState([]);
  const [registerForm, setRegisterForm] = useState({ itemId: '', serialNumber: '', warrantyMonths: 0, warrantyStart: todayInputDate(), notes: '' });
  const [claimRecord, setClaimRecord] = useState(null);
  const [claimForm, setClaimForm] = useState({ issue: '', receivedCondition: '', notes: '' });
  const [claimUpdate, setClaimUpdate] = useState({ status: 'received', resolution: '', notes: '', replacementProductId: '', replacementSerialNumber: '' });

  useEffect(() => { loadWarrantyData(); }, []);
  useEffect(() => {
    if (!selectedClaimId) { setEvents([]); return; }
    supabase.from('warranty_claim_events').select('*').eq('claim_id', selectedClaimId).order('created_at').then(({ data }) => setEvents(data || []));
  }, [selectedClaimId]);
  useEffect(() => {
    const claim = claims.find((row) => row.id === selectedClaimId);
    if (!claim) return;
    setClaimUpdate({ status: claim.status, resolution: claim.resolution || '', notes: claim.internal_notes || '', replacementProductId: claim.replacement_product_id || claim.product_id || '', replacementSerialNumber: claim.replacement_serial_number || '' });
  }, [selectedClaimId, claims]);
  useRealtimeRefresh(['warranty_records', 'warranty_claims', 'warranty_claim_events', 'documents', 'document_items', 'products'], () => {
    loadWarrantyData();
    if (selectedClaimId) {
      supabase.from('warranty_claim_events').select('*').eq('claim_id', selectedClaimId).order('created_at').then(({ data }) => setEvents(data || []));
    }
  });

  async function loadWarrantyData() {
    setLoading(true); setError('');
    const [recordRes, claimRes, productRes] = await Promise.all([
      supabase.from('warranty_register_view').select('*').order('created_at', { ascending: false }).limit(2000),
      supabase.from('warranty_claims_view').select('*').order('created_at', { ascending: false }).limit(2000),
      supabase.from('products').select('id, item_code, name, warranty_months, serial_required, is_active').eq('is_active', true).order('item_code').limit(2500)
    ]);
    const loadError = recordRes.error || claimRes.error || productRes.error;
    if (loadError) setError(`${loadError.message}. Run migration 034_warranty_register_and_claims.sql if it has not been applied.`);
    else {
      setRecords(recordRes.data || []);
      setClaims(claimRes.data || []);
      setProducts(productRes.data || []);
      setSelectedClaimId((current) => current && (claimRes.data || []).some((row) => row.id === current) ? current : (claimRes.data || [])[0]?.id || '');
    }
    setLoading(false);
  }

  const selectedClaim = claims.find((row) => row.id === selectedClaimId) || null;
  const cleanSearch = search.trim().toLowerCase();
  const visibleRecords = records.filter((row) => !cleanSearch || `${row.warranty_no} ${row.serial_number || ''} ${row.document_no} ${row.product_code} ${row.product_name} ${row.customer_name || ''} ${row.customer_phone || ''}`.toLowerCase().includes(cleanSearch));
  const visibleClaims = claims.filter((row) => !cleanSearch || `${row.claim_no} ${row.warranty_no} ${row.serial_number || ''} ${row.document_no} ${row.product_code} ${row.product_name} ${row.customer_name || ''} ${row.customer_phone || ''} ${row.status}`.toLowerCase().includes(cleanSearch));
  const openStatuses = new Set(['received', 'checking', 'sent_supplier', 'ready']);
  const activeWarranties = records.filter((row) => row.display_status === 'active').length;
  const openClaims = claims.filter((row) => openStatuses.has(row.status)).length;
  const expiringSoon = records.filter((row) => {
    if (row.display_status !== 'active') return false;
    const days = (new Date(`${row.warranty_end}T00:00:00`) - new Date()) / 86400000;
    return days >= 0 && days <= 30;
  }).length;

  function resetRegister() {
    setInvoiceSearch(''); setInvoiceMatches([]); setRegisterInvoice(null); setRegisterItems([]);
    setRegisterForm({ itemId: '', serialNumber: '', warrantyMonths: 0, warrantyStart: todayInputDate(), notes: '' });
  }

  async function findInvoices(event) {
    event.preventDefault();
    const term = invoiceSearch.trim();
    if (!term) return;
    setBusy(true); setError('');
    const { data, error: searchError } = await supabase.from('documents')
      .select('id, document_no, document_date, customer_id, customers:customers!documents_customer_id_fkey(id, name, phone)')
      .eq('document_type', 'invoice').ilike('document_no', `%${term}%`).order('document_date', { ascending: false }).limit(15);
    setBusy(false);
    if (searchError) setError(searchError.message); else setInvoiceMatches(data || []);
  }

  async function chooseInvoice(invoice) {
    setBusy(true); setError(''); setRegisterInvoice(invoice);
    const { data, error: itemError } = await supabase.from('document_items').select('id, document_id, product_id, item_code, description, qty').eq('document_id', invoice.id).gt('qty', 0).order('created_at');
    setBusy(false);
    if (itemError) { setError(itemError.message); return; }
    const rows = data || [];
    setRegisterItems(rows);
    const firstAvailable = rows.find((item) => records.filter((row) => row.sale_document_item_id === item.id && row.status !== 'void').length < Math.floor(numberValue(item.qty)));
    if (firstAvailable) selectRegisterItem(firstAvailable, invoice);
  }

  function selectRegisterItem(item, invoice = registerInvoice) {
    const product = products.find((row) => row.id === item.product_id);
    setRegisterForm({ itemId: item.id, serialNumber: '', warrantyMonths: numberValue(product?.warranty_months), warrantyStart: String(invoice?.document_date || todayInputDate()).slice(0, 10), notes: '' });
  }

  async function registerWarranty(event) {
    event.preventDefault();
    setBusy(true); setError(''); setMessage('');
    const { data, error: registerError } = await supabase.rpc('register_product_warranty_v34', {
      p_sale_document_item_id: registerForm.itemId,
      p_serial_number: registerForm.serialNumber.trim() || null,
      p_warranty_months: Math.round(numberValue(registerForm.warrantyMonths)),
      p_warranty_start: registerForm.warrantyStart,
      p_notes: registerForm.notes.trim() || null
    });
    setBusy(false);
    if (registerError) { setError(registerError.message); return; }
    setMessage(`Warranty registered: ${data?.warranty_no || ''}. Expiry ${fmtDate(data?.warranty_end)}.`);
    setShowRegister(false); resetRegister(); await loadWarrantyData();
  }

  function openNewClaim(record) {
    setClaimRecord(record);
    setClaimForm({ issue: '', receivedCondition: '', notes: '' });
    setError('');
  }

  async function createClaim(event) {
    event.preventDefault();
    setBusy(true); setError(''); setMessage('');
    const { data, error: claimError } = await supabase.rpc('create_warranty_claim_v34', {
      p_warranty_record_id: claimRecord.id,
      p_issue: claimForm.issue.trim(),
      p_received_condition: claimForm.receivedCondition.trim() || null,
      p_notes: claimForm.notes.trim() || null
    });
    setBusy(false);
    if (claimError) { setError(claimError.message); return; }
    setMessage(`Warranty claim created: ${data?.claim_no || ''}.`);
    setClaimRecord(null); await loadWarrantyData(); setSection('claims'); setSelectedClaimId(data?.id || '');
  }

  function selectClaim(claim) {
    setSelectedClaimId(claim.id);
    setClaimUpdate({ status: claim.status, resolution: claim.resolution || '', notes: claim.internal_notes || '', replacementProductId: claim.replacement_product_id || claim.product_id || '', replacementSerialNumber: claim.replacement_serial_number || '' });
  }

  async function updateClaim(event) {
    event.preventDefault();
    if (!selectedClaim) return;
    setBusy(true); setError(''); setMessage('');
    const { data, error: updateError } = await supabase.rpc('update_warranty_claim_v34', {
      p_claim_id: selectedClaim.id,
      p_status: claimUpdate.status,
      p_resolution: claimUpdate.resolution.trim() || null,
      p_notes: claimUpdate.notes.trim() || null,
      p_replacement_product_id: claimUpdate.status === 'replaced' ? claimUpdate.replacementProductId || null : null,
      p_replacement_serial_number: claimUpdate.status === 'replaced' ? claimUpdate.replacementSerialNumber.trim() || null : null
    });
    setBusy(false);
    if (updateError) { setError(updateError.message); return; }
    setMessage(`${data?.claim_no || selectedClaim.claim_no} updated to ${String(data?.status || claimUpdate.status).replaceAll('_', ' ')}.`);
    await loadWarrantyData();
  }

  return (
    <section className="page-section warranty-page">
      <div className="warranty-page-heading">
        <div><span>After-sales service</span><h2>Warranty</h2><p>Register sold units, find warranties by serial or invoice, and preserve expiry when an item is replaced.</p></div>
        <button className="primary-button" onClick={() => { resetRegister(); setShowRegister(true); }}>Register Warranty</button>
      </div>
      <div className="warranty-summary-grid">
        <StatCard label="Registered Warranties" value={records.length} />
        <StatCard label="Active Warranties" value={activeWarranties} />
        <StatCard label="Open Claims" value={openClaims} />
        <StatCard label="Expiring in 30 Days" value={expiringSoon} />
      </div>
      <div className="panel-card warranty-toolbar">
        <div className="product-section-tabs"><button className={section === 'claims' ? 'active' : ''} onClick={() => setSection('claims')}>Claims</button><button className={section === 'register' ? 'active' : ''} onClick={() => setSection('register')}>Warranty Register</button></div>
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search claim, warranty, serial, invoice, customer or product" />
        <button className="secondary-button" onClick={loadWarrantyData}>Refresh</button>
      </div>
      {message && <div className="notice">{message}</div>}
      {error && <div className="error-box">{error}</div>}
      {loading && <div className="notice">Loading warranties...</div>}

      {section === 'claims' ? <div className="warranty-workspace">
        <div className="panel-card table-wrap warranty-list-table"><table><thead><tr><th>Claim</th><th>Received</th><th>Customer</th><th>Product</th><th>Serial</th><th>Status</th></tr></thead><tbody>{visibleClaims.map((claim) => <tr key={claim.id} className={selectedClaimId === claim.id ? 'selected-row' : ''} onClick={() => selectClaim(claim)}><td><strong>{claim.claim_no}</strong><small>{claim.warranty_no}</small></td><td>{fmtDate(claim.created_at)}</td><td>{claim.customer_name || 'Walk-in'}<small>{claim.customer_phone || ''}</small></td><td>{claim.product_code}<small>{claim.product_name}</small></td><td>{claim.serial_number || '-'}</td><td><span className={`warranty-status ${claim.status}`}>{claim.status.replaceAll('_', ' ')}</span></td></tr>)}{!visibleClaims.length && <EmptyRow colSpan={6} text="No warranty claims found." />}</tbody></table></div>
        <div className="panel-card warranty-claim-detail">{selectedClaim ? <>
          <div className="warranty-detail-heading"><div><span>Claim</span><h3>{selectedClaim.claim_no}</h3><p>{selectedClaim.product_code} · {selectedClaim.product_name}</p></div><span className={`warranty-status large ${selectedClaim.status}`}>{selectedClaim.status.replaceAll('_', ' ')}</span></div>
          <div className="warranty-detail-grid"><div><span>Customer</span><strong>{selectedClaim.customer_name || 'Walk-in'}</strong><small>{selectedClaim.customer_phone || '-'}</small></div><div><span>Original invoice</span><strong>{selectedClaim.document_no}</strong><small>{fmtDate(selectedClaim.document_date)}</small></div><div><span>Serial number</span><strong>{selectedClaim.serial_number || 'Not recorded'}</strong></div><div><span>Warranty expires</span><strong>{fmtDate(selectedClaim.original_warranty_end)}</strong></div></div>
          <div className="warranty-issue"><span>Reported issue</span><p>{selectedClaim.issue}</p>{selectedClaim.received_condition && <small>Received condition: {selectedClaim.received_condition}</small>}</div>
          <form className="warranty-update-form" onSubmit={updateClaim}>
            <label>Status<select value={claimUpdate.status} onChange={(event) => setClaimUpdate({ ...claimUpdate, status: event.target.value })}>{WARRANTY_CLAIM_STATUSES.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}</select></label>
            <label>Resolution / customer-facing note<textarea value={claimUpdate.resolution} onChange={(event) => setClaimUpdate({ ...claimUpdate, resolution: event.target.value })} /></label>
            <label>Internal notes<textarea value={claimUpdate.notes} onChange={(event) => setClaimUpdate({ ...claimUpdate, notes: event.target.value })} /></label>
            {claimUpdate.status === 'replaced' && <div className="warranty-replacement-box"><strong>Replacement item</strong><p>The new unit keeps the original expiry date: {fmtDate(selectedClaim.original_warranty_end)}.</p><label>Replacement product<select value={claimUpdate.replacementProductId} onChange={(event) => setClaimUpdate({ ...claimUpdate, replacementProductId: event.target.value })}><option value="">Select product</option>{products.map((product) => <option key={product.id} value={product.id}>{product.item_code} · {product.name}</option>)}</select></label><label>Replacement serial number<input value={claimUpdate.replacementSerialNumber} onChange={(event) => setClaimUpdate({ ...claimUpdate, replacementSerialNumber: event.target.value })} placeholder="Scan or type new serial" /></label></div>}
            <button className="primary-button" disabled={busy}>{busy ? 'Saving...' : 'Update Claim'}</button>
          </form>
          <div className="warranty-timeline"><h4>Claim history</h4>{events.map((event) => <div key={event.id}><span /><p><strong>{String(event.status).replaceAll('_', ' ')}</strong><small>{new Date(event.created_at).toLocaleString('en-LK')}</small>{event.note && <em>{event.note}</em>}</p></div>)}{!events.length && <small>No history entries.</small>}</div>
        </> : <div className="muted-box">Select a warranty claim.</div>}</div>
      </div> : <div className="panel-card table-wrap warranty-register-table"><table><thead><tr><th>Warranty</th><th>Product</th><th>Customer</th><th>Invoice</th><th>Serial</th><th>Start</th><th>Expiry</th><th>Status</th><th></th></tr></thead><tbody>{visibleRecords.map((record) => <tr key={record.id}><td><strong>{record.warranty_no}</strong>{record.replaces_warranty_no && <small>Replaces {record.replaces_warranty_no}</small>}</td><td>{record.product_code}<small>{record.product_name}</small></td><td>{record.customer_name || 'Walk-in'}<small>{record.customer_phone || ''}</small></td><td>{record.document_no}</td><td>{record.serial_number || '-'}</td><td>{fmtDate(record.warranty_start)}</td><td>{fmtDate(record.warranty_end)}</td><td><span className={`warranty-status ${record.display_status}`}>{record.display_status}</span></td><td><button className="small-button" disabled={record.display_status !== 'active'} onClick={() => openNewClaim(record)}>New Claim</button></td></tr>)}{!visibleRecords.length && <EmptyRow colSpan={9} text="No registered warranties found." />}</tbody></table></div>}

      {showRegister && <div className="modal-backdrop warranty-modal-backdrop"><div className="modal-card warranty-register-modal"><div className="section-title-row"><div><h3>Register Sold Item Warranty</h3><p>Find the original invoice, then register one sold unit and its serial number.</p></div><button className="secondary-button" onClick={() => setShowRegister(false)}>Close</button></div><form className="warranty-invoice-search" onSubmit={findInvoices}><input value={invoiceSearch} onChange={(event) => setInvoiceSearch(event.target.value)} placeholder="Invoice number" autoFocus /><button className="secondary-button" disabled={busy}>Find Invoice</button></form>{invoiceMatches.length > 0 && <div className="warranty-invoice-results">{invoiceMatches.map((invoice) => <button type="button" key={invoice.id} className={registerInvoice?.id === invoice.id ? 'selected' : ''} onClick={() => chooseInvoice(invoice)}><strong>{invoice.document_no}</strong><span>{fmtDate(invoice.document_date)}</span><small>{invoice.customers?.name || 'Walk-in'} {invoice.customers?.phone || ''}</small></button>)}</div>}{registerInvoice && <form className="warranty-register-form" onSubmit={registerWarranty}><div className="warranty-register-invoice"><span>Selected invoice</span><strong>{registerInvoice.document_no}</strong><small>{registerInvoice.customers?.name || 'Walk-in'} · {fmtDate(registerInvoice.document_date)}</small></div><div className="warranty-sale-items">{registerItems.map((item) => { const product = products.find((row) => row.id === item.product_id); const registered = records.filter((row) => row.sale_document_item_id === item.id && !row.replaces_warranty_record_id && row.status !== 'void').length; const full = registered >= Math.floor(numberValue(item.qty)); return <button type="button" key={item.id} disabled={full} className={registerForm.itemId === item.id ? 'selected' : ''} onClick={() => selectRegisterItem(item)}><strong>{item.item_code}</strong><span>{item.description}</span><small>Sold {numberValue(item.qty)} · Registered {registered}{product?.serial_required ? ' · Serial required' : ''}</small></button>; })}</div>{registerForm.itemId && <div className="warranty-register-fields"><label>Serial number<input value={registerForm.serialNumber} onChange={(event) => setRegisterForm({ ...registerForm, serialNumber: event.target.value })} placeholder="Scan or type serial" /></label><label>Warranty months<input type="number" min="1" step="1" value={registerForm.warrantyMonths} onChange={(event) => setRegisterForm({ ...registerForm, warrantyMonths: event.target.value })} required /></label><label>Warranty starts<input type="date" value={registerForm.warrantyStart} onChange={(event) => setRegisterForm({ ...registerForm, warrantyStart: event.target.value })} required /></label><label className="wide-field">Notes<textarea value={registerForm.notes} onChange={(event) => setRegisterForm({ ...registerForm, notes: event.target.value })} /></label><button className="primary-button" disabled={busy}>{busy ? 'Registering...' : 'Register Warranty'}</button></div>}</form>}</div></div>}

      {claimRecord && <div className="modal-backdrop warranty-modal-backdrop"><form className="modal-card warranty-claim-modal" onSubmit={createClaim}><div className="section-title-row"><div><h3>New Warranty Claim</h3><p>{claimRecord.warranty_no} · {claimRecord.product_code} · {claimRecord.serial_number || 'No serial'}</p></div><button type="button" className="secondary-button" onClick={() => setClaimRecord(null)}>Close</button></div><div className="warranty-validity"><span>Original invoice {claimRecord.document_no}</span><strong>Warranty valid until {fmtDate(claimRecord.warranty_end)}</strong></div><label>Reported issue<textarea value={claimForm.issue} onChange={(event) => setClaimForm({ ...claimForm, issue: event.target.value })} required autoFocus /></label><label>Condition received<input value={claimForm.receivedCondition} onChange={(event) => setClaimForm({ ...claimForm, receivedCondition: event.target.value })} placeholder="Example: no power, scratches on case" /></label><label>Internal notes<textarea value={claimForm.notes} onChange={(event) => setClaimForm({ ...claimForm, notes: event.target.value })} /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setClaimRecord(null)}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? 'Saving...' : 'Create Claim'}</button></div></form></div>}
    </section>
  );
}

function reportPeriodRange(preset, customFrom, customTo) {
  const now = new Date();
  if (preset === 'last_month') {
    return {
      from: localDateInput(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: localDateInput(new Date(now.getFullYear(), now.getMonth(), 0))
    };
  }
  if (preset === 'custom') {
    const first = customFrom || todayInputDate();
    const second = customTo || first;
    return first <= second ? { from: first, to: second } : { from: second, to: first };
  }
  return {
    from: localDateInput(new Date(now.getFullYear(), now.getMonth(), 1)),
    to: localDateInput(new Date(now.getFullYear(), now.getMonth() + 1, 0))
  };
}

function reportQueryBounds(period) {
  const start = new Date(`${period.from}T00:00:00`);
  const endExclusive = new Date(`${period.to}T00:00:00`);
  endExclusive.setDate(endExclusive.getDate() + 1);
  return { start: start.toISOString(), endExclusive: endExclusive.toISOString() };
}

const REPORT_LIBRARY = [
  { title: 'Sales', reports: [
    { id: 'profit_margin', label: 'Profit & Margin' },
    { id: 'payment_types', label: 'Payment Types' },
    { id: 'payment_types_customers', label: 'Payment Types by Customers' },
    { id: 'sales_customers', label: 'Sales by Customers' },
    { id: 'invoice_list', label: 'Invoice List' },
    { id: 'unpaid_sales', label: 'Unpaid Sales' }
  ] },
  { title: 'Purchase', reports: [
    { id: 'purchased_products', label: 'Purchased Products' },
    { id: 'purchase_invoices', label: 'Purchase Invoice List' },
    { id: 'unpaid_purchases', label: 'Unpaid Purchases' }
  ] },
  { title: 'Operations', reports: [
    { id: 'cod_orders', label: 'COD Orders' },
    { id: 'jobs_repairs', label: 'Jobs & Repairs' },
    { id: 'inventory_documents', label: 'Inventory Documents' }
  ] },
  { title: 'Inventory', reports: [
    { id: 'stock_movement', label: 'Stock Movement' }
  ] },
  { title: 'Finance', reports: [
    { id: 'transaction_history', label: 'Transaction History' }
  ] }
];

const CUSTOMER_REPORT_FILTERS = new Set(['profit_margin', 'payment_types_customers', 'sales_customers', 'invoice_list', 'unpaid_sales', 'transaction_history']);
const SUPPLIER_REPORT_FILTERS = new Set(['purchased_products', 'purchase_invoices', 'unpaid_purchases']);
const PAYMENT_REPORT_FILTERS = new Set(['payment_types', 'payment_types_customers', 'transaction_history']);

function reportGroup(rows, keyForRow, seedForRow, addRow) {
  return Array.from(rows.reduce((map, row) => {
    const key = keyForRow(row);
    const current = map.get(key) || seedForRow(row, key);
    addRow(current, row);
    map.set(key, current);
    return map;
  }, new Map()).values());
}

function reportAmount(value) {
  return Number(value || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ReportResultTable({ columns, rows, footer = null, emptyText = 'No records found for this report.' }) {
  return (
    <div className="table-wrap report-result-table">
      <table>
        <thead><tr>{columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, index) => <tr key={row.id || row.key || index}>{columns.map((column) => <td key={column.key} className={typeof column.className === 'function' ? column.className(row) : column.className || ''}>{column.render ? column.render(row) : row[column.key]}</td>)}</tr>)}
          {!rows.length && <EmptyRow colSpan={columns.length} text={emptyText} />}
        </tbody>
        {footer && rows.length > 0 && <tfoot><tr>{columns.map((column) => <td key={column.key}>{footer[column.key] ?? ''}</td>)}</tr></tfoot>}
      </table>
    </div>
  );
}

function ReportsPage() {
  const [activeReport, setActiveReport] = useState('');
  const [reportVisible, setReportVisible] = useState(false);
  const [reportSearch, setReportSearch] = useState('');
  const [periodPreset, setPeriodPreset] = useState('this_month');
  const [customFrom, setCustomFrom] = useState(todayInputDate());
  const [customTo, setCustomTo] = useState(todayInputDate());
  const [customerId, setCustomerId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [paymentMethodId, setPaymentMethodId] = useState('');
  const [documents, setDocuments] = useState([]);
  const [items, setItems] = useState([]);
  const [cashflows, setCashflows] = useState([]);
  const [stockMovements, setStockMovements] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [companySettings, setCompanySettings] = useState(DEFAULT_COMPANY_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const period = useMemo(() => reportPeriodRange(periodPreset, customFrom, customTo), [periodPreset, customFrom, customTo]);
  const periodBounds = useMemo(() => reportQueryBounds(period), [period.from, period.to]);

  useEffect(() => { loadReportLookups(); }, []);
  useEffect(() => {
    const timeout = setTimeout(() => loadPeriodReports(), 160);
    return () => clearTimeout(timeout);
  }, [period.from, period.to]);
  useRealtimeRefresh(['documents', 'document_items', 'cashflow_entries', 'stock_movements'], loadPeriodReports, 420);
  useRealtimeRefresh(['customers', 'suppliers', 'payment_methods', 'company_settings'], loadReportLookups, 420);

  async function loadReportLookups() {
    const [customerRes, supplierRes, paymentRes, companyRes] = await Promise.all([
      supabase.from('customers').select('id, name, phone, address, due_balance, store_credit_balance').order('name').limit(2000),
      supabase.from('suppliers').select('id, name, phone, address, payable_balance').order('name').limit(2000),
      supabase.from('payment_methods').select('id, name, is_paid_method, affects_cashflow, is_active').order('name'),
      fetchCompanySettings().then((data) => ({ data, error: null })).catch((companyError) => ({ data: null, error: companyError }))
    ]);
    const lookupError = customerRes.error || supplierRes.error || paymentRes.error || companyRes.error;
    if (lookupError) setError(lookupError.message);
    if (!customerRes.error) setCustomers(customerRes.data || []);
    if (!supplierRes.error) setSuppliers(supplierRes.data || []);
    if (!paymentRes.error) setPaymentMethods(paymentRes.data || []);
    if (!companyRes.error && companyRes.data) setCompanySettings(companyRes.data);
  }

  async function loadPeriodReports() {
    setLoading(true);
    setError('');
    const [documentRes, cashflowRes, movementRes] = await Promise.all([
      supabase.from('documents')
        .select('id, document_no, document_type, status, customer_id, supplier_id, total_amount, paid_amount, balance_amount, document_date, created_at, notes, external_document_no, linked_document_id, job_no, job_status, recipient_name, delivery_phone, delivery_service, tracking_number, cod_collect_amount')
        .gte('document_date', periodBounds.start)
        .lt('document_date', periodBounds.endExclusive)
        .order('document_date', { ascending: false })
        .limit(2000),
      supabase.from('cashflow_entries')
        .select('id, document_id, entry_type, account_name, payment_method_id, amount, description, created_at, payment_methods(name)')
        .gte('created_at', periodBounds.start)
        .lt('created_at', periodBounds.endExclusive)
        .order('created_at', { ascending: false })
        .limit(3000),
      supabase.from('stock_movements')
        .select('id, product_id, document_id, movement_type, qty, unit_cost, notes, created_at, products(item_code, name), documents(document_no, document_type)')
        .gte('created_at', periodBounds.start)
        .lt('created_at', periodBounds.endExclusive)
        .order('created_at', { ascending: false })
        .limit(4000)
    ]);
    const loadError = documentRes.error || cashflowRes.error || movementRes.error;
    if (loadError) { setError(loadError.message); setLoading(false); return; }
    const rows = documentRes.data || [];
    let itemRows = [];
    if (rows.length) {
      const documentIds = rows.map((row) => row.id);
      const batches = [];
      for (let index = 0; index < documentIds.length; index += 200) batches.push(documentIds.slice(index, index + 200));
      const itemResults = await Promise.all(batches.map((batch) => supabase.from('document_items').select('id, document_id, product_id, item_code, description, qty, unit_price, unit_cost, discount_type, discount_value, line_total').in('document_id', batch).limit(8000)));
      const itemError = itemResults.find((result) => result.error)?.error;
      if (itemError) setError(itemError.message); else itemRows = itemResults.flatMap((result) => result.data || []);
    }
    setDocuments(rows);
    setItems(itemRows);
    setCashflows(cashflowRes.data || []);
    setStockMovements(movementRes.data || []);
    setLoading(false);
  }

  const customerMap = useMemo(() => new Map(customers.map((row) => [row.id, row])), [customers]);
  const supplierMap = useMemo(() => new Map(suppliers.map((row) => [row.id, row])), [suppliers]);
  const documentMap = useMemo(() => new Map(documents.map((row) => [row.id, row])), [documents]);
  const salesDocuments = documents.filter((row) => row.document_type === 'invoice' && (!customerId || row.customer_id === customerId));
  const salesDocumentIds = new Set(salesDocuments.map((row) => row.id));
  const salesItems = items.filter((row) => salesDocumentIds.has(row.document_id));
  const purchaseDocuments = documents.filter((row) => row.document_type === 'purchase' && (!supplierId || row.supplier_id === supplierId));
  const purchaseDocumentIds = new Set(purchaseDocuments.map((row) => row.id));
  const purchaseItems = items.filter((row) => purchaseDocumentIds.has(row.document_id));
  const salesRevenue = salesItems.reduce((sum, row) => sum + numberValue(row.line_total), 0);
  const salesCost = salesItems.reduce((sum, row) => sum + numberValue(row.qty) * numberValue(row.unit_cost), 0);
  const salesProfit = salesRevenue - salesCost;
  const productPerformance = reportGroup(salesItems, (row) => row.product_id || `${row.item_code}|${row.description}`, (row, key) => ({ id: key, item_code: row.item_code || '-', description: row.description || '-', qty: 0, sales: 0, cost: 0 }), (current, row) => { current.qty += numberValue(row.qty); current.sales += numberValue(row.line_total); current.cost += numberValue(row.qty) * numberValue(row.unit_cost); }).sort((a, b) => b.sales - a.sales);
  const purchasedProducts = reportGroup(purchaseItems, (row) => row.product_id || `${row.item_code}|${row.description}`, (row, key) => ({ id: key, item_code: row.item_code || '-', description: row.description || '-', qty: 0, value: 0 }), (current, row) => { current.qty += numberValue(row.qty); current.value += numberValue(row.line_total) || numberValue(row.qty) * numberValue(row.unit_cost); }).sort((a, b) => b.value - a.value);
  const invoicePaymentFlows = cashflows.filter((flow) => {
    const doc = documentMap.get(flow.document_id);
    if (doc?.document_type !== 'invoice') return false;
    if (customerId && doc.customer_id !== customerId) return false;
    if (paymentMethodId && flow.payment_method_id !== paymentMethodId) return false;
    return true;
  });
  const paymentTypeRows = reportGroup(invoicePaymentFlows, (row) => row.payment_method_id || row.account_name || 'unknown', (row, key) => ({ id: key, method: row.payment_methods?.name || row.account_name || 'Unknown', transactions: 0, collected: 0, refunded: 0, credit: 0 }), (current, row) => { current.transactions += 1; if (row.entry_type === 'cash_in') current.collected += numberValue(row.amount); else if (row.entry_type === 'cash_out') current.refunded += numberValue(row.amount); else current.credit += numberValue(row.amount); }).sort((a, b) => b.collected - a.collected);
  const paymentNamesByDocument = cashflows.reduce((map, row) => {
    const name = row.payment_methods?.name || row.account_name || 'Unknown';
    const names = map.get(row.document_id) || new Set();
    names.add(name);
    map.set(row.document_id, names);
    return map;
  }, new Map());
  const paymentPivotMethods = Array.from(invoicePaymentFlows.reduce((map, row) => {
    const key = row.payment_method_id || row.account_name || 'unknown';
    if (!map.has(key)) map.set(key, { key, name: row.payment_methods?.name || row.account_name || 'Unknown' });
    return map;
  }, new Map()).values()).sort((a, b) => a.name.localeCompare(b.name));
  const paymentCustomerRows = reportGroup(invoicePaymentFlows, (row) => documentMap.get(row.document_id)?.customer_id || 'walk-in', (row, key) => ({ id: key, customer: customerMap.get(documentMap.get(row.document_id)?.customer_id)?.name || 'Walk-in customer', amounts: {}, total: 0 }), (current, row) => {
    const methodKey = row.payment_method_id || row.account_name || 'unknown';
    const signedAmount = row.entry_type === 'cash_out' ? -numberValue(row.amount) : numberValue(row.amount);
    current.amounts[methodKey] = numberValue(current.amounts[methodKey]) + signedAmount;
    current.total += signedAmount;
  }).sort((a, b) => a.customer.localeCompare(b.customer));
  const salesCustomerRows = reportGroup(salesDocuments, (row) => row.customer_id || 'walk-in', (row, key) => ({ id: key, customer: customerMap.get(row.customer_id)?.name || 'Walk-in', invoices: 0, total: 0, paid: 0, balance: 0 }), (current, row) => { current.invoices += 1; current.total += numberValue(row.total_amount); current.paid += numberValue(row.paid_amount); current.balance += numberValue(row.balance_amount); }).sort((a, b) => b.total - a.total);
  const filteredCashflows = cashflows.filter((flow) => { const doc = documentMap.get(flow.document_id); if (customerId && doc?.customer_id !== customerId) return false; if (paymentMethodId && flow.payment_method_id !== paymentMethodId) return false; return true; });

  function supplierName(row) { return supplierMap.get(row.supplier_id)?.name || customerMap.get(row.customer_id)?.name || '-'; }

  function buildReport() {
    const commonInvoiceColumns = [
      { key: 'report_index', label: '#' },
      { key: 'date', label: 'Date', render: (row) => fmtDate(row.document_date) },
      { key: 'document_no', label: 'Document number' },
      { key: 'customer', label: 'Customer', render: (row) => customerMap.get(row.customer_id)?.name || 'Walk-in' },
      { key: 'payment_method', label: 'Payment method', render: (row) => Array.from(paymentNamesByDocument.get(row.id) || []).join(', ') || '-' },
      { key: 'total', label: 'Total', render: (row) => reportAmount(row.total_amount), className: 'report-number' }
    ];
    if (activeReport === 'profit_margin') return {
      title: 'Profit & Margin', printTitle: 'PROFIT', description: 'Net item sales after discounts compared with the recorded item cost.', totals: [],
      columns: [
        { key: 'item_code', label: 'Code' },
        { key: 'description', label: 'Product' },
        { key: 'qty', label: 'Quantity', render: (row) => reportAmount(row.qty), className: 'report-number' },
        { key: 'cost', label: 'Cost', render: (row) => reportAmount(row.cost), className: 'report-number' },
        { key: 'sales', label: 'Total', render: (row) => reportAmount(row.sales), className: 'report-number' },
        { key: 'profit', label: 'Profit', render: (row) => reportAmount(row.sales - row.cost), className: 'report-number' },
        { key: 'margin', label: 'Margin', render: (row) => row.sales ? formatPercent(((row.sales - row.cost) / row.sales) * 100) : '0.00%', className: 'report-number' }
      ],
      footer: { description: 'Total', cost: reportAmount(salesCost), sales: reportAmount(salesRevenue), profit: reportAmount(salesProfit), margin: salesRevenue ? formatPercent((salesProfit / salesRevenue) * 100) : '0.00%' },
      rows: productPerformance
    };
    if (activeReport === 'payment_types') return { title: 'Payment Types', description: 'How sales invoices were paid during the selected period.', totals: [['Collected', money(paymentTypeRows.reduce((sum, row) => sum + row.collected, 0))], ['Refunded', money(paymentTypeRows.reduce((sum, row) => sum + row.refunded, 0))], ['Credit', money(paymentTypeRows.reduce((sum, row) => sum + row.credit, 0))]], columns: [{ key: 'method', label: 'Payment Type' }, { key: 'transactions', label: 'Entries' }, { key: 'collected', label: 'Collected', render: (row) => money(row.collected) }, { key: 'refunded', label: 'Refunded', render: (row) => money(row.refunded) }, { key: 'credit', label: 'Credit', render: (row) => money(row.credit) }, { key: 'net', label: 'Net Collected', render: (row) => money(row.collected - row.refunded) }], rows: paymentTypeRows };
    if (activeReport === 'payment_types_customers') {
      const columns = [
        { key: 'customer', label: 'Customer' },
        ...paymentPivotMethods.map((method) => ({
          key: `method_${method.key}`,
          label: method.name,
          render: (row) => numberValue(row.amounts[method.key]) ? reportAmount(row.amounts[method.key]) : '',
          className: 'report-number'
        })),
        { key: 'total', label: 'Total', render: (row) => reportAmount(row.total), className: 'report-number' }
      ];
      const footer = { customer: 'Total', total: reportAmount(paymentCustomerRows.reduce((sum, row) => sum + row.total, 0)) };
      paymentPivotMethods.forEach((method) => { footer[`method_${method.key}`] = reportAmount(paymentCustomerRows.reduce((sum, row) => sum + numberValue(row.amounts[method.key]), 0)); });
      return { title: 'Payment Types by Customers', printTitle: 'PAYMENT TYPES BY CUSTOMERS', description: 'Payment methods used by each customer for sales invoices.', totals: [], columns, footer, rows: paymentCustomerRows };
    }
    if (activeReport === 'sales_customers') return { title: 'Sales by Customers', description: 'Invoice totals and balances grouped by customer.', totals: [['Sales', money(salesCustomerRows.reduce((sum, row) => sum + row.total, 0))], ['Outstanding', money(salesCustomerRows.reduce((sum, row) => sum + row.balance, 0))]], columns: [{ key: 'customer', label: 'Customer' }, { key: 'invoices', label: 'Invoices' }, { key: 'total', label: 'Sales', render: (row) => money(row.total) }, { key: 'paid', label: 'Paid', render: (row) => money(row.paid) }, { key: 'balance', label: 'Outstanding', render: (row) => money(row.balance) }], rows: salesCustomerRows };
    if (activeReport === 'invoice_list') {
      const rows = salesDocuments.map((row, index) => ({ ...row, report_index: index + 1 }));
      return { title: 'Invoice List', printTitle: 'INVOICE LIST', description: 'All sales invoices in the selected period.', totals: [], columns: commonInvoiceColumns, footer: { payment_method: 'Total', total: reportAmount(rows.reduce((sum, row) => sum + numberValue(row.total_amount), 0)) }, rows };
    }
    if (activeReport === 'unpaid_sales') { const rows = salesDocuments.filter((row) => numberValue(row.balance_amount) > 0).map((row, index) => ({ ...row, report_index: index + 1 })); return { title: 'Unpaid Sales', description: 'Sales invoices with an amount still due.', totals: [['Invoices', rows.length], ['Outstanding', money(rows.reduce((sum, row) => sum + numberValue(row.balance_amount), 0))]], columns: commonInvoiceColumns, rows }; }
    if (activeReport === 'purchased_products') {
      const totalValue = purchasedProducts.reduce((sum, row) => sum + row.value, 0);
      return {
        title: 'Purchased Products', printTitle: 'PURCHASE BY PRODUCT', description: 'Products received through purchase documents.', totals: [],
        columns: [
          { key: 'item_code', label: 'Code' },
          { key: 'description', label: 'Product' },
          { key: 'qty', label: 'Quantity', render: (row) => reportAmount(row.qty), className: 'report-number' },
          { key: 'uom', label: 'UOM', render: () => '' },
          { key: 'before_tax', label: 'Total before tax', render: (row) => reportAmount(row.value), className: 'report-number' },
          { key: 'value', label: 'Total', render: (row) => reportAmount(row.value), className: 'report-number' }
        ],
        footer: { uom: 'Total', before_tax: reportAmount(totalValue), value: reportAmount(totalValue) },
        rows: purchasedProducts
      };
    }
    if (activeReport === 'purchase_invoices' || activeReport === 'unpaid_purchases') { const rows = activeReport === 'unpaid_purchases' ? purchaseDocuments.filter((row) => numberValue(row.balance_amount) > 0) : purchaseDocuments; return { title: activeReport === 'unpaid_purchases' ? 'Unpaid Purchases' : 'Purchase Invoice List', description: activeReport === 'unpaid_purchases' ? 'Purchase documents that still have a supplier balance.' : 'All purchase documents in the selected period.', totals: [['Documents', rows.length], ['Total', money(rows.reduce((sum, row) => sum + numberValue(row.total_amount), 0))], ['Outstanding', money(rows.reduce((sum, row) => sum + numberValue(row.balance_amount), 0))]], columns: [{ key: 'date', label: 'Date', render: (row) => fmtDate(row.document_date) }, { key: 'document_no', label: 'Document' }, { key: 'external_document_no', label: 'Supplier Invoice' }, { key: 'supplier', label: 'Supplier', render: supplierName }, { key: 'total', label: 'Total', render: (row) => money(row.total_amount) }, { key: 'paid', label: 'Paid', render: (row) => money(row.paid_amount) }, { key: 'balance', label: 'Balance', render: (row) => money(row.balance_amount) }, { key: 'status', label: 'Status' }], rows }; }
    if (activeReport === 'cod_orders') { const rows = documents.filter((row) => row.document_type === 'cod_order'); return { title: 'COD Orders', description: 'COD orders created, dispatched, returned, or settled in the period.', totals: [['Orders', rows.length], ['COD Value', money(rows.reduce((sum, row) => sum + numberValue(row.cod_collect_amount || row.total_amount), 0))], ['Outstanding', money(rows.filter((row) => !['settled', 'returned', 'cancelled'].includes(row.status)).reduce((sum, row) => sum + numberValue(row.cod_collect_amount || row.total_amount), 0))]], columns: [{ key: 'date', label: 'Date', render: (row) => fmtDate(row.document_date) }, { key: 'document_no', label: 'COD Order' }, { key: 'recipient_name', label: 'Customer' }, { key: 'delivery_phone', label: 'Phone' }, { key: 'delivery_service', label: 'Courier' }, { key: 'tracking_number', label: 'Tracking' }, { key: 'status', label: 'Status' }, { key: 'amount', label: 'COD Amount', render: (row) => money(row.cod_collect_amount || row.total_amount) }], rows }; }
    if (activeReport === 'jobs_repairs') { const rows = documents.filter((row) => row.document_type === 'job'); return { title: 'Jobs & Repairs', description: 'Repair jobs received and their current status.', totals: [['Jobs', rows.length], ['Open', rows.filter((row) => !['completed', 'cancelled'].includes(row.job_status || row.status)).length], ['Completed', rows.filter((row) => (row.job_status || row.status) === 'completed').length]], columns: [{ key: 'date', label: 'Received', render: (row) => fmtDate(row.document_date) }, { key: 'job_no', label: 'Job Number', render: (row) => row.job_no || row.document_no }, { key: 'customer', label: 'Customer', render: (row) => customerMap.get(row.customer_id)?.name || '-' }, { key: 'status', label: 'Job Status', render: (row) => (row.job_status || row.status || '').replace('_', ' ') }, { key: 'notes', label: 'Notes' }], rows }; }
    if (activeReport === 'inventory_documents') { const rows = documents.filter((row) => ['stock_in_transit', 'stock_adjustment', 'trade_in'].includes(row.document_type)); return { title: 'Inventory Documents', description: 'Stock in transit, stock adjustments, and trade-in documents.', totals: [['Documents', rows.length], ['Value', money(rows.reduce((sum, row) => sum + numberValue(row.total_amount), 0))]], columns: [{ key: 'date', label: 'Date', render: (row) => fmtDate(row.document_date) }, { key: 'document_no', label: 'Document' }, { key: 'type', label: 'Type', render: (row) => documentTypeLabel(row.document_type) }, { key: 'party', label: 'Customer / Supplier', render: (row) => customerMap.get(row.customer_id)?.name || supplierMap.get(row.supplier_id)?.name || '-' }, { key: 'status', label: 'Status' }, { key: 'total', label: 'Value', render: (row) => money(row.total_amount) }], rows }; }
    if (activeReport === 'stock_movement') return { title: 'Stock Movement', description: 'Every stock quantity change recorded during the period.', totals: [['Movements', stockMovements.length], ['Quantity Movement', stockMovements.reduce((sum, row) => sum + numberValue(row.qty), 0)]], columns: [{ key: 'date', label: 'Date', render: (row) => new Date(row.created_at).toLocaleString('en-LK') }, { key: 'document', label: 'Document', render: (row) => row.documents?.document_no || '-' }, { key: 'type', label: 'Movement', render: (row) => String(row.movement_type || '').replaceAll('_', ' ') }, { key: 'code', label: 'Code', render: (row) => row.products?.item_code || '-' }, { key: 'product', label: 'Product', render: (row) => row.products?.name || '-' }, { key: 'qty', label: 'Qty' }, { key: 'unit_cost', label: 'Unit Cost', render: (row) => money(row.unit_cost) }, { key: 'value', label: 'Value', render: (row) => money(numberValue(row.qty) * numberValue(row.unit_cost)) }], rows: stockMovements };
    const cashIn = filteredCashflows.filter((row) => row.entry_type === 'cash_in').reduce((sum, row) => sum + numberValue(row.amount), 0); const cashOut = filteredCashflows.filter((row) => row.entry_type === 'cash_out').reduce((sum, row) => sum + numberValue(row.amount), 0); return { title: 'Transaction History', description: 'Cash, bank, card, credit, customer payments, supplier payments, expenses, and other income.', totals: [['Cash In', money(cashIn)], ['Cash Out', money(cashOut)], ['Net', signedMoney(cashIn - cashOut)], ['Entries', filteredCashflows.length]], columns: [{ key: 'date', label: 'Date', render: (row) => new Date(row.created_at).toLocaleString('en-LK') }, { key: 'direction', label: 'Type', render: (row) => row.entry_type.replace('_', ' ') }, { key: 'method', label: 'Payment Type', render: (row) => row.payment_methods?.name || row.account_name || '-' }, { key: 'document', label: 'Document', render: (row) => documentMap.get(row.document_id)?.document_no || '-' }, { key: 'document_type', label: 'Document Type', render: (row) => documentTypeLabel(documentMap.get(row.document_id)?.document_type) }, { key: 'description', label: 'Description' }, { key: 'amount', label: 'Amount', render: (row) => `${row.entry_type === 'cash_out' ? '-' : row.entry_type === 'cash_in' ? '+' : ''}${money(row.amount)}`, className: (row) => row.entry_type === 'cash_out' ? 'negative-balance' : row.entry_type === 'cash_in' ? 'positive-balance' : '' }], rows: filteredCashflows };
  }

  const selectedReport = activeReport ? buildReport() : null;
  const reportPartyLabel = SUPPLIER_REPORT_FILTERS.has(activeReport)
    ? (supplierId ? supplierMap.get(supplierId)?.name || 'Selected supplier' : 'All')
    : (customerId ? customerMap.get(customerId)?.name || 'Selected customer' : 'All');
  const reportPartyTitle = SUPPLIER_REPORT_FILTERS.has(activeReport) ? 'Supplier' : 'Customer';
  const cleanSearch = reportSearch.trim().toLowerCase();
  const visibleGroups = REPORT_LIBRARY.map((group) => ({ ...group, reports: group.reports.filter((report) => `${group.title} ${report.label}`.toLowerCase().includes(cleanSearch)) })).filter((group) => group.reports.length);

  function printSelectedReport() {
    if (!activeReport) return;
    if (!reportVisible) {
      setReportVisible(true);
      window.setTimeout(() => window.print(), 180);
      return;
    }
    window.print();
  }

  return (
    <section className={`page-section reports-page ${reportVisible ? 'report-view-page' : 'report-library-page'}`}>
      <div className="report-page-layout">
        <div className="report-page-main">
          {!reportVisible ? <>
            <div className="report-library-heading"><h2>Select report to view or print</h2><label><span aria-hidden="true">⌕</span><input value={reportSearch} onChange={(event) => setReportSearch(event.target.value)} placeholder="Search reports" autoFocus /></label></div>
            <div className="report-library-list">
              {visibleGroups.map((group) => <div className="report-library-group" key={group.title}><div className="report-library-group-title"><h3>{group.title}</h3><span /></div>{group.reports.map((report) => <button type="button" className={`report-library-item ${activeReport === report.id ? 'selected' : ''}`} key={report.id} onClick={() => { if (activeReport !== report.id) { setCustomerId(''); setSupplierId(''); setPaymentMethodId(''); } setActiveReport(report.id); }}><span className="report-list-icon" aria-hidden="true" /><span>{report.label}</span></button>)}</div>)}
              {!visibleGroups.length && <div className="muted-box">No reports match “{reportSearch}”.</div>}
            </div>
          </> : <>
            <div className="report-view-toolbar">
              <button type="button" className="secondary-button" onClick={() => setReportVisible(false)}>← All Reports</button>
              <div><h2>{selectedReport.title}</h2><p>{selectedReport.description}</p></div>
              <button type="button" className="secondary-button" disabled={loading} onClick={() => { loadReportLookups(); loadPeriodReports(); }}>Refresh</button>
            </div>
            {error && <div className="error-box">{error}</div>}
            {loading && <div className="notice">Loading report...</div>}
            <article className="report-output">
              <div className="aronium-report-sheet">
                <header className="aronium-report-header">
                  <h1>{selectedReport.printTitle || selectedReport.title.toUpperCase()}</h1>
                  <div className="aronium-report-meta">
                    <dl>
                      <dt>Period</dt><dd>{fmtDate(period.from)} - {fmtDate(period.to)}</dd>
                      <dt>{reportPartyTitle}</dt><dd>{reportPartyLabel}</dd>
                      <dt>User</dt><dd>All</dd>
                      <dt>Product</dt><dd>All</dd>
                    </dl>
                    <dl>
                      <dt>Company</dt><dd>{companySettings.shop_name || 'Computer Shop'}</dd>
                      <dt>Address</dt><dd>{companySettings.address || '-'}</dd>
                    </dl>
                  </div>
                </header>
                {selectedReport.totals?.length > 0 && <div className="report-totals-row">{selectedReport.totals.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>}
                <ReportResultTable columns={selectedReport.columns} rows={selectedReport.rows} footer={selectedReport.footer} />
                <footer className="aronium-report-footer"><span>{new Date().toLocaleString('en-LK')}</span><span>Page 1</span></footer>
              </div>
            </article>
          </>}
        </div>

        <aside className="panel-card report-filter-sidebar">
          <h2>Filter</h2>
          <div className="report-filter-selected"><span>Selected report</span><strong>{selectedReport?.title || 'Choose a report from the list'}</strong></div>
          <div className="report-filter-fields">
            <label>Period<select value={periodPreset} onChange={(event) => setPeriodPreset(event.target.value)}><option value="this_month">This Month</option><option value="last_month">Last Month</option><option value="custom">Custom Range</option></select></label>
            {periodPreset === 'custom' && <><label>From<input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} /></label><label>To<input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} /></label></>}
            {CUSTOMER_REPORT_FILTERS.has(activeReport) && <label>Customer<select value={customerId} onChange={(event) => setCustomerId(event.target.value)}><option value="">All customers</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}{customer.phone ? ` · ${customer.phone}` : ''}</option>)}</select></label>}
            {SUPPLIER_REPORT_FILTERS.has(activeReport) && <label>Supplier<select value={supplierId} onChange={(event) => setSupplierId(event.target.value)}><option value="">All suppliers</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>}
            {PAYMENT_REPORT_FILTERS.has(activeReport) && <label>Payment Type<select value={paymentMethodId} onChange={(event) => setPaymentMethodId(event.target.value)}><option value="">All payment types</option>{paymentMethods.map((method) => <option key={method.id} value={method.id}>{method.name}</option>)}</select></label>}
          </div>
          <div className="report-date-card"><span className="report-calendar-icon" aria-hidden="true" /><div><span>Date range</span><strong>{fmtDate(period.from)} – {fmtDate(period.to)}</strong></div></div>
          <div className="report-filter-actions"><button type="button" className="primary-button" disabled={!activeReport} onClick={() => setReportVisible(true)}>Show Report</button><button type="button" className="secondary-button" disabled={!activeReport} onClick={printSelectedReport}>Print</button></div>
        </aside>
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

function accountingDisplayAmount(value) {
  const amount = numberValue(value);
  const formatted = Math.abs(amount).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return amount < -0.004 ? `(${formatted})` : formatted;
}

function accountingPeriodLabel(from, to) {
  const format = (value) => new Date(`${value}T00:00:00`).toLocaleDateString('en-LK', { day: 'numeric', month: 'long', year: 'numeric' });
  return from === to ? format(from) : `${format(from)} to ${format(to)}`;
}

function AccountingStatementRow({ label, value, total = false, major = false, indent = false }) {
  return <div className={`accounting-statement-row${total ? ' total' : ''}${major ? ' major' : ''}${indent ? ' indent' : ''}`}><span>{label}</span><strong>{accountingDisplayAmount(value)}</strong></div>;
}

function AccountingPage({ activeStaff } = {}) {
  const [section, setSection] = useState('income');
  const [periodPreset, setPeriodPreset] = useState('this_month');
  const [customFrom, setCustomFrom] = useState(todayInputDate());
  const [customTo, setCustomTo] = useState(todayInputDate());
  const [asOfDate, setAsOfDate] = useState(todayInputDate());
  const [reportData, setReportData] = useState({ accounts: [], income: [], balance: [], ledger: [], settings: {} });
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [companySettings, setCompanySettings] = useState(DEFAULT_COMPANY_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [ledgerSearch, setLedgerSearch] = useState('');
  const [showCashEntry, setShowCashEntry] = useState(false);
  const [cashEntry, setCashEntry] = useState({ entry_type: 'cash_out', payment_method_id: '', account_id: '', amount: '', description: '', document_date: todayInputDate() });
  const [showAccountEditor, setShowAccountEditor] = useState(false);
  const [accountForm, setAccountForm] = useState({ id: '', code: '', name: '', classification: 'expense', profit_group: '' });
  const [openingAccount, setOpeningAccount] = useState(null);
  const [openingForm, setOpeningForm] = useState({ balance: '', opening_date: todayInputDate(), notes: '' });
  const [allocationForm, setAllocationForm] = useState({ operator_percent: 20, reserve_percent: 5, partner_pool_percent: 60 });
  const period = useMemo(() => reportPeriodRange(periodPreset, customFrom, customTo), [periodPreset, customFrom, customTo]);

  useEffect(() => { loadAccounting(); loadAccountingLookups(); }, []);
  useEffect(() => {
    const timeout = setTimeout(loadAccounting, 160);
    return () => clearTimeout(timeout);
  }, [period.from, period.to, asOfDate]);
  useRealtimeRefresh(['accounting_accounts', 'accounting_journal_entries', 'accounting_journal_lines', 'accounting_opening_balances', 'accounting_settings'], loadAccounting, 420);

  async function loadAccountingLookups() {
    const [paymentRes, companyRes] = await Promise.all([
      supabase.from('payment_methods').select('id, name, is_paid_method, affects_cashflow, is_active').eq('is_active', true).eq('is_paid_method', true).eq('affects_cashflow', true).order('name'),
      fetchCompanySettings().then((data) => ({ data, error: null })).catch((lookupError) => ({ data: null, error: lookupError }))
    ]);
    if (paymentRes.error || companyRes.error) setError((paymentRes.error || companyRes.error).message);
    if (!paymentRes.error) {
      setPaymentMethods(paymentRes.data || []);
      setCashEntry((current) => ({ ...current, payment_method_id: current.payment_method_id || paymentRes.data?.[0]?.id || '' }));
    }
    if (!companyRes.error && companyRes.data) setCompanySettings(companyRes.data);
  }

  async function loadAccounting() {
    setLoading(true); setError('');
    const { data, error: reportError } = await supabase.rpc('get_accounting_report_v42', {
      p_from: period.from,
      p_to: period.to,
      p_as_of: asOfDate
    });
    setLoading(false);
    if (reportError) {
      setError(`${reportError.message}. Run migration 042_double_entry_accounting_statements.sql in Supabase.`);
      return;
    }
    const next = { accounts: [], income: [], balance: [], ledger: [], settings: {}, ...(data || {}) };
    setReportData(next);
    setAllocationForm({
      operator_percent: numberValue(next.settings?.operator_percent, 20),
      reserve_percent: numberValue(next.settings?.reserve_percent, 5),
      partner_pool_percent: numberValue(next.settings?.partner_pool_percent, 60)
    });
    const defaultExpense = next.accounts.find((row) => row.system_key === 'expense_miscellaneous') || next.accounts.find((row) => row.account_type === 'expense');
    setCashEntry((current) => ({ ...current, account_id: current.account_id || defaultExpense?.id || '' }));
  }

  const incomeRows = reportData.income || [];
  const salesRows = incomeRows.filter((row) => row.statement_section === 'sales' && Math.abs(numberValue(row.balance)) > 0.004);
  const otherIncomeRows = incomeRows.filter((row) => row.statement_section === 'other_income' && Math.abs(numberValue(row.balance)) > 0.004);
  const cogsRows = incomeRows.filter((row) => row.statement_section === 'cogs' && Math.abs(numberValue(row.balance)) > 0.004);
  const expenseRows = incomeRows.filter((row) => row.statement_section === 'expense' && Math.abs(numberValue(row.balance)) > 0.004);
  const salesTotal = salesRows.reduce((sum, row) => sum + numberValue(row.balance), 0);
  const otherIncomeTotal = otherIncomeRows.reduce((sum, row) => sum + numberValue(row.balance), 0);
  const cogsTotal = cogsRows.reduce((sum, row) => sum + numberValue(row.balance), 0);
  const expenseTotal = expenseRows.reduce((sum, row) => sum + numberValue(row.balance), 0);
  const grossProfit = salesTotal - cogsTotal;
  const netProfit = grossProfit + otherIncomeTotal - expenseTotal;
  const operatorAllocation = netProfit * numberValue(reportData.settings?.operator_percent, 20) / 100;
  const reserveAllocation = netProfit * numberValue(reportData.settings?.reserve_percent, 5) / 100;
  const distributableProfit = netProfit - operatorAllocation - reserveAllocation;
  const partnerPool = distributableProfit * numberValue(reportData.settings?.partner_pool_percent, 60) / 100;
  const investorPool = distributableProfit - partnerPool;

  const balanceRows = reportData.balance || [];
  const fixedAssets = balanceRows.filter((row) => row.statement_section === 'fixed_asset' && Math.abs(numberValue(row.balance)) > 0.004);
  const currentAssets = balanceRows.filter((row) => row.statement_section === 'current_asset' && Math.abs(numberValue(row.balance)) > 0.004);
  const nonCurrentAssets = balanceRows.filter((row) => row.statement_section === 'non_current_asset' && Math.abs(numberValue(row.balance)) > 0.004);
  const currentLiabilities = balanceRows.filter((row) => row.statement_section === 'current_liability' && Math.abs(numberValue(row.balance)) > 0.004);
  const longLiabilities = balanceRows.filter((row) => row.statement_section === 'long_term_liability' && Math.abs(numberValue(row.balance)) > 0.004);
  const equityRows = balanceRows.filter((row) => row.statement_section === 'equity' && Math.abs(numberValue(row.balance)) > 0.004);
  const totalAssets = [...fixedAssets, ...currentAssets, ...nonCurrentAssets].reduce((sum, row) => sum + numberValue(row.balance), 0);
  const totalLiabilities = [...currentLiabilities, ...longLiabilities].reduce((sum, row) => sum + numberValue(row.balance), 0);
  const equityBeforeEarnings = equityRows.reduce((sum, row) => sum + numberValue(row.balance), 0);
  const currentEarnings = numberValue(reportData.current_earnings);
  const totalEquity = equityBeforeEarnings + currentEarnings;
  const balanceDifference = totalAssets - totalLiabilities - totalEquity;

  const equityMembers = balanceRows.filter((row) => row.account_type === 'equity' && row.profit_group && numberValue(row.balance) > 0);
  function allocatedMembers(group, pool) {
    const members = equityMembers.filter((row) => row.profit_group === group);
    const investment = members.reduce((sum, row) => sum + numberValue(row.balance), 0);
    return members.map((row) => ({ ...row, percentage: investment ? numberValue(row.balance) / investment * 100 : 0, allocation: investment ? pool * numberValue(row.balance) / investment : 0 }));
  }
  const partnerMembers = allocatedMembers('partner', partnerPool);
  const investorMembers = allocatedMembers('investor', investorPool);
  const ledgerRows = (reportData.ledger || []).filter((row) => !ledgerSearch.trim() || `${row.entry_date} ${row.reference_no || ''} ${row.description || ''} ${row.code || ''} ${row.account_name || ''} ${row.memo || ''}`.toLowerCase().includes(ledgerSearch.trim().toLowerCase()));
  const expenseAccounts = (reportData.accounts || []).filter((row) => row.account_type === 'expense' && row.is_active);
  const otherIncomeAccounts = (reportData.accounts || []).filter((row) => row.account_type === 'income' && row.statement_section === 'other_income' && row.is_active);

  async function saveCashEntry(event) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    const { data, error: saveError } = await supabase.rpc('save_accounting_cash_document_v42', {
      p_entry_type: cashEntry.entry_type,
      p_payment_method_id: cashEntry.payment_method_id || null,
      p_account_id: cashEntry.account_id || null,
      p_amount: numberValue(cashEntry.amount),
      p_description: cashEntry.description.trim() || null,
      p_document_date: cashEntry.document_date
    });
    setBusy(false);
    if (saveError) { setError(saveError.message); return; }
    setShowCashEntry(false);
    setCashEntry((current) => ({ ...current, amount: '', description: '', document_date: todayInputDate() }));
    setMessage(`${data?.document_type === 'expense' ? 'Expense' : 'Other income'} ${data?.document_no} saved to cashflow and the ledger.`);
    await loadAccounting();
  }

  const ACCOUNT_CLASSIFICATIONS = {
    fixed_asset: ['asset', 'fixed_asset', 'debit'], current_asset: ['asset', 'current_asset', 'debit'],
    non_current_asset: ['asset', 'non_current_asset', 'debit'], current_liability: ['liability', 'current_liability', 'credit'],
    long_term_liability: ['liability', 'long_term_liability', 'credit'], equity: ['equity', 'equity', 'credit'],
    other_income: ['income', 'other_income', 'credit'], expense: ['expense', 'expense', 'debit']
  };

  async function saveAccount(event) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    const classification = ACCOUNT_CLASSIFICATIONS[accountForm.classification];
    const { data, error: saveError } = await supabase.rpc('admin_save_account_v42', {
      p_account_id: accountForm.id || null, p_code: accountForm.code || null, p_name: accountForm.name.trim(),
      p_account_type: classification[0], p_statement_section: classification[1], p_normal_side: classification[2],
      p_profit_group: classification[0] === 'equity' ? accountForm.profit_group || null : null
    });
    setBusy(false);
    if (saveError) { setError(saveError.message); return; }
    setShowAccountEditor(false); setAccountForm({ id: '', code: '', name: '', classification: 'expense', profit_group: '' });
    setMessage(`Account saved${data ? ` (${String(data).slice(0, 8)})` : ''}.`); await loadAccounting();
  }

  async function saveOpeningBalance(event) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    const { error: saveError } = await supabase.rpc('admin_save_opening_balance_v42', {
      p_account_id: openingAccount.id, p_balance: numberValue(openingForm.balance),
      p_opening_date: openingForm.opening_date, p_notes: openingForm.notes.trim() || null
    });
    setBusy(false);
    if (saveError) { setError(saveError.message); return; }
    setOpeningAccount(null); setMessage('Opening balance saved and the balancing equity entry was created automatically.'); await loadAccounting();
  }

  async function saveAllocationSettings(event) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    const { error: saveError } = await supabase.rpc('admin_save_accounting_settings_v42', {
      p_operator_percent: numberValue(allocationForm.operator_percent), p_reserve_percent: numberValue(allocationForm.reserve_percent),
      p_partner_pool_percent: numberValue(allocationForm.partner_pool_percent)
    });
    setBusy(false);
    if (saveError) { setError(saveError.message); return; }
    setMessage('Profit allocation settings saved.'); await loadAccounting();
  }

  function openOpening(row) {
    setOpeningAccount(row);
    setOpeningForm({ balance: String(numberValue(row.opening_balance)), opening_date: row.opening_date || todayInputDate(), notes: '' });
  }

  function exportAccountingExcel() {
    const workbook = XLSX.utils.book_new();
    let rows = [];
    let sheetName = 'Accounting';
    if (section === 'income') {
      sheetName = 'Income Statement';
      rows = [[companySettings.shop_name || 'Computer Shop'], ['INCOME STATEMENT'], [`For ${accountingPeriodLabel(period.from, period.to)}`], [], ['Income', 'Amount']];
      salesRows.forEach((row) => rows.push([row.name, numberValue(row.balance)]));
      rows.push(['Net Sales', salesTotal], ['Cost of Goods Sold', -cogsTotal], ['Gross Profit', grossProfit]);
      otherIncomeRows.forEach((row) => rows.push([row.name, numberValue(row.balance)]));
      rows.push([], ['Expenses', 'Amount']); expenseRows.forEach((row) => rows.push([row.name, -numberValue(row.balance)]));
      rows.push(['Total Expenses', -expenseTotal], ['Net Profit', netProfit], [], ['Operator allocation', operatorAllocation], ['Reserve', reserveAllocation], ['Distributable profit', distributableProfit]);
      [...partnerMembers, ...investorMembers].forEach((row) => rows.push([`${row.profit_group === 'partner' ? 'Partner' : 'Investor'} - ${row.name}`, row.allocation]));
    } else if (section === 'balance') {
      sheetName = 'Balance Sheet';
      const left = [['Assets', null], ...fixedAssets.map((row) => [row.name, numberValue(row.balance)]), ['Total Fixed Assets', fixedAssets.reduce((sum, row) => sum + numberValue(row.balance), 0)], [], ...currentAssets.map((row) => [row.name, numberValue(row.balance)]), ['Total Current Assets', currentAssets.reduce((sum, row) => sum + numberValue(row.balance), 0)], [], ...nonCurrentAssets.map((row) => [row.name, numberValue(row.balance)]), ['Total Non-Current Assets', nonCurrentAssets.reduce((sum, row) => sum + numberValue(row.balance), 0)], [], ['Total Assets', totalAssets]];
      const right = [['Liabilities & Equity', null], ...currentLiabilities.map((row) => [row.name, numberValue(row.balance)]), ...longLiabilities.map((row) => [row.name, numberValue(row.balance)]), ['Total Liabilities', totalLiabilities], [], ...equityRows.map((row) => [row.name, numberValue(row.balance)]), ['Current Earnings', currentEarnings], ['Total Equity', totalEquity], [], ['Total Equity & Liabilities', totalLiabilities + totalEquity]];
      rows = [[companySettings.shop_name || 'Computer Shop'], ['BALANCE SHEET'], [`As at ${accountingPeriodLabel(asOfDate, asOfDate)}`], [], ['Assets', 'Amount', '', 'Liabilities & Equity', 'Amount']];
      const count = Math.max(left.length, right.length); for (let index = 1; index < count; index += 1) rows.push([left[index]?.[0] || '', left[index]?.[1] ?? '', '', right[index]?.[0] || '', right[index]?.[1] ?? '']);
    } else {
      sheetName = 'General Ledger'; rows = [['Date', 'Reference', 'Description', 'Code', 'Account', 'Debit', 'Credit', 'Memo'], ...ledgerRows.map((row) => [row.entry_date, row.reference_no || '', row.description, row.code, row.account_name, numberValue(row.debit), numberValue(row.credit), row.memo || ''])];
    }
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    worksheet['!cols'] = section === 'balance' ? [{ wch: 30 }, { wch: 16 }, { wch: 3 }, { wch: 32 }, { wch: 16 }] : [{ wch: 30 }, { wch: 18 }, { wch: 24 }, { wch: 12 }, { wch: 26 }, { wch: 16 }, { wch: 16 }, { wch: 30 }];
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName.slice(0, 31));
    XLSX.writeFile(workbook, `${sheetName.replace(/\s+/g, '_')}_${section === 'balance' ? asOfDate : period.to}.xlsx`);
  }

  function printAccounting() {
    document.body.classList.add('accounting-print-mode');
    const cleanup = () => document.body.classList.remove('accounting-print-mode');
    window.addEventListener('afterprint', cleanup, { once: true });
    window.setTimeout(() => { window.print(); window.setTimeout(cleanup, 1000); }, 50);
  }

  if (activeStaff?.role !== 'admin') return <FullScreenMessage title="Admin only" message="An administrator PIN is required to view financial statements and the ledger." />;

  return (
    <section className="page-section accounting-page">
      <div className="accounting-page-header">
        <div><h3>Accounting</h3><p>Automatic double-entry statements generated from POS documents, stock and payments.</p></div>
        <div className="button-row"><button className="primary-button" onClick={() => setShowCashEntry(true)}>+ Expense or Income</button>{section !== 'setup' && <><button className="secondary-button" onClick={printAccounting}>Print / Save PDF</button><button className="secondary-button" onClick={exportAccountingExcel}>Excel</button></>}</div>
      </div>
      <div className="accounting-tabs">
        {[['income', 'Income Statement'], ['balance', 'Balance Sheet'], ['ledger', 'General Ledger'], ['setup', 'Accounts & Opening Balances']].map(([key, label]) => <button key={key} className={section === key ? 'active' : ''} onClick={() => setSection(key)}>{label}</button>)}
      </div>
      {error && <div className="error-box">{error}</div>}{message && <div className="notice success">{message}</div>}

      {section !== 'setup' && <div className="panel-card accounting-filter-bar">
        {section !== 'balance' && <><div className="date-preset-buttons">{[['this_month', 'This month'], ['last_month', 'Last month'], ['custom', 'Custom']].map(([value, label]) => <button key={value} className={periodPreset === value ? 'pill-button active' : 'pill-button'} onClick={() => setPeriodPreset(value)}>{label}</button>)}</div>{periodPreset === 'custom' && <div className="custom-date-range"><label>From<input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} /></label><span>to</span><label>To<input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} /></label></div>}</>}
        {section === 'balance' && <label className="accounting-asof-filter">Balance sheet as at<input type="date" value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)} /></label>}
        <button className="secondary-button" onClick={loadAccounting}>Refresh</button>
      </div>}

      {loading ? <div className="panel-card">Preparing accounting statements...</div> : <>
        {section === 'income' && <div className="accounting-statement accounting-income-statement">
          <div className="accounting-statement-heading"><img src={companyLogoUrl(companySettings)} alt="" /><h1>{companySettings.shop_name || 'Computer Shop'}</h1><h2>INCOME STATEMENT</h2><p>For {accountingPeriodLabel(period.from, period.to)}</p></div>
          <div className="accounting-statement-body">
            <h3>Revenue</h3>{salesRows.map((row) => <AccountingStatementRow key={row.id} label={row.name} value={row.balance} />)}
            <AccountingStatementRow label="Net Sales" value={salesTotal} total />
            {cogsRows.length ? cogsRows.map((row) => <AccountingStatementRow key={row.id} label={row.name} value={-numberValue(row.balance)} />) : <AccountingStatementRow label="Cost of Goods Sold" value={0} />}
            <AccountingStatementRow label="Gross Profit" value={grossProfit} total major />
            {otherIncomeRows.length > 0 && <><h3>Other Income</h3>{otherIncomeRows.map((row) => <AccountingStatementRow key={row.id} label={row.name} value={row.balance} />)}<AccountingStatementRow label="Total Other Income" value={otherIncomeTotal} total /></>}
            <h3>Expenses</h3>{expenseRows.map((row) => <AccountingStatementRow key={row.id} label={row.name} value={-numberValue(row.balance)} />)}{!expenseRows.length && <AccountingStatementRow label="No expenses recorded" value={0} />}
            <AccountingStatementRow label="Total Expenses" value={-expenseTotal} total />
            <AccountingStatementRow label="Net Profit" value={netProfit} total major />
          </div>
          <div className="accounting-profit-allocation">
            <div className="accounting-allocation-summary"><AccountingStatementRow label={`Operator (${numberValue(reportData.settings?.operator_percent, 20)}%)`} value={operatorAllocation} /><AccountingStatementRow label={`Reserve (${numberValue(reportData.settings?.reserve_percent, 5)}%)`} value={reserveAllocation} /><AccountingStatementRow label="Distributable Profit" value={distributableProfit} total /></div>
            {(partnerMembers.length > 0 || investorMembers.length > 0) && <div className="accounting-member-groups">{[['Partners', partnerMembers, partnerPool], ['Investors', investorMembers, investorPool]].map(([label, members, pool]) => members.length > 0 && <div key={label}><h4>{label} <span>{accountingDisplayAmount(pool)}</span></h4><table><thead><tr><th>Name</th><th>Investment</th><th>Share</th><th>Profit</th></tr></thead><tbody>{members.map((row) => <tr key={row.id}><td>{row.name}</td><td>{accountingDisplayAmount(row.balance)}</td><td>{row.percentage.toFixed(2)}%</td><td>{accountingDisplayAmount(row.allocation)}</td></tr>)}</tbody></table></div>)}</div>}
          </div>
        </div>}

        {section === 'balance' && <div className="accounting-statement accounting-balance-sheet">
          <div className="accounting-statement-heading"><img src={companyLogoUrl(companySettings)} alt="" /><h1>{companySettings.shop_name || 'Computer Shop'}</h1><h2>BALANCE SHEET</h2><p>As at {accountingPeriodLabel(asOfDate, asOfDate)}</p></div>
          <div className="accounting-balance-columns">
            <div><h3>Assets</h3><h4>Fixed Assets</h4>{fixedAssets.map((row) => <AccountingStatementRow key={row.id} label={row.name} value={row.balance} />)}<AccountingStatementRow label="Total Fixed Assets" value={fixedAssets.reduce((sum, row) => sum + numberValue(row.balance), 0)} total /><h4>Current Assets</h4>{currentAssets.map((row) => <AccountingStatementRow key={row.id} label={row.name} value={row.balance} />)}<AccountingStatementRow label="Total Current Assets" value={currentAssets.reduce((sum, row) => sum + numberValue(row.balance), 0)} total /><h4>Non-Current Assets</h4>{nonCurrentAssets.map((row) => <AccountingStatementRow key={row.id} label={row.name} value={row.balance} />)}<AccountingStatementRow label="Total Non-Current Assets" value={nonCurrentAssets.reduce((sum, row) => sum + numberValue(row.balance), 0)} total /><AccountingStatementRow label="Total Assets" value={totalAssets} total major /></div>
            <div><h3>Liabilities &amp; Equity</h3><h4>Liabilities</h4>{[...currentLiabilities, ...longLiabilities].map((row) => <AccountingStatementRow key={row.id} label={row.name} value={row.balance} />)}{!currentLiabilities.length && !longLiabilities.length && <AccountingStatementRow label="No liabilities" value={0} />}<AccountingStatementRow label="Total Liabilities" value={totalLiabilities} total /><h4>Equity</h4>{equityRows.map((row) => <AccountingStatementRow key={row.id} label={row.name} value={row.balance} />)}<AccountingStatementRow label="Current Earnings" value={currentEarnings} /><AccountingStatementRow label="Total Equity" value={totalEquity} total /><AccountingStatementRow label="Total Equity & Liabilities" value={totalLiabilities + totalEquity} total major /></div>
          </div>
          <div className={`accounting-balance-check ${Math.abs(balanceDifference) < 0.01 ? 'balanced' : 'warning'}`}>{Math.abs(balanceDifference) < 0.01 ? 'Balance sheet is balanced' : `Difference: ${accountingDisplayAmount(balanceDifference)}`}</div>
        </div>}

        {section === 'ledger' && <div className="panel-card accounting-ledger accounting-print-area"><div className="accounting-ledger-heading"><div><h3>General Ledger</h3><p>{accountingPeriodLabel(period.from, period.to)} · {ledgerRows.length} lines</p></div><input value={ledgerSearch} onChange={(event) => setLedgerSearch(event.target.value)} placeholder="Search account, reference or description" /></div><div className="table-wrap"><table><thead><tr><th>Date</th><th>Reference</th><th>Description</th><th>Code</th><th>Account</th><th>Debit</th><th>Credit</th></tr></thead><tbody>{ledgerRows.map((row) => <tr key={row.line_id}><td>{fmtDate(row.entry_date)}</td><td>{row.reference_no || '-'}</td><td>{row.description}{row.memo ? <small className="ledger-memo">{row.memo}</small> : null}</td><td>{row.code}</td><td>{row.account_name}</td><td className="report-number">{numberValue(row.debit) ? accountingDisplayAmount(row.debit) : '-'}</td><td className="report-number">{numberValue(row.credit) ? accountingDisplayAmount(row.credit) : '-'}</td></tr>)}{!ledgerRows.length && <EmptyRow colSpan={7} text="No ledger entries for this period." />}</tbody></table></div></div>}

        {section === 'setup' && <div className="accounting-setup-grid">
          <div className="panel-card accounting-setup-card"><div className="section-title-row"><div><h3>Chart of Accounts</h3><p>Add capital owners, fixed assets, deposits or extra expense categories.</p></div><button className="primary-button" onClick={() => setShowAccountEditor(true)}>+ Add Account</button></div><div className="table-wrap"><table><thead><tr><th>Code</th><th>Account</th><th>Class</th><th>Profit group</th><th>Opening balance</th><th></th></tr></thead><tbody>{(reportData.accounts || []).filter((row) => row.is_active).map((row) => <tr key={row.id}><td>{row.code}</td><td><strong>{row.name}</strong>{row.is_system && <small className="ledger-memo">Automatic account</small>}</td><td>{row.statement_section.replaceAll('_', ' ')}</td><td>{row.profit_group ? row.profit_group[0].toUpperCase() + row.profit_group.slice(1) : '-'}</td><td>{accountingDisplayAmount(row.opening_balance)}</td><td>{!['opening_balance_equity', 'inventory_revaluation_equity', 'party_opening_equity', 'accounting_difference'].includes(row.system_key) && <button className="small-button" onClick={() => openOpening(row)}>Opening Balance</button>}</td></tr>)}</tbody></table></div></div>
          <form className="panel-card accounting-allocation-settings" onSubmit={saveAllocationSettings}><h3>Profit Allocation</h3><p>Matches the allocation section below your Income Statement.</p><label>Operator percentage<input type="number" min="0" max="100" step="0.01" value={allocationForm.operator_percent} onChange={(event) => setAllocationForm({ ...allocationForm, operator_percent: event.target.value })} /></label><label>Reserve percentage<input type="number" min="0" max="100" step="0.01" value={allocationForm.reserve_percent} onChange={(event) => setAllocationForm({ ...allocationForm, reserve_percent: event.target.value })} /></label><label>Partner share of distributable profit<input type="number" min="0" max="100" step="0.01" value={allocationForm.partner_pool_percent} onChange={(event) => setAllocationForm({ ...allocationForm, partner_pool_percent: event.target.value })} /></label><small>The remaining distributable profit is assigned to the Investor group.</small><button className="primary-button" disabled={busy}>Save Allocation</button></form>
        </div>}
      </>}

      {showCashEntry && <div className="modal-backdrop"><form className="modal-card accounting-cash-modal" onSubmit={saveCashEntry}><div className="section-title-row"><div><h3>Record Expense or Other Income</h3><p>This creates the cashflow document and balanced ledger entry together.</p></div><button type="button" className="secondary-button" onClick={() => setShowCashEntry(false)}>Close</button></div><div className="accounting-modal-grid"><label>Type<select value={cashEntry.entry_type} onChange={(event) => { const type = event.target.value; const accounts = type === 'cash_out' ? expenseAccounts : otherIncomeAccounts; setCashEntry({ ...cashEntry, entry_type: type, account_id: accounts[0]?.id || '' }); }}><option value="cash_out">Expense / Cash out</option><option value="cash_in">Other income / Cash in</option></select></label><label>Date<input type="date" value={cashEntry.document_date} onChange={(event) => setCashEntry({ ...cashEntry, document_date: event.target.value })} /></label><label>Category<select value={cashEntry.account_id} onChange={(event) => setCashEntry({ ...cashEntry, account_id: event.target.value })}>{(cashEntry.entry_type === 'cash_out' ? expenseAccounts : otherIncomeAccounts).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><label>Paid through<select value={cashEntry.payment_method_id} onChange={(event) => setCashEntry({ ...cashEntry, payment_method_id: event.target.value })}>{paymentMethods.map((method) => <option key={method.id} value={method.id}>{method.name}</option>)}</select></label><label>Amount<input type="number" min="0.01" step="0.01" value={cashEntry.amount} onChange={(event) => setCashEntry({ ...cashEntry, amount: event.target.value })} required /></label><label className="wide-field">Description<input value={cashEntry.description} onChange={(event) => setCashEntry({ ...cashEntry, description: event.target.value })} placeholder="Example: Shop rent for April" /></label></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setShowCashEntry(false)}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? 'Saving...' : 'Save to Cashflow & Ledger'}</button></div></form></div>}

      {showAccountEditor && <div className="modal-backdrop"><form className="modal-card accounting-account-modal" onSubmit={saveAccount}><div className="section-title-row"><div><h3>Add Account</h3><p>Create accounts such as Equity - Hakam, Security Deposit or a new expense category.</p></div><button type="button" className="secondary-button" onClick={() => setShowAccountEditor(false)}>Close</button></div><label>Account name<input value={accountForm.name} onChange={(event) => setAccountForm({ ...accountForm, name: event.target.value })} required autoFocus /></label><label>Code optional<input value={accountForm.code} onChange={(event) => setAccountForm({ ...accountForm, code: event.target.value })} placeholder="Generated automatically when empty" /></label><label>Classification<select value={accountForm.classification} onChange={(event) => setAccountForm({ ...accountForm, classification: event.target.value, profit_group: event.target.value === 'equity' ? accountForm.profit_group : '' })}><option value="expense">Expense</option><option value="current_asset">Current asset</option><option value="fixed_asset">Fixed asset</option><option value="non_current_asset">Non-current asset</option><option value="current_liability">Current liability</option><option value="long_term_liability">Long-term liability</option><option value="equity">Equity / Capital</option><option value="other_income">Other income</option></select></label>{accountForm.classification === 'equity' && <label>Profit allocation group<select value={accountForm.profit_group} onChange={(event) => setAccountForm({ ...accountForm, profit_group: event.target.value })}><option value="">Not included</option><option value="partner">Partner</option><option value="investor">Investor</option></select></label>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setShowAccountEditor(false)}>Cancel</button><button className="primary-button" disabled={busy}>Save Account</button></div></form></div>}

      {openingAccount && <div className="modal-backdrop"><form className="modal-card accounting-opening-modal" onSubmit={saveOpeningBalance}><div className="section-title-row"><div><h3>Opening Balance</h3><p>{openingAccount.code} · {openingAccount.name}</p></div><button type="button" className="secondary-button" onClick={() => setOpeningAccount(null)}>Close</button></div><div className="notice slim-notice">Enter the balance on the date you begin using this accounting system. A balancing Opening Balance Equity line is created automatically.</div><label>Opening date<input type="date" value={openingForm.opening_date} onChange={(event) => setOpeningForm({ ...openingForm, opening_date: event.target.value })} /></label><label>Balance<input type="number" step="0.01" value={openingForm.balance} onChange={(event) => setOpeningForm({ ...openingForm, balance: event.target.value })} /></label><label>Note<input value={openingForm.notes} onChange={(event) => setOpeningForm({ ...openingForm, notes: event.target.value })} /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setOpeningAccount(null)}>Cancel</button><button className="primary-button" disabled={busy}>Save Opening Balance</button></div></form></div>}
    </section>
  );
}

function SettingsPage({ activeStaff, appSettings = DEFAULT_APP_SETTINGS, autoLockMinutes = 5, onSettingsSaved, onAutoLockChanged } = {}) {
  const [settingsSection, setSettingsSection] = useState('application');
  const [form, setForm] = useState({ ...DEFAULT_APP_SETTINGS, ...appSettings, auto_lock_minutes: autoLockMinutes });
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setForm({ ...DEFAULT_APP_SETTINGS, ...appSettings, auto_lock_minutes: autoLockMinutes });
  }, [appSettings.updated_at, autoLockMinutes]);
  useEffect(() => { loadSettingsPaymentMethods(); }, []);
  useRealtimeRefresh(['payment_methods'], loadSettingsPaymentMethods);

  async function loadSettingsPaymentMethods() {
    const { data, error: loadError } = await supabase.from('payment_methods').select('id, name, is_active, is_paid_method').eq('is_active', true).order('name');
    if (loadError) setError(loadError.message); else setPaymentMethods(data || []);
  }

  async function saveSettings(event) {
    event.preventDefault();
    setSaving(true); setError(''); setMessage('');
    const autoLock = Math.min(Math.max(Math.round(numberValue(form.auto_lock_minutes, 5)), 1), 240);
    const { data, error: saveError } = await supabase.rpc('admin_save_app_settings_v41', {
      p_settings: {
        allow_negative_pos_stock: !!form.allow_negative_pos_stock,
        show_pos_stock_badges: form.show_pos_stock_badges !== false,
        confirm_pos_sale: !!form.confirm_pos_sale,
        default_payment_method_id: form.default_payment_method_id || null,
        auto_lock_minutes: autoLock
      }
    });
    setSaving(false);
    if (saveError) {
      setError(`${saveError.message}. Run migration 041_admin_app_settings.sql if it has not been applied.`);
      return;
    }
    const saved = { ...DEFAULT_APP_SETTINGS, ...(data || {}), default_payment_method_id: data?.default_payment_method_id || '' };
    setForm({ ...saved, auto_lock_minutes: autoLock });
    onSettingsSaved?.(saved);
    onAutoLockChanged?.(autoLock);
    setMessage('Settings saved and synchronized to all active devices.');
  }

  return (
    <section className="page-section settings-page">
      <nav className="settings-section-tabs" aria-label="Settings sections">
        {[
          ['application', 'Application', 'POS, stock and security defaults'],
          ['company', 'Company & Printing', 'Shop details, logo and documents'],
          ['payments', 'Payment Types', 'Cash, bank, card and credit methods'],
          ['users', 'Users & Security', 'Staff, PINs and trusted devices'],
          ['backups', 'Backups & Restore', 'Daily backups and recovery']
        ].map(([key, label, description]) => (
          <button key={key} type="button" className={settingsSection === key ? 'settings-section-tab active' : 'settings-section-tab'} onClick={() => setSettingsSection(key)}>
            <strong>{label}</strong>
            <small>{description}</small>
          </button>
        ))}
      </nav>

      {settingsSection === 'application' && <>
      <div className="page-actions settings-page-heading"><div><h3>Application Settings</h3><p>Admin-only controls shared by every trusted POS device.</p></div><button className="primary-button" form="application-settings-form" disabled={saving}>{saving ? 'Saving...' : 'Save Settings'}</button></div>
      {error && <div className="error-box">{error}</div>}
      {message && <div className="notice success">{message}</div>}
      <form id="application-settings-form" className="settings-category-grid" onSubmit={saveSettings}>
        <div className="panel-card settings-category-card">
          <div className="settings-category-heading"><span>POS</span><div><h3>Checkout behavior</h3><p>Defaults used while creating sales.</p></div></div>
          <label className="settings-toggle-row"><input type="checkbox" checked={!!form.confirm_pos_sale} onChange={(e) => setForm({ ...form, confirm_pos_sale: e.target.checked })} /><span><strong>Confirm before saving a sale</strong><small>Shows a final amount confirmation for F10 and quick payment saves.</small></span></label>
          <label className="settings-toggle-row"><input type="checkbox" checked={form.show_pos_stock_badges !== false} onChange={(e) => setForm({ ...form, show_pos_stock_badges: e.target.checked })} /><span><strong>Show stock badges on POS tiles</strong><small>Displays available, low, zero, or negative stock below each product.</small></span></label>
          <label className="settings-field-row"><span><strong>Preferred payment method</strong><small>Shown first inside the F10 payment workspace.</small></span><select value={form.default_payment_method_id || ''} onChange={(e) => setForm({ ...form, default_payment_method_id: e.target.value })}><option value="">Use alphabetical order</option>{paymentMethods.map((method) => <option key={method.id} value={method.id}>{method.name}{method.is_paid_method === false ? ' (Credit)' : ''}</option>)}</select></label>
        </div>

        <div className="panel-card settings-category-card">
          <div className="settings-category-heading"><span>ST</span><div><h3>Stock control</h3><p>Controls how POS sales behave when physical stock runs out.</p></div></div>
          <label className={`settings-toggle-row warning-setting ${form.allow_negative_pos_stock ? 'enabled' : ''}`}><input type="checkbox" checked={!!form.allow_negative_pos_stock} onChange={(e) => setForm({ ...form, allow_negative_pos_stock: e.target.checked })} /><span><strong>Allow negative stock in POS sales</strong><small>When enabled, admins and permitted staff may sell tracked items beyond available quantity. COD orders still require physical stock.</small></span></label>
          <div className="settings-safety-note"><strong>{form.allow_negative_pos_stock ? 'Negative stock will be allowed' : 'Overselling is blocked'}</strong><span>{form.allow_negative_pos_stock ? 'Use the Stock page to identify and correct negative quantities.' : 'Product selection and database saving both enforce available quantity.'}</span></div>
        </div>

        <div className="panel-card settings-category-card">
          <div className="settings-category-heading"><span>SC</span><div><h3>Security</h3><p>Trusted-device session behavior.</p></div></div>
          <label className="settings-field-row"><span><strong>Automatic lock</strong><small>Locks the current operator after inactivity. Staff unlock again using their PIN.</small></span><div className="settings-number-field"><input type="number" min="1" max="240" step="1" value={form.auto_lock_minutes} onChange={(e) => setForm({ ...form, auto_lock_minutes: e.target.value })} /><em>minutes</em></div></label>
        </div>

        <div className="panel-card settings-category-card">
          <div className="settings-category-heading"><span>✓</span><div><h3>Accounting safeguards</h3><p>These protections remain enforced and cannot be disabled.</p></div></div>
          <div className="settings-protection-list"><div><strong>Named credit customers</strong><small>Walk-in customers cannot carry an outstanding balance.</small></div><div><strong>Supplier required for purchases</strong><small>Every purchase remains attached to a supplier account.</small></div><div><strong>Realtime synchronization</strong><small>Documents, stock, balances, jobs and COD updates refresh across devices.</small></div></div>
        </div>
      </form>
      </>}

      {settingsSection === 'company' && <div className="settings-embedded-page"><MyCompanyPage /></div>}
      {settingsSection === 'payments' && <div className="settings-embedded-page"><PaymentTypesPage /></div>}
      {settingsSection === 'users' && <div className="settings-embedded-page"><UsersSecurityPage activeStaff={activeStaff} autoLockMinutes={autoLockMinutes} onAutoLockChanged={onAutoLockChanged} /></div>}
      {settingsSection === 'backups' && <div className="settings-embedded-page"><BackupsPage /></div>}
    </section>
  );
}


function PaymentTypesPage() {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ name: '', is_paid_method: true, affects_cashflow: true, account_kind: 'other' });
  const [error, setError] = useState('');

  useEffect(() => { loadRows(); }, []);
  useRealtimeRefresh(['payment_methods'], loadRows);

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
      account_kind: form.is_paid_method && form.affects_cashflow ? form.account_kind : 'other',
      is_active: true
    };
    const { error: insertError } = await supabase.from('payment_methods').insert(payload);
    if (insertError) setError(insertError.message);
    else {
      setForm({ name: '', is_paid_method: true, affects_cashflow: true, account_kind: 'other' });
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
          {form.is_paid_method && form.affects_cashflow && <><label>Cashflow account type</label><select value={form.account_kind} onChange={(e) => setForm({ ...form, account_kind: e.target.value })}><option value="cash">Cash drawer</option><option value="bank">Bank account</option><option value="other">Other payment account</option></select><small className="muted-text">Cash and bank accounts appear separately on the Cashflow page and can be used for transfers.</small></>}
          <button className="primary-button full-width">Save</button>
        </form>
      </div>
      <div className="panel-card table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Paid/Unpaid</th><th>Account Type</th><th>Affects Cashflow</th><th>Active</th><th>Action</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.name}</td>
                <td>{row.is_paid_method === false ? 'Unpaid / Credit' : 'Paid'}</td>
                <td>{row.account_kind === 'cash' ? 'Cash drawer' : row.account_kind === 'bank' ? 'Bank account' : 'Other'}</td>
                <td>{row.affects_cashflow ? 'Yes' : 'No'}</td>
                <td>{row.is_active ? 'Yes' : 'No'}</td>
                <td><button className="small-button" onClick={() => toggleActive(row)}>{row.is_active ? 'Disable' : 'Enable'}</button></td>
              </tr>
            ))}
            {rows.length === 0 && <EmptyRow colSpan={6} text="No payment types." />}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function UsersSecurityPage({ activeStaff, autoLockMinutes = 5, onAutoLockChanged } = {}) {
  const [staff, setStaff] = useState([]);
  const [devices, setDevices] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ id: '', full_name: '', role: 'staff', is_active: true, permissions: { ...DEFAULT_STAFF_PERMISSIONS }, pin: '', confirmPin: '' });
  const [lockMinutes, setLockMinutes] = useState(autoLockMinutes);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { loadSecurityAdmin(); }, []);
  useEffect(() => setLockMinutes(autoLockMinutes), [autoLockMinutes]);

  async function loadSecurityAdmin() {
    setError('');
    const [staffRes, devicesRes] = await Promise.all([
      supabase.rpc('admin_list_staff_v38'),
      supabase.rpc('admin_list_trusted_devices_v38')
    ]);
    const loadError = staffRes.error || devicesRes.error;
    if (loadError) setError(`${loadError.message}. Run migrations 038 and 039 if they have not been applied.`);
    else { setStaff(staffRes.data || []); setDevices(devicesRes.data || []); }
  }

  function openNewStaff() {
    setForm({ id: '', full_name: '', role: 'staff', is_active: true, permissions: { ...DEFAULT_STAFF_PERMISSIONS }, pin: '', confirmPin: '' });
    setMessage(''); setError(''); setShowForm(true);
  }

  function openEditStaff(row) {
    setForm({ id: row.id, full_name: row.full_name, role: row.role, is_active: row.is_active, permissions: { ...DEFAULT_STAFF_PERMISSIONS, ...(row.permissions || {}) }, pin: '', confirmPin: '' });
    setMessage(''); setError(''); setShowForm(true);
  }

  async function saveStaff(event) {
    event.preventDefault();
    if (form.pin && form.pin !== form.confirmPin) { setError('PIN confirmation does not match.'); return; }
    if (!form.id && form.pin.length !== 4) { setError('Set a 4-digit PIN for the new user.'); return; }
    setBusy(true); setError(''); setMessage('');
    const { error: saveError } = await supabase.rpc('admin_save_staff_v38', {
      p_staff_id: form.id || null,
      p_full_name: form.full_name.trim(),
      p_role: form.role,
      p_permissions: form.role === 'admin' ? {} : form.permissions,
      p_pin: form.pin || null,
      p_is_active: form.is_active
    });
    setBusy(false);
    if (saveError) { setError(saveError.message); return; }
    setMessage(form.id ? `${form.full_name} updated.` : `${form.full_name} added.`);
    setShowForm(false);
    await loadSecurityAdmin();
  }

  async function setStaffActive(row, isActive) {
    if (!isActive && !window.confirm(`Deactivate ${row.full_name}? They will no longer be able to unlock the POS.`)) return;
    setBusy(true); setError(''); setMessage('');
    const { error: updateError } = await supabase.rpc('admin_save_staff_v38', {
      p_staff_id: row.id,
      p_full_name: row.full_name,
      p_role: row.role,
      p_permissions: row.permissions || {},
      p_pin: null,
      p_is_active: isActive
    });
    setBusy(false);
    if (updateError) setError(updateError.message);
    else { setMessage(`${row.full_name} ${isActive ? 'reactivated' : 'deactivated'}. Historical records are preserved.`); await loadSecurityAdmin(); }
  }

  async function saveAutoLock(event) {
    event.preventDefault();
    setBusy(true); setError(''); setMessage('');
    const { data, error: settingsError } = await supabase.rpc('admin_update_pos_security_v38', { p_auto_lock_minutes: Number(lockMinutes) });
    setBusy(false);
    if (settingsError) setError(settingsError.message);
    else { const minutes = Number(data?.auto_lock_minutes || lockMinutes); onAutoLockChanged?.(minutes); setMessage(`Auto-lock updated to ${minutes} minute${minutes === 1 ? '' : 's'}.`); }
  }

  async function setDeviceActive(device, isActive) {
    if (!isActive && !window.confirm(`Remove trust from ${device.device_name}? Any active PIN session on it will be locked.`)) return;
    setBusy(true); setError(''); setMessage('');
    const { error: deviceError } = await supabase.rpc('admin_set_trusted_device_active_v38', { p_device_id: device.id, p_is_active: isActive });
    setBusy(false);
    if (deviceError) setError(deviceError.message);
    else { setMessage(`${device.device_name} is now ${isActive ? 'trusted' : 'not trusted'}.`); await loadSecurityAdmin(); }
  }

  if (activeStaff?.role !== 'admin') return <FullScreenMessage title="Admin only" message="An admin PIN is required to manage users and security." />;

  return (
    <section className="page-section users-security-page">
      <div className="section-title-row"><div><h3>Users & Security</h3><p>Use one owner email login to trust a browser, then let each person unlock it using their own 4-digit PIN.</p></div><button className="primary-button" onClick={openNewStaff}>Add User</button></div>
      {message && <div className="notice success">{message}</div>}{error && <div className="error-box">{error}</div>}

      {showForm && <form className="panel-card staff-editor" onSubmit={saveStaff}>
        <div className="section-title-row"><div><h3>{form.id ? `Edit ${form.full_name}` : 'New User'}</h3><p>Changing a PIN is optional when editing. PINs must be unique and contain exactly four numbers.</p></div><button type="button" className="secondary-button" onClick={() => setShowForm(false)}>Close</button></div>
        <div className="staff-basic-grid">
          <label>Name<input autoFocus value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} required /></label>
          <label>Access level<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="staff">Staff · selected permissions</option><option value="admin">Admin · full access</option></select></label>
          <label>{form.id ? 'New PIN (optional)' : '4-digit PIN'}<input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength="4" value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, '').slice(0, 4) })} required={!form.id} /></label>
          <label>Confirm PIN<input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength="4" value={form.confirmPin} onChange={(e) => setForm({ ...form, confirmPin: e.target.value.replace(/\D/g, '').slice(0, 4) })} required={!!form.pin} /></label>
          <label className="staff-active-check"><input type="checkbox" disabled={form.id === activeStaff?.id} checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} /> Active user</label>
        </div>
        {form.role === 'admin' ? <div className="admin-access-note"><strong>Administrator</strong><span>Administrators always have every permission, including users, trusted devices, settings and backups.</span></div> : <div className="permission-groups">{STAFF_PERMISSION_GROUPS.map((group) => <fieldset key={group.label}><legend>{group.label}</legend>{group.items.map((permission) => <label key={permission.key} className="permission-option"><input type="checkbox" checked={form.permissions[permission.key] === true} onChange={(e) => setForm({ ...form, permissions: { ...form.permissions, [permission.key]: e.target.checked } })} /><span><strong>{permission.label}</strong><small>{permission.default ? 'Suitable for normal staff' : 'Sensitive access'}</small></span></label>)}</fieldset>)}</div>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setShowForm(false)}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? 'Saving...' : 'Save User'}</button></div>
      </form>}

      <div className="panel-card">
        <div className="section-title-row"><div><h3>Users</h3><p>Deactivate former staff instead of deleting them so invoices keep the correct operator name.</p></div></div>
        <div className="table-wrap"><table><thead><tr><th>Name</th><th>Level</th><th>PIN</th><th>Email identity</th><th>Status</th><th>Actions</th></tr></thead><tbody>
          {staff.map((row) => <tr key={row.id}><td><strong>{row.full_name}</strong>{row.id === activeStaff?.id && <small className="current-user-label">Currently active</small>}</td><td>{row.role === 'admin' ? 'Admin' : 'Staff'}</td><td>{row.has_pin ? 'Set' : 'Not set'}</td><td>{row.auth_email || 'PIN only'}</td><td><span className={row.is_active ? 'status-pill active' : 'status-pill inactive'}>{row.is_active ? 'Active' : 'Inactive'}</span></td><td><button className="small-button" onClick={() => openEditStaff(row)}>Edit</button><button className={row.is_active ? 'small-button danger' : 'small-button'} disabled={busy || row.id === activeStaff?.id} title={row.id === activeStaff?.id ? 'Switch to another admin before deactivating this user' : ''} onClick={() => setStaffActive(row, !row.is_active)}>{row.is_active ? 'Deactivate' : 'Reactivate'}</button></td></tr>)}
          {!staff.length && <EmptyRow colSpan={6} text="No users found." />}
        </tbody></table></div>
      </div>

      <div className="security-admin-grid">
        <form className="panel-card auto-lock-card" onSubmit={saveAutoLock}><h3>Automatic lock</h3><p>Lock the staff session after no clicks, typing or touch activity. The email session stays signed in because this is a trusted device.</p><label>Inactive for<input type="number" min="1" max="120" value={lockMinutes} onChange={(e) => setLockMinutes(e.target.value)} /><span>minutes</span></label><button className="primary-button" disabled={busy}>Save Auto-lock</button></form>
        <div className="panel-card trusted-devices-card"><h3>Trusted devices</h3><p>A removed device must be authorized again using the linked owner email and password.</p><div className="trusted-device-list">{devices.map((device) => <div key={device.id} className="trusted-device-row"><div><strong>{device.device_name}</strong><small>Last used {new Date(device.last_seen_at).toLocaleString('en-LK')}</small></div><span className={device.is_active ? 'status-pill active' : 'status-pill inactive'}>{device.is_active ? 'Trusted' : 'Removed'}</span><button className="small-button" disabled={busy} onClick={() => setDeviceActive(device, !device.is_active)}>{device.is_active ? 'Remove trust' : 'Trust again'}</button></div>)}{!devices.length && <div className="muted-box">No trusted devices.</div>}</div></div>
      </div>
    </section>
  );
}

function MyCompanyPage() {
  const [form, setForm] = useState(DEFAULT_COMPANY_SETTINGS);
  const [logoFile, setLogoFile] = useState(null);
  const [logoPreview, setLogoPreview] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    fetchCompanySettings()
      .then((settings) => { if (active) setForm(settings); })
      .catch((loadError) => { if (active) setError(`${loadError.message}. Run migration 030_company_branding_a5_printing.sql if it has not been applied.`); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => () => {
    if (logoPreview.startsWith('blob:')) URL.revokeObjectURL(logoPreview);
  }, [logoPreview]);

  function chooseLogo(event) {
    const file = event.target.files?.[0] || null;
    setError('');
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('Logo must be a PNG, JPG, or WebP image.');
      event.target.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Logo must be smaller than 5 MB.');
      event.target.value = '';
      return;
    }
    if (logoPreview.startsWith('blob:')) URL.revokeObjectURL(logoPreview);
    setLogoFile(file);
    setLogoPreview(URL.createObjectURL(file));
  }

  async function saveCompanySettings(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');
    try {
      let logoPath = form.logo_path || null;
      if (logoFile) {
        logoPath = 'branding/shop-logo';
        const { error: uploadError } = await supabase.storage.from('company-assets').upload(logoPath, logoFile, {
          upsert: true,
          contentType: logoFile.type,
          cacheControl: '3600'
        });
        if (uploadError) throw uploadError;
      }
      const payload = {
        id: true,
        shop_name: String(form.shop_name || '').trim() || 'Computer Shop',
        phone: String(form.phone || '').trim() || null,
        address: String(form.address || '').trim() || null,
        email: String(form.email || '').trim() || null,
        registration_no: String(form.registration_no || '').trim() || null,
        header_subtitle: String(form.header_subtitle || '').trim() || null,
        currency: 'LKR',
        invoice_footer: String(form.invoice_footer || '').trim() || null,
        logo_path: logoPath,
        paper_size: form.paper_size || 'A5',
        page_margin_mm: Math.min(Math.max(numberValue(form.page_margin_mm, 8), 4), 20),
        show_item_code: form.show_item_code !== false,
        show_serial_number: !!form.show_serial_number,
        show_warranty: !!form.show_warranty,
        show_payment_movements: !!form.show_payment_movements,
        updated_at: new Date().toISOString()
      };
      const { data, error: saveError } = await supabase.from('company_settings').upsert(payload).select('*').single();
      if (saveError) throw saveError;
      setForm({ ...DEFAULT_COMPANY_SETTINGS, ...data });
      setLogoFile(null);
      setLogoPreview('');
      setMessage('Company details and A5 print settings saved.');
    } catch (saveError) {
      setError(saveError.message || String(saveError));
    } finally {
      setSaving(false);
    }
  }

  const visibleLogo = logoPreview || companyLogoUrl(form);

  return (
    <section className="page-section company-settings-page">
      <div className="page-actions"><div><h3>Company &amp; Printing</h3><p>These details appear on invoices, quotations, purchases, and COD package bills.</p></div></div>
      {error && <div className="error-box">{error}</div>}
      {message && <div className="notice success">{message}</div>}
      {loading ? <div className="panel-card">Loading company settings...</div> : <form onSubmit={saveCompanySettings}>
        <div className="company-settings-layout">
          <div className="company-settings-fields">
            <div className="panel-card form-card company-form-card">
              <h3>Company Header</h3>
              <div className="company-logo-editor">
                <div className="company-logo-preview">{visibleLogo ? <img src={visibleLogo} alt="Company logo preview" /> : <span>LOGO</span>}</div>
                <label className="company-logo-upload">Logo image<input type="file" accept="image/png,image/jpeg,image/webp" onChange={chooseLogo} /><small>PNG, JPG, or WebP. Maximum 5 MB.</small></label>
              </div>
              <div className="company-form-grid">
                <label>Shop name<input value={form.shop_name || ''} onChange={(e) => setForm({ ...form, shop_name: e.target.value })} required /></label>
                <label>Header subtitle<input value={form.header_subtitle || ''} onChange={(e) => setForm({ ...form, header_subtitle: e.target.value })} placeholder="Sales · Repairs · Accessories" /></label>
                <label>Phone<input value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
                <label>Email<input type="email" value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
                <label>Business registration optional<input value={form.registration_no || ''} onChange={(e) => setForm({ ...form, registration_no: e.target.value })} /></label>
                <label>Currency<input value="LKR" readOnly /></label>
                <label className="wide-field">Address<textarea value={form.address || ''} onChange={(e) => setForm({ ...form, address: e.target.value })} /></label>
              </div>
            </div>

            <div className="panel-card form-card company-form-card">
              <h3>Document Options</h3>
              <div className="company-form-grid">
                <label>Paper size<select value={form.paper_size || 'A5'} onChange={(e) => setForm({ ...form, paper_size: e.target.value })}><option value="A5">A5 portrait</option><option value="A4">A4 portrait</option></select></label>
                <label>Page margin (mm)<input type="number" min="4" max="20" step="1" value={form.page_margin_mm ?? 8} onChange={(e) => setForm({ ...form, page_margin_mm: e.target.value })} /></label>
                <label className="wide-field">Invoice footer / warranty terms<textarea value={form.invoice_footer || ''} onChange={(e) => setForm({ ...form, invoice_footer: e.target.value })} placeholder="Thank you, warranty terms, return policy..." /></label>
              </div>
              <div className="company-print-checks">
                <label className="checkbox-label"><input type="checkbox" checked={form.show_item_code !== false} onChange={(e) => setForm({ ...form, show_item_code: e.target.checked })} /> Show item code</label>
                <label className="checkbox-label"><input type="checkbox" checked={!!form.show_serial_number} onChange={(e) => setForm({ ...form, show_serial_number: e.target.checked })} /> Show serial number when available</label>
                <label className="checkbox-label"><input type="checkbox" checked={!!form.show_warranty} onChange={(e) => setForm({ ...form, show_warranty: e.target.checked })} /> Show warranty when available</label>
                <label className="checkbox-label"><input type="checkbox" checked={!!form.show_payment_movements} onChange={(e) => setForm({ ...form, show_payment_movements: e.target.checked })} /> Show payment movements</label>
              </div>
            </div>
          </div>

          <div className="panel-card company-print-preview-card">
            <div className={`company-paper-preview ${form.paper_size === 'A4' ? 'a4' : 'a5'}`}>
              <div className="company-paper-header">{visibleLogo && <img src={visibleLogo} alt="" />}<div><strong>{form.shop_name || 'Computer Shop'}</strong><span>{form.header_subtitle || 'Document header preview'}</span></div></div>
              <div className="company-paper-rule" />
              <div className="company-paper-title"><b>SALES INVOICE</b><span>INV-000001</span></div>
              <div className="company-paper-meta"><i /><i /><i /><i /></div>
              <div className="company-paper-table"><i /><i /><i /><i /><i /></div>
              <div className="company-paper-total" />
              <small>{form.invoice_footer || 'Invoice footer will appear here.'}</small>
            </div>
            <p>A5 portrait preview. The browser print dialog can print to paper or save the same layout as PDF.</p>
          </div>
        </div>
        <div className="company-save-bar"><button className="primary-button" disabled={saving}>{saving ? 'Saving...' : 'Save Company & Print Settings'}</button></div>
      </form>}
    </section>
  );
}

function formatBackupSize(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function BackupsPage() {
  const [backups, setBackups] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [restoreText, setRestoreText] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [restoreComplete, setRestoreComplete] = useState(null);

  const selected = backups.find((backup) => backup.id === selectedId) || backups[0] || null;
  const latestDaily = backups.find((backup) => backup.backup_type === 'daily') || null;

  useEffect(() => { loadBackups(); }, []);

  async function loadBackups() {
    setLoading(true);
    setError('');
    try {
      const { error: ensureError } = await supabase.rpc('ensure_daily_app_backup_v31');
      if (ensureError) throw ensureError;
      const { data, error: listError } = await supabase
        .from('app_backups')
        .select('id, backup_date, backup_type, status, schema_version, row_counts, snapshot_size_bytes, notes, created_at, restored_at')
        .order('created_at', { ascending: false })
        .limit(365);
      if (listError) throw listError;
      setBackups(data || []);
      setSelectedId((current) => (data || []).some((row) => row.id === current) ? current : data?.[0]?.id || '');
    } catch (loadError) {
      setError(`${loadError.message || String(loadError)}. Run migration 031_daily_backups_party_rules.sql in Supabase if it has not been applied.`);
    } finally {
      setLoading(false);
    }
  }

  async function createManualBackup() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const { error: backupError } = await supabase.rpc('create_app_backup_v31', {
        p_backup_type: 'manual',
        p_notes: 'Manual backup from Backups & Restore'
      });
      if (backupError) throw backupError;
      setMessage('Manual backup created successfully.');
      await loadBackups();
    } catch (backupError) {
      setError(backupError.message || String(backupError));
    } finally {
      setBusy(false);
    }
  }

  async function downloadBackup() {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const { data, error: downloadError } = await supabase
        .from('app_backups')
        .select('id, backup_date, backup_type, schema_version, row_counts, snapshot, created_at')
        .eq('id', selected.id)
        .single();
      if (downloadError) throw downloadError;
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `shop-pos-backup-${data.backup_date}-${data.id.slice(0, 8)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setMessage(`Backup downloaded: ${link.download}`);
    } catch (downloadError) {
      setError(downloadError.message || String(downloadError));
    } finally {
      setBusy(false);
    }
  }

  async function restoreBackup() {
    if (!selected || restoreText !== 'RESTORE') return;
    if (!window.confirm(`Restore all shop data to the snapshot from ${fmtDate(selected.created_at)}? Current data will first be saved as a safety backup.`)) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const { data, error: restoreError } = await supabase.rpc('restore_app_backup_v31', { p_backup_id: selected.id });
      if (restoreError) throw restoreError;
      setRestoreComplete(data || { restored_backup_id: selected.id });
      setRestoreText('');
      setMessage('Restore completed. Reload the app before continuing work.');
      await loadBackups();
    } catch (restoreError) {
      setError(restoreError.message || String(restoreError));
    } finally {
      setBusy(false);
    }
  }

  const counts = selected?.row_counts || {};

  return (
    <section className="page-section backups-page">
      <div className="page-actions backup-page-heading">
        <div><h3>Backups &amp; Restore</h3><p>Daily snapshots preserve products, stock, documents, payments, parties, settings, and PC assemblies.</p></div>
        <button className="primary-button" disabled={busy} onClick={createManualBackup}>{busy ? 'Working...' : 'Create Backup Now'}</button>
      </div>

      {error && <div className="error-box">{error}</div>}
      {message && <div className="notice success">{message}</div>}

      <div className="backup-status-grid">
        <div className="panel-card backup-status-card healthy"><span>Automatic backup</span><strong>{latestDaily ? 'Active' : loading ? 'Checking…' : 'Waiting for first backup'}</strong><small>Scheduled for 12:00 AM Sri Lanka time, with app-open fallback.</small></div>
        <div className="panel-card backup-status-card"><span>Latest daily snapshot</span><strong>{latestDaily ? new Date(latestDaily.created_at).toLocaleString('en-LK') : '—'}</strong><small>{latestDaily ? `${formatBackupSize(latestDaily.snapshot_size_bytes)} · ${latestDaily.row_counts?.documents || 0} documents` : 'No daily snapshot found yet.'}</small></div>
        <div className="panel-card backup-status-card"><span>Stored snapshots</span><strong>{backups.length}</strong><small>Manual and pre-restore safety snapshots are kept separately.</small></div>
      </div>

      <div className="backup-layout">
        <div className="panel-card backup-list-card">
          <div className="section-title-row"><div><h3>Available restore points</h3><p>Select the exact date and time you want to inspect or restore.</p></div><button className="secondary-button" disabled={loading || busy} onClick={loadBackups}>Refresh</button></div>
          <div className="table-wrap backup-table-wrap">
            <table>
              <thead><tr><th>Date &amp; time</th><th>Type</th><th>Documents</th><th>Size</th><th>Status</th></tr></thead>
              <tbody>
                {backups.map((backup) => <tr key={backup.id} className={selected?.id === backup.id ? 'selected-row' : ''} onClick={() => { setSelectedId(backup.id); setRestoreText(''); }}>
                  <td><strong>{new Date(backup.created_at).toLocaleDateString('en-LK')}</strong><small>{new Date(backup.created_at).toLocaleTimeString('en-LK')}</small></td>
                  <td><span className={`backup-type-badge ${backup.backup_type}`}>{backup.backup_type === 'pre_restore' ? 'Safety' : backup.backup_type}</span></td>
                  <td>{backup.row_counts?.documents || 0}</td>
                  <td>{formatBackupSize(backup.snapshot_size_bytes)}</td>
                  <td>{backup.status === 'restored' ? 'Used to restore' : 'Ready'}</td>
                </tr>)}
                {!loading && backups.length === 0 && <EmptyRow colSpan={5} text="No backups yet." />}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel-card backup-detail-card">
          {selected ? <>
            <div><span className={`backup-type-badge ${selected.backup_type}`}>{selected.backup_type === 'pre_restore' ? 'Safety backup' : `${selected.backup_type} backup`}</span><h3>{new Date(selected.created_at).toLocaleString('en-LK')}</h3><p>{selected.notes || 'Shop data snapshot'}</p></div>
            <div className="backup-count-grid">
              <StatCard label="Products" value={counts.products || 0} />
              <StatCard label="Documents" value={counts.documents || 0} />
              <StatCard label="Document items" value={counts.document_items || 0} />
              <StatCard label="Stock movements" value={counts.stock_movements || 0} />
              <StatCard label="Customers" value={counts.customers || 0} />
              <StatCard label="Suppliers" value={counts.suppliers || 0} />
            </div>
            <button className="secondary-button backup-download-button" disabled={busy} onClick={downloadBackup}>Download JSON Copy</button>
            <div className="backup-restore-zone">
              <strong>Restore this snapshot</strong>
              <p>This replaces the current shop data with the selected point in time. A safety backup of the current data is created automatically first.</p>
              <label>Type RESTORE to enable<input value={restoreText} onChange={(e) => setRestoreText(e.target.value)} placeholder="RESTORE" autoComplete="off" /></label>
              <button className="danger-button" disabled={busy || restoreText !== 'RESTORE'} onClick={restoreBackup}>{busy ? 'Restoring…' : 'Restore Selected Backup'}</button>
            </div>
          </> : <div className="muted-box">Select a backup to view its details.</div>}
        </div>
      </div>

      <div className="backup-safety-note"><strong>Important:</strong> These are logical backups stored inside the same Supabase project. Download periodic JSON copies and keep Supabase managed backups enabled for protection if the whole project is lost.</div>

      {restoreComplete && <div className="modal-backdrop"><div className="modal-card restore-complete-modal"><div className="pos-save-success-icon">✓</div><h3>Restore complete</h3><p>The database now matches the selected backup. Reload so every screen reads the restored data.</p><button className="primary-button" onClick={() => window.location.reload()}>Reload App Now</button></div></div>}
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
