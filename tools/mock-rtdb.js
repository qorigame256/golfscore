// 確認用の Firebase Realtime Database のまね（手元で共有を試すためのもの。公開しない）。
// 使い方: node tools/mock-rtdb.js [ポート（既定 8772）]
// 本物と同じ形で答える: GET / PUT / PATCH（"a/b" のような場所を並べた一括更新も） / DELETE <場所>.json、
// Accept: text/event-stream の GET には put・patch・keep-alive を流し続ける（EventSource）。
// 本物と違うところ: 規則（firebase-rules.json）は見ない。
// 本物と同じく、鍵が番号だけで、0〜最大の番号の半分より多くが埋まっている入れ物は配列として返す（空いた番号は null）。
// 電波が切れたときの確認用に、/__off で「つながらない」状態（全部 503・流しも切る）、/__on で元に戻す。
const http = require("http");

const port = Number(process.argv[2]) || 8772;
let root = null;
let offline = false;
const streams = new Set();

const segs = (p) => p.split("/").filter(Boolean);
function getAt(s) {
  let o = root;
  for (const k of s) {
    if (o === null || typeof o !== "object") return null;
    o = o[k];
    if (o === undefined) return null;
  }
  return o;
}
// null と空の入れ物を取り除く（本物と同じく、値の無い場所は存在しない）
function clean(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    const c = clean(x);
    if (c !== null) out[k] = c;
  }
  return Object.keys(out).length ? out : null;
}
function setAt(s, v) {
  if (!s.length) { root = clean(v); return; }
  if (root === null || typeof root !== "object") root = {};
  let o = root;
  for (let i = 0; i < s.length - 1; i++) {
    if (o[s[i]] === null || typeof o[s[i]] !== "object") o[s[i]] = {};
    o = o[s[i]];
  }
  o[s[s.length - 1]] = clean(v);
  root = clean(root);
}
const within = (a, b) => a.length >= b.length && b.every((k, i) => a[i] === k); // a が b の中（同じも含む）
// 返すときの形（上の「配列として返す」）
function render(v) {
  if (v === null || typeof v !== "object") return v;
  const keys = Object.keys(v);
  const out = {};
  for (const k of keys) out[k] = render(v[k]);
  if (keys.length && keys.every((k) => /^(0|[1-9][0-9]*)$/.test(k))) {
    const max = Math.max(...keys.map(Number));
    if (keys.length * 2 > max + 1) return Array.from({ length: max + 1 }, (_, i) => (String(i) in out ? out[i] : null));
  }
  return out;
}

// 書き込みを、聞いている人へ流す
function notify(at, kind, payload) {
  for (const st of streams) {
    if (within(at, st.path)) {
      const rel = "/" + at.slice(st.path.length).join("/");
      const data = kind === "patch" ? Object.fromEntries(Object.entries(payload).map(([k, x]) => [k, render(x)])) : render(payload);
      send(st.res, kind, { path: rel, data });
    } else if (within(st.path, at)) {
      send(st.res, "put", { path: "/", data: render(getAt(st.path)) });
    }
  }
}
function send(res, event, obj) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);
}

function body(req) {
  return new Promise((ok) => {
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", () => ok(b));
  });
}

http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/__off") { offline = true; for (const st of streams) st.res.destroy(); streams.clear(); res.end("off"); return; }
  if (url.pathname === "/__on") { offline = false; res.end("on"); return; }
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (offline) { res.writeHead(503); res.end(); return; }
  if (!url.pathname.endsWith(".json")) { res.writeHead(404); res.end(); return; }
  const at = segs(decodeURIComponent(url.pathname.slice(0, -5)));
  const silent = url.searchParams.get("print") === "silent";
  const reply = (v) => {
    if (silent) { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(v));
  };
  try {
    if (req.method === "GET" && (req.headers.accept || "").includes("text/event-stream")) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const st = { res, path: at };
      streams.add(st);
      send(res, "put", { path: "/", data: render(getAt(at)) });
      const ka = setInterval(() => res.write("event: keep-alive\ndata: null\n\n"), 25000);
      req.on("close", () => { clearInterval(ka); streams.delete(st); });
      return;
    }
    if (req.method === "GET") { reply(render(getAt(at))); return; }
    if (req.method === "PUT") {
      const v = JSON.parse(await body(req));
      setAt(at, v);
      notify(at, "put", getAt(at));
      reply(v);
      return;
    }
    if (req.method === "PATCH") {
      const v = JSON.parse(await body(req));
      for (const [k, x] of Object.entries(v)) setAt([...at, ...segs(k)], x);
      notify(at, "patch", v);
      reply(v);
      return;
    }
    if (req.method === "DELETE") {
      setAt(at, null);
      notify(at, "put", null);
      reply(null);
      return;
    }
    res.writeHead(405);
    res.end();
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
}).listen(port, "127.0.0.1", () => console.log(`mock-rtdb: http://127.0.0.1:${port}`));
