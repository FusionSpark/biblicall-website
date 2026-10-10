import { DurableObject } from 'cloudflare:workers';

const ORIGINS = ['https://biblicall.com', 'https://www.biblicall.com'];
const MAX_KEEP = 120;          // messages kept per room
const AI_TURNS = 20;           // messages sent to the AI as context
const IDLE_MS = 30 * 86400000; // delete rooms after 30 idle days
const PASS = '[[PASS]]';
const ADDRESSED = /(^|[^a-z])@?(bibli ?call|bible ?call|bibli)\b/i;
// Photos shared in a call: up to 3 per message, resized by the browser before sending.
const MAX_PHOTOS = 3;
const MAX_PHOTO_B64 = 450000;
const MAX_WS_BYTES = 1000000;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const pad = (n) => String(n).padStart(9, '0');

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/') return new Response('BibliCall rooms', { headers: { 'content-type': 'text/plain' } });
    // Photos: GET /room/<id>/img/<seq>-<n> (the room id is the secret, as with the call itself).
    const im = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{12,40})\/img\/(\d{1,9})-(\d)$/);
    if (im && req.method === 'GET') return env.ROOMS.get(env.ROOMS.idFromName(im[1])).fetch(req);
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{12,40})$/);
    if (!m) return new Response('Not found', { status: 404 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const origin = req.headers.get('Origin');
    const devOk = env.ALLOW_LOCAL === '1' && origin && origin.startsWith('http://localhost:');
    if (!origin || !(ORIGINS.includes(origin) || devOk)) return new Response('Forbidden', { status: 403 });
    return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
  }
};

const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);

const ACK = new Set(('ok okay k kk okey alright aight sure yes yeah yep yup ya no nope nah thanks thank thx ty tysm cheers ' +
  'you great good nice cool awesome perfect got it gotcha understood understand makes sense sounds fine will do done noted ' +
  'right true agreed exactly amen hallelujah praise god wow lol haha hmm oh ah i see so much very really much appreciated appreciate ' +
  'that this helps helpful helped love it me too same will try bye goodbye later night morning hi hello hey').split(' '));
