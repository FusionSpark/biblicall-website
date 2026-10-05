// BibliCall "My week": reminders, weekly goals and gentle check-ins, delivered as phone notifications (Web Push).
// Nothing is sent unless the person asked for it. Stored per device (a random id the page keeps), never tied to a name.
//   Planner (one instance):  dev:<did> = { sub, tz, checkin, sunday, goals, lastCheckin, lastSunday }
//                            rem:<did>:<rid> = { rid, at, text, conv }      q:<at>:<did>:<rid> = 1 (due-time index)
//                            vapid = { pub, jwk }  (made automatically the first time)
import { newVapid, sendPush } from './webpush.js';

const MAX_REMINDERS = 60, MAX_GOALS = 12;
const PUSH_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(push\.apple\.com|fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.api\.chrome\.google\.com)(\/|$)/i;
const DID = /^[A-Za-z0-9_-]{16,40}$/;
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n);
const pad = (n) => String(n).padStart(13, '0');

export class Planner {
  constructor(state) { this.s = state.storage; }
  async fetch(req) {
    const d = await req.json(), s = this.s;
    switch (d.op) {
      case 'vapid': { let v = await s.get('vapid'); if (!v) { v = await newVapid(); await s.put('vapid', v); } return Response.json(d.full ? v : { pub: v.pub }); }
      case 'dev.get': return Response.json((await s.get('dev:' + d.did)) || null);
      case 'dev.put': { const cur = (await s.get('dev:' + d.did)) || { created: Date.now() }; Object.assign(cur, d.patch); await s.put('dev:' + d.did, cur); return Response.json(cur); }
      case 'dev.del': await s.delete('dev:' + d.did); return Response.json({ ok: true });
      case 'rem.add': {
        const list = await s.list({ prefix: 'rem:' + d.did + ':' });
        if (list.size >= MAX_REMINDERS) return Response.json({ error: 'You have a lot of reminders already. Remove a few first.' });
        await s.put('rem:' + d.did + ':' + d.rem.rid, d.rem); await s.put('q:' + pad(d.rem.at) + ':' + d.did + ':' + d.rem.rid, 1);
        return Response.json({ ok: true });
      }
      case 'rem.del': {
        const r = await s.get('rem:' + d.did + ':' + d.rid);
        if (r) { await s.delete('rem:' + d.did + ':' + d.rid); await s.delete('q:' + pad(r.at) + ':' + d.did + ':' + d.rid); }
        return Response.json({ ok: true });
      }
      case 'rem.list': { const m = await s.list({ prefix: 'rem:' + d.did + ':' }); return Response.json([...m.values()].sort((a, b) => a.at - b.at)); }
      case 'due': { const m = await s.list({ prefix: 'q:', end: 'q:' + pad(d.now + 1), limit: 500 }); return Response.json([...m.keys()]); }
      case 'take': { // remove a due entry, return its reminder
        const [, , did, rid] = d.key.split(':'); await s.delete(d.key);
        const r = await s.get('rem:' + did + ':' + rid); if (r) await s.delete('rem:' + did + ':' + rid);
        return Response.json({ did, rem: r || null });
      }
      case 'devs': { const m = await s.list({ prefix: 'dev:', start: d.start, limit: 1000 }); return Response.json([...m.entries()].map(([k, v]) => [k.slice(4), v])); }
    }
    return Response.json({ error: 'unknown op' }, { status: 400 });
  }
}

const P = (env) => env.PLANNER.get(env.PLANNER.idFromName('main'));
async function call(env, body) { const r = await P(env).fetch('https://planner/', { method: 'POST', body: JSON.stringify(body) }); return r.json(); }

function validSub(sub) {
  return sub && typeof sub.endpoint === 'string' && PUSH_HOSTS.test(sub.endpoint) && sub.endpoint.length < 1000 &&
    sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string' && sub.keys.p256dh.length < 200 && sub.keys.auth.length < 60;
}
function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; } }
function cleanGoals(g) { return (Array.isArray(g) ? g : []).slice(0, MAX_GOALS).map((x) => ({ t: clean(x && x.t, 140), done: !!(x && x.done) })).filter((x) => x.t); }

async function push(env, did, dev, note) {
  if (!dev || !dev.sub) return { ok: false };
  const vapid = await call(env, { op: 'vapid', full: true });
  try {
    const r = await sendPush(dev.sub, note, vapid);
    if (r.gone) await call(env, { op: 'dev.put', did, patch: { sub: null } });
    return r;
  } catch (e) { console.error('push', e && e.message); return { ok: false }; }
}

