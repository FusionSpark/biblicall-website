// Daily North Star email (opt-in) and the weekly BibliCall stats summary.
// Runs from the Cron Trigger in wrangler.toml (every morning). Subscribers live in the Directory Durable Object as dn:<email>.

const PHOTOS = [ // Unsplash photos already used on biblicall.com: [id, photographer, place]
  ['photo-1508020963102-c6c723be5764', 'Diego PH', ''], ['photo-1543613949-95cd1b38a10e', 'zenad nabil', ''],
  ['photo-1501898047706-55903296cd09', 'joe ting', ''], ['photo-1541757617970-f33144dbec38', 'Quino Al', ''],
  ['photo-1465101046530-73398c7f28ca', 'Jeremy Thomas', ''], ['photo-1531366936337-7c912a4589a7', 'Lightscape', ''],
  ['photo-1414521203994-7efc0bc37d65', 'cindy del valle', ''], ['photo-1500964757637-c85e8a162699', 'simon', ''],
  ['photo-1575527048208-6475b441e0a0', 'Tim Hart', 'Grand Canyon'], ['photo-1573270695497-b30e5622686e', 'Lewis J Goetz', 'Ha Long Bay'],
  ['photo-1604626676599-e21a94462216', 'Jaime Dantas', 'Iguazu Falls'], ['photo-1591296795955-92a580509b82', 'Thomas Bennie', 'Table Mountain'],
  ['photo-1543385426-191664295b58', 'Fabien Moliné', 'Machu Picchu'], ['photo-1594387295585-34ba732932c8', 'Gabriel Rissi', 'Christ the Redeemer'],
  ['photo-1629185171801-ac685973a72a', 'Parth Savani', 'Mount Everest'], ['photo-1576487248805-cf45f6bcc67f', 'Shan Elahi', 'Taj Mahal'],
  ['photo-1618811308896-d279d72fdf4d', 'Sammy Wong', 'Victoria Falls'], ['photo-1612977512598-3b8d6a498bbb', 'Jieun Lim', 'Jeju Island']
];
const ALIAS = { 'psalm': 'psalms', 'song of songs': 'song of solomon', 'songs': 'song of solomon', 'revelations': 'revelation' };

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function dir(env) { return env.DIRECTORY.get(env.DIRECTORY.idFromName('main')); }
async function call(stub, body) { const r = await stub.fetch('https://do/', { method: 'POST', body: JSON.stringify(body) }); return r.json(); }
function today() { return new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10); } // US Central-ish date

function lookup(bible, ref) {
  const m = String(ref || '').trim().match(/^(.+?)\s+(\d+):(\d+)(?:\s*[-–—]\s*(\d+))?$/);
  if (!m) return null;
  let s = m[1].trim().replace(/\./g, '').replace(/\s+/g, ' ').toLowerCase();
  s = s.replace(/^(1|first|1st)\s+/, 'i ').replace(/^(2|second|2nd)\s+/, 'ii ').replace(/^(3|third|3rd)\s+/, 'iii ');
  s = ALIAS[s] || s;
  const bi = bible.books.findIndex((b) => b.toLowerCase() === s); if (bi < 0) return null;
  const ch = bible.text[bi][+m[2] - 1]; if (!ch) return null;
  const a = +m[3], b = m[4] ? +m[4] : a;
  if (a < 1 || b < a || b > ch.length || b - a > 3) return null;
  const name = bible.books[bi].replace(/^III /, '3 ').replace(/^II /, '2 ').replace(/^I /, '1 ');
  return { label: name + ' ' + m[2] + ':' + a + (b > a ? '–' + b : ''), text: ch.slice(a - 1, b).join(' ') };
}

