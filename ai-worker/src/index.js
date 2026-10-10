import { accountOp, checkToken, Directory, UserData } from './accounts.js';
import { runDaily, unsubscribe, preview } from './daily.js';
import { Planner, planOp, runPlanner, icsFile } from './plan.js';
export { Directory, UserData, Planner };

// BibliCall AI worker.
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
// Fair use per visitor per day (by network address until BibliCall has accounts), and per live call per day.
const DAILY = { ask: 60, roomAsk: 400, speakChars: 20000, transcribe: 120 };
// Songs from YouTube each month. Free now; BibliCall Plus (when payments open) gets the larger allowance.
const SONGS_PER_MONTH = { free: 30, plus: 500 };
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

const TRADITIONS = { catholic: 'Catholic', orthodox: 'Eastern Orthodox', baptist: 'Baptist', methodist: 'Methodist', lutheran: 'Lutheran', reformed: 'Presbyterian / Reformed', anglican: 'Anglican / Episcopal', pentecostal: 'Pentecostal / Charismatic', nondenom: 'non-denominational evangelical', oriental: 'Oriental Orthodox (Coptic, Armenian, Ethiopian, Syriac)', wesleyan: 'Wesleyan / Holiness (such as the Church of the Nazarene)', cofc: 'Churches of Christ', adventist: 'Seventh-day Adventist', anabaptist: 'Mennonite / Anabaptist', messianic: 'Messianic Jewish' };
const LANGS = { es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German', it: 'Italian', zh: 'Chinese (Simplified)', ko: 'Korean', tl: 'Tagalog', vi: 'Vietnamese', hi: 'Hindi', sw: 'Swahili', ru: 'Russian', uk: 'Ukrainian', pl: 'Polish', hr: 'Croatian', sr: 'Serbian (Latin script)', src: 'Serbian (Cyrillic script)', ar: 'Arabic', ja: 'Japanese', id: 'Indonesian' };
const FAITH = {
  1: 'This person chose "Everyday Wisdom" for how much faith appears in BibliCall\'s answers. Let biblical values (honesty, fairness, humility, stewardship, love of neighbor) quietly shape your advice, but do not mention God, faith, prayer, the Bible or biblical phrases, and do not add [[prayer|...]] lines, unless they bring faith up themselves. In grief, fear or crisis, lead with warm, human care (and crisis help when needed); you may gently mention God\'s nearness only if they seem open to it. Never mention this setting.',
  2: 'This person chose "Gentle Guidance" for how much faith appears in BibliCall\'s answers. For practical, technical, factual or creative requests, give a plain, excellent answer with no faith language. When something meaningful is at stake (decisions, relationships, work struggles, character, hardship), a short biblical principle in your own words is welcome when it fits naturally. Never mention this setting.',
  3: 'This person chose "Faith Forward" for how much faith appears in BibliCall\'s answers. Let biblical wisdom shine in most answers: weave in biblical principles and the example of Jesus naturally (still without citing chapter and verse, since the North Star adds verified Scripture), and when they share something heavy, gently offer to pray with them. Stay warm, never preachy. Never mention this setting.'
};
// Fixed assistant rules (reminders, goals, prayer, payments...). Kept in the cached block so every question re-reads them at the low cached price.
const PLAN_RULES = `\n\nBibliCall can set reminders and weekly goals for this person, as a kind, encouraging personal assistant and mentor for work, family and faith.
When they ask to be reminded, mention a task with a day or time (for example "I need to call the insurance company Thursday"), or name a goal for this week, offer to help, and at the very end of your reply add one line per item, exactly in this form:
[[remind|YYYY-MM-DDTHH:MM|short reminder text]]   (their local time; if they gave only a day, choose a sensible time such as 09:00)
or, for a time from now ("in 20 minutes", "in 2 hours"): [[remind|+20m|short reminder text]] or [[remind|+2h|short reminder text]]
[[goal|short goal for this week]]
Anything they want to be reminded of, or that has a time, is ALWAYS a remind line, never a goal. Goal lines are only for things they hope to do over the week (like "walk three times"). The app turns these lines into buttons they tap to confirm, so say something like "Tap Remind me below" and never claim it is already set, and never mention the brackets. At most 3 such lines, and only when they would truly help.
When they are facing a hard moment with a known date (an interview, a surgery, a difficult conversation), you may gently offer to check in afterward; only if they say yes, add a remind line whose text is a warm one-line check-in question, like "How did the interview go? I'm here if you want to talk."
Picking up later: when they mention something specific coming up whose outcome they will know later (a meeting, interview, appointment, trip, game, hard conversation or big decision), also add one quiet line [[followup|a short, warm question to ask next time, e.g. How did the board meeting go?]], written in the language you are answering in. At most one per reply, never for general questions, and never mention it: the app keeps it privately so you can ask about it on their next visit.
If they ask to plan their week, help them choose a few goals across work, family and faith, then offer them as goal lines.
Prayer journal: when they ask you to pray for someone or something, or share a concern they are carrying to God (an illness, a decision, a loved one), you may offer to add it to their prayer journal with a line [[prayer|short prayer request, e.g. Sarah's surgery on Friday]]. At most one per reply.
Payments: BibliCall never moves money itself. When they say they need to pay someone (an employee, a family member, a vendor), you may add [[pay|Name|amount|what it is for]] (amount as a number, or empty) so a button opens Venmo, PayPal, Cash App or their bank for them to approve; if there is a day, also add a remind line like "Pay Jack $300". Never ask for passwords, account or card numbers.
Evening reflection: if they ask to reflect on their day, guide a short, gentle reflection: ask one question at a time (what went well, where they saw God at work, anything to let go of or be thankful for), listen warmly, and close with a brief prayer of thanks after two or three exchanges.`;
function systemPrompt(today, memory, group, decide, ambience, tradition, plan, lang, faith) {
  const base = `You are BibliCall, a full-capability AI assistant guided by biblical wisdom and morality. You help with anything a great AI assistant helps with: business strategy, writing, planning, hard decisions, creative work, research, and everyday questions.

Today's date is ${today}. You have a real-time web_search tool connected. You MUST use it before answering any question touching news, current events, prices, markets, schedules, sports results, who currently holds a position or role, or anything that could have changed since your training. Never say you lack real-time access or can't check current information, because you can: search first, then answer. Only skip searching for timeless questions (personal judgment calls, general advice, math, writing help) where searching would add nothing.

When a question touches decisions, character, relationships, work, money, or hardship, let biblical wisdom (honesty, justice, mercy, humility, stewardship, love of neighbor) shape your judgment, the way a wise and trusted mentor would: warmly, naturally, never preachy or condemning. Where it fits naturally, weave in a short biblical phrase or principle in your own words (for example "iron sharpens iron" or "count the cost"), but don't cite chapter and verse; BibliCall adds verified scripture in its North Star below your answer. Respect people of every background, and never take partisan political sides.

When someone is hurting (grief, fear, shame, abuse, thoughts of suicide or self-harm), lead with gentle care before anything else: never lecture, never use scripture as a rebuke, and remind them that God is near to the brokenhearted. If there is any sign of danger to themselves or others, ask gently whether they are safe, give the 988 Suicide & Crisis Lifeline (call or text 988 in the US) or local emergency help, and encourage them to reach a trusted person or pastor. Never suggest that faith requires someone to stay where they are being abused. BibliCall has an Invite Friends feature: the person can bring a friend or family member into this same conversation, live, by text link. If they say they feel alone, wish they had someone to talk to, or want to pray, study or talk this through with someone, you may gently mention once that they can invite a friend to join them here (the button appears just below your answer, and it is also in the menu). Never let this replace care, and in any crisis still give the crisis help above first.

Music: when the person mentions, asks about, or wants to hear a specific song, hymn or piece of music (for example "what do you think of One Tree Hill by U2?"), or when you recommend specific songs, add at the very end of your reply one line per song, exactly like [[song|Song title|Artist]] (at most 3). The app turns each into a play button that opens the YouTube video right inside BibliCall, so you may say "Tap play below to listen". Never mention the brackets, and never write YouTube links yourself.

BibliCall can bring friends into a conversation: if they want to invite or include someone (a friend, family member or co-worker), tell them warmly to tap "Invite a friend" just above the chat box (it is also at the top of the menu, "Invite to a live conversation"); the friend gets a link and joins this conversation live. Never say you can't invite people.

When the person shares files or photos, read them carefully and ground your answer in what they actually contain. Say so plainly if something is unreadable.

Be direct, warm, and practical. Keep responses focused and conversational, typically under 180 words unless the question genuinely requires more depth. Behind every question is a person trying to build something: a business, a family, a life. Help them build it well.`;
  let s = '';
  if (group) {
    s += `\n\nThis is a live group conversation between friends, and you are one of the participants. Each person's message begins with their first name. Address people by name when it helps, and keep group replies brief (usually under 120 words).`;
  }
  if (decide) {
    s += `\n\nBefore replying, decide whether you should speak at all. Speak only if the latest message is addressed to you, asks a question meant for you, or the friends are weighing something where a short, wise thought from you would clearly help. If the friends are simply talking to each other (greetings, plans, replies to one another, small talk), do not interrupt: reply with exactly [[PASS]] and nothing else.`;
  }
  if (!group && FAITH[faith]) s += '\n\n' + FAITH[faith];
  if (Object.prototype.hasOwnProperty.call(LANGS, lang)) {
    s += `\n\nThis person chose ${LANGS[lang]} as their language. Always reply in ${LANGS[lang]}, even when they write in English, unless they ask you to use another language. Keep any [[...]] lines exactly in the format given, with their text in ${LANGS[lang]}.`;
  }
  if (Object.prototype.hasOwnProperty.call(TRADITIONS, tradition)) {
    s += `\n\nThis person has told BibliCall their church tradition is ${TRADITIONS[tradition]}. When a question touches church teaching or practice (for example baptism, communion, salvation, Mary and the saints, confession, prayer practices, worship, church authority, the sacraments), answer faithfully from the ${TRADITIONS[tradition]} perspective and its teaching, as a knowledgeable and warm member of that tradition would; where Christians genuinely differ, you may briefly and respectfully note that others see it differently. Never disparage any other tradition. On every other subject, answer exactly as you otherwise would.`;
  }
  if (ambience) {
    s += `\n\nThe BibliCall app reports what this person sees and hears on screen right now (from the app itself, not typed by them): ${ambience}\nIf they ask about the music, the song, the artist, the background picture or where it is, tell them from this, and feel free to share a little interesting background (the composer or piece, the place, or the space object), searching the web if it helps. Never claim you can't see or hear it: the app has told you. Don't bring it up unless they ask.`;
  }
  if (plan && !group) {
    s += `\n\nThis person's local date and time right now: ${plan.local}.`;
    if (plan.prayers) s += `\nOn their prayer list: ${plan.prayers}`;
    if (plan.reading) s += `\nTheir Bible reading plan: ${plan.reading}`;
    if (plan.goals) s += `\nTheir goals this week: ${plan.goals}`;
    if (plan.upcoming) s += `\nTheir upcoming reminders: ${plan.upcoming}`;
    if (plan.goals || plan.upcoming) s += `\nWhen it fits naturally, encourage them and help them stay on track with these, kindly and never nagging; don't list them unless asked.`;
  }
  if (memory.length) {
    s += `\n\nThis person has asked BibliCall to remember the following about them. Use it only when it is relevant, and don't list it back to them:\n` + memory.map((m) => '- ' + m).join('\n');
  }
  // The fixed instructions are marked for prompt caching (re-sent instructions cost up to 90% less);
  // per-person extras (group call, memory) follow in their own block.
  const blocks = [{ type: 'text', text: plan && !group ? base + PLAN_RULES : base, cache_control: { type: 'ephemeral' } }];
  if (s.trim()) blocks.push({ type: 'text', text: s.trim() });
  return blocks;
}

const NORTH_STAR_SYSTEM = `You are the North Star layer of BibliCall, an AI assistant guided by biblical wisdom. You never answer the question itself. You follow the instructions in the user message exactly and reply with only the JSON it asks for.`;

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === '0 11 * * *') ctx.waitUntil(runDaily(env).then((r) => console.log('daily', JSON.stringify(r))));
    else ctx.waitUntil(runPlanner(env).then((r) => console.log('planner', JSON.stringify(r))));
  },
  async fetch(request, env, ctx) {
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
    if (request.method === 'GET' && url.pathname === '/ics') return icsFile(url);
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
    const fromRooms = request.headers.get('X-BibliCall-Source') === 'rooms';
    let visitor = 'v:' + (request.headers.get('CF-Connecting-IP') || 'unknown');
    const busy = () => json({ error: 'busy', message: 'Too many questions at once. Please wait a minute and try again.' }, 429);
    if (fromRooms) {
      // Each call has its own allowance, inside an overall cap for all calls together.
      const roomKey = 'room:' + String(request.headers.get('X-BibliCall-Room') || 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
      if (env.ROOM_LIMIT && !(await env.ROOM_LIMIT.limit({ key: roomKey })).success) return busy();
      if (env.ROOMS_LIMIT && !(await env.ROOMS_LIMIT.limit({ key: 'rooms' })).success) return busy();
    } else if (env.VISITOR_LIMIT) {
      if (!(await env.VISITOR_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' })).success) return busy();
    }

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON' }, 400); }

    // Accounts: sign-in, memory and kept conversations.
    if (body.mode === 'daily-preview') return json(await preview(env));
    // Sync apps: pass a person's own monday.com request through (their personal token is used only for this one request and never stored or logged).
    if (body.mode === 'monday') {
      const token = typeof body.token === 'string' ? body.token.trim() : '', query = typeof body.query === 'string' ? body.query : '';
      if (!token || token.length > 2000 || !query || query.length > 6000) return json({ error: 'bad request' }, 400);
      try {
        const r = await fetch('https://api.monday.com/v2', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': token, 'API-Version': '2024-10' }, body: JSON.stringify({ query, variables: body.variables || {} }) });
        const data = await r.json().catch(() => ({ errors: [{ message: 'monday.com did not answer' }] }));
        return json(data, r.ok ? 200 : 200);
      } catch (e) { return json({ errors: [{ message: 'Could not reach monday.com' }] }); }
    }
    if (body.mode === 'plan') {
      try { return json(await planOp(env, body)); }
      catch (e) { console.error('plan', e && e.message); return json({ error: 'Something went wrong. Please try again.' }, 500); }
    }
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
        ctx && ctx.waitUntil(recordCost(env, visitor, { voice: text.length * 30, n_voice: text.length }));
        return new Response(audio, { headers: { ...cors, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } });
      } catch (err) {
        console.error('Speak error', err && err.message);
        return json({ error: 'Could not create the voice', detail: String(err && err.message || '').slice(0, 200) }, 502);
      }
    }

    // Find the YouTube video for a song mentioned in conversation (plays inside BibliCall in YouTube's own player).
    if (body.mode === 'song') {
      const title = String(body.title || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120), artist = String(body.artist || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80);
      if (!title) return json({ error: 'Which song?' }, 400);
      const key = 'song:' + (title + '|' + artist).toLowerCase().replace(/[^a-z0-9|]+/g, ' ').trim();
      const D = env.DIRECTORY.get(env.DIRECTORY.idFromName('main'));
      const dcall = async (b) => (await D.fetch('https://do/', { method: 'POST', body: JSON.stringify(b) })).json();
      // Monthly song allowance per person (signed-in account, else this device). Songs that can't be found don't count.
      const month = new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 7);
      const who = visitor.indexOf('u:') === 0 ? visitor : (/^[A-Za-z0-9_-]{16,40}$/.test(String(body.did || '')) ? 'd:' + body.did : visitor);
      const wd = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('songs:' + who));
      const mk = 'sm:' + month + ':' + [...new Uint8Array(wd)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
      const used = (await dcall({ op: 'map.get', key: mk })) || 0, limit = SONGS_PER_MONTH.free;
      if (used >= limit) return json({ error: 'song_limit', used, limit }, 402);
      const played = async (v) => { await dcall({ op: 'inc', key: mk }); return json({ ...v, used: used + 1, limit }); };
      const hit = await dcall({ op: 'map.get', key });
      if (hit && hit.id) return played(hit);
      if (!(await underQuota(env, visitor, 'song', 1, 40))) return json({ error: "You've found a lot of music today. More tomorrow." }, 429);
      const oembed = async (id) => {
        const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id));
        if (!r.ok) return null;
        const j = await r.json().catch(() => null);
        return j ? { id, title: String(j.title || title).slice(0, 160), author: String(j.author_name || '').slice(0, 80) } : null;
      };
      try {
        const pl = { model: MODEL, max_tokens: 300, system: 'You find official YouTube videos for songs. Search the web, then reply with only YouTube watch URLs (best first, up to 3), one per line, nothing else. Prefer the official music video or the official audio from the artist\'s channel or label.',
          messages: [{ role: 'user', content: 'Song: ' + title + (artist ? '\nArtist: ' + artist : '') }], tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }] };
        const r = await fetch(env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(pl) });
        const data = await r.json();
        if (!r.ok) throw new Error('search');
        ctx && ctx.waitUntil(recordCost(env, visitor, { song: usageCost(data), n_song: 1 }));
        const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        const ids = [...new Set([...text.matchAll(/(?:youtube\.com\/(?:watch\?(?:[^\s]*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/g)].map((m) => m[1]))].slice(0, 3);
        for (const id of ids) {
          const ok = await oembed(id);
          if (ok) { ok.q = title + (artist ? ' \u2014 ' + artist : ''); await dcall({ op: 'map.put', key, value: ok }); return played(ok); }
        }
        return json({ error: 'not_found' }, 404);
      } catch (e) {
        console.error('Song error', e && e.message);
        return json({ error: 'not_found' }, 404);
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
        ctx && ctx.waitUntil(recordCost(env, visitor, { stt: Math.max(50, Math.round(audio.length / 16000 / 60 * 500)), n_stt: 1 }));
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
      const roomId = 'r:' + String(request.headers.get('X-BibliCall-Room') || 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
      const ok = fromRooms ? await underQuota(env, roomId, 'ask', 1, DAILY.roomAsk) : await underQuota(env, visitor, 'ask', 1, DAILY.ask);
      if (!ok) return json({ answer: "You've reached today's limit of questions for BibliCall. It resets tomorrow, and I'll be here. In the meantime, take a quiet moment with what we've already talked about." });
      // Cache the conversation so far, so a follow-up question re-reads it at the lower cached price.
      const last = messages[messages.length - 1];
      if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
      last.content[last.content.length - 1].cache_control = { type: 'ephemeral' };
    }

    const payload = northStar
      ? { model: NS_MODEL, max_tokens: 700, system: NORTH_STAR_SYSTEM, messages }
      : {
          model: MODEL, max_tokens: files.length ? 1600 : 1024, system: systemPrompt(today, memory, !!body.group, !!body.decide, String(body.ambience || '').replace(/[\u0000-\u001f`]/g, ' ').slice(0, 700), String(body.tradition || ''), cleanPlan(body.plan), String(body.lang || ''), +body.faith || 0), messages,
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
      // What this answer cost BibliCall, in millionths of a dollar (no content is recorded).
      ctx && ctx.waitUntil(recordCost(env, visitor, northStar ? { ns: usageCost(data), n_ns: 1 } : { ask: usageCost(data), n_ask: 1, cache_read: (data.usage && data.usage.cache_read_input_tokens) || 0, tokens_in: ((data.usage && data.usage.input_tokens) || 0) + ((data.usage && data.usage.cache_read_input_tokens) || 0) + ((data.usage && data.usage.cache_creation_input_tokens) || 0) }));
      // With web search the answer arrives in pieces split around citations; join them back into one text.
      const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').replace(/\n{3,}/g, '\n\n').trim();
      return json({ answer: text || "Sorry, I couldn't come up with an answer just now." });
    } catch (err) {
      console.error('Worker error', err && err.message);
      return json({ error: 'Something went wrong' }, 500);
    }
  }
};


// ---- Cost tracking: totals per day, and per anonymous person (hashed), for the weekly email ----
// Anthropic prices in $ per million tokens: [input, output, cache write, cache read]. Tokens x price = millionths of a dollar.
const PRICES = [['claude-sonnet-5-5', [2, 10, 2.5, 0.2]], ['claude-haiku-4-5', [1, 5, 1.25, 0.1]], ['claude-sonnet-4-5', [3, 15, 3.75, 0.3]], ['claude-opus-5-5', [4, 20, 5, 0.2]]];
function usageCost(data) {
  const u = (data && data.usage) || {}, m = String((data && data.model) || '');
  const pr = (PRICES.find(([k]) => m.indexOf(k) === 0) || PRICES[0])[1];
  const searches = (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
  return Math.round((u.input_tokens || 0) * pr[0] + (u.output_tokens || 0) * pr[1] + (u.cache_creation_input_tokens || 0) * pr[2] + (u.cache_read_input_tokens || 0) * pr[3] + searches * 10000);
}
async function recordCost(env, who, parts) {
  try {
    const D = env.DIRECTORY.get(env.DIRECTORY.idFromName('main'));
    const day = new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10);
    const dig = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('cost:' + who));
    const h = [...new Uint8Array(dig)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
    const inc = (key, n) => D.fetch('https://do/', { method: 'POST', body: JSON.stringify({ op: 'inc', key, n }) });
    const money = (parts.ask || 0) + (parts.ns || 0) + (parts.voice || 0) + (parts.stt || 0) + (parts.song || 0);
    const jobs = Object.entries(parts).filter(([, n]) => n > 0).map(([k, n]) => inc('cost:' + day + ':' + k, n));
    if (money > 0) jobs.push(inc('cu:' + day + ':' + h, money));
    await Promise.all(jobs);
  } catch (e) { console.error('cost', e && e.message); }
}

// ---- Fair-use counters: one tiny Durable Object per visitor (or call) per day ----
function cleanPlan(p) {
  if (!p || typeof p !== 'object') return null;
  const c = (x, n) => String(x || '').replace(/[\u0000-\u001f`]/g, ' ').slice(0, n);
  return { local: c(p.local, 80) || 'unknown', goals: c(p.goals, 900), upcoming: c(p.upcoming, 900), prayers: c(p.prayers, 700), reading: c(p.reading, 120) };
}

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
