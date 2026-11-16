"use strict";
// 同伴者のスマホと共有する（仕様書 D13〜D15）。app.js より先に読み込み、ここでは関数を用意するだけ（呼ぶのは app.js）。
// 共有したラウンドだけを Firebase Realtime Database（Google の無料のデータ置き場）の /s/<鍵> に置く。
// SDK は使わず、書き込みは fetch（REST の PATCH）、受け取りは EventSource（置き場所の変化が流れてくる）で行う。
// 鍵はリンクに入れる推測できない22文字で、知っている人だけが読み書きできる。置き場所の規則は firebase-rules.json。
// 置き場所の中身：{ v: 1, course, date, nines: [..], holes: [{ no, par }], p: { h: ホスト, m0〜: 同伴者 { name, s: { ホールの番号: 打数 } } } }

const DB_URL = ""; // 本人が Firebase で作った置き場所の住所（https://〜.firebasedatabase.app）。空のあいだは共有を出さない
const DB_LOCAL = ["127.0.0.1", "localhost"].includes(location.hostname);
// 確認用サーバーでは手元のまね（tools/mock-rtdb.js、ポート 8772）を使う。?realdb を付けて開くと本物を使う
const DB = DB_LOCAL && !new URLSearchParams(location.search).has("realdb") ? "http://127.0.0.1:8772" : DB_URL;
const SHARE_KEEP_DAYS = 7; // 終えたラウンドの共有を置いておく日数
const KEY_RE = /^[A-Za-z0-9_-]{22}$/;
const JOIN_STORE = "golfscore.join"; // 同伴者のスマホ側の控え（どの名前で入っているか・送れていない変更・最後に受け取った中身）

const syncs = new Map(); // 鍵 → やり取りの状態