async function makeNorthStar(env, recent) {
  const bible = await fetch('https://biblicall.com/kjv.json', { cf: { cacheTtl: 86400, cacheEverything: true } }).then((r) => r.json());
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Chicago' });
  for (let i = 0; i < 3; i++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, messages: [{ role: 'user', content:
        'You write BibliCall\'s Daily North Star: one short, warm morning encouragement guided by biblical wisdom, for people of all walks of life. Today is ' + date + '. ' +
        'Choose ONE King James Version passage (one verse, or up to 3 verses) that you are certain exists' + (recent.length ? ', and not any of these recent ones: ' + recent.join('; ') : '') + '. ' +
        'Write a gentle 3-sentence reflection that applies it to ordinary life today (work, family, worry, gratitude, courage), never preachy, and one short question to carry through the day. ' +
        'Reply with ONLY JSON: {"ref": "Book C:V", "title": "3-6 word title", "reflection": "3 sentences", "question": "one question"}' }] })
    }).then((x) => x.json()).catch(() => null);
    const t = r && r.content && r.content.map((c) => c.text || '').join('');
    let j = null; try { j = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); } catch (e) {}
    const v = j && lookup(bible, j.ref);
    if (v && j.reflection) return { ...j, verse: v };
  }
  return null;
}

function emailHtml(ns, photo, unsub) {
  const img = 'https://images.unsplash.com/' + photo[0] + '?auto=format&fit=crop&w=1200&h=640&q=75';
  return `<div style="background:#eef6fc;padding:18px 10px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;color:#2c2117">
    <img src="${img}" width="600" alt="${esc(photo[2] || 'Sky')}" style="display:block;width:100%;height:auto">
    <div style="padding:22px 24px 8px">
      <p style="margin:0 0 4px;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#664336">&#10022; Daily North Star</p>
      <h1 style="margin:0 0 14px;font-size:24px;line-height:1.25;color:#4a2f26">${esc(ns.title || 'Today\'s North Star')}</h1>
      <blockquote style="margin:0 0 6px;padding:14px 16px;background:#f6efe8;border-radius:12px;font-size:18px;line-height:1.55;font-style:italic">“${esc(ns.verse.text)}”</blockquote>
      <p style="margin:0 0 16px;font-size:14px;font-weight:700;color:#664336">${esc(ns.verse.label)} (KJV)</p>
      <p style="margin:0 0 14px;font-size:17px;line-height:1.6">${esc(ns.reflection)}</p>
      ${ns.question ? `<p style="margin:0 0 18px;font-size:17px;line-height:1.5;font-weight:700">${esc(ns.question)}</p>` : ''}
      <p style="margin:0 0 22px"><a href="https://biblicall.com" style="display:inline-block;background:#664336;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:700">Talk it through with BibliCall</a></p>
    </div>
    <div style="padding:0 24px 20px;font-size:12.5px;line-height:1.5;color:#6b5948">
      Photo${photo[2] ? ' of ' + esc(photo[2]) : ''} by ${esc(photo[1])}.<br>
      You're receiving this because you asked for the Daily North Star at biblicall.com. <a href="${unsub}" style="color:#6b5948">Unsubscribe</a> &middot; <a href="https://biblicall.com/privacy.html" style="color:#6b5948">Privacy</a>
    </div>
  </div></div>`;
}

async function sendBatch(env, emails) {
  for (let i = 0; i < emails.length; i += 100) {
    const r = await fetch('https://api.resend.com/emails/batch', { method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(emails.slice(i, i + 100)) });
    if (!r.ok) console.error('batch', r.status, await r.text());
  }
}

