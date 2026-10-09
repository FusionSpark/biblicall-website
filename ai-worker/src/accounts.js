// BibliCall accounts: sign in with Face ID / Touch ID (passkeys), an account code, or an emailed link.
// Stores each person's memory and the conversations they choose to keep forever.
//   Directory (one instance): sign-in challenges, passkeys, account codes, email sign-in links, email -> account.
//   UserData (one per account): profile, sessions, memory, kept conversations.

const RP_ID = 'biblicall.com';
const RP_ORIGINS = ['https://biblicall.com', 'https://www.biblicall.com'];
const MAX_MEMORY = 200;
const MAX_KEPT = 500;
const MAX_CONVO_BYTES = 400000;
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

const te = new TextEncoder();
const td = new TextDecoder();
export function b64u(bytes) { let s = ''; for (const x of bytes) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
export function unb64u(str) { let s = String(str || '').replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
async function sha256(bytes) { return new Uint8Array(await crypto.subtle.digest('SHA-256', typeof bytes === 'string' ? te.encode(bytes) : bytes)); }
async function hashHex(str) { return [...(await sha256(str))].map((b) => b.toString(16).padStart(2, '0')).join(''); }
function concat(a, b) { const out = new Uint8Array(a.length + b.length); out.set(a, 0); out.set(b, a.length); return out; }
function same(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }

// Minimal CBOR decoder (enough for WebAuthn attestation objects and COSE keys)
export function cbor(bytes) {
  let i = 0;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = (ai) => {
    if (ai < 24) return ai;
    if (ai === 24) return bytes[i++];
    if (ai === 25) { const v = dv.getUint16(i); i += 2; return v; }
    if (ai === 26) { const v = dv.getUint32(i); i += 4; return v; }
    if (ai === 27) { const v = dv.getUint32(i) * 2 ** 32 + dv.getUint32(i + 4); i += 8; return v; }
    throw new Error('cbor length');
  };
  const item = () => {
    const b = bytes[i++], mt = b >> 5, ai = b & 31;
    if (mt === 7) { if (ai === 20) return false; if (ai === 21) return true; if (ai === 22 || ai === 23) return null; throw new Error('cbor simple'); }
    const n = len(ai);
    if (mt === 0) return n;
    if (mt === 1) return -1 - n;
    if (mt === 2) { const v = bytes.slice(i, i + n); i += n; return v; }
    if (mt === 3) { const v = td.decode(bytes.slice(i, i + n)); i += n; return v; }
    if (mt === 4) { const a = []; for (let k = 0; k < n; k++) a.push(item()); return a; }
    if (mt === 5) { const m = new Map(); for (let k = 0; k < n; k++) { const key = item(); m.set(key, item()); } return m; }
    if (mt === 6) return item();
    throw new Error('cbor type');
  };
  const value = item();
  return { value, length: i };
}

function parseAuthData(ad) {
  if (ad.length < 37) throw new Error('authData too short');
  const flags = ad[32];
  const out = { rpIdHash: ad.slice(0, 32), flags, up: !!(flags & 1), uv: !!(flags & 4), count: new DataView(ad.buffer, ad.byteOffset + 33, 4).getUint32(0) };
  if (flags & 0x40) {
    const credLen = (ad[53] << 8) | ad[54];
    out.credId = ad.slice(55, 55 + credLen);
    out.cose = cbor(ad.slice(55 + credLen)).value;
  }
  return out;
}
function coseToJwk(cose) {
  const kty = cose.get(1);
  if (kty === 2 && cose.get(-1) === 1) return { kind: 'ec', jwk: { kty: 'EC', crv: 'P-256', x: b64u(cose.get(-2)), y: b64u(cose.get(-3)), ext: true } };
  if (kty === 3) return { kind: 'rsa', jwk: { kty: 'RSA', n: b64u(cose.get(-1)), e: b64u(cose.get(-2)), alg: 'RS256', ext: true } };
  throw new Error('Unsupported passkey type');
}
function derToRaw(der) {
  // ECDSA signature: SEQUENCE { INTEGER r, INTEGER s } -> 64-byte r||s
  let p = 2; if (der[1] & 0x80) p = 2 + (der[1] & 0x7f);
  const read = () => { if (der[p++] !== 2) throw new Error('bad sig'); let l = der[p++]; let v = der.slice(p, p + l); p += l; while (v.length > 32 && v[0] === 0) v = v.slice(1); const o = new Uint8Array(32); o.set(v, 32 - v.length); return o; };
  const r = read(), s = read(); const raw = new Uint8Array(64); raw.set(r, 0); raw.set(s, 32); return raw;
}
async function verifySig(key, data, sig) {
  if (key.kind === 'ec') {
    const k = await crypto.subtle.importKey('jwk', key.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, derToRaw(sig), data);
  }
  const k = await crypto.subtle.importKey('jwk', key.jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', k, sig, data);
}
function checkClientData(cdBytes, type, challenge) {
  const cd = JSON.parse(td.decode(cdBytes));
  if (cd.type !== type) throw new Error('wrong type');
  if (cd.challenge !== challenge) throw new Error('wrong challenge');
  if (!RP_ORIGINS.includes(cd.origin)) throw new Error('wrong origin');
}

// ---- Durable Objects ----
export class Directory {
  constructor(state) { this.s = state.storage; }
  async fetch(req) {
    const d = await req.json(), s = this.s, now = Date.now();
    switch (d.op) {
      case 'challenge.new': { const c = b64u(rand(32)); await s.put('ch:' + c, { kind: d.kind, uid: d.uid || null, exp: now + 5 * 60000 }); return Response.json({ challenge: c }); }
      case 'challenge.take': { const v = await s.get('ch:' + d.challenge); if (v) await s.delete('ch:' + d.challenge); return Response.json(v && v.exp > now && v.kind === d.kind ? v : null); }
      case 'cred.put': await s.put('cred:' + d.id, d.rec); return Response.json({ ok: true });
      case 'cred.get': return Response.json((await s.get('cred:' + d.id)) || null);
      case 'map.put': await s.put(d.key, d.value); return Response.json({ ok: true });
      case 'map.get': return Response.json((await s.get(d.key)) ?? null);
      case 'map.del': await s.delete(d.key); return Response.json({ ok: true });
      case 'inc': { const v = ((await s.get(d.key)) || 0) + (d.n || 1); await s.put(d.key, v); return Response.json(v); }
      case 'list': { const m = await s.list({ prefix: d.prefix, start: d.start, limit: Math.min(d.limit || 1000, 5000) }); return Response.json([...m.entries()]); }
      case 'map.take': { const v = await s.get(d.key); if (v != null) await s.delete(d.key); return Response.json(v ?? null); }
    }
    return Response.json({ error: 'op' }, { status: 400 });
  }
}

export class UserData {
  constructor(state) { this.s = state.storage; }
  async fetch(req) {
    const d = await req.json(), s = this.s;
    switch (d.op) {
      case 'init': { if (!(await s.get('profile'))) await s.put('profile', { uid: d.uid, name: d.name || '', email: d.email || '', created: Date.now() }); return Response.json(await s.get('profile')); }
      case 'profile': return Response.json((await s.get('profile')) || null);
      case 'profile.set': { const p = (await s.get('profile')) || {}; Object.assign(p, d.patch); await s.put('profile', p); return Response.json(p); }
      case 'session.add': {
        await s.put('s:' + d.hash, { t: Date.now() });
        const all = await s.list({ prefix: 's:' });
        if (all.size > 20) { const old = [...all.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, all.size - 20).map((e) => e[0]); await s.delete(old); }
        return Response.json({ ok: true });
      }
      case 'session.check': return Response.json({ ok: !!(await s.get('s:' + d.hash)) });
      case 'session.del': await s.delete('s:' + d.hash); return Response.json({ ok: true });
      case 'me': {
        const kept = await s.list({ prefix: 'k:' });
        const list = [...kept.values()].map((c) => ({ id: c.id, title: c.title, t: c.t, room: c.room || null })).sort((a, b) => b.t - a.t);
        const profile = { ...((await s.get('profile')) || {}) }; delete profile.codeHash;
        return Response.json({ profile, memory: (await s.get('memory')) || [], kept: list });
      }
      case 'memory.set': await s.put('memory', d.memory); return Response.json({ ok: true });
      case 'state.get': { const m = await s.list({ prefix: 'st:' }); const o = {}; for (const [k, v] of m) o[k.slice(3)] = v; return Response.json(o); }
      case 'state.put': await s.put('st:' + d.key, { v: d.value, t: d.t }); return Response.json({ ok: true });
      case 'keep.put': {
        const existing = await s.get('k:' + d.convo.id);
        if (!existing) { const n = (await s.list({ prefix: 'k:' })).size; if (n >= MAX_KEPT) return Response.json({ error: 'too_many' }); }
        await s.put('k:' + d.convo.id, d.convo); return Response.json({ ok: true });
      }
      case 'keep.get': return Response.json((await s.get('k:' + d.id)) || null);
      case 'keep.del': await s.delete('k:' + d.id); return Response.json({ ok: true });
    }
    return Response.json({ error: 'op' }, { status: 400 });
  }
}

const call = async (stub, body) => (await stub.fetch('https://do/', { method: 'POST', body: JSON.stringify(body) })).json();
const dir = (env) => env.DIRECTORY.get(env.DIRECTORY.idFromName('main'));
const user = (env, uid) => env.USERDATA.get(env.USERDATA.idFromName('u:' + uid));

async function newSession(env, uid) {
  const secret = b64u(rand(24));
  await call(user(env, uid), { op: 'session.add', hash: await hashHex(secret) });
  return uid + '.' + secret;
}
// Returns the account id for a valid sign-in token, or null.
export async function checkToken(env, token) {
  if (!env.USERDATA || typeof token !== 'string') return null;
  const m = token.match(/^([A-Za-z0-9_-]{16,32})\.([A-Za-z0-9_-]{20,64})$/);
  if (!m) return null;
  try { const r = await call(user(env, m[1]), { op: 'session.check', hash: await hashHex(m[2]) }); return r.ok ? m[1] : null; }
  catch (e) { return null; }
}
function cleanMemory(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX_MEMORY)
    .filter((m) => m && typeof m.text === 'string' && m.text.trim())
    .map((m) => ({ id: String(m.id || '').slice(0, 24) || b64u(rand(6)), text: m.text.replace(/\s+/g, ' ').trim().slice(0, 300), t: Number(m.t) || Date.now() }));
}
function cleanConvo(c) {
  if (!c || typeof c !== 'object' || !/^[A-Za-z0-9_-]{1,40}$/.test(String(c.id || ''))) return null;
  const out = { id: c.id, title: String(c.title || 'Conversation').slice(0, 120), t: Number(c.t) || Date.now(), room: c.room ? String(c.room).slice(0, 64) : null,
    msgs: (Array.isArray(c.msgs) ? c.msgs : []).slice(-200) };
  return JSON.stringify(out).length > MAX_CONVO_BYTES ? null : out;
}
function newCode() {
  const b = rand(16); let s = '';
  for (let i = 0; i < 16; i++) { s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length]; if (i % 4 === 3 && i < 15) s += '-'; }
  return s;
}
const normCode = (c) => String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const normEmail = (e) => String(e || '').trim().toLowerCase();

async function sendEmail(env, to, link) {
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:17px;color:#2c2117;line-height:1.5">
    <p>Tap the button below to sign in to BibliCall. The link works once and expires in 20 minutes.</p>
    <p><a href="${link}" style="display:inline-block;background:#664336;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:700">Sign in to BibliCall</a></p>
    <p style="color:#6b5948;font-size:14px">If you didn't ask to sign in, you can ignore this email.</p></div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM || 'BibliCall <hello@biblicall.com>', to: [to], subject: 'Your BibliCall sign-in link',
      html, text: 'Sign in to BibliCall: ' + link + '\n\nThe link works once and expires in 20 minutes.' })
  });
  if (!r.ok) throw new Error('email ' + r.status);
}