const routeParts = () => (location.hash || "#/").replace(/^#\/?/, "").split("/").filter(Boolean);
const newShareKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const joinLink = (key) => `${new URL(".", location.href).href}#/join/${key}`;
const typing = () => { const el = document.activeElement; return !!el && $view.contains(el) && el.matches("input, textarea"); };

// 入れ子の中身を「場所 → 値」の平らな形にする（差分を取りやすくするため）。null は「無い」
function flatten(v, pre = "", out = {}) {
  if (v === null || v === undefined) return out;
  if (typeof v !== "object") { out[pre] = v; return out; }
  for (const [k, x] of Object.entries(v)) flatten(x, pre ? `${pre}/${k}` : k, out);
  return out;
}
// 受け取った変化を手元の写しに当てる（path は "/p/m0/s/3" のような形）
function putPath(tree, path, val) {
  const s = path.split("/").filter(Boolean);
  if (!s.length) return val ?? null;
  const top = tree && typeof tree === "object" ? tree : {};
  let o = top;
  for (let i = 0; i < s.length - 1; i++) {
    if (!o[s[i]] || typeof o[s[i]] !== "object") o[s[i]] = {};
    o = o[s[i]];
  }
  if (val === null || val === undefined) delete o[s[s.length - 1]];
  else o[s[s.length - 1]] = val;
  return top;
}

// 同伴者に番号（m0, m1…）を振る。置き場所ではこの番号で同伴者を見分ける（外したり足したりしても変わらない）
function ensureMateIds(r) {
  const seen = new Set();
  const all = new Set(r.mates.map((m) => m.id));
  for (const m of r.mates) {
    if (typeof m.id === "string" && /^m\d{1,2}$/.test(m.id) && !seen.has(m.id)) { seen.add(m.id); continue; }
    let n = 0;
    while (seen.has(`m${n}`) || all.has(`m${n}`)) n++;
    m.id = `m${n}`;
    seen.add(m.id);
    all.add(m.id);
  }
}

// ホストのラウンドから、置き場所に置く中身を作る。規則（firebase-rules.json）に合わない値は入れない
// （1か所でも合わないと、その書き込み全体が断られるため）
function shareView(r) {
  const sc = (arr) => {
    const o = {};
    arr.forEach((v, i) => { if (Number.isInteger(v) && v >= 1 && v <= 20) o[i] = v; });
    return o;
  };
  const p = { h: { name: (data.settings.myName || "").trim().slice(0, 12) || "ホスト", s: sc(r.holes.map((h) => h.s)) } };
  for (const m of r.mates) p[m.id] = { name: (m.name || "").trim().slice(0, 12) || "同伴者", s: sc(m.s) };
  return {
    v: 1,
    course: rawCourseName(r).slice(0, 40) || null,
    date: r.date,
    nines: r.nines.slice(0, 2).map((n, i) => String(n || (i ? "後半" : "前半")).slice(0, 12)),
    holes: r.holes.map((h) => ({ no: h.no, par: h.par })),
    p,
  };
}

/* ---------- やり取りの土台（ホスト・同伴者で共通） ---------- */

// mirror＝置き場所の今の中身（受け取ったもの）、pending＝まだ届いていない手元の変更（場所 → 値。null は消す）
function makeSync(key, pending, onRemote) {
  const sy = { key, pending, onRemote, mirror: undefined, fm: {}, loaded: false, ok: false, es: null, timer: null, retry: null, busy: false, saveState: () => {} };
  syncs.set(key, sy);
  return sy;
}

function listen(sy) {
  if (sy.es) sy.es.close();
  clearTimeout(sy.retry);
  const es = new EventSource(`${DB}/s/${sy.key}.json`);
  sy.es = es;
  const handle = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (!msg || typeof msg.path !== "string") return;
    const before = sy.fm;
    if (ev.type === "put") sy.mirror = putPath(sy.mirror, msg.path, msg.data);
    else for (const [k, v] of Object.entries(msg.data || {})) sy.mirror = putPath(sy.mirror, `${msg.path}/${k}`, v);
    sy.fm = flatten(sy.mirror);
    const first = !sy.loaded;
    sy.loaded = true;
    const keys = [...new Set([...Object.keys(before), ...Object.keys(sy.fm)])].filter((k) => before[k] !== sy.fm[k]);
    setLive(sy, true);
    sy.onRemote(sy, keys, first);
  };
  es.addEventListener("put", handle);
  es.addEventListener("patch", handle);
  es.addEventListener("open", () => setLive(sy, true));
  es.addEventListener("cancel", () => setLive(sy, false));
  es.onerror = () => {
    setLive(sy, false);
    // 通常は EventSource が自分でつなぎ直す。閉じてしまったとき（断られた・住所違い）だけ、少し待ってこちらからつなぎ直す
    if (es.readyState === EventSource.CLOSED) sy.retry = setTimeout(() => { if (syncs.get(sy.key) === sy) listen(sy); }, 15000);
  };
}

function closeSync(sy) {
  if (sy.es) sy.es.close();
  clearTimeout(sy.timer);
  clearTimeout(sy.retry);
  syncs.delete(sy.key);
}

// つながっているかの印（緑の点・板の文字）を書き換える
function setLive(sy, ok) {
  sy.ok = ok;
  document.querySelectorAll("[data-live]").forEach((el) => { if (el.dataset.live === sy.key) el.classList.toggle("off", !ok); });
  const st = document.getElementById("sh-state");
  if (st && st.dataset.key === sy.key) st.textContent = ok ? "つながっています" : "電波を待っています";
}

function schedulePush(sy, delay = 250) {
  clearTimeout(sy.timer);
  sy.timer = setTimeout(() => pushNow(sy), delay);
}

// 送れていない変更をまとめて1回で送る（"p/m0/s/3": 5 のような場所の一括更新）。届かなければ手元に残し、あとで送り直す
async function pushNow(sy) {
  if (sy.busy) { schedulePush(sy, 500); return; }
  const body = { ...sy.pending };
  if (!Object.keys(body).length) return;
  sy.busy = true;
  let again = 250;
  try {
    const res = await fetch(`${DB}/s/${sy.key}.json?print=silent`, { method: "PATCH", body: JSON.stringify(body) });
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      // 断られた（規則に合わない・共有が終わった）。送り直しても通らないので捨てる
      console.error("共有の置き場所に断られました", res.status, body);
      for (const k of Object.keys(body)) if (sy.pending[k] === body[k]) delete sy.pending[k];
    } else if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    } else {
      for (const k of Object.keys(body)) if (sy.pending[k] === body[k]) delete sy.pending[k];
      setLive(sy, true);
    }
    sy.saveState();
  } catch (e) {
    setLive(sy, false);
    again = 8000;
  } finally {
    sy.busy = false;
  }
  if (Object.keys(sy.pending).length) schedulePush(sy, again);
}