export async function runDaily(env, force) {
  if (!env.RESEND_API_KEY || !env.DIRECTORY) return { skipped: 'not configured' };
  const D = dir(env), day = today();
  const out = {};
  // 1) Daily North Star (once per day, even if the trigger fires twice).
  if (force || !(await call(D, { op: 'map.get', key: 'dn_sent:' + day }))) {
    const subs = (await call(D, { op: 'list', prefix: 'dn:', limit: 5000 })).map(([, v]) => v).filter((v) => v && v.email);
    out.subscribers = subs.length;
    if (subs.length) {
      const recent = (await call(D, { op: 'map.get', key: 'dn_recent' })) || [];
      const ns = await makeNorthStar(env, recent);
      if (ns) {
        const photo = PHOTOS[Math.floor(Math.random() * PHOTOS.length)];
        const base = 'https://biblicall-ai.sjonlich.workers.dev/u?';
        await sendBatch(env, subs.map((s) => {
          const unsub = base + 'e=' + encodeURIComponent(s.email) + '&t=' + s.tok;
          return { from: env.EMAIL_FROM || 'BibliCall <hello@biblicall.com>', to: [s.email], reply_to: 'hello@biblicall.com',
            subject: '✦ ' + (ns.title || 'Your Daily North Star'), html: emailHtml(ns, photo, unsub),
            text: (ns.title || 'Daily North Star') + '\n\n"' + ns.verse.text + '"\n' + ns.verse.label + ' (KJV)\n\n' + ns.reflection + '\n\n' + (ns.question || '') + '\n\nbiblicall.com\nUnsubscribe: ' + unsub,
            headers: { 'List-Unsubscribe': '<' + unsub + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
        }));
        await call(D, { op: 'map.put', key: 'dn_recent', value: [ns.verse.label].concat(recent).slice(0, 60) });
        await call(D, { op: 'inc', key: 'st:' + day + ':daily_sent', n: subs.length });
        out.sent = ns.verse.label;
      }
    }
    await call(D, { op: 'map.put', key: 'dn_sent:' + day, value: 1 });
  }
  // 2) Weekly stats summary on Mondays.
  if (env.NOTIFY_EMAIL && (force === 'stats' || (new Date().getUTCDay() === 1 && !(await call(D, { op: 'map.get', key: 'stats_sent:' + day }))))) {
    await sendStats(env, D);
    await call(D, { op: 'map.put', key: 'stats_sent:' + day, value: 1 });
    out.stats = true;
  }
  return out;
}

const LABELS = [['level_1', 'Faith level: Everyday Wisdom (people-days)'], ['level_2', 'Faith level: Gentle Guidance (people-days)'], ['level_3', 'Faith level: Faith Forward (people-days)'], ['faith_invite', 'Invited to include more Scripture'], ['ns_more', 'Tapped More on a North Star'], ['offer_open', 'Tapped the launch offer'], ['offer_reserve', 'Reserved the launch offer'], ['talk', 'Started a spoken Talk'], ['pickup_show', 'Shown "picking up from last time"'], ['pickup_yes', 'Picked up from last time'], ['pickup_no', 'Said not now to picking up'], ['tabs_all', 'Opened all menu tools'], ['faith_up', 'Accepted the invitation'], ['visit', 'Visits (devices per day)'], ['visit_new', 'New visitors'], ['question', 'Questions asked'], ['northstar', 'North Stars shown'],
  ['listen', 'Listen (voice) taps'], ['music', 'Music turned on'], ['share', 'Verses shared'], ['shared_open', 'Shared verses opened by friends'], ['shared_ask', 'Friends who then asked a question'], ['fb_up', '👍 Helpful'], ['fb_down', '👎 Not helpful'],
  ['waitlist', 'Waitlist signups'], ['daily_sub', 'Daily North Star signups'], ['account', 'Accounts created'], ['call', 'Invite window opened'], ['invite_offer', 'Invite suggested in a chat'], ['invite_yes', 'Invite suggestion accepted'], ['read_chapter', 'Chapters opened from a verse'], ['pray', 'Pray with me taps'], ['push_on', 'Phones that turned on reminders'], ['reminder', 'Reminders set'], ['goal', 'Weekly goals added'], ['goal_done', 'Weekly goals completed'], ['share_week', 'Weeks shared'], ['week_open', 'Shared weeks opened'], ['cheer', 'Encouragements sent'], ['save_pdf', 'Saved as PDF'], ['save_docx', 'Saved as Word'], ['prayer_add', 'Prayers added to journals'], ['prayer_answered', 'Prayers marked answered'], ['read_plan', 'Reading-plan chapters read'], ['group_create', 'Family / group weeks started'], ['group_join', 'People who joined a group week'], ['daily_sent', 'Daily emails sent']];

// Costs: what the AI, voice and speech cost BibliCall this week, per question and per person (anonymous).
async function costSection(D, days, big) {
  try {
    const tot = {};
    (await call(D, { op: 'list', prefix: 'cost:', start: 'cost:' + days[0], limit: 2000 })).forEach(([k, v]) => { const [, d, kind] = k.split(':'); if (days.includes(d)) tot[kind] = (tot[kind] || 0) + v; });
    const per = {};
    for (const d of days) (await call(D, { op: 'list', prefix: 'cu:' + d + ':', limit: 5000 })).forEach(([k, v]) => { const h = k.split(':')[2]; per[h] = (per[h] || 0) + v; });
    const all = (tot.ask || 0) + (tot.ns || 0) + (tot.voice || 0) + (tot.stt || 0) + (tot.song || 0);
    if (!all) return '<h3 style="color:#4a2f26;margin:18px 0 6px">Costs</h3><p style="color:#6b5948;font-size:14px">Cost tracking started; numbers appear once people use BibliCall this week.</p>';
    const $ = (micro) => '$' + (micro / 1e6).toFixed(micro < 1e5 ? 3 : 2);
    const vals = Object.values(per).sort((a, b) => b - a), n = vals.length;
    const avg = n ? vals.reduce((a, b) => a + b, 0) / n : 0;
    const topN = Math.max(1, Math.ceil(n * 0.1)), topAvg = n ? vals.slice(0, topN).reduce((a, b) => a + b, 0) / topN : 0;
    const month = (x) => x * 30 / 7;
    const cacheShare = tot.tokens_in ? Math.round(100 * (tot.cache_read || 0) / tot.tokens_in) : 0;
    return '<h3 style="color:#4a2f26;margin:18px 0 6px">Costs</h3><table cellpadding="0" cellspacing="0" style="width:100%;max-width:520px;border-collapse:collapse">' +
      big('Total cost this week', $(all), 'Answers ' + $(tot.ask || 0) + ' \u00b7 North Star ' + $(tot.ns || 0) + ' \u00b7 Voice ' + $(tot.voice || 0) + ' \u00b7 Speaking ' + $(tot.stt || 0) + (tot.song ? ' \u00b7 Finding songs ' + $(tot.song) : '')) +
      big('Cost per question', tot.n_ask ? $((tot.ask || 0) / tot.n_ask) : '\u2014', (tot.n_ask || 0) + ' questions answered' + (tot.n_voice ? ' \u00b7 voice: ' + Math.round(tot.n_voice / 1000) + 'k characters read aloud' : '')) +
      big('Average person, per month', $(month(avg)), n + ' people this week \u00b7 compare with the $20 plan') +
      big('Busiest 10% of people, per month', $(month(topAvg)), 'Busiest single person: ' + $(month(vals[0] || 0)) + ' a month') +
      big('Instructions re-read at the cached price', cacheShare + '%', 'Higher is cheaper') + '</table>' +
      '<p style="color:#6b5948;font-size:13px">Monthly figures are this week \u00d7 30/7. Anthropic prices as of Oct 2026; voice at $0.03 per 1,000 characters.</p>';
  } catch (e) { return ''; }
}

async function sendStats(env, D) {
  const days = []; for (let i = 7; i >= 1; i--) days.push(new Date(Date.now() - i * 86400000 - 6 * 3600000).toISOString().slice(0, 10));
  const rows = await call(D, { op: 'list', prefix: 'st:', start: 'st:' + days[0], limit: 2000 });
  const tot = {}; rows.forEach(([k, v]) => { const [, d, ev] = k.split(':'); if (days.includes(d)) tot[ev] = (tot[ev] || 0) + v; });
  const subs = (await call(D, { op: 'list', prefix: 'dn:', limit: 5000 })).length;
  // People: active this week, new, and how many of last week's newcomers came back.
  const prev = []; for (let i = 14; i >= 8; i--) prev.push(new Date(Date.now() - i * 86400000 - 6 * 3600000).toISOString().slice(0, 10));
  const keysOf = async (prefix) => (await call(D, { op: 'list', prefix, limit: 5000 })).map(([k]) => k.slice(prefix.length));
  const weekDays = {}, union = (arr) => { const s = new Set(); arr.forEach((a) => a.forEach((x) => s.add(x))); return s; };
  const thisAct = []; for (const d of days) { const k = await keysOf('act:' + d + ':'); thisAct.push(k); k.forEach((x) => { weekDays[x] = (weekDays[x] || 0) + 1; }); }
  const prevAct = []; for (const d of prev) prevAct.push(await keysOf('act:' + d + ':'));
  const newThis = union(await Promise.all(days.map((d) => keysOf('new:' + d + ':')))), newPrev = union(await Promise.all(prev.map((d) => keysOf('new:' + d + ':'))));
  const wau = union(thisAct), wauPrev = union(prevAct);
  const back = [...newPrev].filter((x) => wau.has(x)).length, rate = newPrev.size ? Math.round(100 * back / newPrev.size) : null;
  const twoPlus = Object.values(weekDays).filter((n) => n >= 2).length, perDay = Math.round(thisAct.reduce((a, b) => a + b.length, 0) / 7);
  const big = (label, value, note) => '<tr><td style="padding:8px 0;border-bottom:1px solid #eee">' + label + (note ? '<br><span style="color:#6b5948;font-size:13px">' + note + '</span>' : '') + '</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;font-weight:800;font-size:20px;color:#4a2f26">' + value + '</td></tr>';
  const people = '<h3 style="color:#4a2f26;margin:18px 0 6px">People</h3><table cellpadding="0" cellspacing="0" style="width:100%;max-width:520px;border-collapse:collapse">' +
    big('People who used BibliCall this week', wau.size, 'Last week: ' + wauPrev.size) +
    big('Came back after their first week', rate == null ? '\u2014' : rate + '%', newPrev.size ? back + ' of the ' + newPrev.size + ' people who first came the week before' : 'Shows once there is a full week of newcomers') +
    big('New people this week', newThis.size) + big('Used it on 2 or more days', twoPlus) + big('Average people per day', perDay) + '</table>' +
    '<p style="color:#6b5948;font-size:13px">Goal to watch: 40% or more coming back after their first week.</p>' + (await costSection(D, days, big)) + '<h3 style="color:#4a2f26;margin:18px 0 6px">Activity</h3>';
  const html = '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#2c2117;font-size:16px"><h2 style="color:#4a2f26">BibliCall: last 7 days</h2><p>' + days[0] + ' to ' + days[6] + '</p>' + people + '<table cellpadding="6" style="border-collapse:collapse">' +
    LABELS.map(([k, l]) => '<tr><td style="border-bottom:1px solid #eee">' + l + '</td><td style="border-bottom:1px solid #eee;text-align:right;font-weight:700">' + (tot[k] || 0) + '</td></tr>').join('') +
    '<tr><td>Daily North Star subscribers (total)</td><td style="text-align:right;font-weight:700">' + subs + '</td></tr></table>' +
    '<p style="color:#6b5948;font-size:13px">Counts only: BibliCall does not record who asked what.</p></div>';
  await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM || 'BibliCall <hello@biblicall.com>', to: [env.NOTIFY_EMAIL], subject: 'BibliCall weekly summary', html }) });
}

