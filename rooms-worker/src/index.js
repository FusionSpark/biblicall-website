import { DurableObject } from 'cloudflare:workers';

const ORIGINS = ['https://biblicall.com', 'https://www.biblicall.com'];
const MAX_KEEP = 120;          // messages kept per room
const AI_TURNS = 20;           // messages sent to the AI as context
const IDLE_MS = 30 * 86400000; // delete rooms after 30 idle days

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/') return new Response('Biblicall rooms', { headers: { 'content-type': 'text/plain' } });
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
function parseJson(text) {
  try { return JSON.parse(text); } catch (e) {}
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (e) {} }
  return null;
}
function nsPrompt(question, ctx) {
  return 'You are the North Star layer of Biblicall, an AI assistant guided by biblical wisdom. Do NOT answer the question itself; another part of the app does that. Several friends may be sharing this conversation.\n\n' +
    (ctx ? 'Recent conversation, for context:\n"""' + ctx + '"""\n\n' : '') +
    'The latest message:\n"""' + question.slice(0, 2000) + '"""\n\n' +
    'FIRST decide whether a North Star belongs here. Include one ONLY when someone is: weighing an idea, plan or decision (money, work, family, leadership, technology); asking a moral, ethical or character question; or showing they need direction, encouragement or support (discouraged, anxious, grieving, stuck, overwhelmed). ' +
    'Do NOT include one for plain factual, how-to, technical or trivia questions, casual chat, or short replies that just acknowledge something. When in doubt, skip. ' +
    'If a North Star does not belong, reply with ONLY {"skip": true}.\n\n' +
    'If it does belong: in 2 to 4 sentences, teach how biblical wisdom speaks to this exact situation, warm and never preachy. ' +
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
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const me = { id: crypto.randomUUID().slice(0, 8), name: 'Guest', last: 0 };
    server.serializeAttachment(me);
    server.send(JSON.stringify({ type: 'welcome', you: me.id, msgs: await this.messages(), thinking: this.busy }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async messages() {
    const map = await this.ctx.storage.list({ prefix: 'm:', reverse: true, limit: MAX_KEEP });
    return [...map.values()].reverse();
  }
  async add(msg) {
    const seq = ((await this.ctx.storage.get('seq')) || 0) + 1;
    msg.id = seq; msg.t = Date.now();
    await this.ctx.storage.put({ seq, ['m:' + String(seq).padStart(9, '0')]: msg });
    if (seq > MAX_KEEP) await this.ctx.storage.delete('m:' + String(seq - MAX_KEEP).padStart(9, '0'));
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
    if (typeof data !== 'string' || data.length > 30000) return;
    const d = parseJson(data);
    if (!d || typeof d !== 'object') return;
    const me = ws.deserializeAttachment() || {};

    if (d.type === 'hello') {
      me.name = clean(d.name, 40) || 'Guest';
      ws.serializeAttachment(me);
      this.presence();
      return;
    }

    if (d.type === 'seed') {
      // The person who opens the call brings their conversation so far. Only accepted into an empty room.
      if ((await this.ctx.storage.get('seq')) || !Array.isArray(d.msgs)) return;
      for (const x of d.msgs.slice(-8)) {
        const role = x && x.role === 'assistant' ? 'assistant' : 'user';
        const content = clean(x && x.content, 4000);
        if (!content) continue;
        const msg = { role, content, from: role === 'user' ? me.id : 'ai', name: role === 'user' ? me.name : 'Biblicall' };
        if (role === 'assistant' && x.ns && Array.isArray(x.ns.verses)) msg.ns = this.cleanNs(x.ns);
        await this.add(msg);
      }
      return;
    }

    if (d.type === 'ask') {
      const content = clean(d.content, 2000);
      if (!content) return;
      const now = Date.now();
      if (now - (me.last || 0) < 2500) { ws.send(JSON.stringify({ type: 'error', text: 'One moment, please send one message at a time.' })); return; }
      if (this.busy) { ws.send(JSON.stringify({ type: 'error', text: 'Biblicall is still answering. Try again in a moment.' })); return; }
      me.last = now; ws.serializeAttachment(me);
      this.busy = true;
      this.broadcast({ type: 'thinking', on: true });
      try {
        await this.add({ role: 'user', content, from: me.id, name: me.name });
        const all = await this.messages();
        const people = new Set(all.filter((m) => m.role === 'user').map((m) => m.name));
        const multi = people.size > 1;
        const recent = all.slice(-AI_TURNS);
        const turns = [];
        for (const m of recent) {
          const text = m.role === 'user' && multi ? m.name + ': ' + m.content : m.content;
          const last = turns[turns.length - 1];
          if (last && last.role === m.role) last.content += '\n\n' + text; else turns.push({ role: m.role, content: text });
        }
        while (turns.length && turns[0].role !== 'user') turns.shift();
        const ctx = recent.slice(-6, -1).map((m) => (m.role === 'user' ? m.name + ': ' : 'Biblicall: ') + String(m.content).slice(0, 600)).join('\n');
        const nsP = isAck(content) ? Promise.resolve(null) : this.northStar(content, ctx);
        let answer;
        try { answer = await this.ai(turns); }
        catch (e) { answer = "Biblicall couldn't answer that just now. Please try again in a moment."; }
        const ns = await nsP;
        await this.add({ role: 'assistant', content: answer, from: 'ai', name: 'Biblicall', ns: ns || undefined, offer: !ns && !isAck(content) });
      } finally {
        this.busy = false;
        this.broadcast({ type: 'thinking', on: false });
      }
      return;
    }
  }

  cleanNs(ns) {
    const verses = (Array.isArray(ns.verses) ? ns.verses : []).slice(0, 3)
      .map((v) => ({ ref: clean(v && v.ref, 60), why: clean(v && v.why, 400) })).filter((v) => v.ref);
    if (!verses.length || !ns.northStar && !ns.teach) return undefined;
    return { teach: clean(ns.northStar || ns.teach, 1200), verses, reflect: clean(ns.reflect, 300) };
  }

  async ai(messages) {
    const r = await fetch(this.env.AI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://biblicall.com' },
      body: JSON.stringify({ messages })
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || 'ai');
    return clean(j.answer, 12000);
  }
  async northStar(question, ctx) {
    try {
      const out = parseJson(await this.ai([{ role: 'user', content: nsPrompt(question, ctx) }]));
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
