// Sunlo API: Urdu voice note -> Urdu script, Roman Urdu, English.
// Audio and transcripts are never stored. Only counters and metadata go to D1.
const WHISPER = '@cf/openai/whisper-large-v3-turbo';
const LLM = '@cf/meta/llama-4-scout-17b-16e-instruct';
const DAILY_NEURON_CAP = 8000;      // Workers AI free allocation is 10,000/day; stay below it
const FREE_NEURON_CAP = 6500;       // free users stop here; the rest is kept for Pro passes
const PRO_VISITOR_SECONDS = 7200;   // Pro: 2 hours of audio a day
const WHOP = 'https://api.whop.com/api/v1', WHOP_BIZ = 'biz_qZuLHz6vQfmtiI', PRO_PLAN = 'plan_WbxE3cVGWlTXa', TEST_PLAN = 'plan_OW32Icd9xsUNH'; // TEST_PLAN: hidden $0 plan, own tests only
const WHISPER_NEURONS_PER_MIN = 46.4; // $0.00051 per audio minute / $0.011 per 1k neurons
const LLM_NEURON_EST = 40;
const MAX_SECONDS = 300;            // free notes up to 5 minutes
const MAX_BYTES = 12 * 1024 * 1024;
const PER_VISITOR_DAILY = 40;        // requests (a long file is several chunks)
const PER_VISITOR_SECONDS = 1800;   // 30 minutes of audio per visitor per day
const ORIGINS = ['https://sunlo.appin60.com'];

const SYS = `You receive an Urdu transcript of a voice note, made by speech recognition, so it may contain small spelling errors and English words written in Urdu script.
Reply with JSON only, exactly: {"roman": "...", "english": "..."}
"roman": TRANSLITERATE, do not translate. Write every Urdu word as the same Urdu word in Latin letters, the way Pakistanis type on WhatsApp (for example "main kal aaunga, aap fikar na karein", "hospital ne infection par qaboo paane ke liye"). Only words that are English in the transcript (written in Urdu script, like ہسپتال or پروٹوکول) become English spelling. Use only Latin letters.
"english": a natural, faithful English translation. Do not add, explain or drop anything. Keep names, numbers and places. If a word looks like a recognition error, use the meaning that fits the rest of the message; never invent a dramatic or alarming meaning that the message does not support.`;

function cors(req) {
  const o = req.headers.get('Origin') || '';
  return { 'Access-Control-Allow-Origin': ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(o) ? o : ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Duration, X-Test, X-Src, X-Part, X-Asr-Only, X-Pro',
    'Access-Control-Max-Age': '86400', Vary: 'Origin' };
}
const J = (req, obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(req) } });
const day = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();

