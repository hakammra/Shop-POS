import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supportedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const systemInstruction = `You are the technical workshop assistant for a small computer sales and repair shop.

Help with laptop and desktop diagnosis, compatible batteries, chargers, screens, keyboards, storage, RAM, components, disassembly preparation, and replacement-part checks.

Rules:
- Be concise, practical, and explicit about uncertainty.
- Never invent a specification, part number, service-manual fact, source, URL, or video.
- Compatibility answers must distinguish confirmed facts from likely matches.
- For batteries and power parts, require verification of exact device model, original part number, nominal voltage, connector, polarity, dimensions, wattage, and manufacturer compatibility before fitting.
- Never recommend bypassing a battery-management system, protection circuit, fuse, grounding, or electrical safety device.
- For troubleshooting, begin with low-risk checks and warn before destructive, high-voltage, soldering, firmware, or data-loss steps.
- When important information is missing, state exactly what label, measurement, photo, or model detail is needed.
- You do not have live web or YouTube search. If asked for a video, provide one precise YouTube search phrase instead of claiming a specific video exists.
- Do not request or repeat customer personal information.
- Use plain text with short headings and dash bullets. Do not use Markdown tables, hash headings, or asterisk emphasis.

Use short headings where helpful: Recommendation, Verify, Steps, Warnings, and Search phrase.`;

type HistoryMessage = { role?: unknown; text?: unknown };
type GeminiPart = { text?: string; inline_data?: { mime_type: string; data: string } };
type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] };

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function normalizedHistory(value: unknown): GeminiContent[] {
  if (!Array.isArray(value)) return [];
  const output: GeminiContent[] = [];
  for (const raw of value.slice(-8) as HistoryMessage[]) {
    const text = String(raw?.text || '').trim().slice(0, 4000);
    if (!text) continue;
    const role: 'user' | 'model' = raw?.role === 'assistant' ? 'model' : 'user';
    const previous = output[output.length - 1];
    if (previous?.role === role) previous.parts[0].text = `${previous.parts[0].text || ''}\n\n${text}`;
    else output.push({ role, parts: [{ text }] });
  }
  return output;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);

  try {
    const authorization = request.headers.get('authorization') || '';
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    if (!authorization.startsWith('Bearer ') || !supabaseUrl || !anonKey) {
      return jsonResponse({ error: 'Login required.' }, 401);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return jsonResponse({ error: 'Your login session is not valid.' }, 401);

    const { data: permitted, error: permissionError } = await userClient.rpc('can_use_tech_assistant_v44');
    if (permissionError) {
      return jsonResponse({ error: 'Run migration 044_tech_assistant_permission.sql in Supabase.' }, 403);
    }
    if (permitted !== true) return jsonResponse({ error: 'The active POS user does not have Tech Assistant permission.' }, 403);

    const geminiKey = Deno.env.get('GEMINI_API_KEY') || '';
    const model = Deno.env.get('GEMINI_MODEL') || 'gemini-3.5-flash';
    if (!geminiKey) return jsonResponse({ error: 'GEMINI_API_KEY has not been configured for this Edge Function.' }, 503);

    const body = await request.json();
    const question = String(body?.question || '').trim();
    if (question.length < 2 || question.length > 2000) {
      return jsonResponse({ error: 'Enter a question between 2 and 2,000 characters.' }, 400);
    }

    const currentParts: GeminiPart[] = [];
    if (body?.image) {
      const mimeType = String(body.image.mimeType || '');
      const data = String(body.image.data || '');
      if (!supportedImageTypes.has(mimeType)) return jsonResponse({ error: 'Use a JPG, PNG or WebP image.' }, 400);
      if (!data || data.length > 6_000_000) return jsonResponse({ error: 'The prepared image is too large.' }, 413);
      currentParts.push({ inline_data: { mime_type: mimeType, data } });
    }
    currentParts.push({ text: question });

    const payload = {
      system_instruction: { parts: [{ text: systemInstruction }] },
      contents: [...normalizedHistory(body?.history), { role: 'user', parts: currentParts }],
      generationConfig: { maxOutputTokens: 1400 }
    };
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) {
      const message = result?.error?.message || `Gemini returned ${response.status}.`;
      const status = response.status === 429 ? 429 : response.status === 400 ? 400 : 502;
      return jsonResponse({ error: message }, status);
    }

    const answer = (result?.candidates?.[0]?.content?.parts || [])
      .map((part: { text?: string }) => part.text || '')
      .join('\n')
      .trim();
    if (!answer) {
      const blocked = result?.promptFeedback?.blockReason || result?.candidates?.[0]?.finishReason;
      return jsonResponse({ error: blocked ? `Gemini could not answer this request (${blocked}).` : 'Gemini returned an empty answer.' }, 422);
    }

    return jsonResponse({ answer, model });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Unable to contact Gemini.' }, 500);
  }
});
