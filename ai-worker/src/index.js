import { accountOp, checkToken, Directory, UserData } from './accounts.js';
import { runDaily, unsubscribe, preview } from './daily.js';
export { Directory, UserData };

// Biblicall AI worker.
//   POST { messages: [{role, content}], memory?: [string], mode?: "answer" | "northstar", group?: bool,
//          attachments?: [{kind: "image"|"pdf"|"text", name, media_type?, data?, text?}] } -> { answer }
//   attachments are files the visitor uploaded; they are given to Claude with the latest user message.
// Only biblicall.com (and the biblicall-rooms call server) may use it, with a fair-use limit per visitor.

const ORIGINS = ['https://biblicall.com', 'https://www.biblicall.com'];
// Answers use the newer, lower-cost Sonnet; the short North Star step uses the small, fast Haiku.
// If either is ever unavailable, the call is retried once on the previous model so answers keep flowing.
const MODEL = 'claude-sonnet-5-5';
const NS_MODEL = 'claude-haiku-4-5-20251001';
const FALLBACK_MODEL = 'claude-sonnet-4-5';
// Fair use per visitor per day (by network address until Biblicall has accounts), and per live call per day.
const DAILY = { ask: 60, roomAsk: 400, speakChars: 20000, transcribe: 120 };
const MAX_MESSAGES = 20;
const MAX_CHARS = 4000;
// Uploaded files: at most 5 per request, about 24 MB of file data in total.
const MAX_FILES = 5;
const MAX_IMAGE_B64 = 7_000_000;   // about 5 MB per image
const MAX_PDF_B64 = 20_000_000;    // about 15 MB per PDF
const MAX_TEXT_CHARS = 60_000;     // per text or Word document
const MAX_TOTAL_B64 = 24_000_000;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function attachmentBlocks(list) {
  if (!Array.isArray(list)) return [];
  const blocks = [];
  let total = 0;
  for (const a of list.slice(0, MAX_FILES)) {
    if (!a || typeof a !== 'object') continue;
    const name = String(a.name || 'file').replace(/[\r\n]+/g, ' ').slice(0, 120);
    if (a.kind === 'image' && IMAGE_TYPES.includes(a.media_type) && typeof a.data === 'string'
        && a.data.length <= MAX_IMAGE_B64 && total + a.data.length <= MAX_TOTAL_B64 && B64_RE.test(a.data.slice(0, 2000))) {
      total += a.data.length;
      blocks.push({ type: 'text', text: 'Image: ' + name });
      blocks.push({ type: 'image', source: { type: 'base64', media_type: a.media_type, data: a.data } });
    } else if (a.kind === 'pdf' && typeof a.data === 'string'
        && a.data.length <= MAX_PDF_B64 && total + a.data.length <= MAX_TOTAL_B64 && B64_RE.test(a.data.slice(0, 2000))) {
      total += a.data.length;
      blocks.push({ type: 'document', title: name, source: { type: 'base64', media_type: 'application/pdf', data: a.data } });
    } else if (a.kind === 'text' && typeof a.text === 'string' && a.text.trim()) {
      blocks.push({ type: 'document', title: name, source: { type: 'text', media_type: 'text/plain', data: a.text.slice(0, MAX_TEXT_CHARS) } });
    }
  }
  return blocks;
}

