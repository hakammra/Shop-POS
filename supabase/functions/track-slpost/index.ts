import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const trackingUrl = 'https://bepost.lk/p/Search/';
const browserHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

function decodeHtml(value: string) {
  const entities: Record<string, string> = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' '
  };
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (entity) => entities[entity] || entity)
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTrackingTable(html: string) {
  const fields: Record<string, string> = {};
  const rowPattern = /<tr[^>]*>\s*<t[dh][^>]*>([\s\S]*?)<\/t[dh]>\s*<t[dh][^>]*>([\s\S]*?)<\/t[dh]>\s*<\/tr>/gi;
  for (const match of html.matchAll(rowPattern)) {
    const key = decodeHtml(match[1]);
    const value = decodeHtml(match[2]);
    if (key && value) fields[key] = value;
  }
  return fields;
}

async function lookupSlpost(trackingNumber: string) {
  const initialResponse = await fetch(trackingUrl, { headers: browserHeaders });
  if (!initialResponse.ok) throw new Error(`SLPOST page returned ${initialResponse.status}`);

  const initialHtml = await initialResponse.text();
  const csrfMatch = initialHtml.match(/name=["']csrf_token["'][^>]*value=["']([^"']+)["']/i);
  if (!csrfMatch?.[1]) throw new Error('SLPOST security token was not found.');

  const setCookie = initialResponse.headers.get('set-cookie') || '';
  const sessionCookie = setCookie.match(/(?:^|,\s*)(TRUSTPOSTCODSESSID=[^;,\s]+)/i)?.[1]
    || setCookie.split(';')[0].trim();
  const form = new URLSearchParams({ csrf_token: csrfMatch[1], website: '', barcode: trackingNumber });

  // SLPOST rejects forms submitted instantly after loading the CSRF page.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const submitTracking = () => fetch(trackingUrl, {
        method: 'POST',
        headers: {
          ...browserHeaders,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': 'https://bepost.lk',
          'Referer': trackingUrl,
          ...(sessionCookie ? { Cookie: sessionCookie } : {})
        },
        body: form.toString()
      });
  let resultResponse = await submitTracking();
  if (!resultResponse.ok) throw new Error(`SLPOST tracking returned ${resultResponse.status}`);

  let resultHtml = await resultResponse.text();
  let fields = parseTrackingTable(resultHtml);
  if (!fields.Status && resultHtml.includes('Please wait a moment and try again')) {
    await new Promise((resolve) => setTimeout(resolve, 3500));
    resultResponse = await submitTracking();
    if (!resultResponse.ok) throw new Error(`SLPOST tracking returned ${resultResponse.status}`);
    resultHtml = await resultResponse.text();
    fields = parseTrackingTable(resultHtml);
  }
  if (!fields.Status) {
    if (resultHtml.includes('Please wait a moment and try again')) {
      throw new Error('SLPOST is temporarily limiting tracking checks. Please try again in a minute.');
    }
    throw new Error('No SLPOST tracking result was found for this number.');
  }

  return {
    trackingNumber: fields.Barcode || trackingNumber,
    status: fields.Status,
    acceptingPostOffice: fields.AcceptingPO || null,
    acceptedAt: fields.DateAccepted || null,
    deliveryPostOffice: fields.DeliveryPO || null,
    receivedAt: fields.ReceivedDate || null,
    settledPostOffice: fields.POSettled || null,
    settledAt: fields.SettledDate || null,
    checkedAt: new Date().toISOString()
  };
}

function suppliedSecret(request: Request) {
  const apiKey = request.headers.get('apikey');
  const authorization = request.headers.get('authorization') || '';
  return apiKey || authorization.replace(/^Bearer\s+/i, '');
}

async function syncDispatchedOrders(request: Request) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!serviceRoleKey || suppliedSecret(request) !== serviceRoleKey) {
    return Response.json({ error: 'Daily tracking sync is not authorized.' }, { status: 401, headers: corsHeaders });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const cutoff = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
  const { data: orders, error: loadError } = await admin
    .from('documents')
    .select('id, document_no, tracking_number')
    .eq('document_type', 'cod_order')
    .eq('delivery_service', 'SLPOST')
    .in('status', ['dispatched', 'awaiting_settlement'])
    .not('tracking_number', 'is', null)
    .or('courier_status.is.null,courier_status.neq.Settled')
    .or(`courier_status_checked_at.is.null,courier_status_checked_at.lt.${cutoff}`)
    .order('courier_status_checked_at', { ascending: true, nullsFirst: true })
    .limit(20);
  if (loadError) throw loadError;

  const results: Array<Record<string, unknown>> = [];
  for (const order of orders || []) {
    try {
      const tracking = await lookupSlpost(String(order.tracking_number).trim().toUpperCase());
      const { data: recorded, error: recordError } = await admin.rpc('record_cod_tracking_v25', {
        p_document_id: order.id,
        p_tracking_number: tracking.trackingNumber,
        p_courier_status: tracking.status,
        p_tracking_payload: tracking
      });
      if (recordError) throw recordError;
      results.push({ documentNo: order.document_no, trackingNumber: tracking.trackingNumber, status: tracking.status, workflowStatus: recorded?.workflow_status });
    } catch (error) {
      results.push({ documentNo: order.document_no, trackingNumber: order.tracking_number, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return Response.json({ checked: results.length, results }, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders });
  }

  try {
    const body = await request.json();
    if (body?.syncAll === true) return await syncDispatchedOrders(request);

    const trackingNumber = String(body?.trackingNumber || '').trim().toUpperCase();
    if (!/^[A-Z0-9-]{6,20}$/.test(trackingNumber)) {
      return Response.json({ error: 'Enter a valid SLPOST tracking number.' }, { status: 400, headers: corsHeaders });
    }
    const tracking = await lookupSlpost(trackingNumber);
    return Response.json(tracking, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to check SLPOST tracking.';
    const status = message.includes('temporarily limiting') ? 429 : message.includes('No SLPOST tracking result') ? 404 : 502;
    return Response.json(
      { error: message },
      { status, headers: corsHeaders }
    );
  }
});
