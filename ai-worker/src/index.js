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
  2: 'This person chose "Gentle Guidance" for how much faith appears in BibliCall\'s answers. Give plain, excellent answers with no faith language unless they directly ask about faith, the Bible or prayer, or bring God up themselves; then answer warmly from Scripture. Never mention this setting.',
  3: 'This person chose "Faith Forward" for how much faith appears in BibliCall\'s answers. By choosing Faith Forward they have asked for a deeper, faith-centered conversation: when something meaningful is at stake (decisions, relationships, work struggles, character, purpose, hardship), let biblical wisdom and the example of Jesus shape your answer openly and warmly, and in heavy moments offer to pray with them. Everyday questions (sports, news, how-to, trivia) still get a plain, excellent answer with no faith add-on. Never preachy. Never mention this setting.'
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
function systemPrompt(today, memory, group, decide, ambience, tradition, plan, lang, faith, name, town) {
  const base = `You are BibliCall, a full-capability AI assistant guided by biblical wisdom and morality. You help with anything a great AI assistant helps with: business strategy, writing, planning, hard decisions, creative work, research, and everyday questions.

Today's date is ${today}. You have a real-time web_search tool connected. You MUST use it before answering any question touching news, current events, prices, markets, schedules, sports results, who currently holds a position or role, or anything that could have changed since your training. Never say you lack real-time access or can't check current information, because you can: search first, then answer. Only skip searching for timeless questions (personal judgment calls, general advice, math, writing help) where searching would add nothing.

When a question touches decisions, character, relationships, work, money, or hardship, let biblical wisdom (honesty, justice, mercy, humility, stewardship, love of neighbor) quietly shape your judgment, the way a wise and trusted mentor would. UNIVERSAL RULE: never add faith, Bible or spiritual commentary, verses, biblical phrases or sermon-like closing thoughts unless the person directly asks for it (for example they ask what the Bible says, ask for a verse or prayer, or bring up God or faith themselves). Sports, news, business, how-to and everyday questions get a plain, excellent answer and nothing more. Scripture appears only in the North Star, and only when the person taps for it. Respect people of every background, and never take partisan political sides.

When someone is hurting (grief, fear, shame, abuse, thoughts of suicide or self-harm), lead with gentle care before anything else: never lecture, never use scripture as a rebuke, and remind them that God is near to the brokenhearted. If there is any sign of danger to themselves or others, ask gently whether they are safe, give the 988 Suicide & Crisis Lifeline (call or text 988 in the US) or local emergency help, and encourage them to reach a trusted person or pastor. Never suggest that faith requires someone to stay where they are being abused. BibliCall has an Invite Friends feature: the person can bring a friend or family member into this same conversation, live, by text link. If they say they feel alone, wish they had someone to talk to, or want to pray, study or talk this through with someone, you may gently mention once that they can invite a friend to join them here (the button appears just below your answer, and it is also in the menu). Never let this replace care, and in any crisis still give the crisis help above first.

Music: when the person mentions, asks about, or wants to hear a specific song, hymn or piece of music (for example "what do you think of One Tree Hill by U2?"), or when you recommend specific songs, add at the very end of your reply one line per song, exactly like [[song|Song title|Artist]] (at most 3). The app turns each into a play button that opens the YouTube video right inside BibliCall, so you may say "Tap play below to listen". Never mention the brackets, and never write YouTube links yourself.

Your friendly nickname is Bibli: people (and their friends in a live call) call you "Bibli", and you may call yourself Bibli too ("I'm Bibli"), while the app is BibliCall. When someone says "Bibli" they are talking to you.

ALWAYS UP TO THE MINUTE (universal rule): for anything that happens in the world (news, events, games, markets, weather, prices, people in the news, schedules), use your live tools before answering: live_scores for games, latest_news for news and current events (newest first, with minutes ago), weather for weather, and web search for detail. Compare publish times with the exact time right now; trust the newest sources; never say something hasn't happened or hasn't started based on older articles; and say how fresh the information is when it matters (for example "as of 7:52 p.m. Central"). Never rely on memory for current facts.

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
  {
    const now = new Date(), f = (tz) => now.toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    s += `\n\nThe exact time right now: ${f('America/New_York')} Eastern = ${f('America/Chicago')} Central = ${f('America/Los_Angeles')} Pacific (${now.toISOString()} UTC). Sports and TV start times are usually listed in Eastern time; convert carefully before saying whether something has started, and for any game or score use the live_scores tool instead of guessing from articles.`;
  }
  if (town === 'hinsdale') s += `

This person follows Hinsdale, Illinois in BibliCall. For anything local ("around here", "this weekend", the village, the schools, Hinsdale organizations or events), use the local_guide tool first and name the source (for example "the Village of Hinsdale" or "District 86"), then web search for anything it doesn't cover.`;
  if (name && !group) s += `\n\nThis person's first name is ${name}. When you use their name, call them ${name}. Never call them by a joking nickname or a name that came up in banter (with friends, in earlier messages or in memory) unless they clearly ask to be called that.`;
  else if (!group) s += `\n\nNever call this person by a joking nickname that came up in banter or memory unless they clearly ask to be called that.`;
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
          model: MODEL, max_tokens: files.length ? 1600 : 1024, system: systemPrompt(today, memory, !!body.group, !!body.decide, String(body.ambience || '').replace(/[\u0000-\u001f`]/g, ' ').slice(0, 700), String(body.tradition || ''), cleanPlan(body.plan), String(body.lang || ''), +body.faith || 0, String(body.name || '').replace(/[^A-Za-z\u00C0-\u024F' -]/g, '').trim().slice(0, 30), TOWNS[String(body.town || '')] ? String(body.town) : ''), messages,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }, LIVE_SCORES_TOOL, LATEST_NEWS_TOOL, WEATHER_TOOL, LOCAL_GUIDE_TOOL]
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
      // A long web search can pause mid-answer; continue it (up to twice) so the person never gets an empty reply.
      // Keep going while the answer pauses mid web search, or asks BibliCall's live-scores tool for real-time results.
      let extraCost = 0, convo = [...payload.messages];
      for (let k = 0; k < 4 && (data.stop_reason === 'pause_turn' || data.stop_reason === 'tool_use'); k++) {
        extraCost += usageCost(data);
        convo = [...convo, { role: 'assistant', content: data.content }];
        if (data.stop_reason === 'tool_use') {
          const results = [];
          for (const b of data.content || []) if (b.type === 'tool_use') results.push({ type: 'tool_result', tool_use_id: b.id, content: await runTool(b.name, b.input || {}) });
          convo.push({ role: 'user', content: results });
        }
        const cont = await call({ ...payload, messages: convo });
        const d2 = await cont.json();
        if (!cont.ok) break;
        if (data.stop_reason === 'pause_turn') d2.content = [...(data.content || []), ...(d2.content || [])];
        data = d2;
      }
      // What this answer cost BibliCall, in millionths of a dollar (no content is recorded).
      ctx && ctx.waitUntil(recordCost(env, visitor, northStar ? { ns: usageCost(data), n_ns: 1 } : { ask: usageCost(data) + extraCost, n_ask: 1, cache_read: (data.usage && data.usage.cache_read_input_tokens) || 0, tokens_in: ((data.usage && data.usage.input_tokens) || 0) + ((data.usage && data.usage.cache_read_input_tokens) || 0) + ((data.usage && data.usage.cache_creation_input_tokens) || 0) }));
      // With web search the answer arrives in pieces split around citations; join them back into one text.
      const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').replace(/<\/?cite[^>]*>/gi, '').replace(/\n{3,}/g, '\n\n').trim();
      return json({ answer: text || "Sorry, I couldn't come up with an answer just now." });
    } catch (err) {
      console.error('Worker error', err && err.message);
      return json({ error: 'Something went wrong' }, 500);
    }
  }
};


// ---- Live scores from ESPN's public scoreboard: real-time game status, so Bibli is never behind on a game in progress ----
const LEAGUES = { mlb: 'baseball/mlb', nfl: 'football/nfl', ncaaf: 'football/college-football', nba: 'basketball/nba', wnba: 'basketball/wnba', ncaab: 'basketball/mens-college-basketball', ncaaw: 'basketball/womens-college-basketball', nhl: 'hockey/nhl', mls: 'soccer/usa.1', epl: 'soccer/eng.1', laliga: 'soccer/esp.1', ucl: 'soccer/uefa.champions', pga: 'golf/pga' };
const LIVE_SCORES_TOOL = {
  name: 'live_scores',
  description: 'Real-time scores and game status (inning, quarter, period, time left, final), start times, series and TV for today (or a given date) from ESPN. ALWAYS use this for any question about a score, a game in progress, tonight\'s or today\'s game, or a result from the last few days; it is live, unlike web search results. Use web search only for other background.',
  input_schema: { type: 'object', properties: { league: { type: 'string', enum: Object.keys(LEAGUES), description: 'mlb, nfl, ncaaf (college football), nba, wnba, ncaab (men\'s college basketball), ncaaw, nhl, mls, epl (Premier League), laliga, ucl (Champions League), pga' }, team: { type: 'string', description: 'Optional team name to filter, e.g. "White Sox"' }, date: { type: 'string', description: 'Optional YYYYMMDD; omit for today' } }, required: ['league'] }
};
async function liveScores(input) {
  try {
    const lg = LEAGUES[String(input.league || '').toLowerCase()];
    if (!lg) return 'Unknown league.';
    let url = 'https://site.api.espn.com/apis/site/v2/sports/' + lg + '/scoreboard';
    if (/^\d{8}$/.test(String(input.date || ''))) url += '?dates=' + input.date;
    const r = await fetch(url, { headers: { 'User-Agent': 'BibliCall/1.0' }, cf: { cacheTtl: 15 } });
    if (!r.ok) return 'Live scores are unavailable right now.';
    const j = await r.json();
    const team = String(input.team || '').toLowerCase().trim();
    const all = j.events || [];
    const pick = team ? all.filter((e) => ((e.competitions && e.competitions[0] && e.competitions[0].competitors) || []).some((c) => [c.team && c.team.displayName, c.team && c.team.shortDisplayName, c.team && c.team.name, c.team && c.team.abbreviation].join(' ').toLowerCase().includes(team))) : all;
    if (!pick.length) return team ? 'No ' + input.league + ' game found for "' + input.team + '" on that date. Games that day: ' + all.map((e) => e.name).slice(0, 12).join('; ') : 'No games found.';
    return JSON.stringify({ checked_at_utc: new Date().toISOString(), games: pick.slice(0, 8).map((e) => {
      const c = (e.competitions && e.competitions[0]) || {};
      const sit = c.situation || {};
      return { game: e.name, status: e.status && e.status.type && e.status.type.detail, state: e.status && e.status.type && e.status.type.state, start_utc: e.date,
        teams: (c.competitors || []).map((t) => ({ team: t.team && t.team.displayName, home_away: t.homeAway, score: t.score, hits: t.hits, record: t.records && t.records[0] && t.records[0].summary })),
        series: c.series && c.series.summary, note: (c.notes || []).map((n) => n.headline).join('; ') || undefined,
        situation: c.situation ? { outs: sit.outs, balls: sit.balls, strikes: sit.strikes, onFirst: sit.onFirst, onSecond: sit.onSecond, onThird: sit.onThird, down_distance: sit.downDistanceText, last_play: sit.lastPlay && sit.lastPlay.text } : undefined,
        tv: (c.broadcasts || []).flatMap((b) => b.names || []).join(', ') || undefined };
    }) });
  } catch (e) { return 'Live scores are unavailable right now.'; }
}

// ---- Latest news (Google News, minutes old) and live weather (Open-Meteo): Bibli is never behind on what's happening ----
const LATEST_NEWS_TOOL = {
  name: 'latest_news',
  description: 'The newest headlines from news outlets worldwide, with the exact time each was published (usually minutes old). ALWAYS use this for news, current events, breaking stories, elections, markets, business, weather events, deaths, launches, or anything that may have changed recently, then use web search for detail if needed. Results are sorted newest first.',
  input_schema: { type: 'object', properties: { query: { type: 'string', description: 'What to look for, e.g. "White Sox Guardians Game 5" or "hurricane Florida"' }, hours: { type: 'number', description: 'How far back to look, in hours (default 24)' } }, required: ['query'] }
};
const WEATHER_TOOL = {
  name: 'weather',
  description: 'Current weather and the next 3 days for any place, live. Use for any weather question.',
  input_schema: { type: 'object', properties: { place: { type: 'string', description: 'City or town, e.g. "Hinsdale, Illinois"' } }, required: ['place'] }
};
async function runTool(name, input) {
  if (name === 'live_scores') return liveScores(input);
  if (name === 'latest_news') return latestNews(input);
  if (name === 'weather') return weatherNow(input);
  if (name === 'local_guide') return localGuide(input);
  return 'Unknown tool';
}
async function latestNews(input) {
  try {
    const hours = Math.min(168, Math.max(1, +input.hours || 24));
    const r = await fetch('https://www.bing.com/news/search?format=rss&qft=sortbydate%3d%221%22&q=' + encodeURIComponent(String(input.query || '').slice(0, 200)), { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BibliCall/1.0)' }, cf: { cacheTtl: 60 } });
    if (!r.ok) return 'News is unavailable right now.';
    const xml = await r.text();
    const dec = (x) => x.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    const tag = (s, t) => { const m = s.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>')); return m ? dec(m[1]) : ''; };
    const now = Date.now();
    const items = (xml.match(/<item>[\s\S]*?<\/item>/g) || []).map((it) => {
      const t = Date.parse(tag(it, 'pubDate'));
      return { title: tag(it, 'title'), summary: tag(it, 'description').slice(0, 300), source: tag(it, 'News:Source'), published_utc: isNaN(t) ? undefined : new Date(t).toISOString(), minutes_ago: isNaN(t) ? undefined : Math.round((now - t) / 60000) };
    }).filter((x) => x.title && (x.minutes_ago == null || x.minutes_ago <= hours * 60))
      .sort((a, b) => (a.minutes_ago ?? 1e9) - (b.minutes_ago ?? 1e9)).slice(0, 12);
    return items.length ? JSON.stringify({ checked_at_utc: new Date().toISOString(), headlines: items }) : 'No news found in that time window. Try a broader query or more hours.';
  } catch (e) { return 'News is unavailable right now.'; }
}
async function weatherNow(input) {
  try {
    const place = String(input.place || '').slice(0, 100);
    const g = await (await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(place.split(',')[0]))).json();
    const loc = g && g.results && g.results[0];
    if (!loc) return 'Could not find that place.';
    const u = 'https://api.open-meteo.com/v1/forecast?latitude=' + loc.latitude + '&longitude=' + loc.longitude + '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto&forecast_days=3';
    const w = await (await fetch(u)).json();
    return JSON.stringify({ place: loc.name + (loc.admin1 ? ', ' + loc.admin1 : '') + (loc.country ? ', ' + loc.country : ''), current: w.current, daily: w.daily, units: 'F, mph, inches; weather_code is WMO (0 clear, 1-3 partly cloudy, 45 fog, 51-67 drizzle/rain, 71-77 snow, 80-82 showers, 95-99 thunderstorms)' });
  } catch (e) { return 'Weather is unavailable right now.'; }
}

// ---- Local guide: the town's own sources (village, schools, chamber, nonprofits), read live ----
const TOWNS = {
  hinsdale: {
    name: 'Hinsdale, Illinois',
    sources: {
      village: { name: 'Village of Hinsdale (government, board meetings, parks & recreation, police and fire news)', urls: ['https://www.villageofhinsdale.org/news_list.php', 'https://www.villageofhinsdale.org/calendar.php'] },
      d86: { name: 'Hinsdale Township High School District 86 (Hinsdale Central, Hinsdale South)', urls: ['https://www.hinsdale86.org/our-district/news-and-announcements', 'https://www.hinsdale86.org/our-district/calendars'] },
      d181: { name: 'Community Consolidated School District 181 (elementary and middle schools)', urls: ['https://www.d181.org/district/news', 'https://www.d181.org/calendars', 'https://www.d181.org/families/family-education-events'] },
      chamber: { name: 'Hinsdale Chamber of Commerce', urls: ['https://business.hinsdalechamber.com/events/calendar', 'https://www.hinsdalechamber.com/feed/'] },
      community_house: { name: 'The Community House', urls: ['https://thecommunityhouse.org/events/', 'https://thecommunityhouse.org/feed/'] },
      wellness_house: { name: 'Wellness House (free support for people affected by cancer)', urls: ['https://wellnesshouse.org/program-list/', 'https://wellnesshouse.org/feed/'] },
      library: { name: 'Hinsdale Public Library', urls: ['https://hinsdale.libnet.info/events', 'https://www.hinsdalelibrary.info/'] },
      history: { name: 'Hinsdale Historical Society', urls: ['https://www.hinsdalehistory.org/upcoming-events'] },
      humane_society: { name: 'Hinsdale Humane Society', urls: ['https://hinsdalehumanesociety.org/events/', 'https://hinsdalehumanesociety.org/feed/'] },
      hinsdale_magazine: { name: 'Hinsdale Magazine (local stories)', urls: ['https://hinsdalemag.com/feed/'] },
      // Faith communities: every congregation in the Village of Hinsdale's directory plus nearby synagogues, mosques and temple, treated alike.
      f_chabad: { name: 'Chabad Jewish Center of Hinsdale (synagogue)', urls: ['https://www.jewishhinsdale.com/'] },
      f_avenue: { name: 'Avenue Christian Church (formerly Christian Church of Clarendon Hills)', urls: ['https://www.avenuechristian.com/'] },
      f_christchurch: { name: 'Christ Church of Oak Brook', urls: ['https://christchurch.us/oakbrook'] },
      f_chcpc: { name: 'Community Presbyterian Church, Clarendon Hills', urls: ['https://www.chcpc.org/'] },
      f_etzchaim: { name: 'Congregation Etz Chaim (synagogue), Lombard', urls: ['https://www.mycec.org/'] },
      f_covenant: { name: 'Evangelical Covenant Church (Hinsdale Covenant)', urls: ['https://www.hinsdalecovenant.com/'] },
      f_faithfellowship: { name: 'Faith Fellowship Church, Oak Brook', urls: ['https://www.churchfaithfellowship.org/'] },
      f_grace: { name: 'Grace Episcopal Church', urls: ['https://www.gracehinsdale.org/'] },
      f_htgc: { name: 'Hindu Temple of Greater Chicago, Lemont', urls: ['https://www.htgc.org/'] },
      f_humc: { name: 'Hinsdale United Methodist Church', urls: ['https://www.hinsdaleumc.com/'] },
      f_islamicfoundation: { name: 'Islamic Foundation (mosque), Villa Park', urls: ['https://www.islamicfoundation.org/'] },
      f_redeemer: { name: 'Redeemer Lutheran Church', urls: ['https://redeemerhinsdale.org/'] },
      f_sij: { name: 'St. Isaac Jogues Catholic Parish', urls: ['https://www.sij.net/'] },
      f_trinitylutheran: { name: 'Trinity Lutheran Church, Burr Ridge', urls: ['https://www.mytls.org/'] },
      f_union: { name: 'Union Church of Hinsdale', urls: ['https://hinsdale.church/'] },
      f_unitarian: { name: 'Unitarian Church of Hinsdale', urls: ['https://www.hinsdaleunitarian.org/'] },
      f_zion: { name: 'Zion Lutheran Church', urls: ['https://www.zionhinsdale.org/'] }
    },
    faithNoSite: 'Also in the Village directory (no website listed): First Church of Christ, Scientist (First and Oak Streets, 630-323-4740); Oak Community Church (620 N. Oak St., 630-323-0087); Sts. Cyril & Methodius Macedonian Orthodox Church (10 S 330 Route 83, 630-654-0016); Hinsdale Seventh-day Adventist Church (201 N. Oak, 630-323-0182); Burr Ridge United Church of Christ (15 W 100 Plainfield Rd, 630-654-4544); The Mecca Center (mosque), Willowbrook.'
  }
};
const TOPIC_GROUPS = { faith: Object.keys(TOWNS.hinsdale.sources).filter((k) => k.indexOf('f_') === 0), schools: ['d86', 'd181'], events: ['village', 'chamber', 'community_house', 'library', 'history', 'humane_society'], news: ['village', 'd86', 'd181', 'hinsdale_magazine', 'chamber'], nonprofits: ['community_house', 'wellness_house', 'humane_society', 'history', 'library'], government: ['village'] };
const LOCAL_GUIDE_TOOL = {
  name: 'local_guide',
  description: 'Live information straight from Hinsdale, Illinois community sources: the Village of Hinsdale (government, board meetings, parks & recreation, police/fire news), District 86 and District 181 schools, the Hinsdale Chamber of Commerce, The Community House, Wellness House, Hinsdale Public Library, Hinsdale Historical Society, Hinsdale Humane Society and Hinsdale Magazine, plus the area's faith communities (topic "faith": every church in the Village directory and nearby synagogues, mosques and Hindu temple, treated equally and listed alphabetically; never rank or recommend one over another). Anyone can ask about Hinsdale, wherever they live. ALWAYS use this (topic "faith") when someone asks about churches, synagogues, mosques, temples or worship near Hinsdale, and ALWAYS use this for questions about Hinsdale events, schools, village business, local organizations, or "what is happening around here". Use web search and latest_news for anything else local (other nonprofits, restaurants, businesses).',
  input_schema: { type: 'object', properties: {
    topic: { type: 'string', enum: ['events', 'news', 'schools', 'government', 'nonprofits', 'faith', 'village', 'd86', 'd181', 'chamber', 'community_house', 'wellness_house', 'library', 'history', 'humane_society', 'hinsdale_magazine'], description: 'Which source or group to read' },
    query: { type: 'string', description: 'Optional words to look for, e.g. "board meeting", "homecoming", "Santa"' } }, required: ['topic'] }
};
function htmlToText(h) {
  return String(h).replace(/<(script|style|noscript|svg|header|footer|nav|form|iframe)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|article|section)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;|&#39;/g, "'").replace(/&#8220;|&#8221;|&quot;/g, '"').replace(/&#8211;|&ndash;/g, '-').replace(/&#\d+;/g, ' ')
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length > 2).join('\n');
}
async function readSource(url, query) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BibliCall/1.0; +https://biblicall.com)' }, cf: { cacheTtl: 900, cacheEverything: true } });
    if (!r.ok) return '';
    const t = await r.text();
    if (/<rss|<feed/i.test(t.slice(0, 500))) {
      const tag = (s, k) => { const m = s.match(new RegExp('<' + k + '[^>]*>([\\s\\S]*?)</' + k + '>')); return m ? htmlToText(m[1].replace(/<!\[CDATA\[|\]\]>/g, '')) : ''; };
      return (t.match(/<item>[\s\S]*?<\/item>/g) || []).slice(0, 8).map((it) => '- ' + tag(it, 'title') + ' (' + tag(it, 'pubDate').slice(0, 16) + '): ' + tag(it, 'description').slice(0, 220)).join('\n');
    }
    let text = htmlToText(t);
    if (query) {
      const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      const lines = text.split('\n'), keep = new Set();
      lines.forEach((l, i) => { if (words.some((w) => l.toLowerCase().includes(w))) for (let k = Math.max(0, i - 2); k <= Math.min(lines.length - 1, i + 3); k++) keep.add(k); });
      if (keep.size) text = [...keep].sort((a, b) => a - b).map((i) => lines[i]).join('\n');
    }
    return text.slice(0, 3500);
  } catch (e) { return ''; }
}
async function localGuide(input) {
  const town = TOWNS[String(input.town || 'hinsdale').toLowerCase()] || TOWNS.hinsdale;
  const topic = String(input.topic || 'events');
  const keys = TOPIC_GROUPS[topic] || (town.sources[topic] ? [topic] : TOPIC_GROUPS.events);
  const parts = await Promise.all(keys.map(async (k) => {
    const src = town.sources[k];
    const texts = await Promise.all(src.urls.map((u) => readSource(u, input.query)));
    const body = texts.filter(Boolean).join('\n').slice(0, Math.max(500, Math.floor(14000 / keys.length)));
    return '### ' + src.name + ' (' + src.urls[0] + ')\n' + (body || '(nothing could be read right now)');
  }));
  return 'Read live from ' + town.name + ' sources at ' + new Date().toISOString() + ' UTC:\n\n' + parts.join('\n\n') + (topic === 'faith' ? '\n\n' + town.faithNoSite : '');
}

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