function systemPrompt(today, memory, group, decide, ambience) {
  const base = `You are Biblicall, a full-capability AI assistant guided by biblical wisdom and morality. You help with anything a great AI assistant helps with: business strategy, writing, planning, hard decisions, creative work, research, and everyday questions.

Today's date is ${today}. You have a real-time web_search tool connected. You MUST use it before answering any question touching news, current events, prices, markets, schedules, sports results, who currently holds a position or role, or anything that could have changed since your training. Never say you lack real-time access or can't check current information, because you can: search first, then answer. Only skip searching for timeless questions (personal judgment calls, general advice, math, writing help) where searching would add nothing.

When a question touches decisions, character, relationships, work, money, or hardship, let biblical wisdom (honesty, justice, mercy, humility, stewardship, love of neighbor) shape your judgment, the way a wise and trusted mentor would: warmly, naturally, never preachy or condemning. Where it fits naturally, weave in a short biblical phrase or principle in your own words (for example "iron sharpens iron" or "count the cost"), but don't cite chapter and verse; Biblicall adds verified scripture in its North Star below your answer. Respect people of every background, and never take partisan political sides.

When someone is hurting (grief, fear, shame, abuse, thoughts of suicide or self-harm), lead with gentle care before anything else: never lecture, never use scripture as a rebuke, and remind them that God is near to the brokenhearted. If there is any sign of danger to themselves or others, ask gently whether they are safe, give the 988 Suicide & Crisis Lifeline (call or text 988 in the US) or local emergency help, and encourage them to reach a trusted person or pastor. Never suggest that faith requires someone to stay where they are being abused.

When the person shares files or photos, read them carefully and ground your answer in what they actually contain. Say so plainly if something is unreadable.

Be direct, warm, and practical. Keep responses focused and conversational, typically under 180 words unless the question genuinely requires more depth. Behind every question is a person trying to build something: a business, a family, a life. Help them build it well.`;
  let s = '';
  if (group) {
    s += `\n\nThis is a live group conversation between friends, and you are one of the participants. Each person's message begins with their first name. Address people by name when it helps, and keep group replies brief (usually under 120 words).`;
  }
  if (decide) {
    s += `\n\nBefore replying, decide whether you should speak at all. Speak only if the latest message is addressed to you, asks a question meant for you, or the friends are weighing something where a short, wise thought from you would clearly help. If the friends are simply talking to each other (greetings, plans, replies to one another, small talk), do not interrupt: reply with exactly [[PASS]] and nothing else.`;
  }
  if (ambience) {
    s += `\n\nThe Biblicall app reports what this person sees and hears on screen right now (from the app itself, not typed by them): ${ambience}\nIf they ask about the music, the song, the artist, the background picture or where it is, tell them from this, and feel free to share a little interesting background (the composer or piece, the place, or the space object), searching the web if it helps. Never claim you can't see or hear it: the app has told you. Don't bring it up unless they ask.`;
  }
  if (memory.length) {
    s += `\n\nThis person has asked Biblicall to remember the following about them. Use it only when it is relevant, and don't list it back to them:\n` + memory.map((m) => '- ' + m).join('\n');
  }
  // The fixed instructions are marked for prompt caching (re-sent instructions cost up to 90% less);
  // per-person extras (group call, memory) follow in their own block.
  const blocks = [{ type: 'text', text: base, cache_control: { type: 'ephemeral' } }];
  if (s.trim()) blocks.push({ type: 'text', text: s.trim() });
  return blocks;
}

