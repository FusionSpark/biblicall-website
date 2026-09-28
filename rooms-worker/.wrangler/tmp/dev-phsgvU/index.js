var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
import { DurableObject } from "cloudflare:workers";
var ORIGINS = ["https://biblicall.com", "https://www.biblicall.com"];
var MAX_KEEP = 120;
var AI_TURNS = 20;
var IDLE_MS = 30 * 864e5;
var src_default = {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response("Biblicall rooms", { headers: { "content-type": "text/plain" } });
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{12,40})$/);
    if (!m) return new Response("Not found", { status: 404 });
    if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const origin = req.headers.get("Origin");
    if (!origin || !ORIGINS.includes(origin)) return new Response("Forbidden", { status: 403 });
    return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
  }
};
var clean = /* @__PURE__ */ __name((v, n) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n), "clean");
var ACK = new Set("ok okay k kk okey alright aight sure yes yeah yep yup ya no nope nah thanks thank thx ty tysm cheers you great good nice cool awesome perfect got it gotcha understood understand makes sense sounds fine will do done noted right true agreed exactly amen hallelujah praise god wow lol haha hmm oh ah i see so much very really much appreciated appreciate that this helps helpful helped love it me too same will try bye goodbye later night morning hi hello hey".split(" "));
function isAck(text) {
  const t = String(text).toLowerCase().replace(/[^a-z\s']/g, " ").replace(/'/g, "").trim();
  if (!t) return true;
  const w = t.split(/\s+/);
  return w.length <= 6 && w.every((x) => ACK.has(x));
}
__name(isAck, "isAck");
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
  }
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(text.slice(a, b + 1));
    } catch (e) {
    }
  }
  return null;
}
__name(parseJson, "parseJson");
function nsPrompt(question, ctx) {
  return "You are the North Star layer of Biblicall, an AI assistant guided by biblical wisdom. Do NOT answer the question itself; another part of the app does that. Several friends may be sharing this conversation.\n\n" + (ctx ? 'Recent conversation, for context:\n"""' + ctx + '"""\n\n' : "") + 'The latest message:\n"""' + question.slice(0, 2e3) + '"""\n\nFIRST decide whether a North Star belongs here. Include one ONLY when someone is: weighing an idea, plan or decision (money, work, family, leadership, technology); asking a moral, ethical or character question; or showing they need direction, encouragement or support (discouraged, anxious, grieving, stuck, overwhelmed). Do NOT include one for plain factual, how-to, technical or trivia questions, casual chat, or short replies that just acknowledge something. When in doubt, skip. If a North Star does not belong, reply with ONLY {"skip": true}.\n\nIf it does belong: in 2 to 4 sentences, teach how biblical wisdom speaks to this exact situation, warm and never preachy. Then choose 1 or 2 King James Version passages that truly fit (a third only for a weighty moment such as grief or a life-changing decision), each a single verse or a range of at most 4 verses, written like "Proverbs 3:5-6" or "1 Corinthians 13:4". Only cite references you are certain exist; each is checked against the KJV and discarded if it does not match. Do not quote the verse text.\n\nThen reply with ONLY this JSON and nothing else:\n{"northStar": "2-4 sentences", "verses": [{"ref": "Book C:V", "why": "one sentence on why it applies"}], "reflect": "one short question for the user to ponder"}';
}
__name(nsPrompt, "nsPrompt");
var Room = class extends DurableObject {
  static {
    __name(this, "Room");
  }
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.busy = false;
  }
  async fetch(req) {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const me = { id: crypto.randomUUID().slice(0, 8), name: "Guest", last: 0 };
    server.serializeAttachment(me);
    server.send(JSON.stringify({ type: "welcome", you: me.id, msgs: await this.messages(), thinking: this.busy }));
    return new Response(null, { status: 101, webSocket: client });
  }
  async messages() {
    const map = await this.ctx.storage.list({ prefix: "m:", reverse: true, limit: MAX_KEEP });
    return [...map.values()].reverse();
  }
  async add(msg) {
    const seq = (await this.ctx.storage.get("seq") || 0) + 1;
    msg.id = seq;
    msg.t = Date.now();
    await this.ctx.storage.put({ seq, ["m:" + String(seq).padStart(9, "0")]: msg });
    if (seq > MAX_KEEP) await this.ctx.storage.delete("m:" + String(seq - MAX_KEEP).padStart(9, "0"));
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
    this.broadcast({ type: "msg", msg });
    return msg;
  }
  async alarm() {
    await this.ctx.storage.deleteAll();
  }
  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== except) {
        try {
          ws.send(s);
        } catch (e) {
        }
      }
    }
  }
  presence(except) {
    const people = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const a = ws.deserializeAttachment();
      if (a) people.push({ id: a.id, name: a.name });
    }
    this.broadcast({ type: "presence", people }, except);
  }
  async webSocketMessage(ws, data) {
    if (typeof data !== "string" || data.length > 3e4) return;
    const d = parseJson(data);
    if (!d || typeof d !== "object") return;
    const me = ws.deserializeAttachment() || {};
    if (d.type === "hello") {
      me.name = clean(d.name, 40) || "Guest";
      ws.serializeAttachment(me);
      this.presence();
      return;
    }
    if (d.type === "seed") {
      if (await this.ctx.storage.get("seq") || !Array.isArray(d.msgs)) return;
      for (const x of d.msgs.slice(-8)) {
        const role = x && x.role === "assistant" ? "assistant" : "user";
        const content = clean(x && x.content, 4e3);
        if (!content) continue;
        const msg = { role, content, from: role === "user" ? me.id : "ai", name: role === "user" ? me.name : "Biblicall" };
        if (role === "assistant" && x.ns && Array.isArray(x.ns.verses)) msg.ns = this.cleanNs(x.ns);
        await this.add(msg);
      }
      return;
    }
    if (d.type === "ask") {
      const content = clean(d.content, 2e3);
      if (!content) return;
      const now = Date.now();
      if (now - (me.last || 0) < 2500) {
        ws.send(JSON.stringify({ type: "error", text: "One moment, please send one message at a time." }));
        return;
      }
      if (this.busy) {
        ws.send(JSON.stringify({ type: "error", text: "Biblicall is still answering. Try again in a moment." }));
        return;
      }
      me.last = now;
      ws.serializeAttachment(me);
      this.busy = true;
      this.broadcast({ type: "thinking", on: true });
      try {
        await this.add({ role: "user", content, from: me.id, name: me.name });
        const all = await this.messages();
        const people = new Set(all.filter((m) => m.role === "user").map((m) => m.name));
        const multi = people.size > 1;
        const recent = all.slice(-AI_TURNS);
        const turns = [];
        for (const m of recent) {
          const text = m.role === "user" && multi ? m.name + ": " + m.content : m.content;
          const last = turns[turns.length - 1];
          if (last && last.role === m.role) last.content += "\n\n" + text;
          else turns.push({ role: m.role, content: text });
        }
        while (turns.length && turns[0].role !== "user") turns.shift();
        const ctx = recent.slice(-6, -1).map((m) => (m.role === "user" ? m.name + ": " : "Biblicall: ") + String(m.content).slice(0, 600)).join("\n");
        const nsP = isAck(content) ? Promise.resolve(null) : this.northStar(content, ctx);
        let answer;
        try {
          answer = await this.ai(turns);
        } catch (e) {
          answer = "Biblicall couldn't answer that just now. Please try again in a moment.";
        }
        const ns = await nsP;
        await this.add({ role: "assistant", content: answer, from: "ai", name: "Biblicall", ns: ns || void 0, offer: !ns && !isAck(content) });
      } finally {
        this.busy = false;
        this.broadcast({ type: "thinking", on: false });
      }
      return;
    }
  }
  cleanNs(ns) {
    const verses = (Array.isArray(ns.verses) ? ns.verses : []).slice(0, 3).map((v) => ({ ref: clean(v && v.ref, 60), why: clean(v && v.why, 400) })).filter((v) => v.ref);
    if (!verses.length || !ns.northStar && !ns.teach) return void 0;
    return { teach: clean(ns.northStar || ns.teach, 1200), verses, reflect: clean(ns.reflect, 300) };
  }
  async ai(messages) {
    const r = await this.env.AI.fetch("https://biblicall-ai/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": "https://biblicall.com" },
      body: JSON.stringify({ messages })
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || "ai");
    return clean(j.answer, 12e3);
  }
  async northStar(question, ctx) {
    try {
      const out = parseJson(await this.ai([{ role: "user", content: nsPrompt(question, ctx) }]));
      if (!out || out.skip) return null;
      return this.cleanNs(out) || null;
    } catch (e) {
      return null;
    }
  }
  async webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 ? 1e3 : code, "bye");
    } catch (e) {
    }
    this.presence(ws);
  }
  async webSocketError(ws) {
    this.presence(ws);
  }
};

// ../../.npm/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../.npm/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// wrangler-config:config:middleware/patch-console-prefix
var prefix = "[biblicall-rooms]";

// ../../.npm/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/middleware-patch-console-prefix.ts
["log", "debug", "info"].forEach((method) => {
  globalThis.console[method] = new Proxy(globalThis.console[method], {
    apply(target, thisArg, argumentsList) {
      return target.apply(thisArg, [prefix, ...argumentsList]);
    }
  });
});
var passthrough = /* @__PURE__ */ __name((request, env, _ctx, middlewareCtx) => {
  return middlewareCtx.next(request, env);
}, "passthrough");
var middleware_patch_console_prefix_default = passthrough;

// .wrangler/tmp/bundle-2TUoIW/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default,
  middleware_patch_console_prefix_default
];
var middleware_insertion_facade_default = src_default;

// ../../.npm/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-2TUoIW/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  Room,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