// Welcome email for new waitlist signups (sent once per address).
async function sendWelcome(env, to) {
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:17px;color:#2c2117;line-height:1.6;max-width:560px">
    <p style="font-size:22px;font-weight:700;color:#4a2f26;margin:0 0 14px">Welcome to BibliCall</p>
    <p>Thank you for joining the BibliCall waitlist. We're so glad you're here.</p>
    <p>BibliCall is an AI assistant guided by biblical wisdom. Ask it anything, from business plans and hard decisions to writing, research and everyday questions. When it matters most, it adds a <b>North Star</b>: scripture quoted word for word from the King James Bible to guide and encourage you.</p>
    <p>You can already try it at <a href="https://biblicall.com" style="color:#664336;font-weight:700">biblicall.com</a>. We'll write again when BibliCall fully launches.</p>
    <div style="margin:22px 0;padding:14px 18px;background:#f6efe8;border-radius:12px">
      <p style="margin:0;font-style:italic">“Trust in the Lord with all thine heart; and lean not unto thine own understanding. In all thy ways acknowledge him, and he shall direct thy paths.”</p>
      <p style="margin:6px 0 0;font-weight:700;color:#664336">Proverbs 3:5–6</p>
    </div>
    <p>Grace and peace,<br>The BibliCall team</p>
    <p style="color:#6b5948;font-size:13.5px;margin-top:26px">You're receiving this because this address joined the waitlist at biblicall.com. To be removed, just reply with “remove.” <a href="https://biblicall.com/privacy.html" style="color:#6b5948">Privacy</a></p></div>`;
  const text = 'Welcome to BibliCall\n\nThank you for joining the BibliCall waitlist. We\'re so glad you\'re here.\n\n' +
    'BibliCall is an AI assistant guided by biblical wisdom. Ask it anything, from business plans and hard decisions to writing, research and everyday questions. When it matters most, it adds a North Star: scripture quoted word for word from the King James Bible to guide and encourage you.\n\n' +
    'You can already try it at https://biblicall.com. We\'ll write again when BibliCall fully launches.\n\n' +
    '"Trust in the Lord with all thine heart; and lean not unto thine own understanding. In all thy ways acknowledge him, and he shall direct thy paths." (Proverbs 3:5-6)\n\n' +
    'Grace and peace,\nThe BibliCall team\n\nTo be removed from the waitlist, reply with "remove".';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM || 'BibliCall <hello@biblicall.com>', to: [to], reply_to: 'hello@biblicall.com',
      subject: 'Welcome to BibliCall', html, text,
      headers: { 'List-Unsubscribe': '<mailto:hello@biblicall.com?subject=remove>' } })
  });
  if (!r.ok) throw new Error('welcome ' + r.status);
}

