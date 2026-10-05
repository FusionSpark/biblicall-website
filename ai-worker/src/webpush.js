// Web Push (RFC 8291 message encryption + RFC 8292 VAPID), using only WebCrypto. No libraries.
const te = new TextEncoder();
export function b64u(bytes) { let s = ''; for (const x of new Uint8Array(bytes)) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
export function unb64u(str) { let s = String(str || '').replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
function cat(...parts) { const n = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}

// A VAPID key pair, made once and kept by the caller: { pub: b64u raw public key, jwk: private JWK }.
export async function newVapid() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return { pub: b64u(pub), jwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
}

async function vapidAuth(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', vapid.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(head + '.' + body)));
  return 'vapid t=' + head + '.' + body + '.' + b64u(sig) + ', k=' + vapid.pub;
}

// Encrypt a payload for one subscription (aes128gcm content coding, one record).
export async function encrypt(sub, payload) {
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, shared, cat(te.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plain = cat(te.encode(typeof payload === 'string' ? payload : JSON.stringify(payload)), new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plain));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

// Send one notification. Returns { ok, status, gone } (gone = the subscription no longer exists; delete it).
export async function sendPush(sub, payload, vapid, subject = 'mailto:hello@biblicall.com') {
  const body = await encrypt(sub, payload);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { Authorization: await vapidAuth(sub.endpoint, vapid, subject), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal' },
    body
  });
  return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
}