function isAck(text) {
  const t = String(text).toLowerCase().replace(/[^a-z\s']/g, ' ').replace(/'/g, '').trim();
  if (!t) return true;
  const w = t.split(/\s+/);
  return w.length <= 6 && w.every((x) => ACK.has(x));
}
function isChatter(text) {
  const t = String(text).trim();
  if (isAck(t)) return true;
  if (t.includes('?')) return false;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length <= 5;
}
function parseJson(text) {
  try { return JSON.parse(text); } catch (e) {}
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (e) {} }
  return null;
}
function nsPrompt(question, ctx) {
  return 'You are the North Star layer of BibliCall, an AI assistant guided by biblical wisdom. Do NOT answer the question itself; another part of the app does that. Several friends may be sharing this conversation.\n\n' +
    (ctx ? 'Recent conversation, for context:\n"""' + ctx + '"""\n\n' : '') +
    'The latest message:\n"""' + question.slice(0, 2000) + '"""\n\n' +
    'Provide a North Star for this message. Every question, practical, technical or factual ones included, can be seen in the light of biblical wisdom, so find the connection. ' +
    'The ONLY exception: if the message is just a greeting, small talk between friends, or a short acknowledgment (like "thanks", "ok", "see you"), reply with ONLY {"skip": true}.\n\n' +
    'In 2 to 4 sentences, teach how biblical wisdom speaks to this exact situation, warm and never preachy. ' +
    'Then choose 1 or 2 King James Version passages that truly fit (a third only for a weighty moment such as grief or a life-changing decision), each a single verse or a range of at most 4 verses, written like "Proverbs 3:5-6" or "1 Corinthians 13:4". Only cite references you are certain exist; each is checked against the KJV and discarded if it does not match. Do not quote the verse text.\n\n' +
    'Then reply with ONLY this JSON and nothing else:\n{"northStar": "2-4 sentences", "verses": [{"ref": "Book C:V", "why": "one sentence on why it applies"}], "reflect": "one short question for the user to ponder"}';
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.busy = false;
  }

  async fetch(req) {
    const im = new URL(req.url).pathname.match(/\/img\/(\d{1,9})-(\d)$/);
    if (im) {
      const photo = await this.ctx.storage.get('img:' + pad(im[1]) + ':' + im[2]);
      if (!photo) return new Response('Not found', { status: 404 });
      const bytes = Uint8Array.from(atob(photo.data), (c) => c.charCodeAt(0));
      return new Response(bytes, { headers: { 'Content-Type': photo.media_type, 'Cache-Control': 'private, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*' } });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const me = { id: crypto.randomUUID().slice(0, 8), name: 'Guest', last: 0 };
    server.serializeAttachment(me);
    server.send(JSON.stringify({ type: 'welcome', you: me.id, msgs: await this.messages(), thinking: this.busy, invites: (await this.ctx.storage.get('invites')) || [] }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async messages() {
    const map = await this.ctx.storage.list({ prefix: 'm:', reverse: true, limit: MAX_KEEP });
    return [...map.values()].reverse();
  }
  async add(msg, photos) {
    const seq = ((await this.ctx.storage.get('seq')) || 0) + 1;
    msg.id = seq; msg.t = Date.now();
    const puts = { seq, ['m:' + pad(seq)]: msg };
    if (photos && photos.length) {
      msg.images = photos.map((ph, i) => { puts['img:' + pad(seq) + ':' + i] = ph; return { k: seq + '-' + i, media_type: ph.media_type }; });
    }
    await this.ctx.storage.put(puts);
    if (seq > MAX_KEEP) {
      const old = pad(seq - MAX_KEEP);
      const imgs = await this.ctx.storage.list({ prefix: 'img:' + old + ':' });
      await this.ctx.storage.delete(['m:' + old, ...imgs.keys()]);
    }
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
    this.broadcast({ type: 'msg', msg });
    return msg;
  }
  async alarm() { await this.ctx.storage.deleteAll(); }

  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) { if (ws !== except) { try { ws.send(s); } catch (e) {} } }
  }
  presence(except) {
    const people = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const a = ws.deserializeAttachment();
      if (a) people.push({ id: a.id, name: a.name });
    }
    this.broadcast({ type: 'presence', people }, except);
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > MAX_WS_BYTES) return;
    const d = parseJson(data);
    if (!d || typeof d !== 'object') return;
    const me = ws.deserializeAttachment() || {};

    if (d.type === 'hello') {
      me.name = clean(d.name, 40) || 'Guest';
      // A stable id per device, so "you" stays the same after a refresh or reconnect.
      if (typeof d.uid === 'string' && /^[A-Za-z0-9_-]{8,32}$/.test(d.uid)) me.id = d.uid;
      const wasNamed = me.named;
      if (me.name !== 'Guest') me.named = true;
      ws.serializeAttachment(me);
      this.presence();
      // Someone who was invited just arrived: their envelope opens for everyone.
      if (me.name !== 'Guest' && !wasNamed) {
        const list = (await this.ctx.storage.get('invites')) || [];
        const key = me.name.toLowerCase().split(/\s+/)[0];
        let hit = list.find((x) => !x.joined && x.name && x.name.toLowerCase() === key);
        if (!hit && !list.some((x) => x.joined && x.uid === me.id)) hit = list.find((x) => !x.joined && !x.name);
        if (hit && hit.by !== me.id) { hit.joined = Date.now(); hit.uid = me.id; if (!hit.name) hit.name = me.name; await this.ctx.storage.put('invites', list); this.broadcast({ type: 'invites', list }); }
      }
      // Once someone gives their first name, their earlier messages show it too (instead of "Guest").
      if (me.name !== 'Guest') {
        const map = await this.ctx.storage.list({ prefix: 'm:' }), puts = {};
        for (const [k, m] of map) if (m && m.role === 'user' && m.from === me.id && m.name !== me.name) { m.name = me.name; puts[k] = m; }
        if (Object.keys(puts).length) { await this.ctx.storage.put(puts); this.broadcast({ type: 'rename', from: me.id, name: me.name }); }
      }
      return;
    }

    if (d.type === 'invited') {
      // Remember who was invited (first name, or the last 4 digits of the number), so everyone sees who's on the way.
      const list = (await this.ctx.storage.get('invites')) || [];
      const name = clean(d.name, 30), last4 = String(d.last4 || '').replace(/\D/g, '').slice(-4);
      if (!name && !last4) return;
      const same = list.find((x) => !x.joined && ((name && x.name === name) || (!name && x.last4 === last4)));
      if (same) same.t = Date.now(); else list.push({ id: crypto.randomUUID().slice(0, 8), name, last4, by: me.id, byName: me.name, t: Date.now(), joined: 0 });
      const keep = list.slice(-12);
      await this.ctx.storage.put('invites', keep);
      this.broadcast({ type: 'invites', list: keep });
      return;
    }

    if (d.type === 'playing') {
      // A friend started a song from YouTube: remember it (and the last few), so BibliCall always knows what's playing.
      const song = { title: clean(d.title, 160), author: clean(d.author, 80), by: me.name, t: Date.now() };
      if (!song.title) return;
      const list = ((await this.ctx.storage.get('songs')) || []).filter((x) => x.title !== song.title);
      list.unshift(song);
      await this.ctx.storage.put('songs', list.slice(0, 6));
      return;
    }

    if (d.type === 'seed') {
      // The person who opens the call brings their conversation so far. Only accepted into an empty room.
      if ((await this.ctx.storage.get('seq')) || !Array.isArray(d.msgs)) return;
      for (const x of d.msgs.slice(-8)) {
        const role = x && x.role === 'assistant' ? 'assistant' : 'user';
        const content = clean(x && x.content, 4000);
        if (!content) continue;
        const msg = { role, content, from: role === 'user' ? me.id : 'ai', name: role === 'user' ? me.name : 'BibliCall' };
        if (role === 'assistant' && x.ns && Array.isArray(x.ns.verses)) msg.ns = this.cleanNs(x.ns);
        await this.add(msg);
      }
      return;
    }

    if (d.type === 'ask') {
      const photos = (Array.isArray(d.images) ? d.images : []).slice(0, MAX_PHOTOS)
        .filter((x) => x && PHOTO_TYPES.includes(x.media_type) && typeof x.data === 'string' && x.data.length <= MAX_PHOTO_B64 && B64_RE.test(x.data.slice(0, 2000)))
        .map((x) => ({ media_type: x.media_type, data: x.data }));
      const content = clean(d.content, 2000) || (photos.length ? (photos.length > 1 ? 'Shared ' + photos.length + ' photos' : 'Shared a photo') : '');
      if (!content) return;
      const now = Date.now();
      if (now - (me.last || 0) < 1200) { ws.send(JSON.stringify({ type: 'error', text: 'One moment, please send one message at a time.' })); return; }
      me.last = now; ws.serializeAttachment(me);
      await this.add({ role: 'user', content, from: me.id, name: me.name }, photos);
      const addressed = ADDRESSED.test(content);
      if (this.busy) {
        // Friends keep talking while BibliCall thinks; if someone calls on it, it answers next.
        if (addressed) this.pending = true;
        return;
      }
      await this.respond(addressed);
      return;
    }
  }

  // Decide whether BibliCall speaks, and if so answer (plus a North Star when it fits).
  async respond(addressed) {
    this.busy = true;
    let showed = false;
    try {
      const all = await this.messages();
      const recent = all.slice(-AI_TURNS);
      const lastUser = [...all].reverse().find((m) => m.role === 'user');
      if (!lastUser) return;
      const names = new Set(recent.filter((m) => m.role === 'user').map((m) => m.name));
      const group = this.ctx.getWebSockets().length > 1 || names.size > 1;
      const mustAnswer = !group || addressed;
      // With friends together, BibliCall listens quietly and only speaks when someone calls on it by name.
      if (group && !addressed) return;
      if (mustAnswer) { this.broadcast({ type: 'thinking', on: true }); showed = true; }

      const turns = [];
      for (const m of recent) {
        const text = m.role === 'user' && group ? m.name + ': ' + m.content : m.content;
        const last = turns[turns.length - 1];
        if (last && last.role === m.role) last.content += '\n\n' + text; else turns.push({ role: m.role, content: text });
      }
      while (turns.length && turns[0].role !== 'user') turns.shift();
      const ctx = recent.slice(-7, -1).map((m) => (m.role === 'user' ? m.name + ': ' : 'BibliCall: ') + String(m.content).slice(0, 600)).join('\n');
      const question = lastUser.content;

      // Solo: answer and North Star in parallel. Group: only look for a North Star once BibliCall decides to speak.
      const nsEarly = !group && !isAck(question) ? this.northStar(question, ctx) : null;
      // Photos from the latest message that had any (within the recent turns) go to the AI with the conversation.
      const attachments = [];
      const withPhotos = [...recent].reverse().slice(0, 6).find((m) => m.role === 'user' && m.images && m.images.length);
      if (withPhotos) {
        for (const ref of withPhotos.images) {
          const [sq, n] = ref.k.split('-');
          const ph = await this.ctx.storage.get('img:' + pad(sq) + ':' + n);
          if (ph) attachments.push({ kind: 'image', name: 'Photo shared by ' + withPhotos.name, media_type: ph.media_type, data: ph.data });
        }
      }
      let answer;
      const songs = (await this.ctx.storage.get('songs')) || [];
      const ago = (t) => { const m = Math.max(1, Math.round((Date.now() - t) / 60000)); return m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };
      const ambience = songs.length ? 'Songs played in this live call from YouTube, most recent first (the first is very likely still playing): ' + songs.map((x) => '"' + x.title + '"' + (x.author ? ' (' + x.author + ')' : '') + ', started by ' + x.by + ' ' + ago(x.t)).join('; ') + '. When anyone asks about "this song" or "the song", it is the most recent one.' : undefined;
      try { answer = await this.ai(turns, { group, decide: false, ambience, attachments: attachments.length ? attachments : undefined }); }
      catch (e) { answer = mustAnswer ? "BibliCall couldn't answer that just now. Please try again in a moment." : PASS; }
      if (!answer || answer.includes(PASS)) return; // stays quiet, keeps listening
      if (!showed) { this.broadcast({ type: 'thinking', on: true }); showed = true; }
      const ns = nsEarly ? await nsEarly : (group && !isAck(question) ? await this.northStar(question, ctx) : null);
      await this.add({ role: 'assistant', content: answer, from: 'ai', name: 'BibliCall', ns: ns || undefined, offer: !ns && !isAck(question) });
    } finally {
      this.busy = false;
      if (showed) this.broadcast({ type: 'thinking', on: false });
      if (this.pending) { this.pending = false; this.respond(true); }
    }
  }

  cleanNs(ns) {
    const verses = (Array.isArray(ns.verses) ? ns.verses : []).slice(0, 3)
      .map((v) => ({ ref: clean(v && v.ref, 60), why: clean(v && v.why, 400) })).filter((v) => v.ref);
    if (!verses.length || !ns.northStar && !ns.teach) return undefined;
    return { teach: clean(ns.northStar || ns.teach, 1200), verses, reflect: clean(ns.reflect, 300) };
  }

  async ai(messages, opts) {
    const r = await fetch(this.env.AI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://biblicall.com', 'X-BibliCall-Source': 'rooms', 'X-BibliCall-Room': this.ctx.id.toString() },
      body: JSON.stringify({ messages, ...(opts || {}) })
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || 'ai');
    return clean(j.answer, 12000);
  }
  async northStar(question, ctx) {
    try {
      const out = parseJson(await this.ai([{ role: 'user', content: nsPrompt(question, ctx) }], { mode: 'northstar' }));
      if (!out || out.skip) return null;
      return this.cleanNs(out) || null;
    } catch (e) { return null; }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch (e) {}
    this.presence(ws);
  }
  async webSocketError(ws) { this.presence(ws); }
}