// Requests from the page: { mode: 'plan', op, did, ... }
export async function planOp(env, body) {
  if (!env.PLANNER) return { error: 'Reminders are not set up yet.' };
  const op = String(body.op || ''), did = String(body.did || '');
  if (op === 'key') return await call(env, { op: 'vapid' });
  if (!DID.test(did)) return { error: 'bad device' };
  if (op === 'sync') {
    const patch = {};
    if ('sub' in body) { if (body.sub && !validSub(body.sub)) return { error: 'That notification service isn’t supported.' }; patch.sub = body.sub || null; }
    if (body.tz && validTz(body.tz)) patch.tz = String(body.tz);
    if ('checkin' in body) patch.checkin = /^([01]\d|2[0-3]):[0-5]\d$/.test(body.checkin) ? body.checkin : '';
    if ('sunday' in body) patch.sunday = !!body.sunday;
    if ('goals' in body) patch.goals = cleanGoals(body.goals);
    const dev = await call(env, { op: 'dev.put', did, patch });
    return { ok: true, push: !!dev.sub };
  }
  if (op === 'off') { await call(env, { op: 'dev.put', did, patch: { sub: null } }); return { ok: true }; }
  if (op === 'rem.add') {
    const at = Math.round(+body.at), text = clean(body.text, 160);
    if (!text || !(at > Date.now() - 60000) || at > Date.now() + 400 * 86400000) return { error: 'Please choose a time in the future.' };
    const rid = clean(body.rid, 24).replace(/[^A-Za-z0-9_-]/g, '') || crypto.randomUUID().slice(0, 12);
    return await call(env, { op: 'rem.add', did, rem: { rid, at, text, conv: clean(body.conv, 40).replace(/[^A-Za-z0-9_-]/g, ''), kind: body.kind === 'follow' ? 'follow' : 'task' } });
  }
  if (op === 'rem.del') return await call(env, { op: 'rem.del', did, rid: clean(body.rid, 24) });
  if (op === 'rem.list') return { reminders: await call(env, { op: 'rem.list', did }) };
  if (op === 'test') {
    const dev = await call(env, { op: 'dev.get', did });
    const r = await push(env, did, dev, { title: 'BibliCall', body: 'Reminders are on. I’ll only tap you on the shoulder when you’ve asked me to.', url: '/' });
    return r.ok ? { ok: true } : { error: 'The test didn’t go through. Try turning reminders off and on again.' };
  }
  return { error: 'unknown' };
}

function localParts(tz, now) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Chicago', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  const hh = p.hour === '24' ? '00' : p.hour;
  return { date: p.year + '-' + p.month + '-' + p.day, mins: +hh * 60 + +p.minute, wd: p.weekday };
}

// Every 15 minutes: send reminders that are due, the morning check-in, and the Sunday-evening planning nudge.
export async function runPlanner(env) {
  if (!env.PLANNER) return { skipped: true };
  const now = Date.now(); let sent = 0;
  const due = await call(env, { op: 'due', now });
  const devCache = {};
  for (const key of due) {
    const { did, rem } = await call(env, { op: 'take', key });
    if (!rem) continue;
    const dev = devCache[did] || (devCache[did] = await call(env, { op: 'dev.get', did }));
    const late = now - rem.at > 6 * 3600000; // skip reminders more than 6 hours old (the phone was off for the night, say)
    if (!late && (await push(env, did, dev, { title: rem.kind === 'follow' ? 'BibliCall is thinking of you' : 'BibliCall reminder', body: rem.text, url: rem.conv ? '/?open=' + rem.conv : '/?plan=1', tag: 'r-' + rem.rid })).ok) sent++;
  }
  let start; let checkins = 0;
  for (let page = 0; page < 20; page++) {
    const devs = await call(env, { op: 'devs', start });
    if (!devs.length) break;
    for (const [did, dev] of devs) {
      if (!dev.sub) continue;
      const t = localParts(dev.tz, now);
      const goals = dev.goals || [], open = goals.filter((g) => !g.done);
      if (dev.checkin && dev.lastCheckin !== t.date) {
        const [h, m] = dev.checkin.split(':').map(Number), at = h * 60 + m;
        if (t.mins >= at && t.mins < at + 20) {
          const body = goals.length
            ? (open.length ? 'This week: ' + (goals.length - open.length) + ' of ' + goals.length + ' goals done. Next up: ' + open[0].t + '.' : 'Every goal for this week is done. Well done, faithful one.')
            : 'A new day. What matters most today? Tap to plan it with BibliCall.';
          await push(env, did, dev, { title: 'Good morning', body, url: '/?plan=1', tag: 'checkin' });
          await call(env, { op: 'dev.put', did, patch: { lastCheckin: t.date } }); checkins++;
        }
      }
      if (dev.sunday && t.wd === 'Sun' && dev.lastSunday !== t.date && t.mins >= 18 * 60 && t.mins < 18 * 60 + 20) {
        await push(env, did, dev, { title: 'Plan the week ahead', body: 'Take five quiet minutes with BibliCall to set your goals for work, family and faith.', url: '/?plan=week', tag: 'sunday' });
        await call(env, { op: 'dev.put', did, patch: { lastSunday: t.date } }); checkins++;
      }
    }
    if (devs.length < 1000) break; start = 'dev:' + devs[devs.length - 1][0] + '\u0000';
  }
  return { due: due.length, sent, checkins };
}

// GET /ics?t=<title>&s=<start, epoch ms>&m=<minutes>: one calendar event the phone offers to add (nothing is stored).
export function icsFile(url) {
  const t = clean(url.searchParams.get('t'), 160) || 'BibliCall reminder', s = +url.searchParams.get('s'), m = Math.min(480, Math.max(5, +url.searchParams.get('m') || 30));
  if (!(s > 0)) return new Response('Bad request', { status: 400 });
  const f = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (x) => x.replace(/\\/g, '\\\\').replace(/[,;]/g, (c) => '\\' + c);
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BibliCall//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    'UID:' + crypto.randomUUID() + '@biblicall.com', 'DTSTAMP:' + f(Date.now()), 'DTSTART:' + f(s), 'DTEND:' + f(s + m * 60000),
    'SUMMARY:' + esc(t), 'DESCRIPTION:' + esc('From BibliCall. https://biblicall.com'), 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + esc(t), 'TRIGGER:-PT10M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  return new Response(body, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="biblicall-reminder.ics"', 'Cache-Control': 'no-store' } });
}