const NORTH_STAR_SYSTEM = `You are the North Star layer of Biblicall, an AI assistant guided by biblical wisdom. You never answer the question itself. You follow the instructions in the user message exactly and reply with only the JSON it asks for.`;

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(runDaily(env).then((r) => console.log('daily', JSON.stringify(r)))); },
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    // Music relay: incompetech.com doesn't send CORS headers, which the page needs to control music volume on iPhone.
    // GET /m/<file>.mp3 streams that one file from incompetech's royalty-free folder, with CORS and range support.
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/u') return unsubscribe(env, url);
    if (request.method === 'POST' && url.pathname === '/u') { await unsubscribe(env, url); return new Response('ok'); } // one-click unsubscribe from mail apps
    if (request.method === 'GET' && url.pathname.startsWith('/m/')) {
      const name = decodeURIComponent(url.pathname.slice(3));
      if (!/^[A-Za-z0-9 ,'().\-]{1,120}\.mp3$/.test(name) || (origin && !allowed)) return new Response('Not found', { status: 404 });
      const up = await fetch('https://incompetech.com/music/royalty-free/mp3-royaltyfree/' + encodeURIComponent(name), {
        headers: request.headers.get('Range') ? { Range: request.headers.get('Range') } : {}, cf: { cacheEverything: true, cacheTtl: 2592000 } });
      const h = new Headers();
      ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified'].forEach((k) => { const v = up.headers.get(k); if (v) h.set(k, v); });
      h.set('Content-Type', 'audio/mpeg');
      h.set('Access-Control-Allow-Origin', allowed ? origin : ORIGINS[0]); h.set('Vary', 'Origin'); h.set('Cache-Control', 'public, max-age=2592000');
      return new Response(up.body, { status: up.status, headers: h });
    }
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });
    if (!allowed) return json({ error: 'Forbidden' }, 403);

    // Fair use: each visitor (by IP) gets VISITOR_LIMIT calls a minute; the call server shares ROOMS_LIMIT.
    const fromRooms = request.headers.get('X-Biblicall-Source') === 'rooms';
    let visitor = 'v:' + (request.headers.get('CF-Connecting-IP') || 'unknown');
    const busy = () => json({ error: 'busy', message: 'Too many questions at once. Please wait a minute and try again.' }, 429);
    if (fromRooms) {
      // Each call has its own allowance, inside an overall cap for all calls together.
      const roomKey = 'room:' + String(request.headers.get('X-Biblicall-Room') || 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
      if (env.ROOM_LIMIT && !(await env.ROOM_LIMIT.limit({ key: roomKey })).success) return busy();
      if (env.ROOMS_LIMIT && !(await env.ROOMS_LIMIT.limit({ key: 'rooms' })).success) return busy();
    } else if (env.VISITOR_LIMIT) {
      if (!(await env.VISITOR_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' })).success) return busy();
    }

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON' }, 400); }

    // Accounts: sign-in, memory and kept conversations.
    if (body.mode === 'daily-preview') return json(await preview(env));
    if (body.mode === 'account') {
      try { return json(await accountOp(env, body, { underQuota: (who, kind, amount, limit) => underQuota(env, who, kind, amount, limit) })); }
      catch (e) { console.error('account', e && e.message); return json({ error: 'Something went wrong. Please try again.' }, 500); }
    }
    // Signed-in people get their own daily allowance (instead of sharing one per network).
    if (body.token && !fromRooms) { const uid = await checkToken(env, body.token); if (uid) visitor = 'u:' + uid; }

    // Text to speech for the Listen button: a deep, steady baritone (Deepgram Aura-2 "Zeus" on Workers AI by default).
    if (body.mode === 'speak') {
      const text = typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim().slice(0, 1900) : '';
      if (!text) return json({ error: 'Nothing to read' }, 400);
      if (!(await underQuota(env, visitor, 'speak', text.length, DAILY.speakChars))) return json({ error: 'daily_limit', message: "You've reached today's listening limit. It resets tomorrow." }, 429);
      if (!env.AI) return json({ error: 'Voice is not set up' }, 503);
      try {
        const VOICES = ['zeus', 'saturn', 'mars', 'pluto', 'jupiter', 'draco', 'orion'];
        const speaker = VOICES.includes(body.voice) ? body.voice : 'zeus';
        const audio = await env.AI.run('@cf/deepgram/aura-2-en', { text, speaker, encoding: 'mp3' });
        return new Response(audio, { headers: { ...cors, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } });
      } catch (err) {
        console.error('Speak error', err && err.message);
        return json({ error: 'Could not create the voice', detail: String(err && err.message || '').slice(0, 200) }, 502);
      }
    }

    // Speech to text for the microphone button (Workers AI Whisper).
    if (body.mode === 'transcribe') {
      const audio = typeof body.audio === 'string' ? body.audio : '';
      if (!audio || audio.length > 6_000_000 || !B64_RE.test(audio.slice(0, 2000))) return json({ error: 'Bad audio' }, 400);
      if (!(await underQuota(env, visitor, 'transcribe', 1, DAILY.transcribe))) return json({ error: 'daily_limit', message: "You've reached today's speaking limit. It resets tomorrow." }, 429);
      if (!env.AI) return json({ error: 'Speech is not set up' }, 503);
      try {
        let out;
        try { out = await env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio }); }
        catch (e) {
          const bytes = Uint8Array.from(atob(audio), (c) => c.charCodeAt(0));
          out = await env.AI.run('@cf/openai/whisper', { audio: [...bytes] });
        }
        return json({ text: String((out && out.text) || '').trim() });
      } catch (err) {
        console.error('Transcribe error', err && err.message);
        return json({ error: 'Could not transcribe', detail: String(err && err.message || '').slice(0, 200) }, 502);
      }
    }

    let messages = [];
    if (Array.isArray(body.messages)) {
      messages = body.messages
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .slice(-MAX_MESSAGES)
        .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
    } else if (body.question) {
      const qn = String(body.question).slice(0, 2000);
      if (qn.trim()) messages = [{ role: 'user', content: qn }];
    }
    while (messages.length && messages[0].role !== 'user') messages.shift();
    if (!messages.length || messages[messages.length - 1].role !== 'user') return json({ error: 'Empty question' }, 400);

    const northStar = body.mode === 'northstar';
    const files = northStar ? [] : attachmentBlocks(body.attachments);
    if (files.length) {
      const last = messages[messages.length - 1];
      last.content = [...files, { type: 'text', text: last.content }];
    }
    const memory = Array.isArray(body.memory)
      ? body.memory.filter((m) => typeof m === 'string' && m.trim()).slice(0, 40).map((m) => m.replace(/\s+/g, ' ').trim().slice(0, 300))
      : [];
    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Chicago' });

    if (!northStar) {
      const roomId = 'r:' + String(request.headers.get('X-Biblicall-Room') || 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
      const ok = fromRooms ? await underQuota(env, roomId, 'ask', 1, DAILY.roomAsk) : await underQuota(env, visitor, 'ask', 1, DAILY.ask);
      if (!ok) return json({ answer: "You've reached today's limit of questions for Biblicall. It resets tomorrow, and I'll be here. In the meantime, take a quiet moment with what we've already talked about." });
      // Cache the conversation so far, so a follow-up question re-reads it at the lower cached price.
      const last = messages[messages.length - 1];
      if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
      last.content[last.content.length - 1].cache_control = { type: 'ephemeral' };
    }

    const payload = northStar
      ? { model: NS_MODEL, max_tokens: 700, system: NORTH_STAR_SYSTEM, messages }
      : {
          model: MODEL, max_tokens: files.length ? 1600 : 1024, system: systemPrompt(today, memory, !!body.group, !!body.decide, String(body.ambience || '').replace(/[\u0000-\u001f`]/g, ' ').slice(0, 700)), messages,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
        };

    try {
      const call = (pl) => fetch(env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(pl)
      });
      let resp = await call(payload);
      let data = await resp.json();
      if (!resp.ok && (resp.status === 404 || resp.status === 400) && payload.model !== FALLBACK_MODEL) {
        console.error('Model unavailable, retrying on fallback', payload.model, resp.status, data && data.error && data.error.message);
        resp = await call({ ...payload, model: FALLBACK_MODEL });
        data = await resp.json();
      }
      if (!resp.ok) {
        console.error('Anthropic error', resp.status, data && data.error && data.error.type);
        return json({ error: 'Upstream error' }, 502);
      }
      // With web search the answer arrives in pieces split around citations; join them back into one text.
      const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').replace(/\n{3,}/g, '\n\n').trim();
      return json({ answer: text || "Sorry, I couldn't come up with an answer just now." });
    } catch (err) {
      console.error('Worker error', err && err.message);
      return json({ error: 'Something went wrong' }, 500);
    }
  }
};


// ---- Fair-use counters: one tiny Durable Object per visitor (or call) per day ----
export class Quota {
  constructor(state) { this.state = state; }
  async fetch(req) {
    const { kind, amount, limit } = await req.json();
    const used = ((await this.state.storage.get(kind)) || 0);
    if (used + amount > limit) return Response.json({ ok: false, used });
    await this.state.storage.put(kind, used + amount);
    if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + 2 * 86400000);
    return Response.json({ ok: true, used: used + amount });
  }
  async alarm() { await this.state.storage.deleteAll(); }
}
async function underQuota(env, who, kind, amount, limit) {
  if (!env.QUOTA) return true;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const stub = env.QUOTA.get(env.QUOTA.idFromName(who + '|' + day));
    const r = await stub.fetch('https://quota/', { method: 'POST', body: JSON.stringify({ kind, amount, limit }) });
    return (await r.json()).ok;
  } catch (e) { return true; } // never block people because the counter itself had a hiccup
}