// iPhone では裏に回ると受け取りが止まることがあるので、前に出たとき・電波が戻ったときにつなぎ直して送り直す
function shareReconnect() {
  for (const sy of syncs.values()) {
    listen(sy);
    if (Object.keys(sy.pending).length) schedulePush(sy, 0);
  }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") shareReconnect(); });
window.addEventListener("online", shareReconnect);

/* ---------- ホスト（このアプリの持ち主）側 ---------- */

// 共有中のラウンドのやり取りを始める（もう始まっていればそれを返す）
function hostSync(r) {
  if (!DB || !r.share) return null;
  let sy = syncs.get(r.share.key);
  if (sy) return sy;
  if (!r.share.pending || typeof r.share.pending !== "object") r.share.pending = {};
  sy = makeSync(r.share.key, r.share.pending, (s, keys, first) => hostRemote(r.id, s, keys, first));
  sy.rid = r.id;
  sy.saveState = () => save();
  sy.lastLocal = flatten(shareView(r));
  listen(sy);
  if (Object.keys(sy.pending).length) schedulePush(sy, 0);
  return sy;
}

// 手元で記録を変えたとき（touch から呼ぶ）：前回からの差分を「送れていない変更」に足して送る
function hostTouch(r) {
  const sy = hostSync(r);
  if (!sy) return;
  const now = flatten(shareView(r));
  for (const k of new Set([...Object.keys(sy.lastLocal), ...Object.keys(now)])) {
    if (sy.lastLocal[k] !== now[k]) sy.pending[k] = now[k] ?? null;
  }
  sy.lastLocal = now;
  if (Object.keys(sy.pending).length) schedulePush(sy);
}

// 置き場所が変わったとき：同伴者の名前と打数は置き場所の値を手元へ（まだ送れていない手元の変更がある場所は除く）。
// それ以外（ゴルフ場名・日付・パー・ホスト自身の名前と打数）は手元が正なので、食い違っていたら手元の値で上書きする
function hostRemote(rid, sy, keys, first) {
  const r = roundById(rid);
  if (!r || !r.share || r.share.key !== sy.key) { closeSync(sy); return; }
  if (sy.mirror === null || sy.mirror === undefined) {
    // 置き場所から消えている（Firebase の画面で消した など）。共有を続けているので作り直す
    sy.pending = r.share.pending = flatten(shareView(r));
    save();
    schedulePush(sy, 0);
    return;
  }
  const local = flatten(shareView(r));
  if (first) keys = [...new Set([...Object.keys(local), ...Object.keys(sy.fm)])];
  const mate = (id) => r.mates.find((m) => m.id === id);
  let changed = false;
  for (const k of keys) {
    const mm = /^p\/(m\d{1,2})\/name$/.exec(k);
    if (!mm || k in sy.pending) continue;
    const v = typeof sy.fm[k] === "string" ? sy.fm[k].trim().slice(0, 12) : "";
    if (!v) continue; // 名前が消えた（ホストが外した）ときは手元をいじらない
    const m = mate(mm[1]);
    if (!m) {
      if (r.mates.length >= MAX_MATES) continue;
      r.mates.push({ id: mm[1], name: v, s: r.holes.map(() => null) }); // 同伴者のスマホから新しい名前で入った人
      changed = true;
    } else if (m.name !== v) {
      m.name = v;
      changed = true;
    }
  }
  for (const k of keys) {
    const mm = /^p\/(m\d{1,2})\/s\/(\d{1,2})$/.exec(k);
    if (!mm || k in sy.pending) continue;
    const m = mate(mm[1]);
    const i = Number(mm[2]);
    if (!m || i >= r.holes.length || !(`p/${mm[1]}/name` in sy.fm)) continue; // 同伴者ごと置き場所に無いときは手元を消さない
    const v = sy.fm[k];
    const nv = Number.isInteger(v) && v >= 1 && v <= 20 ? v : null;
    if (m.s[i] !== nv) {
      m.s[i] = nv;
      changed = true;
    }
  }
  const now = flatten(shareView(r));
  const reassert = (k) => { if (!(k in sy.pending) && sy.fm[k] !== now[k]) sy.pending[k] = now[k] ?? null; };
  for (const k of keys) {
    const mm = /^p\/(m\d{1,2})\//.exec(k);
    if (!mm) reassert(k);
    else if (mate(mm[1]) && !(`p/${mm[1]}/name` in sy.fm)) reassert(k); // 手元にいる同伴者が置き場所に無ければ置き直す
  }
  sy.lastLocal = now;
  if (changed) {
    r.updatedAt = Date.now();
    liveRefresh(r);
  }
  if (changed || Object.keys(sy.pending).length) save();
  if (Object.keys(sy.pending).length) schedulePush(sy);
}

// 共有を始める：置き場所に今の中身を置いてから、リンクを出す。届かなければ始めない
async function startShare(r) {
  ensureMateIds(r);
  const key = newShareKey();
  const res = await fetch(`${DB}/s/${key}.json?print=silent`, { method: "PUT", body: JSON.stringify(shareView(r)) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  r.share = { key, pending: {} };
  r.updatedAt = Date.now();
  save();
  hostSync(r);
}

// 共有をやめる：置き場所から消す。電波が無くて消せなければ控えておき、次に開いたときに消す
function stopShare(r) {
  if (!r.share) return;
  const key = r.share.key;
  const sy = syncs.get(key);
  if (sy) closeSync(sy);
  r.share = null;
  r.updatedAt = Date.now();
  save();
  dropRemote(key);
}
function dropRemote(key) {
  if (!DB || !KEY_RE.test(key)) return;
  // 消せたと分かるまでは控えに残す（消している途中でアプリを閉じても、次に開いたときに消し直せるように）
  const st = data.settings;
  if (!Array.isArray(st.shareTrash)) st.shareTrash = [];
  if (!st.shareTrash.includes(key)) { st.shareTrash.push(key); save(); }
  fetch(`${DB}/s/${key}.json?print=silent`, { method: "DELETE" })
    .then((res) => {
      const refused = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
      if (!res.ok && !refused) throw new Error(`HTTP ${res.status}`);
      if (refused) console.error("共有の置き場所に断られました", res.status, key); // 消し直しても通らないので控えから外す
      data.settings.shareTrash = (data.settings.shareTrash || []).filter((k) => k !== key);
      save();
    })
    .catch(() => {});
}

// 開いたとき：終えてから（最後に直してから）7日たった共有を消す。前に消せなかったものも消し直す
function shareCleanup() {
  if (!DB) return;
  const before = [...(data.settings.shareTrash || [])]; // 下で消す分は控えに足されるので、その前の分だけを消し直す
  const limit = Date.now() - SHARE_KEEP_DAYS * 864e5;
  for (const r of data.rounds) if (r.share && r.done && r.updatedAt < limit) stopShare(r);
  for (const k of before) dropRemote(k);
}

// 受け取りを続けるのは、終えていない共有ラウンドと、いま見ている共有ラウンドだけ（画面が変わるたびに呼ぶ）
function syncWatch() {
  if (!DB) return;
  const [a, b] = routeParts();
  const viewing = (a === "play" || a === "round") ? b : null;
  const want = new Set(data.rounds.filter((r) => r.share && (!r.done || r.id === viewing)).map((r) => r.share.key));
  for (const sy of [...syncs.values()]) {
    if (sy.rid ? !want.has(sy.key) : !(a === "join" && b === sy.key)) closeSync(sy);
  }
  for (const r of data.rounds) if (r.share && want.has(r.share.key)) hostSync(r);
}

// 同伴者の打数が届いたら、そのラウンドの画面を描き直す。文字を打っている間は待ち、欄を離れてから描き直す
let refreshQueued = false;
function liveRefresh(r) {
  const [a, b, c] = routeParts();
  if (b !== r.id || !((a === "play" && c !== undefined) || (a === "round" && c === undefined))) return;
  if (typing()) {
    if (!refreshQueued) {
      refreshQueued = true;
      $view.addEventListener("focusout", () => setTimeout(() => { refreshQueued = false; liveRefresh(r); }, 0), { once: true });
    }
    return;
  }
  if (a === "round" && $view.querySelector(".rhead-hello")) justFinished = r.id; // 「おつかれさまでした」を消さない
  keepScroll(() => (a === "play" ? renderPlay(r.id, Number(c)) : renderRound(r.id)));
}

// 「同伴者のスマホで入力」の板。まだ共有していなければ名前を聞いて始め、共有中なら QR コードとリンクを出す
function openShareSheet(r, after) {
  const draw = () => {
    if (!r.share) {
      $sheet.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="同伴者のスマホで入力">
<div class="grip"></div>
<h3 class="sheet-title">同伴者のスマホで入力</h3>
<label class="flabel" for="sh-me">あなたの名前</label>
<input class="input" id="sh-me" maxlength="12" autocomplete="off" enterkeyhint="done" value="${esc(data.settings.myName || "")}">
<div class="err" id="sh-err" hidden></div>
<div class="sheet-btns"><button class="btn" id="sh-cancel">やめる</button><button class="btn primary" id="sh-ok">共有する</button></div>
</div>`;
      const $me = $sheet.querySelector("#sh-me");
      const $ok = $sheet.querySelector("#sh-ok");
      const err = (msg) => { const e = $sheet.querySelector("#sh-err"); e.textContent = msg; e.hidden = false; };
      const ok = async () => {
        const name = $me.value.trim();
        if (!name) { err("名前を入れてください"); return; }
        $sheet.querySelector("#sh-err").hidden = true;
        data.settings.myName = name;
        save();
        $ok.disabled = true;
        $ok.textContent = "つないでいます…";
        try {
          await startShare(r);
          draw();
          after();
        } catch (e) {
          console.error(e);
          $ok.disabled = false;
          $ok.textContent = "共有する";
          err("つながりませんでした。電波のある所でもう一度押してください");
        }
      };
      $sheet.querySelector("#sh-cancel").onclick = closeSheet;
      $ok.onclick = ok;
      $me.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); ok(); } });
    } else {
      const link = joinLink(r.share.key);
      const sy = hostSync(r);
      $sheet.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="同伴者のスマホで入力">
<div class="grip"></div>
<h3 class="sheet-title">同伴者のスマホで入力</h3>
<div class="qr-box">${QR.svg(link)}</div>
<p class="share-state" id="sh-state" data-key="${r.share.key}">${sy && sy.ok ? "つながっています" : "電波を待っています"}</p>
<div class="sheet-btns"><button class="btn" id="sh-close">閉じる</button><button class="btn primary" id="sh-send">${ICON.share}リンクを送る</button></div>
<button class="btn danger small" id="sh-stop">共有をやめる</button>
</div>`;
      $sheet.querySelector("#sh-close").onclick = closeSheet;
      $sheet.querySelector("#sh-send").onclick = async () => {
        try {
          if (navigator.share) {
            await navigator.share({ title: "ゴルフ記録", text: `${nameless(r) ? fmtDate(r.date) : courseName(r)}　スコアはここから入れてください`, url: link });
          } else {
            await navigator.clipboard.writeText(link);
            toast("リンクをコピーしました");
          }
        } catch (e) {
          if (e.name !== "AbortError") toast("リンクを送れませんでした");
        }
      };
      $sheet.querySelector("#sh-stop").onclick = () => {
        if (!confirm("共有をやめますか？\n同伴者のスマホでは入力できなくなります（入っている打数はこのスマホに残ります）。")) return;
        stopShare(r);
        closeSheet();
        after();
      };
    }
  };
  draw();
  $sheet.hidden = false;
  $sheet.onclick = (e) => { if (e.target === $sheet) closeSheet(); };
  const $me = $sheet.querySelector("#sh-me");
  if ($me && !$me.value) $me.focus();
}

/* ---------- 同伴者のスマホ側（リンク #/join/<鍵> で開く画面） ---------- */

function joinStore() {
  try { return JSON.parse(localStorage.getItem(JOIN_STORE)) || {}; } catch (e) { return {}; }
}
function joinSave(key, st) {
  const all = joinStore();
  all[key] = { ...st, at: Date.now() };
  // 古い控えは5つまで残す
  const keys = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
  for (const k of keys.slice(5)) delete all[k];
  try { localStorage.setItem(JOIN_STORE, JSON.stringify(all)); } catch (e) { console.error(e); }
}

function mateSync(key) {
  let sy = syncs.get(key);
  if (sy) return sy;
  const st = joinStore()[key] || {};
  sy = makeSync(key, st.pending && typeof st.pending === "object" ? st.pending : {}, (s) => {
    s.saveState();
    const [a, b, c] = routeParts();
    if (a === "join" && b === s.key && !typing()) keepScroll(() => renderJoin(s.key, c));
  });
  sy.pid = typeof st.pid === "string" ? st.pid : null;
  // 電波が無くても前に受け取った中身で出せるように、控えから始める
  sy.mirror = st.cache && typeof st.cache === "object" ? st.cache : undefined;
  sy.fm = flatten(sy.mirror);
  sy.saveState = () => joinSave(key, { pid: sy.pid, pending: sy.pending, cache: sy.mirror });
  listen(sy);
  if (Object.keys(sy.pending).length) schedulePush(sy, 0);
  return sy;
}

// 受け取った中身に、まだ送れていない自分の変更を重ねて、画面に出す形にする
function joinModel(sy) {
  const f = { ...sy.fm };
  for (const [k, v] of Object.entries(sy.pending)) { if (v === null) delete f[k]; else f[k] = v; }
  const holes = [];
  for (let i = 0; i < 18; i++) {
    const par = f[`holes/${i}/par`];
    if (!Number.isInteger(par)) break;
    const no = f[`holes/${i}/no`];
    holes.push({ no: Number.isInteger(no) ? no : i + 1, par });
  }
  const ids = [...new Set(Object.keys(f).map((k) => (/^p\/(h|m\d{1,2})\/name$/.exec(k) || [])[1]).filter(Boolean))]
    .sort((a, b) => (a === "h" ? -1 : b === "h" ? 1 : Number(a.slice(1)) - Number(b.slice(1))));
  const players = ids.map((id) => ({
    id,
    name: String(f[`p/${id}/name`]).slice(0, 12),
    s: holes.map((_, i) => { const v = f[`p/${id}/s/${i}`]; return Number.isInteger(v) && v >= 1 && v <= 20 ? v : null; }),
  }));
  return {
    course: typeof f.course === "string" ? f.course : "",
    date: typeof f.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.date) ? f.date : "",
    nines: [f["nines/0"], f["nines/1"]].map((n) => (typeof n === "string" ? n : "")),
    holes,
    players,
  };
}

const joinTotal = (p, holes) => {
  let s = 0, par = 0, n = 0;
  p.s.forEach((v, i) => { if (v != null) { s += v; par += holes[i].par; n++; } });
  return { s, diff: s - par, n };
};

function joinMessage(title, msg) {
  $view.innerHTML = `${bar(title)}<div class="empty">${EMPTY_ART}${msg}</div>`;
}

// 同伴者の画面：sub が無ければホールの入力（自分の未入力の最初のホール）、数字ならそのホール、card はスコアカード、who は名前を選ぶ
function renderJoin(key, sub, bump = false) {
  if (!KEY_RE.test(key || "")) return joinMessage("スコア入力", "リンクが正しくありません");
  if (!DB) return joinMessage("スコア入力", "準備中です");
  const sy = mateSync(key);
  if (sy.mirror === undefined) return joinMessage("スコア入力", "読み込んでいます…");
  const md = joinModel(sy);
  if (sy.mirror === null || !md.holes.length) return joinMessage("スコア入力", "このラウンドの共有は終わりました");
  const me = md.players.find((p) => p.id === sy.pid && p.id !== "h");
  if (!me || sub === "who") return joinWho(key, sy, md);
  if (sub === "card") return joinCard(key, md, me);
  let i = Number(sub);
  if (sub === undefined || !(i >= 0 && i < md.holes.length)) {
    const k = me.s.findIndex((v) => v == null);
    i = k === -1 ? md.holes.length - 1 : k;
    // 選んだホールを住所に書いておく（書かないと、打数が届いて描き直すたびに次の未入力のホールへ飛んでしまう）
    history.replaceState(null, "", `#/join/${key}/${i}`);
  }
  joinHole(key, sy, md, me, i, bump);
}

// 名前を選ぶ（一覧に無ければ新しい名前で入る）
function joinWho(key, sy, md) {
  const mates = md.players.filter((p) => p.id !== "h");
  const canAdd = mates.length < MAX_MATES;
  const back = mates.some((p) => p.id === sy.pid) ? `#/join/${key}` : "";
  let html = bar(md.course || "スコア入力", { back });
  html += `<div class="join-intro">${md.date ? `${esc(fmtDate(md.date))}<br>` : ""}どなたですか？</div>`;
  if (mates.length) {
    html += `<div class="field"><div class="opts">${mates.map((p) => `<button class="opt${p.id === sy.pid ? " on" : ""}" data-pid="${p.id}"><span class="ring"></span><span><span class="t">${esc(p.name)}</span></span></button>`).join("")}</div></div>`;
  }
  if (canAdd) {
    html += `<div class="field"><label class="flabel" for="j-name">${mates.length ? "ほかの名前で入る" : "あなたの名前"}</label>
<div class="mate"><input class="input" id="j-name" maxlength="12" autocomplete="off" enterkeyhint="done"><button class="btn primary j-add" data-act="add">入る</button></div>
<div class="err" id="j-err" hidden></div></div>`;
  }
  $view.innerHTML = html;
  on("[data-pid]", "click", (el) => {
    sy.pid = el.dataset.pid;
    sy.saveState();
    go(`#/join/${key}`);
  });
  const add = () => {
    const $n = document.getElementById("j-name");
    const name = $n.value.trim();
    if (!name) return showErr("j-err", "名前を入れてください");
    const used = new Set(md.players.map((p) => p.id));
    let n = 0;
    while (used.has(`m${n}`)) n++;
    sy.pid = `m${n}`;
    sy.pending[`p/m${n}/name`] = name.slice(0, 12);
    sy.saveState();
    schedulePush(sy, 0);
    go(`#/join/${key}`);
  };
  on("[data-act=add]", "click", add);
  on("#j-name", "keydown", (el, e) => { if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); add(); } });
}