export async function unsubscribe(env, url) {
  const e = String(url.searchParams.get('e') || '').toLowerCase().trim(), t = url.searchParams.get('t') || '';
  const D = dir(env); const rec = e ? await call(D, { op: 'map.get', key: 'dn:' + e }) : null;
  const ok = rec && rec.tok === t;
  if (ok) await call(D, { op: 'map.del', key: 'dn:' + e });
  const msg = ok ? 'You’re unsubscribed from the Daily North Star. You won’t get these emails anymore.' : 'This link has already been used, or it isn’t valid. If you still get emails, reply to one with “remove.”';
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BibliCall</title>
    <body style="margin:0;background:#eef6fc;font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#2c2117"><div style="max-width:520px;margin:12vh auto;background:#fff;border-radius:16px;padding:28px 24px;font-size:18px;line-height:1.55">
    <h1 style="margin:0 0 10px;font-size:24px;color:#4a2f26">BibliCall</h1><p>${msg}</p><p><a href="https://biblicall.com" style="color:#664336;font-weight:700">Go to biblicall.com</a></p></div></body>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// Preview: send today's style of Daily North Star to the owner (NOTIFY_EMAIL) only, at most a few times a day.
export async function preview(env) {
  if (!env.NOTIFY_EMAIL || !env.RESEND_API_KEY) return { error: 'not configured' };
  const D = dir(env), key = 'dn_preview:' + today();
  const n = await call(D, { op: 'inc', key });
  if (n > 3) return { error: 'Preview limit reached for today.' };
  const ns = await makeNorthStar(env, []);
  if (!ns) return { error: 'Could not prepare a North Star right now.' };
  const photo = PHOTOS[Math.floor(Math.random() * PHOTOS.length)];
  await sendBatch(env, [{ from: env.EMAIL_FROM || 'BibliCall <hello@biblicall.com>', to: [env.NOTIFY_EMAIL], subject: '[Preview] \u2726 ' + (ns.title || 'Daily North Star'), html: emailHtml(ns, photo, 'https://biblicall.com') }]);
  return { ok: true, ref: ns.verse.label, title: ns.title };
}
