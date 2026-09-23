import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const wholesaleBridgeUrl = 'https://xxmdrrzoflakyzecmrmy.supabase.co/functions/v1/retail-bridge';

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function messageOf(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  if (typeof error === 'number' || typeof error === 'boolean') return String(error);
  if (error && typeof error === 'object') {
    const detail = error as Record<string, unknown>;
    for (const candidate of [detail.message, detail.error_description, detail.error, detail.details, detail.hint, detail.context]) {
      if (candidate && candidate !== error) {
        const message = messageOf(candidate);
        if (message && message !== 'Wholesale integration failed.') return message;
      }
    }
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}') return serialized;
    } catch {
      // Use the stable fallback below for circular or non-serializable errors.
    }
  }
  return 'Wholesale integration failed.';
}

function requiredEnvironment() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const bridgeSecret = Deno.env.get('RETAIL_BRIDGE_SHARED_SECRET') || '';
  if (!supabaseUrl || !anonKey || !serviceRoleKey) throw new Error('Retail Supabase function environment is incomplete.');
  if (!bridgeSecret) throw new Error('RETAIL_BRIDGE_SHARED_SECRET is not configured in the Retail Supabase project.');
  return { supabaseUrl, anonKey, serviceRoleKey, bridgeSecret };
}

async function callWholesale(bridgeSecret: string, init?: RequestInit) {
  const response = await fetch(wholesaleBridgeUrl, {
    ...init,
    headers: {
      'x-retail-bridge-secret': bridgeSecret,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success !== true) {
    throw new Error(messageOf(payload?.error || payload?.message || `Wholesale bridge returned ${response.status}.`));
  }
  return payload;
}

async function refreshCatalog(admin: any, bridgeSecret: string) {
  const catalog = await callWholesale(bridgeSecret, { method: 'GET' });
  if (!Array.isArray(catalog?.products)) throw new Error('Wholesale catalog response did not contain a products list.');
  const { data, error } = await admin.rpc('sync_retail_wholesale_catalog_v76', { p_catalog: catalog.products });
  if (error) throw error;
  return data;
}

async function loadTransfer(admin: any, transferId: string) {
  const { data, error } = await admin
    .from('retail_wholesale_transfers')
    .select('*')
    .eq('id', transferId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Retail wholesale transfer was not found.');
  return data;
}

function validateWholesaleResponse(response: any, transfer: any) {
  if (!response?.wholesale_document_id || !response?.wholesale_document_no || !Array.isArray(response?.lines)) {
    throw new Error('Wholesale returned an incomplete transfer response.');
  }
  if (response.idempotency_key !== transfer.idempotency_key) throw new Error('Wholesale idempotency key did not match the Retail transfer.');
  if (response.retail_sale_reference !== transfer.retail_sale_reference) throw new Error('Wholesale sale reference did not match the Retail transfer.');
  if (response.payment_status !== 'credit') throw new Error('Wholesale transfer was not posted as credit.');
}

async function continueTransfer(userClient: any, admin: any, bridgeSecret: string, transferId: string) {
  let transfer = await loadTransfer(admin, transferId);
  if (['cancel_pending', 'wholesale_cancelled', 'cancelled'].includes(transfer.status)) {
    throw new Error('This Wholesale transfer is being cancelled and cannot be retried as a sale.');
  }
  await admin.from('retail_wholesale_transfers').update({
    attempt_count: Number(transfer.attempt_count || 0) + 1,
    last_error: null,
    updated_at: new Date().toISOString()
  }).eq('id', transferId);

  if (!transfer.wholesale_response) {
    const wholesaleResponse = await callWholesale(bridgeSecret, {
      method: 'POST',
      body: JSON.stringify(transfer.wholesale_request)
    });
    validateWholesaleResponse(wholesaleResponse, transfer);
    const { error: storeError } = await admin.from('retail_wholesale_transfers').update({
      status: 'wholesale_posted',
      next_step: 'retail_post',
      wholesale_response: wholesaleResponse,
      wholesale_document_id: wholesaleResponse.wholesale_document_id,
      wholesale_document_no: wholesaleResponse.wholesale_document_no,
      wholesale_customer_id: wholesaleResponse.wholesale_customer_id || null,
      wholesale_transfer_total: Number(wholesaleResponse.transfer_total || 0),
      wholesale_posted_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString()
    }).eq('id', transferId);
    if (storeError) throw storeError;
    transfer = await loadTransfer(admin, transferId);
  }

  const { data, error } = await userClient.rpc('post_retail_wholesale_transfer_v76', { p_transfer_id: transferId });
  if (error) throw error;
  return data;
}

async function continueCancellation(userClient: any, admin: any, bridgeSecret: string, transferId: string) {
  let transfer = await loadTransfer(admin, transferId);
  await admin.from('retail_wholesale_transfers').update({
    attempt_count: Number(transfer.attempt_count || 0) + 1,
    last_error: null,
    updated_at: new Date().toISOString()
  }).eq('id', transferId);

  if (transfer.status === 'cancelled') {
    return { cancelled: true, already_cancelled: true, document_no: transfer.retail_sale_reference };
  }

  if (transfer.status !== 'wholesale_cancelled') {
    const wholesaleCancellation = await callWholesale(bridgeSecret, {
      method: 'POST',
      body: JSON.stringify({
        action: 'cancel_sale',
        idempotency_key: transfer.idempotency_key,
        retail_sale_reference: transfer.retail_sale_reference,
        wholesale_document_id: transfer.wholesale_document_id
      })
    });
    const { error: storeError } = await admin.from('retail_wholesale_transfers').update({
      status: 'wholesale_cancelled',
      next_step: 'retail_cancel',
      wholesale_cancellation_response: wholesaleCancellation,
      wholesale_document_id: wholesaleCancellation.wholesale_document_id || transfer.wholesale_document_id,
      wholesale_document_no: wholesaleCancellation.wholesale_document_no || transfer.wholesale_document_no,
      last_error: null,
      updated_at: new Date().toISOString()
    }).eq('id', transferId);
    if (storeError) throw storeError;
    transfer = await loadTransfer(admin, transferId);
  }

  const { data, error } = await userClient.rpc('finalize_retail_wholesale_cancellation_v81', { p_transfer_id: transfer.id });
  if (error) throw error;
  await refreshCatalog(admin, bridgeSecret);
  return data;
}

async function continuePendingCancellation(userClient: any, admin: any, bridgeSecret: string, transferId: string) {
  let transfer = await loadTransfer(admin, transferId);
  if (transfer.status === 'cancelled') {
    return { cancelled: true, already_cancelled: true, document_no: transfer.retail_sale_reference };
  }
  if (transfer.retail_invoice_document_id || transfer.retail_purchase_document_id) {
    throw new Error('This transfer has posted Retail documents. Cancel its sales invoice from Documents.');
  }

  if (transfer.status !== 'wholesale_cancelled') {
    const wholesaleCancellation = await callWholesale(bridgeSecret, {
      method: 'POST',
      body: JSON.stringify({
        action: 'cancel_pending',
        idempotency_key: transfer.idempotency_key,
        retail_sale_reference: transfer.retail_sale_reference
      })
    });
    const { error: storeError } = await admin.from('retail_wholesale_transfers').update({
      status: 'wholesale_cancelled',
      next_step: 'retail_cancel',
      wholesale_cancellation_response: wholesaleCancellation,
      wholesale_document_id: wholesaleCancellation.wholesale_document_id || transfer.wholesale_document_id,
      wholesale_document_no: wholesaleCancellation.wholesale_document_no || transfer.wholesale_document_no,
      last_error: null,
      updated_at: new Date().toISOString()
    }).eq('id', transferId);
    if (storeError) throw storeError;
    transfer = await loadTransfer(admin, transferId);
  }

  const { data, error } = await userClient.rpc('finalize_pending_retail_wholesale_cancellation_v84', {
    p_transfer_id: transfer.id
  });
  if (error) throw error;
  try { await refreshCatalog(admin, bridgeSecret); } catch {
    // Cancellation is complete; catalog refresh can be retried separately.
  }
  return data;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed.' }, 405);

  let transferId = '';
  let admin: any = null;
  let pendingTransfer = false;
  let requestedAction = 'checkout';
  try {
    const { supabaseUrl, anonKey, serviceRoleKey, bridgeSecret } = requiredEnvironment();
    const authorization = request.headers.get('Authorization') || '';
    if (!authorization.toLowerCase().startsWith('bearer ')) return json({ success: false, error: 'Login required.' }, 401);

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false }
    });
    admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) return json({ success: false, error: 'Your login session has expired.' }, 401);

    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || 'checkout');
    requestedAction = action;

    if (action === 'refresh_catalog') {
      const { error: authorizationError } = await userClient.rpc('authorize_retail_wholesale_catalog_v76');
      if (authorizationError) throw authorizationError;
      const result = await refreshCatalog(admin, bridgeSecret);
      return json({ success: true, catalog: result });
    }

    if (action === 'retry') {
      const { error: authorizationError } = await userClient.rpc('authorize_retail_wholesale_admin_v76');
      if (authorizationError) throw authorizationError;
      transferId = String(body?.transfer_id || '');
      if (!transferId) throw new Error('Transfer ID is required.');
      const transfer = await loadTransfer(admin, transferId);
      const result = ['wholesale_cancel', 'retail_cancel'].includes(transfer.next_step)
        ? transfer.retail_invoice_document_id
          ? await continueCancellation(userClient, admin, bridgeSecret, transferId)
          : await continuePendingCancellation(userClient, admin, bridgeSecret, transferId)
        : await continueTransfer(userClient, admin, bridgeSecret, transferId);
      return json({ success: true, ...result });
    }

    if (action === 'dismiss_pending') {
      transferId = String(body?.transfer_id || '');
      if (!transferId) throw new Error('Transfer ID is required.');
      const { data: prepared, error: prepareError } = await userClient.rpc(
        'prepare_pending_retail_wholesale_cancellation_v84', { p_transfer_id: transferId }
      );
      if (prepareError) throw prepareError;
      pendingTransfer = true;
      const result = prepared?.already_cancelled
        ? { cancelled: true, already_cancelled: true }
        : await continuePendingCancellation(userClient, admin, bridgeSecret, transferId);
      return json({ success: true, ...result });
    }

    if (action === 'cancel') {
      const retailInvoiceId = String(body?.retail_invoice_document_id || '');
      if (!retailInvoiceId) throw new Error('Retail invoice ID is required.');
      const { data: prepared, error: prepareError } = await userClient.rpc('prepare_retail_wholesale_cancellation_v81', {
        p_document_id: retailInvoiceId
      });
      if (prepareError) throw prepareError;
      transferId = String(prepared?.transfer_id || '');
      if (!transferId) throw new Error('Wholesale transfer could not be identified for this invoice.');
      pendingTransfer = true;
      const result = await continueCancellation(userClient, admin, bridgeSecret, transferId);
      return json({ success: true, ...result });
    }

    if (action !== 'checkout') return json({ success: false, error: 'Unsupported bridge action.' }, 400);
    transferId = String(body?.transfer_id || '');
    if (!transferId || !body?.payload) throw new Error('Transfer ID and checkout payload are required.');

    // This refresh is intentionally performed immediately before checkout.
    await refreshCatalog(admin, bridgeSecret);
    const { error: prepareError } = await userClient.rpc('prepare_retail_wholesale_transfer_v76', {
      p_transfer_id: transferId,
      p_payload: body.payload
    });
    if (prepareError) throw prepareError;
    pendingTransfer = true;
    const result = await continueTransfer(userClient, admin, bridgeSecret, transferId);
    return json({ success: true, ...result });
  } catch (error) {
    const errorMessage = messageOf(error);
    if (admin && transferId) {
      try {
        const transfer = await loadTransfer(admin, transferId);
        pendingTransfer = true;
        const cancellationFlow = requestedAction === 'cancel' || ['wholesale_cancel', 'retail_cancel'].includes(transfer.next_step);
        if (requestedAction === 'dismiss_pending'
            || (requestedAction === 'retry' && !transfer.retail_invoice_document_id
              && ['cancel_pending', 'wholesale_cancelled', 'cancelled'].includes(transfer.status))) {
          await admin.from('retail_wholesale_transfers').update({
            last_error: errorMessage.slice(0, 2000),
            updated_at: new Date().toISOString()
          }).eq('id', transferId);
        } else if (['cancel_pending', 'wholesale_cancelled', 'cancelled'].includes(transfer.status)
            && requestedAction === 'checkout') {
          // A sale request that races with cancellation must not overwrite it.
        } else if (cancellationFlow && transfer.status !== 'cancelled') {
          await admin.from('retail_wholesale_transfers').update({
            status: transfer.status === 'wholesale_cancelled' ? 'wholesale_cancelled' : 'failed',
            next_step: transfer.status === 'wholesale_cancelled' ? 'retail_cancel' : 'wholesale_cancel',
            last_error: errorMessage.slice(0, 2000),
            updated_at: new Date().toISOString()
          }).eq('id', transferId);
        } else if (transfer.status !== 'retail_posted') {
          await admin.from('retail_wholesale_transfers').update({
            status: 'failed',
            next_step: transfer.wholesale_response ? 'retail_post' : 'wholesale_post',
            last_error: errorMessage.slice(0, 2000),
            updated_at: new Date().toISOString()
          }).eq('id', transferId);
        }
      } catch {
        // Preparing the outbox may itself have failed, so there may be no row to mark.
      }
    }
    return json({ success: false, pending: pendingTransfer, transfer_id: transferId || null, error: errorMessage });
  }
});