async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].slice(0, 8).map(x => x.toString(16).padStart(2, '0')).join('');
}
function uaClass(ua) {
  ua = ua || '';
  if (/bot|crawl|spider|curl|wget|python|headless|httpclient|axios|node-fetch|go-http/i.test(ua)) return 'bot';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iOS/i.test(ua)) return 'ios';
  if (/Windows|Macintosh|Linux|CrOS/i.test(ua)) return 'desktop';
  return 'other';
}
function b64(buf) {
  let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode(...buf.subarray(i, i + 32768));
  return btoa(s);
}
function parseLLM(r) {
  let x = r && (r.response ?? r.choices?.[0]?.message?.content);
  if (x && typeof x === 'object') return x;
  if (typeof x !== 'string') return null;
  const m = x.match(/\{[\s\S]*\}/); if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
async function logEvent(env, e) {
  try {
    await env.DB.prepare('INSERT INTO events (ts,kind,vid,country,ua,ref,seconds,bytes,mime,ms,neurons,ok,detail,test) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(now(), e.kind, e.vid || null, e.country || null, e.ua || null, e.ref || null, e.seconds ?? null, e.bytes ?? null, e.mime || null, e.ms ?? null, e.neurons ?? null, e.ok ?? null, e.detail || null, e.test ? 1 : 0).run();
  } catch (_) {}
}

async function transcribe(req, env, ctx, meta) {
  const buf = new Uint8Array(await req.arrayBuffer());
  const mime = (req.headers.get('Content-Type') || '').slice(0, 40);
  const hdrDur = parseFloat(req.headers.get('X-Duration'));
  // without a duration from the browser (file it could not decode), guess from size at ~128 kbit/s and let the size cap protect the budget
  const claimed = Math.max(1, Math.min(3600, hdrDur || Math.min(MAX_SECONDS, buf.length / 16000)));
  const part = (req.headers.get('X-Part') || '').replace(/[^0-9/]/g, '').slice(0, 7);
  const ev = { ...meta, kind: 'transcribe', bytes: buf.length, mime, seconds: claimed, detail: part ? 'part ' + part : '' };
  if (buf.length < 500) return J(req, { error: 'empty', msg: 'Audio file khaali hai.' }, 400);
  if (buf.length > MAX_BYTES || claimed > MAX_SECONDS + 5) { ctx.waitUntil(logEvent(env, { ...ev, ok: 0, detail: 'too_long' })); return J(req, { error: 'too_long', msg: 'Yeh file is phone par tukron mein nahin kaati ja saki. 5 minute se chhoti file bhejein, ya Chrome mein koshish karein.' }, 413); }
  const d = day();
  const asrOnly = req.headers.get('X-Asr-Only') === '1';
  const est = claimed / 60 * WHISPER_NEURONS_PER_MIN + (asrOnly ? 0 : LLM_NEURON_EST);
  const pro = await proActive(env, req.headers.get('X-Pro'));
  const b = await env.DB.prepare('SELECT neurons FROM budget WHERE day=?').bind(d).first();
  if ((b?.neurons || 0) + est > (pro ? DAILY_NEURON_CAP : FREE_NEURON_CAP)) { ctx.waitUntil(logEvent(env, { ...ev, ok: 0, detail: 'daily_cap' })); return J(req, { error: 'daily_cap', msg: 'Aaj ki muft had poori ho gayi. Kal dobara koshish karein (raat 5 baje PKT ke baad).' }, 503); }
  const v = await env.DB.prepare('SELECT notes, seconds FROM visitor WHERE day=? AND vid=?').bind(d, meta.vid).first();
  if (!meta.test && ((v?.notes || 0) >= (pro ? 200 : PER_VISITOR_DAILY) || (v?.seconds || 0) + claimed > (pro ? PRO_VISITOR_SECONDS : PER_VISITOR_SECONDS))) { ctx.waitUntil(logEvent(env, { ...ev, ok: 0, detail: 'visitor_cap' })); return J(req, { error: 'visitor_cap', msg: 'Aaj ki aap ki muft had (30 minute awaz) poori ho gayi. Kal dobara aayein.' }, 429); }
  // reserve budget before calling the model, so parallel calls cannot overshoot
  await env.DB.batch([
    env.DB.prepare('INSERT INTO budget (day,neurons,notes,seconds) VALUES (?,?,1,?) ON CONFLICT(day) DO UPDATE SET neurons=neurons+excluded.neurons, notes=notes+1, seconds=seconds+excluded.seconds').bind(d, est, claimed),
    env.DB.prepare('INSERT INTO visitor (day,vid,notes,seconds) VALUES (?,?,1,?) ON CONFLICT(day,vid) DO UPDATE SET notes=notes+1, seconds=seconds+excluded.seconds').bind(d, meta.vid, claimed),
  ]);
  const t0 = Date.now();
  let w;
  try {
    const opts = { audio: b64(buf), language: 'ur', task: 'transcribe', vad_filter: true };
    if (meta.test && req.headers.get('X-Prompt')) opts.initial_prompt = decodeURIComponent(req.headers.get('X-Prompt')).slice(0, 400); // experiments only
    w = await env.AI.run(WHISPER, opts);
  } catch (e) {
    ctx.waitUntil(logEvent(env, { ...ev, ok: 0, ms: Date.now() - t0, detail: 'whisper:' + String(e).slice(0, 120) }));
    return J(req, { error: 'asr_failed', msg: 'Is file ko parha nahin ja saka. WhatsApp se note dobara share karein ya MP3/M4A/OGG file chunein.' }, 502);
  }
  const urdu = (w.text || '').trim();
  const real = w.transcription_info?.duration || claimed;
  let roman = '', english = '', llmNeurons = 0;
  if (urdu && !asrOnly) {
    try {
      const r = await env.AI.run(LLM, { messages: [{ role: 'system', content: SYS }, { role: 'user', content: urdu }], max_tokens: Math.min(3500, 300 + urdu.length * 3), temperature: 0.2 });
      llmNeurons = r.usage?.neurons || LLM_NEURON_EST;
      const p = parseLLM(r); if (p) { roman = String(p.roman || '').trim(); english = String(p.english || '').trim(); }
    } catch (e) { ev.detail = 'llm:' + String(e).slice(0, 80); }
  }
  const used = real / 60 * WHISPER_NEURONS_PER_MIN + llmNeurons;
  ctx.waitUntil(env.DB.prepare('UPDATE budget SET neurons=neurons+?, seconds=seconds+? WHERE day=?').bind(used - est, real - claimed, d).run().catch(() => {}));
  ctx.waitUntil(logEvent(env, { ...ev, seconds: real, ok: urdu ? 1 : 0, ms: Date.now() - t0, neurons: used, detail: [ev.detail, pro ? 'pro' : '', urdu ? (asrOnly ? 'asr_only' : (roman ? '' : 'no_roman')) : 'no_speech'].filter(Boolean).join(' ') }));
  if (!urdu) return J(req, { error: 'no_speech', msg: 'Is note mein koi baat sunai nahin di.' }, 422);
  return J(req, { urdu, roman, english, seconds: Math.round(real * 10) / 10 });
}

async function proActive(env, token) {
  if (!token || !/^[a-f0-9]{32}$/.test(token)) return false;
  const r = await env.DB.prepare('SELECT paid_ts, expires_ts, revoked FROM pro WHERE token=?').bind(token).first();
  return !!(r && r.paid_ts && !r.revoked && r.expires_ts > now());
}

async function whop(env, path, init = {}) {
  const r = await fetch(WHOP + path, { ...init, headers: { Authorization: 'Bearer ' + env.WHOP_API_KEY, 'Content-Type': 'application/json' } });
  return r.json();
}

async function proStart(req, env, ctx, meta) {
  const recent = await env.DB.prepare("SELECT COUNT(*) n FROM pro WHERE ts > datetime('now','-1 hour')").first();
  if ((recent?.n || 0) > 60) return J(req, { error: 'busy', msg: 'Thori dair baad koshish karein.' }, 503);
  const token = crypto.randomUUID().replace(/-/g, '');
  const c = await whop(env, '/checkout_configurations', { method: 'POST', body: JSON.stringify({ mode: 'payment', plan_id: meta.test ? TEST_PLAN : PRO_PLAN,
    metadata: { sunlo_token: token }, redirect_url: 'https://sunlo.appin60.com/pro.html?t=' + token }) });
  if (!c.purchase_url) { ctx.waitUntil(logEvent(env, { ...meta, kind: 'pro_start', ok: 0, detail: String(c.error?.message || 'no url').slice(0, 100) })); return J(req, { error: 'checkout', msg: 'Checkout abhi nahin khul saka. Dobara koshish karein.' }, 502); }
  await env.DB.prepare('INSERT INTO pro (token, ts, checkout_id, country, test) VALUES (?,?,?,?,?)').bind(token, now(), c.id, meta.country, meta.test ? 1 : 0).run();
  ctx.waitUntil(logEvent(env, { ...meta, kind: 'pro_start', ok: 1 }));
  return J(req, { url: c.purchase_url.startsWith('http') ? c.purchase_url : 'https://whop.com' + c.purchase_url, token });
}

async function proStatus(req, env, ctx, meta, url) {
  const t = url.searchParams.get('t') || '';
  if (!/^[a-f0-9]{32}$/.test(t)) return J(req, { error: 'bad' }, 400);
  const r = await env.DB.prepare('SELECT * FROM pro WHERE token=?').bind(t).first();
  if (!r) return J(req, { pro: false, error: 'unknown' }, 404);
  const stale = !r.last_check || (Date.now() - Date.parse(r.last_check)) > (r.paid_ts ? 6 * 3600e3 : 15e3);
  if (stale && !r.revoked) {
    await env.DB.prepare('UPDATE pro SET last_check=? WHERE token=?').bind(now(), t).run();
    let cursor = '', found = null;
    const pid = url.searchParams.get('pid') || '';
    if (/^pay_[A-Za-z0-9]{6,40}$/.test(pid)) { const one = await whop(env, '/payments/' + pid); if (one?.metadata?.sunlo_token === t) found = one; }
    for (let page = 0; page < 5 && !found; page++) {
      const p = await whop(env, `/payments?account_id=${WHOP_BIZ}&plan_id=${r.test ? TEST_PLAN : PRO_PLAN}&first=50` + (cursor ? '&after=' + encodeURIComponent(cursor) : ''));
      found = (p.data || []).find(x => x.metadata?.sunlo_token === t) || null;
      if (!p.page_info?.has_next_page) break; cursor = p.page_info.end_cursor;
    }
    if (found) {
      const refunded = /refund|dispute|chargeback/i.test(found.substatus || '') || Number(found.refunded_amount?.amount || 0) > 0;
      const amountOk = Number(found.total?.amount ?? found.usd_total?.amount ?? 0) >= 3.99 || r.test === 1;
      if (found.status === 'paid' && !refunded && amountOk && !r.paid_ts) {
        const exp = new Date(Date.parse(found.paid_at || now()) + 30 * 864e5).toISOString();
        await env.DB.prepare('UPDATE pro SET paid_ts=?, expires_ts=?, payment_id=? WHERE token=?').bind(found.paid_at || now(), exp, found.id, t).run();
        ctx.waitUntil(logEvent(env, { ...meta, kind: 'pro_paid', ok: 1, detail: found.id }));
      } else if (refunded && r.paid_ts) {
        await env.DB.prepare('UPDATE pro SET revoked=? WHERE token=?').bind(now(), t).run();
        ctx.waitUntil(logEvent(env, { ...meta, kind: 'pro_revoked', ok: 1, detail: found.id }));
      }
    }
  }
  const x = await env.DB.prepare('SELECT paid_ts, expires_ts, revoked FROM pro WHERE token=?').bind(t).first();
  const active = !!(x.paid_ts && !x.revoked && x.expires_ts > now());
  return J(req, { pro: active, paid: !!x.paid_ts, expires: x.expires_ts || null, revoked: !!x.revoked });
}

async function translate(req, env, ctx, meta) {
  let body; try { body = await req.json(); } catch { return J(req, { error: 'bad' }, 400); }
  const urdu = String(body.text || '').trim().slice(0, 12000);
  if (!urdu) return J(req, { error: 'empty' }, 400);
  const d = day(), est = 60 + urdu.length * 0.03;
  const b = await env.DB.prepare('SELECT neurons FROM budget WHERE day=?').bind(d).first();
  const pro = await proActive(env, req.headers.get('X-Pro'));
  if ((b?.neurons || 0) + est > (pro ? DAILY_NEURON_CAP : FREE_NEURON_CAP)) return J(req, { error: 'daily_cap', msg: 'Aaj ki muft had poori ho gayi. Urdu text upar hai; translation kal dobara try karein.' }, 503);
  await env.DB.prepare('INSERT INTO budget (day,neurons,notes,seconds) VALUES (?,?,0,0) ON CONFLICT(day) DO UPDATE SET neurons=neurons+excluded.neurons').bind(d, est).run();
  const t0 = Date.now(); let roman = '', english = '', used = est, err = '';
  try {
    const r = await env.AI.run(LLM, { messages: [{ role: 'system', content: SYS }, { role: 'user', content: urdu }], max_tokens: Math.min(6000, 300 + urdu.length * 3), temperature: 0.2 });
    used = r.usage?.neurons || est;
    const p = parseLLM(r); if (p) { roman = String(p.roman || '').trim(); english = String(p.english || '').trim(); } else err = 'parse';
  } catch (e) { err = 'llm:' + String(e).slice(0, 80); }
  ctx.waitUntil(env.DB.prepare('UPDATE budget SET neurons=neurons+? WHERE day=?').bind(used - est, d).run().catch(() => {}));
  ctx.waitUntil(logEvent(env, { ...meta, kind: 'translate', bytes: urdu.length, ms: Date.now() - t0, neurons: used, ok: roman ? 1 : 0, detail: err }));
  return J(req, { roman, english });
}

async function signup(req, env, meta) {
  let body; try { body = await req.json(); } catch { return J(req, { error: 'bad' }, 400); }
  const email = String(body.email || '').trim().toLowerCase().slice(0, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return J(req, { error: 'email', msg: 'Email theek nahin lagta.' }, 400);
  const purpose = String(body.purpose || 'updates').slice(0, 40), note = String(body.note || '').slice(0, 500);
  const recent = await env.DB.prepare("SELECT COUNT(*) n FROM signups WHERE ts > datetime('now','-1 day')").first();
  if ((recent?.n || 0) > 200) return J(req, { error: 'busy' }, 503);
  const dup = await env.DB.prepare('SELECT id FROM signups WHERE email=? AND purpose=?').bind(email, purpose).first();
  if (!dup) {
    const token = crypto.randomUUID().replace(/-/g, '');
    await env.DB.prepare('INSERT INTO signups (ts,email,purpose,note,token,country,test) VALUES (?,?,?,?,?,?,?)').bind(now(), email, purpose, note, token, meta.country, meta.test ? 1 : 0).run();
  }
  return J(req, { ok: true });
}

async function confirm(req, env, url) {
  const t = url.searchParams.get('t') || '';
  if (/^[a-f0-9]{32}$/.test(t)) await env.DB.prepare('UPDATE signups SET confirmed_ts=COALESCE(confirmed_ts,?) WHERE token=?').bind(now(), t).run();
  return Response.redirect('https://sunlo.appin60.com/confirmed', 302);
}

async function feedback(req, env, meta) {
  let body; try { body = await req.json(); } catch { return J(req, { error: 'bad' }, 400); }
  const rating = String(body.rating || '').slice(0, 20), text = String(body.text || '').slice(0, 2000), email = String(body.email || '').slice(0, 120);
  if (!rating && !text) return J(req, { error: 'empty' }, 400);
  await env.DB.prepare('INSERT INTO feedback (ts,rating,text,email,country,test) VALUES (?,?,?,?,?,?)').bind(now(), rating, text, email, meta.country, meta.test ? 1 : 0).run();
  return J(req, { ok: true });
}

async function stats(req, env) {
  const r = await env.DB.prepare("SELECT substr(ts,1,10) day, COUNT(*) runs, SUM(ok) ok, COUNT(DISTINCT vid) visitors, ROUND(SUM(CASE WHEN ok=1 THEN seconds ELSE 0 END)/60.0,1) minutes FROM events WHERE kind='transcribe' AND test=0 AND ua!='bot' GROUP BY 1 ORDER BY 1").all();
  const s = await env.DB.prepare("SELECT kind, COUNT(*) n FROM events WHERE kind!='transcribe' AND test=0 GROUP BY 1").all();
  const c = await env.DB.prepare("SELECT COUNT(*) n FROM signups WHERE confirmed_ts IS NOT NULL AND test=0").first();
  return J(req, { note: 'Transcriptions by real visitors (own tests and bots excluded). No audio or text is stored.', by_day: r.results, events: s.results, confirmed_signups: c?.n || 0 });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(req) });
    const ip = req.headers.get('CF-Connecting-IP') || '';
    const ua = req.headers.get('User-Agent') || '';
    const meta = { vid: await sha(ip + '|' + day() + '|' + (env.SALT || 'sunlo')), country: req.cf?.country || '', ua: uaClass(ua),
      ref: (req.headers.get('X-Src') || '').slice(0, 60), test: env.TEST_KEY && req.headers.get('X-Test') === env.TEST_KEY };
    try {
      if (url.pathname === '/api/transcribe' && req.method === 'POST') return await transcribe(req, env, ctx, meta);
      if (url.pathname === '/api/pro/start' && req.method === 'POST') return await proStart(req, env, ctx, meta);
      if (url.pathname === '/api/pro/status') return await proStatus(req, env, ctx, meta, url);
      if (url.pathname === '/api/translate' && req.method === 'POST') return await translate(req, env, ctx, meta);
      if (url.pathname === '/api/signup' && req.method === 'POST') return await signup(req, env, meta);
      if (url.pathname === '/api/confirm') return await confirm(req, env, url);
      if (url.pathname === '/api/feedback' && req.method === 'POST') return await feedback(req, env, meta);
      if (url.pathname === '/api/event' && req.method === 'POST') {
        let k = '', rf = ''; try { const j = await req.json(); k = String(j.kind || '').replace(/[^a-z_]/g, '').slice(0, 24); rf = String(j.ref || '').replace(/[^a-z0-9.-]/gi, '').slice(0, 60); } catch {}
        if (k) ctx.waitUntil(logEvent(env, { ...meta, kind: 'ev_' + k, detail: rf }));
        return J(req, { ok: true });
      }
      if (url.pathname === '/api/stats') return await stats(req, env);
      if (url.pathname === '/api/health') return J(req, { ok: true });
    } catch (e) {
      return J(req, { error: 'server', msg: 'Kuch ghalat ho gaya. Dobara koshish karein.' }, 500);
    }
    return J(req, { error: 'not_found' }, 404);
  },
};