// ホールの入力（ホストのホール画面と同じ形。自分の打数だけを入れ、みんなのスコアを下に出す）
function joinHole(key, sy, md, me, i, bump) {
  const h = md.holes[i];
  const v = me.s[i];
  const shown = v ?? h.par;
  const last = i === md.holes.length - 1;
  const nine = md.nines[i < 9 ? 0 : 1] || "";
  const t = joinTotal(me, md.holes);
  const dots = md.holes.map((x, k) => `<button class="dot${k === 9 ? " gap" : ""}${me.s[k] != null ? ` ${cat(me.s[k], x.par)}` : ""}${k === i ? " cur" : ""}" data-act="dot" data-k="${k}" aria-label="${x.no}番ホール"></button>`).join("");
  const rows = md.players.map((p) => {
    const s = p.s[i];
    const pt = joinTotal(p, md.holes);
    return `<div class="row ply${p.id === me.id ? " me" : ""}"><span class="lbl">${esc(p.name)}</span><span class="ply-s">${s != null ? `<span class="mark ${cat(s, h.par)}">${s}</span>` : `<span class="dash">—</span>`}</span><span class="ply-t">${pt.n ? `${pt.s}<small>${signed(pt.diff)}</small>` : ""}</span></div>`;
  }).join("");

  $view.innerHTML = `<div class="play join">
<header class="play-head">
  <div class="play-top">
    <a class="bar-btn who" href="#/join/${key}/who" aria-label="名前を選び直す"><span>${esc(me.name)}</span></a>
    <div class="play-course"><i class="live${sy.ok ? "" : " off"}" data-live="${key}"></i>${esc(md.course || (md.date ? fmtDate(md.date) : ""))}</div>
    <a class="bar-btn" href="#/join/${key}/card" aria-label="スコアカード">${ICON.card}</a>
  </div>
  <div class="play-hole">
    <div class="no">${h.no}<small>番</small>${nine ? `<span class="nine">${esc(nine)}</span>` : ""}</div>
    <div class="hole-info"><span>パー<b>${h.par}</b></span></div>
  </div>
</header>
<div class="dots">${dots}</div>
<section class="stroke">
  <button class="pm minus" data-act="minus" aria-label="1打減らす">−</button>
  <button class="val${v == null ? " unset" : ""}${bump ? " bump" : ""}" data-act="confirm" aria-label="打数 ${shown}">${shown}</button>
  <button class="pm plus" data-act="plus" aria-label="1打増やす">＋</button>
</section>
<div class="sname">${v == null ? `<span class="k-unset">未入力</span>` : `<span class="k-${cat(v, h.par)}">${scoreName(v, h.par)}</span>`}</div>
<h2 class="rows-h">みんなのスコア</h2>
<section class="rows">${rows}</section>
<footer class="play-foot">
  <div class="total"><span>${t.n}ホール</span><span>合計 <b>${t.s}</b>${t.n ? `（${signed(t.diff)}）` : ""}</span><span></span></div>
  <div class="nav2">
    ${i > 0 ? `<button class="btn prev" data-act="prev">${ICON.back}前へ</button>` : ""}
    <button class="btn primary" data-act="next">${last ? "スコアカードへ" : `次のホール${ICON.next}`}</button>
  </div>
</footer>
</div>`;

  // 打数は触ったときだけ入る（「次のホール」では記録しない。途中から入ったときに、通り過ぎたホールをパーにしないため）
  const setScore = (nv) => {
    sy.pending[`p/${me.id}/s/${i}`] = nv;
    sy.saveState();
    schedulePush(sy, 0);
    renderJoin(key, String(i), true);
  };
  on("[data-act]", "click", (el) => {
    switch (el.dataset.act) {
      case "minus": setScore(Math.max(1, shown - 1)); break;
      case "plus": setScore(Math.min(20, shown + 1)); break;
      case "confirm": if (v == null) setScore(h.par); break;
      case "dot": go(`#/join/${key}/${el.dataset.k}`); break;
      case "prev": go(`#/join/${key}/${i - 1}`); break;
      case "next": go(last ? `#/join/${key}/card` : `#/join/${key}/${i + 1}`); break;
    }
  });
}

