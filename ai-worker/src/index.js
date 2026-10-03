// Biblicall AI worker.
//   POST { messages: [{role, content}], memory?: [string], mode?: "answer" | "northstar", group?: bool,
//          attachments?: [{kind: "image"|"pdf"|"text", name, media_type?, data?, text?}] } -> { answer }
//   attachments are files the visitor uploaded; they are given to Claude with the latest user message.
// Only biblicall.com (and the biblicall-rooms call server) may use it, with a fair-use limit per visitor.

const ORIGINS = ['https://biblicall.com', 'https://www.biblicall.com'];
const MODEL = 'claude-sonnet-4-5';
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

function systemPrompt(today, memory, group, decide) {
  let s = `You are Biblicall, a full-capability AI assistant guided by biblical wisdom and morality. You help with anything a great AI assistant helps with: business strategy, writing, planning, hard decisions, creative work, research, and everyday questions.

Today's date is ${today}. You have a real-time web_search tool connected. You MUST use it before answering any question touching news, current events, prices, markets, schedules, sports results, who currently holds a position or role, or anything that could have changed since your training. Never say you lack real-time access or can't check current information, because you can: search first, then answer. Only skip searching for timeless questions (personal judgment calls, general advice, math, writing help) where searching would add nothing.

When a question touches decisions, character, relationships, work, money, or hardship, let biblical wisdom (honesty, justice, mercy, humility, stewardship, love of neighbor) shape your judgment, the way a wise and trusted mentor would: warmly, naturally, never preachy or condemning. Don't quote verses yourself; Biblicall adds verified scripture in its North Star when it fits. Respect people of every background, and never take partisan political sides.

When the person shares files or photos, read them carefully and ground your answer in what they actually contain. Say so plainly if something is unreadable.

Be direct, warm, and practical. Keep responses focused and conversational, typically under 180 words unless the question genuinely requires more depth. Behind every question is a person trying to build something: a business, a family, a life. Help them build it well.`;
  if (group) {
    s += `\n\nThis is a live group conversation between friends, and you are one of the participants. Each person's message begins with their first name. Address people by name when it helps, and keep group replies brief (usually under 120 words).`;
  }
  if (decide) {
    s += `\n\nBefore replying, decide whether you should speak at all. Speak only if the latest message is addressed to you, asks a question meant for you, or the friends are weighing something where a short, wise thought from you would clearly help. If the friends are simply talking to each other (greetings, plans, replies to one another, small talk), do not interrupt: reply with exactly [[PASS]] and nothing else.`;
  }
  if (memory.length) {
    s += `\n\nThis person has asked Biblicall to remember the following about them. Use it only when it is relevant, and don't list it back to them:\n` + memory.map((m) => '- ' + m).join('\n');
  }
  return s;
}

const NORTH_STAR_SYSTEM = `You are the North Star layer of Biblicall, an AI assistant guided by biblical wisdom. You never answer the question itself. You follow the instructions in the user message exactly and reply with only the JSON it asks for.`;

export default {
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

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });
    if (!allowed) return json({ error: 'Forbidden' }, 403);

    // Fair use: each visitor (by IP) gets VISITOR_LIMIT calls a minute; the call server shares ROOMS_LIMIT.
    const fromRooms = request.headers.get('X-Biblicall-Source') === 'rooms';
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

    const payload = northStar
      ? { model: MODEL, max_tokens: 700, system: NORTH_STAR_SYSTEM, messages }
      : {
          model: MODEL, max_tokens: files.length ? 1600 : 1024, system: systemPrompt(today, memory, !!body.group, !!body.decide), messages,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
        };

    try {
      const resp = await fetch(env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(payload)
      });
      const data = await resp.json();
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