// Handles POST { mode: 'account', op, token?, ... } and returns a plain object for the response.
export async function accountOp(env, body, helpers) {
  if (!env.DIRECTORY || !env.USERDATA) return { error: 'Accounts are not set up yet' };
  const op = String(body.op || '');
  const D = dir(env);
  const signedIn = async (uid, name) => {
    const token = await newSession(env, uid);
    const me = await call(user(env, uid), { op: 'me' });
    return { token, ...me };
  };

  if (op === 'status') return { email: !!env.RESEND_API_KEY };

  if (op === 'passkey.begin') {
    const purpose = body.purpose === 'register' ? 'reg' : 'login';
    const uid = purpose === 'reg' ? b64u(rand(16)) : null;
    const { challenge } = await call(D, { op: 'challenge.new', kind: purpose, uid });
    return { challenge, uid };
  }

  if (op === 'passkey.register') {
    const ch = await call(D, { op: 'challenge.take', challenge: body.challenge, kind: 'reg' });
    if (!ch || ch.uid !== body.uid) return { error: 'That sign-up took too long. Please try again.' };
    try {
      checkClientData(unb64u(body.clientDataJSON), 'webauthn.create', body.challenge);
      const att = cbor(unb64u(body.attestationObject)).value;
      const ad = parseAuthData(att.get('authData'));
      if (!same(ad.rpIdHash, await sha256(RP_ID)) || !ad.up || !ad.credId) throw new Error('bad authData');
      const key = coseToJwk(ad.cose);
      const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      await call(D, { op: 'cred.put', id: b64u(ad.credId), rec: { uid: ch.uid, ...key, count: ad.count } });
      await call(user(env, ch.uid), { op: 'init', uid: ch.uid, name });
      await call(D, { op: 'inc', key: 'st:' + new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10) + ':account' });
      return await signedIn(ch.uid);
    } catch (e) { console.error('register', e && e.message); return { error: "Your passkey couldn't be saved. Please try again." }; }
  }

  if (op === 'passkey.login') {
    const ch = await call(D, { op: 'challenge.take', challenge: body.challenge, kind: 'login' });
    if (!ch) return { error: 'That sign-in took too long. Please try again.' };
    try {
      const rec = await call(D, { op: 'cred.get', id: body.id });
      if (!rec) return { error: "This passkey isn't connected to a BibliCall account. Create an account first." };
      const cdBytes = unb64u(body.clientDataJSON), adBytes = unb64u(body.authenticatorData);
      checkClientData(cdBytes, 'webauthn.get', body.challenge);
      const ad = parseAuthData(adBytes);
      if (!same(ad.rpIdHash, await sha256(RP_ID)) || !ad.up) throw new Error('bad authData');
      const ok = await verifySig(rec, concat(adBytes, await sha256(cdBytes)), unb64u(body.signature));
      if (!ok) throw new Error('bad signature');
      if (ad.count > 0) await call(D, { op: 'cred.put', id: body.id, rec: { ...rec, count: ad.count } });
      return await signedIn(rec.uid);
    } catch (e) { console.error('login', e && e.message); return { error: "Sign-in didn't work. Please try again." }; }
  }

  if (op === 'code.login') {
    const code = normCode(body.code);
    if (code.length !== 16) return { error: 'Account codes have 16 letters and numbers.' };
    const uid = await call(D, { op: 'map.get', key: 'code:' + await hashHex(code) });
    if (!uid) return { error: "That account code wasn't found. Check it and try again." };
    return await signedIn(uid);
  }

  // Waitlist: saved here, and (if the NOTIFY_EMAIL secret is set) emailed to the owner. Keeps any personal address out of the public page.
  // Anonymous usage counters (no names, no content): one number per event per day.
  // Weekly active people and how many come back: one anonymous ping per device per day (a scrambled random device number, never a name).
  if (op === 'active') {
    const did = String(body.did || ''); if (!/^[A-Za-z0-9_-]{16,40}$/.test(did)) return { ok: false };
    const h = (await hashHex('active:' + did)).slice(0, 16), day = new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10);
    await call(D, { op: 'map.put', key: 'act:' + day + ':' + h, value: 1 });
    if (!(await call(D, { op: 'map.get', key: 'fst:' + h }))) { await call(D, { op: 'map.put', key: 'fst:' + h, value: day }); await call(D, { op: 'map.put', key: 'new:' + day + ':' + h, value: 1 }); }
    return { ok: true };
  }
  if (op === 'stat') {
    const ev = String(body.ev || '');
    const OK = ['visit', 'visit_new', 'question', 'northstar', 'listen', 'music', 'share', 'shared_open', 'shared_ask', 'fb_up', 'fb_down', 'call', 'invite_offer', 'invite_yes', 'read_chapter', 'pray', 'reminder', 'goal', 'goal_done', 'push_on', 'own_photo', 'own_photo_shared', 'save_pdf', 'save_docx', 'goal_reminder', 'pay_open', 'pay_reminder', 'payee_add', 'monday_connect', 'monday_sync', 'faith_set_1', 'faith_set_2', 'faith_set_3', 'faith_invite', 'faith_up', 'ns_more', 'invite_pill', 'offer_open', 'offer_reserve', 'talk', 'pickup_show', 'pickup_yes', 'pickup_no', 'tabs_all', 'level_1', 'level_2', 'level_3', 'share_week', 'week_open', 'cheer', 'prayer_add', 'prayer_answered', 'read_plan', 'group_create', 'group_join', 'group_open', 'group_invite'];
    if (!OK.includes(ev)) return { error: 'event' };
    await call(D, { op: 'inc', key: 'st:' + new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10) + ':' + ev });
    return { ok: true };
  }

  // Daily North Star email: opt-in list (dn:<email>), each with a private unsubscribe token.
  if (op === 'daily.sub') {
    const email = normEmail(body.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return { error: 'Please enter a valid email address.' };
    const had = await call(D, { op: 'map.get', key: 'dn:' + email });
    if (!had) {
      await call(D, { op: 'map.put', key: 'dn:' + email, value: { email, t: Date.now(), tok: b64u(rand(18)) } });
      await call(D, { op: 'inc', key: 'st:' + new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10) + ':daily_sub' });
    }
    return { ok: true, already: !!had };
  }

  if (op === 'waitlist') {
    const email = normEmail(body.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return { error: 'Please enter a valid email address.' };
    if (helpers && !(await helpers.underQuota('w:' + email, 'email', 1, 3))) return { ok: true };
    const question = String(body.question || '').slice(0, 300);
    const already = await call(D, { op: 'map.get', key: 'wl:' + email });
    await call(D, { op: 'map.put', key: 'wl:' + email, value: { email, question, t: (already && already.t) || Date.now(), offer: body.offer ? 'launch' : (already && already.offer) || undefined } });
    if (!already) await call(D, { op: 'inc', key: 'st:' + new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10) + ':waitlist' });
    if (!already && env.RESEND_API_KEY) await sendWelcome(env, email).catch((e) => console.error('welcome', e && e.message));
    if (env.RESEND_API_KEY && env.NOTIFY_EMAIL) {
      const esc = (x) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      await fetch('https://api.resend.com/emails', { method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.EMAIL_FROM || 'BibliCall <hello@biblicall.com>', to: [env.NOTIFY_EMAIL], subject: 'New BibliCall waitlist signup',
          html: '<p><b>' + esc(email) + '</b> joined the BibliCall waitlist.</p>' + (question ? '<p>Last question asked: ' + esc(question) + '</p>' : ''),
          text: email + ' joined the BibliCall waitlist.' + (question ? '\nLast question asked: ' + question : '') }) }).catch(() => {});
    }
    return { ok: true };
  }

  if (op === 'email.start') {
    if (!env.RESEND_API_KEY) return { error: 'Email sign-in is coming soon.' };
    const email = normEmail(body.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return { error: 'Please enter a valid email address.' };
    if (helpers && !(await helpers.underQuota('e:' + email, 'email', 1, 6))) return { error: 'Too many sign-in emails today. Please try again tomorrow.' };
    // Signed in already? Then the link adds this email to the current account (backup sign-in) instead of making a new one.
    const linkUid = body.token ? await checkToken(env, body.token) : null;
    if (linkUid) {
      const owner = await call(D, { op: 'map.get', key: 'email:' + email });
      if (owner && owner !== linkUid) return { error: 'That email is already used by another BibliCall account.' };
    }
    const tok = b64u(rand(24));
    await call(D, { op: 'map.put', key: 'et:' + await hashHex(tok), value: { email, linkUid: linkUid || null, exp: Date.now() + 20 * 60000 } });
    try { await sendEmail(env, email, 'https://biblicall.com/?signin=' + tok); }
    catch (e) { console.error('email', e && e.message); return { error: "The email couldn't be sent. Please try again in a moment." }; }
    return { ok: true };
  }

  if (op === 'email.finish') {
    const v = await call(D, { op: 'map.take', key: 'et:' + await hashHex(String(body.signin || '')) });
    if (!v || v.exp < Date.now()) return { error: 'That sign-in link has expired or was already used. Please request a new one.' };
    let uid = await call(D, { op: 'map.get', key: 'email:' + v.email });
    if (v.linkUid && (!uid || uid === v.linkUid)) {
      uid = v.linkUid;
      await call(D, { op: 'map.put', key: 'email:' + v.email, value: uid });
      await call(user(env, uid), { op: 'profile.set', patch: { email: v.email } });
    }
    if (!uid) {
      uid = b64u(rand(16));
      await call(D, { op: 'map.put', key: 'email:' + v.email, value: uid });
      await call(user(env, uid), { op: 'init', uid, email: v.email, name: '' });
      await call(D, { op: 'inc', key: 'st:' + new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10) + ':account' });
    }
    return await signedIn(uid);
  }

  // Everything below needs a signed-in person.
  const uid = await checkToken(env, body.token);
  if (!uid) return { error: 'signed_out' };
  const U = user(env, uid);

  if (op === 'me') return await call(U, { op: 'me' });
  if (op === 'logout') { await call(U, { op: 'session.del', hash: await hashHex(String(body.token).split('.')[1]) }); return { ok: true }; }
  if (op === 'name.set') return { profile: await call(U, { op: 'profile.set', patch: { name: String(body.name || '').trim().slice(0, 40) } }) };
  if (op === 'memory.set') { await call(U, { op: 'memory.set', memory: cleanMemory(body.memory) }); return { ok: true }; }
  // Sync across the person's own devices: their week (to-do list, reminders, reading plan, groups) and, if they choose, prayer journal and payment list.
  if (op === 'state.get') return { state: await call(U, { op: 'state.get' }) };
  if (op === 'state.put') {
    const key = String(body.key || ''); if (!['plan', 'prayers', 'payees'].includes(key)) return { error: 'bad key' };
    const json = JSON.stringify(body.value ?? null); if (json.length > 200000) return { error: 'too large' };
    await call(U, { op: 'state.put', key, value: JSON.parse(json), t: Math.min(+body.t || Date.now(), Date.now() + 60000) }); return { ok: true };
  }
  if (op === 'keep.put') { const c = cleanConvo(body.convo); if (!c) return { error: 'That conversation is too long to keep.' }; return await call(U, { op: 'keep.put', convo: c }); }
  if (op === 'keep.get') return { convo: await call(U, { op: 'keep.get', id: String(body.id || '') }) };
  if (op === 'keep.del') return await call(U, { op: 'keep.del', id: String(body.id || '') });
  if (op === 'code.create') {
    const code = newCode(), h = await hashHex(normCode(code));
    const p = await call(U, { op: 'profile' });
    if (p && p.codeHash) await call(D, { op: 'map.del', key: 'code:' + p.codeHash });
    await call(D, { op: 'map.put', key: 'code:' + h, value: uid });
    await call(U, { op: 'profile.set', patch: { codeHash: h } });
    return { code };
  }
  return { error: 'Unknown request' };
}