// みんなのスコアカード（紙のスコアカードと同じ表）
function joinCard(key, md, me) {
  const halves = md.holes.length > 9 ? [0, 1] : [0];
  let html = bar("スコアカード", { back: `#/join/${key}` });
  html += `<div class="join-intro">${esc(md.course || "")}${md.course && md.date ? "　" : ""}${md.date ? esc(fmtDate(md.date)) : ""}</div>`;
  html += halves.map((hf) => {
    const from = hf * 9;
    const hs = md.holes.slice(from, from + 9);
    const rows = md.players.map((p) => {
      const ss = p.s.slice(from, from + 9);
      const got = ss.filter((x) => x != null);
      return `<tr class="r-me${p.id === me.id ? " mine" : ""}"><td>${esc(p.name)}</td>${ss.map((s, k) => `<td>${s != null ? `<span class="mark ${cat(s, hs[k].par)}">${s}</span>` : `<span class="dash">·</span>`}</td>`).join("")}<td class="tot">${got.length ? sum(got) : ""}</td></tr>`;
    }).join("");
    return `<div class="card sc-card"><table class="sc">
<thead><tr><th>${esc(md.nines[hf] || "")}</th>${hs.map((h) => `<th>${h.no}</th>`).join("")}<th class="tot">計</th></tr></thead>
<tbody><tr class="r-par"><td>パー</td>${hs.map((h) => `<td>${h.par}</td>`).join("")}<td class="tot">${sum(hs.map((h) => h.par))}</td></tr>${rows}</tbody></table></div>`;
  }).join("");
  html += `<div class="card"><h2 class="card-h">合計</h2>${md.players.map((p) => {
    const t = joinTotal(p, md.holes);
    return `<div class="kv"><span class="k">${esc(p.name)}</span><span class="v">${t.n ? `${t.s}<small>${signed(t.diff)}・${t.n}ホール</small>` : "—"}</span></div>`;
  }).join("")}</div>`;
  $view.innerHTML = html;
}
