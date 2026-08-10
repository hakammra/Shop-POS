import { useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabaseClient';
import './storefront.css';

const STORE_CART_KEY = 'gatronix_store_cart_v46';
const STORE_IMAGE_BUCKET = 'store-product-images';
const FALLBACK_SETTINGS = {
  store_name: 'Gatronix Store',
  eyebrow: 'COMPUTERS · COMPONENTS · SERVICE',
  hero_title: 'Build faster. Play harder.',
  hero_subtitle: 'Computers, upgrades and dependable technical support from your local specialists.',
  announcement: 'Islandwide delivery available · Message us for expert advice',
  accent_color: '#62e7ff',
  secondary_color: '#8b5cf6'
};

function storeMoney(value) {
  return `LKR ${Number(value || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function storeImageUrl(path) {
  if (!path) return '';
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  return supabase.storage.from(STORE_IMAGE_BUCKET).getPublicUrl(path).data.publicUrl || '';
}

function companyLogoUrl(path) {
  if (!path) return '/gslogo.jpeg';
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  return supabase.storage.from('company-assets').getPublicUrl(path).data.publicUrl || '/gslogo.jpeg';
}

function stripWarrantyText(name = '') {
  return String(name).replace(/\s*\([^)]*warranty[^)]*\)\s*/gi, ' ').replace(/\s{2,}/g, ' ').trim();
}

function productWebName(product) {
  return stripWarrantyText(product.web_name || product.custom_name || product.pos_name || 'Unnamed product');
}

function productWarranty(product) {
  const months = Number(product.warranty_months || 0);
  if (months > 0) {
    if (months % 12 === 0) return `${months / 12} year${months === 12 ? '' : 's'} warranty`;
    return `${months} month${months === 1 ? '' : 's'} warranty`;
  }
  const match = String(product.pos_name || '').match(/\(([^)]*warranty[^)]*)\)/i);
  return match?.[1]?.trim() || 'Warranty information available on request';
}

function categoryPathLabel(category) {
  return String(category?.path || category?.web_name || '').split('/').filter(Boolean).map(storefrontCategoryName).join(' › ');
}

function categoryPathParts(category) {
  return String(category?.path || category?.web_name || '').split('/').map((part) => part.trim()).filter(Boolean);
}

const STOREFRONT_CATEGORY_NAMES = {
  acessories: 'Accessories',
  camera: 'Cameras',
  cases: 'Computer Cases',
  cpu: 'Processors',
  fantech: 'Gaming Gear',
  'fantech gaming accessories': 'Gaming Accessories',
  'fantech keyboard': 'Gaming Keyboards',
  'fantech mouse': 'Gaming Mice',
  'fantech speakers & headphones': 'Gaming Audio',
  hdd: 'Hard Drives',
  monitors: 'Monitors',
  motherboard: 'Motherboards',
  powersupply: 'Power Supplies',
  'power supply': 'Power Supplies',
  ram: 'Memory (RAM)',
  'desktop ram new': 'Desktop RAM — New',
  'desktop ram used': 'Desktop RAM — Used',
  'laptop ram new': 'Laptop RAM — New',
  'laptop ram used': 'Laptop RAM — Used',
  routers: 'Networking',
  ssd: 'Solid State Drives',
  'ssd new': 'New SSDs',
  'ssd used': 'Used SSDs',
  'branded pc': 'Desktop PCs',
  'laptop items': 'Laptops & Parts',
  'softwares & services': 'Software & Services'
};

function storefrontCategoryName(value = '') {
  const name = String(value).trim();
  return STOREFRONT_CATEGORY_NAMES[name.toLowerCase()] || name.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function buildStoreCategoryGroups(categories = []) {
  const sorted = [...categories].sort((a, b) => categoryPathLabel(a).localeCompare(categoryPathLabel(b)));
  const normalizedPath = (category) => categoryPathParts(category).join('/').toLowerCase();
  const rootName = (category) => categoryPathParts(category)[0]?.toLowerCase() || '';
  const leafName = (category) => categoryPathParts(category).at(-1)?.toLowerCase() || '';
  const isAccessories = (category) => /accessories|acessories/.test(rootName(category));
  const unique = (items) => [...new Map(items.map((item) => [item.category_id, item])).values()];
  const roots = sorted.filter((category) => categoryPathParts(category).length === 1);
  const findRoot = (pattern) => roots.find((category) => pattern.test(rootName(category))) || null;

  const definitions = [
    {
      key: 'computers', label: 'Computers', caption: 'Complete systems',
      items: sorted.filter((category) => /branded pc/.test(rootName(category)) || (/laptop items/.test(rootName(category)) && (/^(laptops|mini pc)$/.test(leafName(category)) || categoryPathParts(category).length === 1)))
    },
    {
      key: 'components', label: 'Components', caption: 'Build and upgrade',
      items: sorted.filter((category) => categoryPathParts(category).length === 1 && /^(cpu|motherboard|ram|graphics card|hdd|ssd|powersupply|power supply|cases|case)$/.test(rootName(category)))
        .concat(sorted.filter((category) => isAccessories(category) && /coolers?\s*&?\s*fans?/.test(leafName(category))))
    },
    {
      key: 'laptop_parts', label: 'Laptop Parts', caption: 'Repair and replacement',
      items: sorted.filter((category) => /laptop items/.test(rootName(category)) && categoryPathParts(category).length > 1 && !/^(laptops|mini pc)$/.test(leafName(category)))
    },
    {
      key: 'accessories', label: 'Accessories', caption: 'Everyday essentials',
      allCategory: findRoot(/accessories|acessories/),
      items: sorted.filter((category) => (isAccessories(category) && categoryPathParts(category).length > 1 && !/coolers?\s*&?\s*fans?/.test(leafName(category)))
        || (categoryPathParts(category).length === 1 && /^(camera|monitors?|powerbanks?\s*&?\s*batteries|printers?|routers?)$/.test(rootName(category))))
    },
    {
      key: 'gaming', label: 'Gaming', caption: 'Gaming peripherals',
      allCategory: findRoot(/fantech|gaming/),
      items: sorted.filter((category) => /fantech|gaming/.test(rootName(category)) && categoryPathParts(category).length > 1)
    },
    {
      key: 'software', label: 'Software & Services', caption: 'Setup and protection',
      allCategory: findRoot(/software/),
      items: sorted.filter((category) => /software/.test(rootName(category)) && categoryPathParts(category).length > 1)
    }
  ];

  const assignedIds = new Set(definitions.flatMap((group) => [group.allCategory, ...group.items].filter(Boolean).map((item) => item.category_id)));
  const otherRoots = roots.filter((category) => !assignedIds.has(category.category_id));
  if (otherRoots.length) definitions.push({ key: 'more', label: 'More', caption: 'Other categories', items: otherRoots });
  return definitions.map((group) => ({ ...group, items: unique(group.items) })).filter((group) => group.allCategory || group.items.length);
}

function StoreCategoryNavigation({ groups, productsCount, selectedCategoryId, open, activeGroupKey, onToggle, onGroup, onSelect }) {
  const activeGroup = groups.find((group) => group.key === activeGroupKey) || null;
  const categoryLink = (category, allLabel = '') => <button type="button" key={category.category_id} className={selectedCategoryId === category.category_id ? 'active' : ''} onClick={() => onSelect(category.category_id)}><span><strong>{allLabel || storefrontCategoryName(categoryPathParts(category).at(-1) || category.web_name)}</strong><small>{categoryPathParts(category).map(storefrontCategoryName).join(' / ')}</small></span><em>{category.product_count}</em></button>;
  return <section id="categories" className={`sf-category-navigation${open ? ' open' : ''}${activeGroup ? ' group-open' : ''}`} onMouseLeave={() => { if (window.matchMedia('(min-width: 1181px)').matches) onGroup(''); }}>
    <div className="sf-category-navigation-inner">
      <button type="button" className="sf-mobile-category-toggle" aria-expanded={open} onClick={onToggle}><span>Browse categories</span><small>{groups.length} departments</small><b>{open ? 'Close' : 'Open'}</b></button>
      <div className="sf-category-tabs">
        <button type="button" className={selectedCategoryId === 'all' ? 'active all' : 'all'} onClick={() => onSelect('all')}><span>All products</span><small>{productsCount}</small></button>
        {groups.map((group) => <button type="button" key={group.key} className={activeGroupKey === group.key ? 'active' : ''} onMouseEnter={() => onGroup(group.key)} onClick={() => onGroup(activeGroupKey === group.key ? '' : group.key)}><span>{group.label}</span><small>{group.caption}</small></button>)}
      </div>
      {activeGroup && <div className="sf-category-mega"><div className="sf-category-mega-title"><span>SHOP</span><strong>{activeGroup.label}</strong><small>{activeGroup.caption}</small></div><div className="sf-category-mega-links">{activeGroup.allCategory && categoryLink(activeGroup.allCategory, `All ${activeGroup.label}`)}{activeGroup.items.map((category) => categoryLink(category))}</div></div>}
    </div>
  </section>;
}

function stockState(product) {
  if (product.track_inventory === false) return { label: 'Available', tone: 'ready', canBuy: true };
  const qty = Number(product.available_qty || 0);
  if (qty <= 0) return { label: 'Out of stock', tone: 'out', canBuy: false };
  if (qty <= 2) return { label: `Only ${qty} left`, tone: 'low', canBuy: true };
  return { label: 'In stock', tone: 'ready', canBuy: true };
}

function safeStoredCart() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORE_CART_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function StoreLogo({ settings, compact = false }) {
  return <a className={`sf-logo${compact ? ' compact' : ''}`} href="/store" aria-label={`${settings.store_name} home`}><span><img src={companyLogoUrl(settings.company_logo_path)} alt="" /></span><div><strong>{settings.store_name}</strong><small>TECH THAT MOVES YOU</small></div></a>;
}

function ProductVisual({ product, className = '' }) {
  const image = storeImageUrl(product.image_paths?.[0]);
  return <div className={`sf-product-visual ${className}${image ? ' has-image' : ''}`}>
    {image ? <img src={image} alt={productWebName(product)} /> : <><span>{String(product.category_name || 'TECH').slice(0, 12)}</span><strong>{String(product.item_code || 'GS').slice(-5)}</strong><i /></>}
  </div>;
}

function ProductCard({ product, onOpen, onAdd }) {
  const stock = stockState(product);
  return <article className="sf-product-card">
    <button type="button" className="sf-product-open" onClick={() => onOpen(product)} aria-label={`View ${productWebName(product)}`}>
      <ProductVisual product={product} />
      <div className="sf-product-flags">{product.is_featured && <span className="featured">Featured</span>}{product.badge && <span>{product.badge}</span>}</div>
    </button>
    <div className="sf-product-copy">
      <div className="sf-product-meta"><span>{product.brand_name || product.category_name || 'Gatronix'}</span><span className={`sf-stock ${stock.tone}`}>{stock.label}</span></div>
      <button type="button" className="sf-product-title" onClick={() => onOpen(product)}>{productWebName(product)}</button>
      <p>{product.short_description || productWarranty(product)}</p>
      <div className="sf-product-buy"><div>{Number(product.compare_at_price || 0) > Number(product.selling_price || 0) && <del>{storeMoney(product.compare_at_price)}</del>}<strong>{storeMoney(product.selling_price)}</strong></div><button type="button" disabled={!stock.canBuy} onClick={() => onAdd(product)}>{stock.canBuy ? 'Add' : 'Sold out'}</button></div>
    </div>
  </article>;
}

function ProductModal({ product, onClose, onAdd }) {
  const [imageIndex, setImageIndex] = useState(0);
  if (!product) return null;
  const images = product.image_paths || [];
  const stock = stockState(product);
  const specs = product.specifications && typeof product.specifications === 'object' ? Object.entries(product.specifications) : [];
  return <div className="sf-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="sf-product-modal" role="dialog" aria-modal="true" aria-label={productWebName(product)}>
      <button type="button" className="sf-modal-close" onClick={onClose} aria-label="Close">×</button>
      <div className="sf-modal-gallery">
        {images.length ? <div className="sf-modal-main-image"><img src={storeImageUrl(images[imageIndex] || images[0])} alt={productWebName(product)} /></div> : <ProductVisual product={product} className="large" />}
        {images.length > 1 && <div className="sf-thumbnails">{images.map((path, index) => <button type="button" key={path} className={imageIndex === index ? 'active' : ''} onClick={() => setImageIndex(index)}><img src={storeImageUrl(path)} alt="" /></button>)}</div>}
      </div>
      <div className="sf-modal-details">
        <span className="sf-kicker">{product.category_path || product.category_name || 'Computer technology'}</span>
        <h2>{productWebName(product)}</h2>
        <div className="sf-modal-code">Item {product.item_code} · {product.brand_name || 'Gatronix selection'}</div>
        <p className="sf-modal-description">{product.description || product.short_description || 'Carefully selected and supported by our computer shop team.'}</p>
        <div className="sf-warranty-card"><span>✓</span><div><strong>{productWarranty(product)}</strong><small>Shop-backed service and warranty tracking</small></div></div>
        {specs.length > 0 && <dl className="sf-specs">{specs.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>}
        <div className="sf-modal-purchase"><div><small>{stock.label}</small><strong>{storeMoney(product.selling_price)}</strong></div><button type="button" disabled={!stock.canBuy} onClick={() => onAdd(product)}>{stock.canBuy ? 'Add to cart' : 'Currently unavailable'}</button></div>
      </div>
    </section>
  </div>;
}

function CartDrawer({ open, cart, products, onClose, onQuantity, onCheckout }) {
  const lines = cart.map((item) => ({ ...item, product: products.find((product) => product.product_id === item.product_id) })).filter((item) => item.product);
  const total = lines.reduce((sum, item) => sum + Number(item.product.selling_price || 0) * item.qty, 0);
  return <><button type="button" className={`sf-drawer-scrim${open ? ' open' : ''}`} onClick={onClose} aria-label="Close cart" /><aside className={`sf-cart-drawer${open ? ' open' : ''}`}>
    <div className="sf-cart-head"><div><span>Your selection</span><h2>Shopping cart</h2></div><button type="button" onClick={onClose}>Close</button></div>
    <div className="sf-cart-lines">{lines.map(({ product, qty }) => <div className="sf-cart-line" key={product.product_id}><ProductVisual product={product} /><div><strong>{productWebName(product)}</strong><small>{storeMoney(product.selling_price)}</small><div className="sf-qty"><button type="button" onClick={() => onQuantity(product, qty - 1)}>−</button><span>{qty}</span><button type="button" onClick={() => onQuantity(product, qty + 1)}>+</button></div></div></div>)}{!lines.length && <div className="sf-empty-cart"><span>◇</span><h3>Your cart is ready for something brilliant.</h3><p>Browse the latest products and add your favourites.</p></div>}</div>
    <div className="sf-cart-total"><div><span>Subtotal</span><strong>{storeMoney(total)}</strong></div><small>Delivery charges are confirmed before dispatch.</small><button type="button" disabled={!lines.length} onClick={onCheckout}>Continue to checkout</button></div>
  </aside></>;
}

function CheckoutModal({ cart, products, onClose, onComplete }) {
  const [step, setStep] = useState('details');
  const [form, setForm] = useState({ name: '', phone: '', email: '', address: '', city: '', delivery: 'delivery', payment: 'cod', notes: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [placedOrder, setPlacedOrder] = useState(null);
  const lines = cart.map((item) => ({ ...item, product: products.find((product) => product.product_id === item.product_id) })).filter((item) => item.product);
  const total = lines.reduce((sum, item) => sum + Number(item.product.selling_price || 0) * item.qty, 0);

  async function submit(event) {
    event.preventDefault();
    if (busy || !lines.length) return;
    setBusy(true);
    setError('');
    const { data, error: submitError } = await supabase.rpc('submit_online_store_order_v47', {
      p_order: {
        customer_name: form.name,
        phone: form.phone,
        email: form.email,
        delivery_address: form.address,
        city: form.city,
        fulfillment_method: form.delivery,
        payment_preference: form.payment,
        customer_notes: form.notes,
        items: lines.map(({ product, qty }) => ({ product_id: product.product_id, quantity: qty }))
      }
    });
    setBusy(false);
    if (submitError) {
      setError(`${submitError.message}. Run migration 047_online_store_orders.sql in Supabase if order intake has not been installed.`);
      return;
    }
    setPlacedOrder(data || null);
    setStep('success');
  }

  return <div className="sf-overlay checkout"><section className="sf-checkout" role="dialog" aria-modal="true"><button type="button" className="sf-modal-close" onClick={onClose}>×</button>
    {step === 'success' ? <div className="sf-checkout-success"><span>✓</span><h2>Order request received</h2><strong>{placedOrder?.order_no}</strong><p>Your order has reached our shop. We will contact you to confirm stock, delivery and payment. No online payment was taken.</p><button type="button" onClick={onComplete}>Return to store</button></div> : <>
      <div className="sf-checkout-title"><span>ORDER REQUEST</span><h2>Complete your order</h2><p>Your preferred payment method will be confirmed by our staff.</p></div>
      <form onSubmit={submit} className="sf-checkout-grid"><div className="sf-checkout-fields"><div className="sf-field-row"><label>Full name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label><label>Phone<input required inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label></div><label>Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label><label>Address<textarea required={form.delivery === 'delivery'} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></label><label>Town / city<input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></label><label>Order note<textarea value={form.notes} maxLength={1000} placeholder="Optional: preferred colour, call before delivery, or other details" onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
        <div className="sf-choice-grid"><label className={form.delivery === 'delivery' ? 'active' : ''}><input type="radio" name="delivery" checked={form.delivery === 'delivery'} onChange={() => setForm({ ...form, delivery: 'delivery' })} /><strong>Islandwide delivery</strong><small>Courier charge confirmed by staff</small></label><label className={form.delivery === 'pickup' ? 'active' : ''}><input type="radio" name="delivery" checked={form.delivery === 'pickup'} onChange={() => setForm({ ...form, delivery: 'pickup' })} /><strong>Store pickup</strong><small>Collect after confirmation</small></label></div>
        <h3>Payment preference</h3><div className="sf-payment-options">{[['cod','Cash on delivery'],['bank','Bank transfer'],['pickup','Pay at store'],['card','Card · coming soon']].map(([value,label]) => <label className={form.payment === value ? 'active' : ''} key={value}><input type="radio" name="payment" checked={form.payment === value} onChange={() => setForm({ ...form, payment: value })} /><span>{label}</span></label>)}</div>
      </div><aside className="sf-order-review"><h3>Order summary</h3>{lines.map(({ product, qty }) => <div key={product.product_id}><span>{qty} × {productWebName(product)}</span><strong>{storeMoney(qty * Number(product.selling_price || 0))}</strong></div>)}<div className="total"><span>Total</span><strong>{storeMoney(total)}</strong></div>{error && <div className="sf-checkout-error">{error}</div>}<button disabled={busy}>{busy ? 'Sending order...' : 'Place order request'}</button><small>Submitting creates an order request in the shop POS. Payment is not charged online.</small></aside></form>
    </>}
  </section></div>;
}

function StorefrontSite() {
  const [catalog, setCatalog] = useState({ settings: FALLBACK_SETTINGS, categories: [], products: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('all');
  const [sort, setSort] = useState('featured');
  const [inStockOnly, setInStockOnly] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [cart, setCart] = useState(safeStoredCart);
  const [cartOpen, setCartOpen] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false);
  const [activeCategoryGroup, setActiveCategoryGroup] = useState('');
  const [visibleCount, setVisibleCount] = useState(24);

  useEffect(() => {
    supabase.rpc('get_public_storefront_v46').then(({ data, error: loadError }) => {
      if (loadError) setError(`${loadError.message}. Run migration 046_online_storefront.sql in Supabase.`);
      else setCatalog({ settings: { ...FALLBACK_SETTINGS, ...(data?.settings || {}) }, categories: data?.categories || [], products: data?.products || [] });
      setLoading(false);
    });
  }, []);

  useEffect(() => { window.localStorage.setItem(STORE_CART_KEY, JSON.stringify(cart)); }, [cart]);

  const settings = catalog.settings || FALLBACK_SETTINGS;
  useEffect(() => {
    document.title = `${settings.store_name || 'Gatronix Store'} · Computers & Technology`;
  }, [settings.store_name]);
  const category = catalog.categories.find((item) => item.category_id === categoryId);
  const filteredProducts = useMemo(() => {
    const term = search.trim().toLowerCase();
    let rows = catalog.products.filter((product) => {
      const categoryMatch = categoryId === 'all' || product.category_id === categoryId || (category?.path && String(product.category_path || '').startsWith(`${category.path}/`));
      const searchMatch = !term || [productWebName(product), product.item_code, product.brand_name, product.category_path].some((value) => String(value || '').toLowerCase().includes(term));
      const stockMatch = !inStockOnly || stockState(product).canBuy;
      return categoryMatch && searchMatch && stockMatch;
    });
    if (sort === 'price_low') rows = [...rows].sort((a, b) => Number(a.selling_price) - Number(b.selling_price));
    if (sort === 'price_high') rows = [...rows].sort((a, b) => Number(b.selling_price) - Number(a.selling_price));
    if (sort === 'name') rows = [...rows].sort((a, b) => productWebName(a).localeCompare(productWebName(b)));
    return rows;
  }, [catalog.products, search, categoryId, category?.path, sort, inStockOnly]);
  const visibleProducts = filteredProducts.slice(0, visibleCount);

  useEffect(() => {
    setVisibleCount(24);
  }, [search, categoryId, sort, inStockOnly]);

  const categoryOptions = [...catalog.categories].sort((a, b) => String(a.path || a.web_name).localeCompare(String(b.path || b.web_name)));
  const categoryGroups = buildStoreCategoryGroups(catalog.categories);
  const cartCount = cart.reduce((sum, item) => sum + item.qty, 0);

  function selectCategory(nextCategoryId, scrollToShop = true) {
    setCategoryId(nextCategoryId || 'all');
    setMobileMenu(false);
    setCategoryMenuOpen(false);
    setActiveCategoryGroup('');
    if (scrollToShop) window.setTimeout(() => document.querySelector('#shop')?.scrollIntoView({ behavior: 'smooth' }), 20);
  }

  function addToCart(product) {
    const stock = stockState(product);
    if (!stock.canBuy) return;
    setCart((current) => {
      const existing = current.find((item) => item.product_id === product.product_id);
      const maximum = product.track_inventory === false ? 99 : Math.max(1, Number(product.available_qty || 0));
      if (existing) return current.map((item) => item.product_id === product.product_id ? { ...item, qty: Math.min(item.qty + 1, maximum) } : item);
      return [...current, { product_id: product.product_id, qty: 1 }];
    });
    setCartOpen(true);
  }

  function updateQuantity(product, qty) {
    if (qty <= 0) { setCart((current) => current.filter((item) => item.product_id !== product.product_id)); return; }
    const maximum = product.track_inventory === false ? 99 : Math.max(1, Number(product.available_qty || 0));
    setCart((current) => current.map((item) => item.product_id === product.product_id ? { ...item, qty: Math.min(qty, maximum) } : item));
  }

  if (loading) return <div className="sf-loading"><img src="/gslogo.jpeg" alt="" /><span /><p>Loading the latest store catalogue...</p></div>;
  if (error) return <div className="sf-loading error"><img src="/gslogo.jpeg" alt="" /><h2>Store setup needed</h2><p>{error}</p><a href="/">Return to POS</a></div>;
  if (settings.is_published === false) return <div className="sf-loading"><img src={companyLogoUrl(settings.company_logo_path)} alt="" /><h2>We are updating the store</h2><p>The online catalogue will be available again shortly. Contact the shop directly for prices and availability.</p></div>;

  return <div className="storefront" style={{ '--sf-accent': settings.accent_color, '--sf-secondary': settings.secondary_color }}>
    {settings.announcement && <div className="sf-announcement"><span>{settings.announcement}</span><a href={settings.whatsapp ? `https://wa.me/${String(settings.whatsapp).replace(/\D/g, '')}` : '#contact'}>Talk to an expert ↗</a></div>}
    <header className="sf-header"><StoreLogo settings={settings} /><nav className={mobileMenu ? 'open' : ''}><a href="#shop" onClick={() => { setMobileMenu(false); setCategoryMenuOpen(false); }}>Shop</a><button type="button" className="sf-header-category-link" onClick={() => { setCategoryMenuOpen(true); setActiveCategoryGroup((current) => current || categoryGroups[0]?.key || ''); setMobileMenu(false); window.setTimeout(() => document.querySelector('#categories')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 20); }}>Categories</button><a href="#services" onClick={() => { setMobileMenu(false); setCategoryMenuOpen(false); }}>Services</a><a href="#contact" onClick={() => { setMobileMenu(false); setCategoryMenuOpen(false); }}>Contact</a></nav><div className="sf-header-actions"><button type="button" className="sf-search-jump" onClick={() => document.querySelector('.sf-search input')?.focus()}>⌕</button><button type="button" className="sf-cart-button" onClick={() => setCartOpen(true)}>Cart <span>{cartCount}</span></button><button type="button" className="sf-menu-button" onClick={() => { setMobileMenu(!mobileMenu); setCategoryMenuOpen(false); }}>Menu</button></div></header>

    <StoreCategoryNavigation groups={categoryGroups} productsCount={catalog.products.length} selectedCategoryId={categoryId} open={categoryMenuOpen} activeGroupKey={activeCategoryGroup} onToggle={() => { setCategoryMenuOpen((current) => !current); if (!activeCategoryGroup) setActiveCategoryGroup(categoryGroups[0]?.key || ''); }} onGroup={setActiveCategoryGroup} onSelect={selectCategory} />

    <main>
      <section className={`sf-hero${settings.hero_image_path ? ' has-image' : ''}`} style={settings.hero_image_path ? { '--sf-hero-image': `url(${storeImageUrl(settings.hero_image_path)})` } : undefined}><div className="sf-hero-glow one" /><div className="sf-hero-glow two" /><div className="sf-hero-grid"><div className="sf-hero-copy"><span className="sf-kicker">{settings.eyebrow}</span><h1>{settings.hero_title}</h1><p>{settings.hero_subtitle}</p><div className="sf-hero-actions"><a href="#shop">Explore products <span>→</span></a><a className="ghost" href={settings.whatsapp ? `https://wa.me/${String(settings.whatsapp).replace(/\D/g, '')}` : '#contact'}>Get expert advice</a></div><div className="sf-hero-proof"><div><strong>Real-time</strong><span>POS stock visibility</span></div><div><strong>Tracked</strong><span>Product warranties</span></div><div><strong>Local</strong><span>Technical support</span></div></div></div><div className="sf-hero-device"><div className="sf-orbit orbit-one" /><div className="sf-orbit orbit-two" /><div className="sf-device-core"><img src={companyLogoUrl(settings.company_logo_path)} alt="Gatronix" /><span>POWERED FOR<br />WHAT'S NEXT</span></div><div className="sf-floating-spec top"><small>CATALOGUE</small><strong>{catalog.products.length} products</strong></div><div className="sf-floating-spec bottom"><small>SUPPORT</small><strong>Shop-backed service</strong></div></div></div></section>

      <section className="sf-service-strip"><div><span>01</span><strong>Expert guidance</strong><small>Ask before you buy</small></div><div><span>02</span><strong>Secure delivery</strong><small>Carefully packed orders</small></div><div><span>03</span><strong>Warranty tracked</strong><small>Linked to your invoice</small></div><div><span>04</span><strong>Upgrade ready</strong><small>Parts that work together</small></div></section>

      <section className="sf-section sf-shop" id="shop"><div className="sf-section-heading"><div><span className="sf-kicker">LIVE POS CATALOGUE</span><h2>{categoryId === 'all' ? 'Latest technology' : categoryPathLabel(category)}</h2></div><p>Prices and availability come directly from our shop system.</p></div><div className="sf-shop-toolbar"><label className="sf-search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search products, brands or item codes" /></label><label className="sf-category-select"><span>Category</span><select value={categoryId} onChange={(event) => selectCategory(event.target.value, false)}><option value="all">All categories</option>{categoryOptions.map((item) => <option key={item.category_id} value={item.category_id}>{categoryPathLabel(item)} ({item.product_count})</option>)}</select></label><label className="sf-stock-toggle"><input type="checkbox" checked={inStockOnly} onChange={(event) => setInStockOnly(event.target.checked)} /><span>In stock only</span></label><select aria-label="Sort products" value={sort} onChange={(event) => setSort(event.target.value)}><option value="featured">Featured first</option><option value="price_low">Price: low to high</option><option value="price_high">Price: high to low</option><option value="name">Name A–Z</option></select></div><div className="sf-results-line"><span>{filteredProducts.length} products{categoryId !== 'all' && category ? ` in ${categoryPathLabel(category)}` : ''}</span>{(search || categoryId !== 'all' || inStockOnly) && <button type="button" onClick={() => { setSearch(''); setCategoryId('all'); setInStockOnly(false); }}>Clear filters</button>}</div><div className="sf-products-grid">{visibleProducts.map((product) => <ProductCard key={product.product_id} product={product} onOpen={setSelectedProduct} onAdd={addToCart} />)}{!filteredProducts.length && <div className="sf-no-results"><strong>No matching products</strong><p>Try another category or a shorter search.</p></div>}</div>{visibleCount < filteredProducts.length && <div className="sf-load-more"><button type="button" onClick={() => setVisibleCount((count) => count + 24)}>Load more products</button><span>Showing {visibleProducts.length} of {filteredProducts.length}</span></div>}</section>

      <section className="sf-build-banner" id="services"><div><span className="sf-kicker">CUSTOM PC & UPGRADES</span><h2>Not sure what works together?</h2><p>Tell us your work, game or budget. We’ll help choose compatible parts and build the right system.</p><a href={settings.whatsapp ? `https://wa.me/${String(settings.whatsapp).replace(/\D/g, '')}` : '#contact'}>Plan a build with us →</a></div><div className="sf-build-visual"><span>CPU</span><span>GPU</span><span>RAM</span><span>SSD</span><strong>YOUR<br />BUILD</strong></div></section>
    </main>

    <footer className="sf-footer" id="contact"><div className="sf-footer-main"><div><StoreLogo settings={settings} compact /><p>{settings.hero_subtitle}</p></div><div><strong>Visit & contact</strong><span>{settings.display_address || settings.address || 'Store address available soon'}</span><a href={`tel:${settings.display_phone || settings.phone || ''}`}>{settings.display_phone || settings.phone || 'Add phone in store admin'}</a><a href={`mailto:${settings.display_email || settings.email || ''}`}>{settings.display_email || settings.email || 'Add email in store admin'}</a></div><div><strong>Opening hours</strong><span>{settings.opening_hours || 'Monday – Saturday'}</span><span>Contact us before visiting for availability.</span></div><div><strong>Store</strong><a href="#shop">Products</a><a href="#services">PC builds</a><a href="/store/admin">Store admin</a></div></div><div className="sf-footer-bottom"><span>© {new Date().getFullYear()} {settings.store_name}. All rights reserved.</span><span>Prices and availability may change before order confirmation.</span></div></footer>

    <ProductModal product={selectedProduct} onClose={() => setSelectedProduct(null)} onAdd={(product) => { addToCart(product); setSelectedProduct(null); }} />
    <CartDrawer open={cartOpen} cart={cart} products={catalog.products} onClose={() => setCartOpen(false)} onQuantity={updateQuantity} onCheckout={() => { setCartOpen(false); setCheckoutOpen(true); }} />
    {checkoutOpen && <CheckoutModal cart={cart} products={catalog.products} onClose={() => setCheckoutOpen(false)} onComplete={() => { setCheckoutOpen(false); setCart([]); }} />}
  </div>;
}

function StoreAdminLogin({ onLoggedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function login(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const { data, error: loginError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (loginError) setError(loginError.message);
    else onLoggedIn(data.session);
  }

  return <div className="sa-login"><div className="sa-login-art"><StoreLogo settings={FALLBACK_SETTINGS} /><div><span>STORE CONTROL CENTRE</span><h1>Curate the experience behind the counter.</h1><p>Publish POS products, add photography and create a clean online catalogue without changing your POS records.</p></div><small>Protected with the linked administrator’s Supabase email and password.</small></div><form onSubmit={login}><a href="/store">← Back to online store</a><span className="sf-kicker">ADMINISTRATOR ACCESS</span><h2>Sign in to Store Admin</h2><p>Use the email and password linked to the POS administrator. Staff accounts are not accepted.</p>{error && <div className="sa-error">{error}</div>}<label>Email address<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label><button disabled={busy}>{busy ? 'Signing in...' : 'Sign in securely'}</button><small>For security, there is no public admin registration or password-reset shortcut here. Manage the owner login through Supabase.</small></form></div>;
}

function blankProductDraft(product) {
  return {
    custom_name: product.custom_name || '', short_description: product.short_description || '', description: product.description || '',
    specifications: JSON.stringify(product.specifications || {}, null, 2), image_paths: product.image_paths || [], badge: product.badge || '',
    compare_at_price: product.compare_at_price || '', is_featured: !!product.is_featured, is_published: !!product.is_published,
    sort_order: Number(product.sort_order || 0)
  };
}

function StoreAdminApp() {
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [catalog, setCatalog] = useState({ settings: FALLBACK_SETTINGS, categories: [], products: [] });
  const [section, setSection] = useState('products');
  const [search, setSearch] = useState('');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [productDraft, setProductDraft] = useState(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const [categoryDraft, setCategoryDraft] = useState(null);
  const [settingsDraft, setSettingsDraft] = useState(FALLBACK_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthReady(true); });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => { document.title = 'Store Admin · Gatronix'; }, []);
  useEffect(() => { if (session?.user) loadAdminCatalog(); }, [session?.user?.id]);

  async function loadAdminCatalog() {
    setBusy(true); setError('');
    const { data, error: loadError } = await supabase.rpc('store_admin_catalog_v46');
    setBusy(false);
    if (loadError) { setError(`${loadError.message}. Run migration 046_online_storefront.sql and make sure this email is linked to the active POS admin.`); return; }
    const next = { settings: { ...FALLBACK_SETTINGS, ...(data?.settings || {}) }, categories: data?.categories || [], products: data?.products || [] };
    setCatalog(next); setSettingsDraft(next.settings);
    if (selectedProductId) {
      const updated = next.products.find((product) => product.product_id === selectedProductId);
      if (updated) setProductDraft(blankProductDraft(updated));
    }
  }

  function selectProduct(product) { setSelectedProductId(product.product_id); setProductDraft(blankProductDraft(product)); setMessage(''); setError(''); }
  function selectCategory(category) { setSelectedCategoryId(category.category_id); setCategoryDraft({ custom_name: category.custom_name || '', description: category.description || '', image_path: category.image_path || '', is_featured: !!category.is_featured, is_published: !!category.is_published, sort_order: Number(category.sort_order || 0) }); setMessage(''); setError(''); }

  async function uploadImages(files, folder) {
    const valid = [...files].filter((file) => /^image\/(jpeg|png|webp)$/i.test(file.type) && file.size <= 6 * 1024 * 1024);
    if (!valid.length) throw new Error('Choose JPG, PNG or WebP images smaller than 6 MB.');
    const paths = [];
    for (const [index, file] of valid.entries()) {
      const extension = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
      const path = `${folder}/${Date.now()}-${index}.${extension}`;
      const { data, error: uploadError } = await supabase.storage.from(STORE_IMAGE_BUCKET).upload(path, file, { cacheControl: '3600', upsert: false });
      if (uploadError) throw uploadError;
      paths.push(data.path);
    }
    return paths;
  }

  async function addProductImages(event) {
    if (!productDraft || !selectedProductId) return;
    setUploading(true); setError('');
    try { const paths = await uploadImages(event.target.files, `products/${selectedProductId}`); setProductDraft((current) => ({ ...current, image_paths: [...current.image_paths, ...paths].slice(0, 8) })); }
    catch (uploadError) { setError(uploadError.message || String(uploadError)); }
    finally { setUploading(false); event.target.value = ''; }
  }

  async function uploadCategoryImage(event) {
    if (!categoryDraft || !selectedCategoryId) return;
    setUploading(true); setError('');
    try { const [path] = await uploadImages(event.target.files, `categories/${selectedCategoryId}`); setCategoryDraft((current) => ({ ...current, image_path: path })); }
    catch (uploadError) { setError(uploadError.message || String(uploadError)); }
    finally { setUploading(false); event.target.value = ''; }
  }

  async function uploadHero(event) {
    setUploading(true); setError('');
    try { const [path] = await uploadImages(event.target.files, 'store'); setSettingsDraft((current) => ({ ...current, hero_image_path: path })); }
    catch (uploadError) { setError(uploadError.message || String(uploadError)); }
    finally { setUploading(false); event.target.value = ''; }
  }

  async function saveProduct(event) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      const specifications = productDraft.specifications.trim() ? JSON.parse(productDraft.specifications) : {};
      const { error: saveError } = await supabase.rpc('store_admin_save_product_v46', { p_product_id: selectedProductId, p_payload: { ...productDraft, specifications, compare_at_price: productDraft.compare_at_price === '' ? null : Number(productDraft.compare_at_price) } });
      if (saveError) throw saveError;
      setMessage('Website product updated. POS name and product details were not changed.'); await loadAdminCatalog();
    } catch (saveError) { setError(saveError instanceof SyntaxError ? 'Specifications must be valid JSON, for example {"Processor":"Core i5"}.' : saveError.message || String(saveError)); }
    finally { setBusy(false); }
  }

  async function saveCategory(event) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    const { error: saveError } = await supabase.rpc('store_admin_save_category_v46', { p_category_id: selectedCategoryId, p_payload: categoryDraft });
    setBusy(false); if (saveError) setError(saveError.message); else { setMessage('Website category updated.'); await loadAdminCatalog(); }
  }

  async function saveSettings(event) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    const { error: saveError } = await supabase.rpc('store_admin_save_settings_v46', { p_payload: settingsDraft });
    setBusy(false); if (saveError) setError(saveError.message); else { setMessage('Store presentation settings saved.'); await loadAdminCatalog(); }
  }

  async function publishAll() {
    if (!window.confirm('Publish every active POS product on the website? You can unpublish individual products afterwards.')) return;
    setBusy(true); const { error: publishError } = await supabase.rpc('store_admin_publish_all_v46', { p_published: true }); setBusy(false);
    if (publishError) setError(publishError.message); else { setMessage('All active POS products are now published.'); await loadAdminCatalog(); }
  }

  if (!authReady) return <div className="sf-loading"><img src="/gslogo.jpeg" alt="" /><p>Checking administrator session...</p></div>;
  if (!session) return <StoreAdminLogin onLoggedIn={setSession} />;

  const visibleProducts = catalog.products.filter((product) => [product.pos_name, product.custom_name, product.item_code, product.category_path].some((value) => String(value || '').toLowerCase().includes(search.toLowerCase())));
  const selectedProduct = catalog.products.find((product) => product.product_id === selectedProductId);
  const selectedCategory = catalog.categories.find((category) => category.category_id === selectedCategoryId);
  const publishedCount = catalog.products.filter((product) => product.is_published).length;
  const missingImages = catalog.products.filter((product) => product.is_published && !product.image_paths?.length).length;

  return <div className="store-admin"><aside className="sa-sidebar"><StoreLogo settings={{ ...FALLBACK_SETTINGS, ...catalog.settings }} compact /><span>STORE ADMIN</span><nav>{[['products','Products'],['categories','Categories'],['appearance','Store appearance']].map(([key,label]) => <button type="button" key={key} className={section === key ? 'active' : ''} onClick={() => setSection(key)}>{label}<i>→</i></button>)}</nav><div><a href="/store" target="_blank" rel="noreferrer">Open live store ↗</a><a href="/">Return to POS</a><button type="button" onClick={() => supabase.auth.signOut()}>Sign out</button></div></aside>
    <main className="sa-main"><header><div><span>ONLINE STORE CONTROL CENTRE</span><h1>{section === 'products' ? 'Product catalogue' : section === 'categories' ? 'Category presentation' : 'Store appearance'}</h1></div><div className="sa-admin-user"><span>{session.user.email}</span><strong>Administrator</strong></div></header>
      <div className="sa-stats"><div><span>POS products</span><strong>{catalog.products.length}</strong></div><div><span>Published online</span><strong>{publishedCount}</strong></div><div><span>Need images</span><strong>{missingImages}</strong></div><div><span>Store status</span><strong className={catalog.settings.is_published ? 'live' : ''}>{catalog.settings.is_published ? 'Live' : 'Hidden'}</strong></div></div>
      {error && <div className="sa-error">{error}</div>}{message && <div className="sa-success">{message}</div>}

      {section === 'products' && <div className="sa-workspace"><section className="sa-list"><div className="sa-list-head"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search POS products" /><button type="button" disabled={busy} onClick={publishAll}>Publish all</button></div><div className="sa-product-list">{visibleProducts.map((product) => <button type="button" key={product.product_id} className={selectedProductId === product.product_id ? 'active' : ''} onClick={() => selectProduct(product)}><ProductVisual product={{ ...product, web_name: product.custom_name || product.pos_name }} /><div><strong>{product.custom_name || stripWarrantyText(product.pos_name)}</strong><span>{product.item_code} · {product.category_path || 'Uncategorised'}</span><small><i className={product.is_published ? 'published' : ''} />{product.is_published ? 'Published' : 'Not published'} · {storeMoney(product.selling_price)}</small></div></button>)}</div></section><section className="sa-editor">{selectedProduct && productDraft ? <form onSubmit={saveProduct}><div className="sa-editor-title"><div><span>POS PRODUCT {selectedProduct.item_code}</span><h2>{stripWarrantyText(selectedProduct.pos_name)}</h2><p>POS price {storeMoney(selectedProduct.selling_price)} · {productWarranty(selectedProduct)}</p></div><label className="sa-publish"><input type="checkbox" checked={productDraft.is_published} onChange={(event) => setProductDraft({ ...productDraft, is_published: event.target.checked })} /><span>Published</span></label></div><div className="sa-note">The POS name remains <strong>{selectedProduct.pos_name}</strong>. Fields below affect only the website.</div><label>Website product name<input value={productDraft.custom_name} onChange={(event) => setProductDraft({ ...productDraft, custom_name: event.target.value })} placeholder={stripWarrantyText(selectedProduct.pos_name)} /></label><label>Short card description<input maxLength={140} value={productDraft.short_description} onChange={(event) => setProductDraft({ ...productDraft, short_description: event.target.value })} placeholder="One clear line shown on product cards" /></label><label>Full product description<textarea value={productDraft.description} onChange={(event) => setProductDraft({ ...productDraft, description: event.target.value })} placeholder="Explain the product, condition and ideal use" /></label><div className="sa-field-grid"><label>Badge<input value={productDraft.badge} onChange={(event) => setProductDraft({ ...productDraft, badge: event.target.value })} placeholder="New · Best value" /></label><label>Compare-at price<input type="number" min="0" step="0.01" value={productDraft.compare_at_price} onChange={(event) => setProductDraft({ ...productDraft, compare_at_price: event.target.value })} /></label><label>Sort order<input type="number" value={productDraft.sort_order} onChange={(event) => setProductDraft({ ...productDraft, sort_order: Number(event.target.value) })} /></label><label className="sa-check"><input type="checkbox" checked={productDraft.is_featured} onChange={(event) => setProductDraft({ ...productDraft, is_featured: event.target.checked })} /><span>Feature this product</span></label></div><label>Specifications (JSON)<textarea className="code" value={productDraft.specifications} onChange={(event) => setProductDraft({ ...productDraft, specifications: event.target.value })} /></label><div className="sa-images"><div><strong>Product images</strong><span>First image is the catalogue cover. Up to 8 images.</span></div><label className="sa-upload">{uploading ? 'Uploading...' : 'Add images'}<input type="file" multiple accept="image/jpeg,image/png,image/webp" disabled={uploading} onChange={addProductImages} /></label><div className="sa-image-grid">{productDraft.image_paths.map((path, index) => <div key={path}><img src={storeImageUrl(path)} alt="" /><button type="button" onClick={() => setProductDraft({ ...productDraft, image_paths: productDraft.image_paths.filter((item) => item !== path) })}>{index === 0 ? 'Cover · Remove' : 'Remove'}</button></div>)}{!productDraft.image_paths.length && <p>No website images yet. A futuristic placeholder is used on the live store.</p>}</div></div><div className="sa-savebar"><span>POS stock and price continue syncing automatically.</span><button disabled={busy || uploading}>{busy ? 'Saving...' : 'Save website product'}</button></div></form> : <div className="sa-empty-editor"><span>◇</span><h2>Select a POS product</h2><p>Add web-only names, descriptions, badges, specifications and photography.</p></div>}</section></div>}

      {section === 'categories' && <div className="sa-workspace categories"><section className="sa-list"><div className="sa-category-list">{catalog.categories.map((category) => <button type="button" key={category.category_id} className={selectedCategoryId === category.category_id ? 'active' : ''} onClick={() => selectCategory(category)}><span>{String(category.custom_name || category.pos_name).slice(0,2).toUpperCase()}</span><div><strong>{category.custom_name || category.pos_name}</strong><small>{category.path}</small></div><i className={category.is_published ? 'published' : ''} /></button>)}</div></section><section className="sa-editor">{selectedCategory && categoryDraft ? <form onSubmit={saveCategory}><div className="sa-editor-title"><div><span>POS CATEGORY</span><h2>{selectedCategory.pos_name}</h2><p>{selectedCategory.path}</p></div><label className="sa-publish"><input type="checkbox" checked={categoryDraft.is_published} onChange={(event) => setCategoryDraft({ ...categoryDraft, is_published: event.target.checked })} /><span>Published</span></label></div><label>Website category name<input value={categoryDraft.custom_name} onChange={(event) => setCategoryDraft({ ...categoryDraft, custom_name: event.target.value })} placeholder={selectedCategory.pos_name} /></label><label>Category description<textarea value={categoryDraft.description} onChange={(event) => setCategoryDraft({ ...categoryDraft, description: event.target.value })} /></label><div className="sa-field-grid"><label>Sort order<input type="number" value={categoryDraft.sort_order} onChange={(event) => setCategoryDraft({ ...categoryDraft, sort_order: Number(event.target.value) })} /></label><label className="sa-check"><input type="checkbox" checked={categoryDraft.is_featured} onChange={(event) => setCategoryDraft({ ...categoryDraft, is_featured: event.target.checked })} /><span>Feature category</span></label></div><div className="sa-images"><div><strong>Category cover</strong><span>Optional image used in category promotions.</span></div><label className="sa-upload">{uploading ? 'Uploading...' : 'Choose image'}<input type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading} onChange={uploadCategoryImage} /></label>{categoryDraft.image_path && <div className="sa-category-preview"><img src={storeImageUrl(categoryDraft.image_path)} alt="" /><button type="button" onClick={() => setCategoryDraft({ ...categoryDraft, image_path: '' })}>Remove</button></div>}</div><div className="sa-savebar"><span>POS category names are never changed here.</span><button disabled={busy || uploading}>Save website category</button></div></form> : <div className="sa-empty-editor"><span>⌗</span><h2>Select a category</h2><p>Choose how POS categories appear on the public website.</p></div>}</section></div>}

      {section === 'appearance' && <form className="sa-settings" onSubmit={saveSettings}><section><div className="sa-editor-title"><div><span>BRAND & HERO</span><h2>Public store presentation</h2><p>Text, contact details and colours shown to customers.</p></div><label className="sa-publish"><input type="checkbox" checked={settingsDraft.is_published !== false} onChange={(event) => setSettingsDraft({ ...settingsDraft, is_published: event.target.checked })} /><span>Store live</span></label></div><div className="sa-field-grid two"><label>Store name<input value={settingsDraft.store_name || ''} onChange={(event) => setSettingsDraft({ ...settingsDraft, store_name: event.target.value })} /></label><label>Hero eyebrow<input value={settingsDraft.eyebrow || ''} onChange={(event) => setSettingsDraft({ ...settingsDraft, eyebrow: event.target.value })} /></label></div><label>Hero title<input className="large" value={settingsDraft.hero_title || ''} onChange={(event) => setSettingsDraft({ ...settingsDraft, hero_title: event.target.value })} /></label><label>Hero description<textarea value={settingsDraft.hero_subtitle || ''} onChange={(event) => setSettingsDraft({ ...settingsDraft, hero_subtitle: event.target.value })} /></label><label>Announcement bar<input value={settingsDraft.announcement || ''} onChange={(event) => setSettingsDraft({ ...settingsDraft, announcement: event.target.value })} /></label><div className="sa-field-grid two"><label>Accent colour<input type="color" value={settingsDraft.accent_color || '#62e7ff'} onChange={(event) => setSettingsDraft({ ...settingsDraft, accent_color: event.target.value })} /></label><label>Secondary colour<input type="color" value={settingsDraft.secondary_color || '#8b5cf6'} onChange={(event) => setSettingsDraft({ ...settingsDraft, secondary_color: event.target.value })} /></label></div><div className="sa-images"><div><strong>Hero background image</strong><span>Optional. The animated futuristic background is used when empty.</span></div><label className="sa-upload">{uploading ? 'Uploading...' : 'Choose hero image'}<input type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading} onChange={uploadHero} /></label>{settingsDraft.hero_image_path && <div className="sa-hero-preview"><img src={storeImageUrl(settingsDraft.hero_image_path)} alt="" /><button type="button" onClick={() => setSettingsDraft({ ...settingsDraft, hero_image_path: '' })}>Use default graphic</button></div>}</div></section><section><span className="sf-kicker">CONTACT & SOCIAL</span><h2>Customer contact points</h2><div className="sa-field-grid two"><label>Phone<input value={settingsDraft.phone || ''} onChange={(event) => setSettingsDraft({ ...settingsDraft, phone: event.target.value })} /></label><label>WhatsApp number<input value={settingsDraft.whatsapp || ''} onChange={(event) => setSettingsDraft({ ...settingsDraft, whatsapp: event.target.value })} placeholder="947XXXXXXXX" /></label><label>Email<input type="email" value={settingsDraft.email || ''} onChange={(event) => setSettingsDraft({ ...settingsDraft, email: event.target.value })} /></label><label>Opening hours<input value={settingsDraft.opening_hours || ''} onChange={(event) => setSettingsDraft({ ...settingsDraft, opening_hours: event.target.value })} /></label></div><label>Store address<textarea value={settingsDraft.address || ''} onChange={(event) => setSettingsDraft({ ...settingsDraft, address: event.target.value })} /></label><div className="sa-field-grid two"><label>Facebook URL<input value={settingsDraft.facebook_url || ''} onChange={(event) => setSettingsDraft({ ...settingsDraft, facebook_url: event.target.value })} /></label><label>Instagram URL<input value={settingsDraft.instagram_url || ''} onChange={(event) => setSettingsDraft({ ...settingsDraft, instagram_url: event.target.value })} /></label></div></section><div className="sa-savebar sticky"><span>Preview the live store after saving.</span><button disabled={busy || uploading}>{busy ? 'Saving...' : 'Save store appearance'}</button></div></form>}
    </main>
  </div>;
}

export default function Storefront({ adminMode = false }) {
  return adminMode ? <StoreAdminApp /> : <StorefrontSite />;
}
