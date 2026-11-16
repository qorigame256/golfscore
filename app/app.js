"use strict";
// ゴルフ記録：画面の切り替え・記録の保存・集計・グラフ・バックアップ。
// 記録は端末の localStorage（キー golfscore.v1）だけに置き、どこにも送らない（仕様書 D3）。
// データの形は仕様書「3. データ形式」。

const KEY = "golfscore.v1";
const MAX_MATES = 3;
const PARS = [3, 4, 5, 6];

const $view = document.getElementById("view");
const $tabbar = document.getElementById("tabbar");
const $sheet = document.getElementById("sheet");
const $toast = document.getElementById("toast");

/* ================= 保存 ================= */

function blank() {
  return { v: 1, courses: [], rounds: [], settings: { lastExport: null, statsRange: "10" } };
}

function load() {
  let raw = null;
  try {
    raw = localStorage.getItem(KEY);
    if (!raw) return blank();
    const d = JSON.parse(raw);
    return {
      v: 1,
      courses: Array.isArray(d.courses) ? d.courses : [],
      rounds: Array.isArray(d.rounds) ? d.rounds : [],
      settings: Object.assign(blank().settings, d.settings || {}),
    };
  } catch (e) {
    // 読めない形で残っていたら、空で上書きして失わないよう別の名前へ退避してから始める
    console.error(e);
    try { if (raw) localStorage.setItem(`${KEY}.broken-${Date.now()}`, raw); } catch (_) { /* 退避できなくても続ける */ }
    return blank();
  }
}

let data = load();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch (e) {
    console.error(e);
    toast("保存できませんでした");
  }
}

const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const courseById = (id) => data.courses.find((c) => c.id === id);
const roundById = (id) => data.rounds.find((r) => r.id === id);
// ゴルフ場の名前は登録の今の名前を出す。登録を消したゴルフ場は、ラウンドに控えた名前を出す
const courseName = (r) => (courseById(r.courseId) || {}).name || r.courseName || "ゴルフ場";
const touch = (r) => { r.updatedAt = Date.now(); save(); };

/* ================= 小さな道具 ================= */

const pad2 = (n) => String(n).padStart(2, "0");
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function ymd(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return { y, m, d };
}
const wday = (s) => { const { y, m, d } = ymd(s); return "日月火水木金土"[new Date(y, m - 1, d).getDay()]; };
const fmtDate = (s) => { const { y, m, d } = ymd(s); return `${y}年${m}月${d}日（${wday(s)}）`; };
const fmtMD = (s) => { const { m, d } = ymd(s); return `${m}/${d}`; };
const fmtYMD = (s) => { const { y, m, d } = ymd(s); return `${y}/${m}/${d}`; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);
const fix1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
const pct = (n) => `${Math.round(n * 100)}%`;
// 正負の記号つき。マイナスは横棒の長い「−」を使う
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "±0");
function signedF(n, digits) {
  const v = Number(n.toFixed(digits));
  return v > 0 ? `+${v.toFixed(digits)}` : v < 0 ? `−${(-v).toFixed(digits)}` : `±${(0).toFixed(digits)}`;
}

function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $toast.classList.remove("show"), 2600);
}

// いま出ている画面の中の要素にまとめて出来事を結び付ける
function on(sel, ev, fn) {
  $view.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, (e) => fn(el, e)));
}

function showErr(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.hidden = false;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
}

// 描き直してもスクロールの位置を変えない
function keepScroll(fn) {
  const y = window.scrollY;
  fn();
  window.scrollTo(0, y);
}

/* ================= スコアの呼び名と色 ================= */

const CATS = [
  { key: "eagle", label: "イーグル以上", color: "#e0a82e" },
  { key: "birdie", label: "バーディー", color: "#4da3e0" },
  { key: "par", label: "パー", color: "#2f9e5b" },
  { key: "bogey", label: "ボギー", color: "#f6b26b" },
  { key: "double", label: "ダブルボギー", color: "#ee7b5c" },
  { key: "triple", label: "トリプル以上", color: "#c9483f" },
];

function cat(s, par) {
  const d = s - par;
  if (d <= -2) return "eagle";
  if (d === -1) return "birdie";
  if (d === 0) return "par";
  if (d === 1) return "bogey";
  if (d === 2) return "double";
  return "triple";
}

function scoreName(s, par) {
  if (s === 1) return "ホールインワン";
  const d = s - par;
  if (d <= -4) return "コンドル";
  if (d === -3) return "アルバトロス";
  if (d === -2) return "イーグル";
  if (d === -1) return "バーディー";
  if (d === 0) return "パー";
  if (d === 1) return "ボギー";
  if (d === 2) return "ダブルボギー";
  if (d === 3) return "トリプルボギー";
  if (s === par * 2) return "ダブルパー";
  return signed(d);
}

/* ================= 絵（アイコン・天気・風景） ================= */

const icon = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  back: icon('<path d="M15 5l-7 7 7 7"/>'),
  next: icon('<path d="M9 5l7 7-7 7"/>'),
  pencil: icon('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  card: icon('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M9 9.5v10M14.5 9.5v10"/>'),
  plus: icon('<path d="M12 5v14M5 12h14"/>'),
  x: icon('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  trash: icon('<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>'),
  share: icon('<path d="M12 15V3.5M7.5 8L12 3.5 16.5 8"/><path d="M5 12v7.5h14V12"/>'),
  open: icon('<path d="M12 3.5V15M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19.5h14"/>'),
  flag: icon('<path d="M7 21V3.5"/><path d="M7 4h10.5l-2.5 3.75L17.5 11.5H7"/>'),
};

const cloud = (tf, fill) => `<path transform="${tf}" d="M9.5 24.5h14a5 5 0 0 0 .8-9.94 7 7 0 0 0-13.4-1.6A5.75 5.75 0 0 0 9.5 24.5z" fill="${fill}"/>`;
const WX = {
  sun: { label: "晴れ", svg: `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3.5v3M16 25.5v3M3.5 16h3M25.5 16h3M7.2 7.2l2.1 2.1M22.7 22.7l2.1 2.1M7.2 24.8l2.1-2.1M22.7 9.3l2.1-2.1" stroke="#f5b52e" stroke-width="2.4" stroke-linecap="round"/><circle cx="16" cy="16" r="6.5" fill="#f7be3a"/></svg>` },
  cloud: { label: "くもり", svg: `<svg viewBox="0 0 32 32" aria-hidden="true">${cloud("translate(7 -6) scale(.72)", "#d3dee6")}${cloud("translate(0 1)", "#aebfcc")}</svg>` },
  rain: { label: "雨", svg: `<svg viewBox="0 0 32 32" aria-hidden="true">${cloud("translate(0 -4)", "#a3b7c6")}<path d="M11 24.5l-1.6 3.6M16.5 24.5l-1.6 3.6M22 24.5l-1.6 3.6" stroke="#4da3e0" stroke-width="2.3" stroke-linecap="round"/></svg>` },
  snow: { label: "雪", svg: `<svg viewBox="0 0 32 32" aria-hidden="true">${cloud("translate(0 -4)", "#b7c8d4")}<g fill="#7fc1ea"><circle cx="10.5" cy="25.5" r="1.7"/><circle cx="16" cy="28" r="1.7"/><circle cx="21.5" cy="25.5" r="1.7"/></g></svg>` },
};
const WX_KEYS = ["sun", "cloud", "rain", "snow"];

// ホームの上の風景（空・丘・旗）
const SCENE = `<svg class="scene" viewBox="0 0 375 230" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
<defs><linearGradient id="g-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a98da"/><stop offset=".62" stop-color="#8fcdf2"/><stop offset="1" stop-color="#d6effb"/></linearGradient></defs>
<rect width="375" height="230" fill="url(#g-sky)"/>
<circle cx="318" cy="66" r="42" fill="#fff8dc" opacity=".22"/>
<circle cx="318" cy="66" r="22" fill="#fff4c4"/>
<g fill="#fff" opacity=".9"><ellipse cx="148" cy="133" rx="30" ry="7.5"/><ellipse cx="164" cy="127" rx="15" ry="8.5"/><ellipse cx="232" cy="106" rx="22" ry="5"/><ellipse cx="241" cy="102" rx="10" ry="5.5"/></g>
<path d="M0 158C58 136 122 140 188 152S312 136 375 146V230H0Z" fill="#a9ddb7"/>
<path d="M0 178C78 158 152 162 232 174S338 166 375 172V230H0Z" fill="#6cc28a"/>
<ellipse cx="258" cy="171" rx="36" ry="7.5" fill="#93dbab"/>
<ellipse cx="266" cy="171.5" rx="3.2" ry="1.4" fill="#1f6e40"/>
<path d="M266 171V131" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>
<path d="M266 131.5L290 138.5L266 145.5Z" fill="#ff8a5b"/>
<path d="M0 198C92 182 204 188 375 194V230H0Z" fill="#3fac6b"/>
<path d="M0 214C124 204 262 208 375 211V230H0Z" fill="#2f9e5b"/>
</svg>`;

const EMPTY_ART = `<svg viewBox="0 0 120 90" aria-hidden="true"><ellipse cx="60" cy="76" rx="52" ry="10" fill="#dcf1e3"/><ellipse cx="62" cy="76" rx="30" ry="6" fill="#a8ddb8"/><ellipse cx="68" cy="76" rx="3" ry="1.3" fill="#1f6e40"/><path d="M68 76V22" stroke="#7d8c83" stroke-width="2" stroke-linecap="round"/><path d="M68 22.5L94 30L68 37.5Z" fill="#ff8a5b"/><circle cx="40" cy="72.5" r="3.6" fill="#fff" stroke="#c5cfc9"/></svg>`;

function weatherRow(sel) {
  return `<div class="wx-row">${WX_KEYS.map((k) => `<button class="wx-btn${sel === k ? " on" : ""}" data-act="wx" data-v="${k}" aria-pressed="${sel === k}">${WX[k].svg}${WX[k].label}</button>`).join("")}</div>`;
}

// これまでに入れた同伴者の名前を、入力欄の候補に出す
function mateList() {
  const names = [...new Set(data.rounds.flatMap((r) => (r.mates || []).map((m) => m.name)).filter(Boolean))];
  return `<datalist id="mate-names">${names.map((n) => `<option value="${esc(n)}">`).join("")}</datalist>`;
}

/* ================= ゴルフ場とラウンドの計算 ================= */

// ゴルフ場のコースが2つなら1〜18番、1つや3つ以上（27ホールなど）なら各コース1〜9番
const holeNo = (course, ni, k) => (course.nines.length === 2 ? ni * 9 + k + 1 : k + 1);
const newNine = (name) => ({ name, holes: Array.from({ length: 9 }, () => ({ par: 4, yd: null })) });
const newCourse = (name) => ({ id: uid("c"), name, nines: [newNine("OUT"), newNine("IN")], updatedAt: Date.now() });

function courseParText(c) {
  if (c.nines.length === 2) return `パー${sum(c.nines.flatMap((n) => n.holes.map((h) => h.par)))}`;
  return `${c.nines.length * 9}ホール`;
}

function nineSumText(n) {
  const yd = sum(n.holes.map((h) => h.yd || 0));
  return `パー${sum(n.holes.map((h) => h.par))}${yd ? `・${yd.toLocaleString()}Y` : ""}`;
}

// 最近回った順（回ったことのないゴルフ場は、登録を直した新しい順で後ろ）
function coursesByRecent() {
  const last = {};
  for (const r of data.rounds) if (r.courseId && (!last[r.courseId] || r.date > last[r.courseId])) last[r.courseId] = r.date;
  return data.courses.slice().sort((a, b) => (last[b.id] || "").localeCompare(last[a.id] || "") || (b.updatedAt || 0) - (a.updatedAt || 0));
}

function makeRound(course, nineIdx, { date, weather, mates }) {
  const holes = [];
  for (const ni of nineIdx) {
    course.nines[ni].holes.forEach((h, k) => {
      holes.push({ no: holeNo(course, ni, k), par: h.par, yd: h.yd ?? null, s: null, p: null, t: null, pen: 0, src: [ni, k] });
    });
  }
  const now = Date.now();
  return {
    id: uid("r"), date, courseId: course.id, courseName: course.name,
    nines: nineIdx.map((ni) => course.nines[ni].name),
    holes, weather: weather || null, memo: "",
    mates: mates.map((name) => ({ name, s: holes.map(() => null) })),
    done: false, createdAt: now, updatedAt: now,
  };
}

// from〜to のホールの合計（打数を入れたホールだけ数える）
function totals(r, from = 0, to = r.holes.length) {
  let s = 0, par = 0, n = 0, putts = 0, pn = 0, pen = 0;
  for (const h of r.holes.slice(from, to)) {
    if (h.s == null) continue;
    s += h.s; par += h.par; n++; pen += h.pen || 0;
    if (h.p != null) { putts += h.p; pn++; }
  }
  return { s, par, diff: s - par, n, putts, pn, pen, full: n === to - from };
}

// 平均・ベスト・推移に使うのは、18ホールすべて打数の入ったラウンドだけ
const is18 = (r) => r.holes.length === 18 && r.holes.every((h) => h.s != null);
const byDateAsc = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt);
const byDateDesc = (a, b) => byDateAsc(b, a);
function bestOf(rounds) {
  let best = null;
  for (const r of rounds) if (!best || totals(r).s < totals(best).s) best = r;
  return best;
}

// ホールごとの成績（パット・パーオン・フェアウェイ・OB・スコアの内訳・パー別）
function holeStats(rounds) {
  const hs = rounds.flatMap((r) => r.holes.filter((h) => h.s != null));
  const withP = hs.filter((h) => h.p != null);
  const tee = hs.filter((h) => h.par >= 4 && h.t);
  const dist = Object.fromEntries(CATS.map((c) => [c.key, 0]));
  for (const h of hs) dist[cat(h.s, h.par)]++;
  const byPar = {};
  for (const p of [3, 4, 5]) {
    const x = hs.filter((h) => h.par === p);
    byPar[p] = { n: x.length, avg: mean(x.map((h) => h.s)) };
  }
  return {
    n: hs.length,
    putts: sum(withP.map((h) => h.p)), puttN: withP.length,
    // パーオン＝パーより2打少ない打数までにグリーンに乗せた（打数−パット数 ≦ パー−2）
    gir: withP.filter((h) => h.s - h.p <= h.par - 2).length,
    fw: tee.filter((h) => h.t === "F").length,
    left: tee.filter((h) => h.t === "L").length,
    right: tee.filter((h) => h.t === "R").length,
    teeN: tee.length,
    pen: sum(hs.map((h) => h.pen || 0)),
    dist, byPar,
  };
}

/* ================= 画面の切り替え ================= */

let leaveGuard = null; // 保存していない変更がある画面で「戻る」を止める確認
let justFinished = null; // 終えたばかりのラウンド（スコアカードに「おつかれさまでした」を出す）
let draft = null; // 「ラウンドを始める」の入力中の中身
let redit = null; // 「ラウンドの情報」の入力中の中身
let cedit = null; // ゴルフ場の編集中の中身

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function route() {
  const [a, b, c] = (location.hash || "#/").replace(/^#\/?/, "").split("/").filter(Boolean);
  leaveGuard = null;
  closeSheet();
  if (a !== "new") draft = null;
  if (!(a === "round" && c === "edit")) redit = null;
  if (a !== "course") cedit = null;
  let tab = null;
  switch (a) {
    case undefined: tab = "home"; renderHome(); break;
    case "stats": tab = "stats"; renderStats(); break;
    case "courses": tab = "courses"; renderCourses(); break;
    case "course": renderCourseEdit(b); break;
    case "settings": tab = "settings"; renderSettings(); break;
    case "new": renderNew(); break;
    case "play": renderPlay(b, Number(c)); break;
    case "round": if (c === "edit") renderRoundEdit(b); else renderRound(b); break;
    default: tab = "home"; renderHome();
  }
  document.body.classList.toggle("no-tabs", !tab);
  $tabbar.querySelectorAll("a").forEach((el) => el.classList.toggle("on", el.dataset.tab === tab));
  window.scrollTo(0, 0);
}

function bar(title, { back = "", right = "" } = {}) {
  return `<header class="bar"><div class="side">${back ? `<button class="bar-btn" data-back="${back}">${ICON.back}<span>戻る</span></button>` : ""}</div><h1>${esc(title)}</h1><div class="side right">${right}</div></header>`;
}

$view.addEventListener("click", (e) => {
  const b = e.target.closest("[data-back]");
  if (!b) return;
  if (leaveGuard && !leaveGuard()) return;
  go(b.dataset.back);
});

/* ================= ホーム ================= */

function renderHome() {
  const done = data.rounds.filter((r) => r.done).sort(byDateDesc);
  const playing = data.rounds.filter((r) => !r.done).sort((a, b) => b.updatedAt - a.updatedAt);
  const full = done.filter(is18);
  const best = bestOf(full);
  const recent = full.slice().sort(byDateAsc).slice(-5);
  const avg = mean(recent.map((r) => totals(r).s));

  let html = `<section class="hero">${SCENE}<div class="hero-text"><h1>ゴルフ記録</h1><p>${fmtDate(today())}</p></div></section>
<section class="summary">
  <div><div class="lbl">ベスト</div><div class="val">${best ? totals(best).s : "—"}</div><div class="sub">${best ? fmtYMD(best.date) : "18ホール"}</div></div>
  <div><div class="lbl">平均</div><div class="val">${avg != null ? fix1(avg) : "—"}</div><div class="sub">直近${recent.length || 5}回</div></div>
  <div><div class="lbl">ラウンド</div><div class="val">${done.length}</div><div class="sub">回</div></div>
</section>`;
  // iPhone の Safari のタブで開いているときだけ出す（ホーム画面から開いたアプリでは出ない）
  if (navigator.standalone === false) html += `<div class="note">ホーム画面に追加して使うと、記録が消えにくくなります</div>`;
  html += playing.map(playingCard).join("");
  html += `<div class="home-start"><a class="btn primary big" href="#/new">${ICON.flag}ラウンドを始める</a></div>`;

  if (done.length) {
    let year = null, rows = "";
    for (const r of done) {
      const y = ymd(r.date).y;
      if (y !== year) {
        if (year !== null) html += `<div class="rounds">${rows}</div>`;
        html += `<h2 class="list-h">${y}年</h2>`;
        rows = "";
        year = y;
      }
      rows += roundRow(r, best && r.id === best.id);
    }
    html += `<div class="rounds">${rows}</div>`;
  } else if (!playing.length) {
    html += `<div class="empty">${EMPTY_ART}最初のラウンドを記録しましょう</div>`;
  }
  $view.innerHTML = html;
}

function playingCard(r) {
  const t = totals(r);
  const k = r.holes.findIndex((h) => h.s == null);
  const at = k === -1 ? r.holes.length - 1 : k;
  return `<a class="card playing" href="#/play/${r.id}/${at}">
<div class="playing-top"><span class="badge sky">ラウンド中</span><span class="muted">${fmtMD(r.date)}</span></div>
<div class="playing-name">${esc(courseName(r))}</div>
<div class="progress"><i style="width:${(t.n / r.holes.length) * 100}%"></i></div>
<div class="playing-foot"><span>${t.n}/${r.holes.length}ホール　合計 <b>${t.s}</b>${t.n ? `（${signed(t.diff)}）` : ""}</span><span class="go">続きから${ICON.next}</span></div>
</a>`;
}

function roundRow(r, isBest) {
  const t = totals(r);
  const { m, d } = ymd(r.date);
  const tags = [];
  if (isBest) tags.push(`<span class="badge gold">ベスト</span>`);
  if (r.holes.length === 9) tags.push(`<span class="badge">ハーフ</span>`);
  if (!t.full) tags.push(`<span class="badge gray">途中まで</span>`);
  return `<a class="round-row" href="#/round/${r.id}">
<div class="date"><div class="m">${m}月</div><div class="d">${d}</div></div>
<div class="wx">${r.weather && WX[r.weather] ? WX[r.weather].svg : ""}</div>
<div class="info"><div class="name">${esc(courseName(r))}</div><div class="meta">${esc(r.nines.join("・"))} ${tags.join(" ")}</div></div>
<div class="score"><b>${t.n ? t.s : "—"}</b><span>${t.n ? signed(t.diff) : ""}</span></div>
</a>`;
}

/* ================= ラウンドを始める ================= */

function renderNew() {
  const courses = coursesByRecent();
  if (!draft) draft = { date: today(), courseId: courses.length ? courses[0].id : "new", newName: "", first: 0, second: 1, weather: null, mates: [] };
  const f = draft;
  const c = f.courseId === "new" ? null : courseById(f.courseId);
  if (f.courseId !== "new" && !c) f.courseId = "new";
  const nines = c ? c.nines.map((n) => n.name) : ["OUT", "IN"];
  if (f.first >= nines.length) f.first = 0;
  if (f.second !== "none" && f.second >= nines.length) f.second = nines.length > 1 ? 1 : "none";

  // 最近回った5つを並べ、それより前のゴルフ場は選ぶ欄にまとめる
  const shown = courses.length > 6 ? courses.slice(0, 5) : courses;
  const rest = courses.length > 6 ? courses.slice(5).sort((a, b) => a.name.localeCompare(b.name, "ja")) : [];
  const opt = (x) => `<button class="opt${f.courseId === x.id ? " on" : ""}" data-act="pick" data-id="${x.id}"><span class="ring"></span><span><span class="t">${esc(x.name)}</span><span class="s">${esc(x.nines.map((n) => n.name).join("・"))}　${courseParText(x)}</span></span></button>`;
  const restSel = rest.length
    ? `<select class="input" id="f-rest"><option value="">ほかのゴルフ場から選ぶ</option>${rest.map((x) => `<option value="${x.id}"${f.courseId === x.id ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select>`
    : "";
  const nineOpts = (sel) => nines.map((n, k) => `<option value="${k}"${k === sel ? " selected" : ""}>${esc(n)}</option>`).join("");

  let html = bar("ラウンドを始める", { back: "#/" });
  html += `<div class="field"><label for="f-date">日付</label><input class="input" id="f-date" type="date" value="${esc(f.date)}"></div>
<div class="field"><span class="flabel">ゴルフ場</span><div class="opts">${shown.map(opt).join("")}${restSel}
<button class="opt${f.courseId === "new" ? " on" : ""}" data-act="pick" data-id="new"><span class="ring"></span><span><span class="t">新しいゴルフ場</span></span></button></div>
${f.courseId === "new" ? `<input class="input" id="f-name" style="margin-top:8px" value="${esc(f.newName)}" placeholder="ゴルフ場の名前" maxlength="40" autocomplete="off">` : ""}
<div class="err" id="f-err" hidden></div></div>
<div class="field pair"><div><label class="flabel" for="f-first">前半</label><select class="input" id="f-first">${nineOpts(f.first)}</select></div>
<div><label class="flabel" for="f-second">後半</label><select class="input" id="f-second">${nineOpts(f.second)}<option value="none"${f.second === "none" ? " selected" : ""}>なし（9ホール）</option></select></div></div>
<div class="field"><span class="flabel">天気</span>${weatherRow(f.weather)}</div>
<div class="field"><span class="flabel">同伴者（任意）</span>
${f.mates.map((m, x) => `<div class="mate"><input class="input" data-mate="${x}" value="${esc(m)}" placeholder="名前" maxlength="12" list="mate-names" autocomplete="off"><button class="x-btn" data-act="rmmate" data-x="${x}" aria-label="外す">${ICON.x}</button></div>`).join("")}
${f.mates.length < MAX_MATES ? `<button class="add-btn" data-act="addmate">${ICON.plus}同伴者を足す</button>` : ""}${mateList()}</div>
<div class="sticky-foot"><button class="btn primary big" data-act="start">${ICON.flag}スタート</button></div>`;
  $view.innerHTML = html;

  const again = () => keepScroll(renderNew);
  on("#f-date", "change", (el) => { f.date = el.value; });
  on("#f-name", "input", (el) => { f.newName = el.value; });
  on("#f-first", "change", (el) => { f.first = Number(el.value); });
  on("#f-second", "change", (el) => { f.second = el.value === "none" ? "none" : Number(el.value); });
  on("#f-rest", "change", (el) => { if (el.value) { f.courseId = el.value; f.first = 0; f.second = 1; again(); } });
  on("[data-mate]", "input", (el) => { f.mates[el.dataset.mate] = el.value; });
  on("[data-act]", "click", (el) => {
    switch (el.dataset.act) {
      case "pick":
        f.courseId = el.dataset.id; f.first = 0; f.second = 1; again();
        if (f.courseId === "new") document.getElementById("f-name").focus();
        break;
      case "wx": f.weather = f.weather === el.dataset.v ? null : el.dataset.v; again(); break;
      case "addmate": f.mates.push(""); again(); $view.querySelector(`[data-mate="${f.mates.length - 1}"]`).focus(); break;
      case "rmmate": f.mates.splice(Number(el.dataset.x), 1); again(); break;
      case "start": startRound(); break;
    }
  });
}

function startRound() {
  const f = draft;
  let course;
  if (f.courseId === "new") {
    const name = f.newName.trim();
    if (!name) return showErr("f-err", "ゴルフ場の名前を入れてください");
    // 同じ名前で登録済みなら、そのゴルフ場（覚えているパー）を使う
    course = data.courses.find((x) => x.name === name);
    if (!course) {
      course = newCourse(name);
      data.courses.push(course);
    }
  } else {
    course = courseById(f.courseId);
  }
  const idx = [Math.min(f.first, course.nines.length - 1)];
  if (f.second !== "none") idx.push(Math.min(f.second, course.nines.length - 1));
  const mates = f.mates.map((m) => m.trim()).filter(Boolean).slice(0, MAX_MATES);
  const r = makeRound(course, idx, { date: f.date || today(), weather: f.weather, mates });
  data.rounds.push(r);
  save();
  draft = null;
  go(`#/play/${r.id}/0`);
}

/* ================= ホールの入力 ================= */

function renderPlay(id, i, bump = false) {
  const r = roundById(id);
  if (!r) return go("#/");
  if (!(i >= 0 && i < r.holes.length)) i = 0;
  const h = r.holes[i];
  const shown = h.s ?? h.par; // まだ入れていないホールは、パーの数を薄く出しておく
  const unset = h.s == null;
  const last = i === r.holes.length - 1;
  const t = totals(r);
  const nine = r.nines[i < 9 ? 0 : 1] || "";
  const maxPutt = Math.max(0, shown - 1); // パットは打数より1つ少ない数まで（ティーショットはパットにならない）

  const dots = r.holes.map((x, k) => `<button class="dot${k === 9 ? " gap" : ""}${x.s != null ? ` ${cat(x.s, x.par)}` : ""}${k === i ? " cur" : ""}" data-act="dot" data-k="${k}" aria-label="${x.no}番ホール"></button>`).join("");
  const putts = [0, 1, 2, 3, 4, 5].map((n) => `<button class="chip${h.p === n ? " on" : ""}" data-act="putt" data-n="${n}"${n > maxPutt ? " disabled" : ""}>${n}</button>`).join("");
  const tee = [["L", "左"], ["F", "FW"], ["R", "右"]].map(([v, l]) => `<button class="chip wide${h.t === v ? " on" : ""}" data-act="tee" data-v="${v}">${l}</button>`).join("");
  const mates = r.mates.map((m, j) => {
    const v = m.s[i];
    const has = m.s.some((x) => x != null);
    return `<div class="row"><span class="lbl mate-name">${esc(m.name)}<small>${has ? `計 ${sum(m.s.filter((x) => x != null))}` : ""}</small></span>
<div class="counter"><button data-act="mminus" data-j="${j}" aria-label="${esc(m.name)}の打数を減らす">−</button><button class="n${v == null ? " unset" : ""}" data-act="mset" data-j="${j}">${v ?? "—"}</button><button data-act="mplus" data-j="${j}" aria-label="${esc(m.name)}の打数を増やす">＋</button></div></div>`;
  }).join("");

  $view.innerHTML = `<div class="play">
<header class="play-head">
  <div class="play-top">
    <button class="bar-btn" data-act="leave">${ICON.back}<span>${r.done ? "戻る" : "ホーム"}</span></button>
    <div class="play-course">${esc(courseName(r))}</div>
    <button class="bar-btn" data-act="card" aria-label="スコアカード">${ICON.card}</button>
  </div>
  <div class="play-hole">
    <div class="no">${h.no}<small>番</small>${nine ? `<span class="nine">${esc(nine)}</span>` : ""}</div>
    <button class="par-pill" data-act="holeset">パー${h.par}${h.yd ? `　${h.yd}Y` : ""}${ICON.pencil}</button>
  </div>
</header>
<div class="dots">${dots}</div>
<section class="stroke">
  <button class="pm minus" data-act="minus" aria-label="1打減らす">−</button>
  <button class="val${unset ? " unset" : ""}${bump ? " bump" : ""}" data-act="confirm" aria-label="打数 ${shown}">${shown}</button>
  <button class="pm plus" data-act="plus" aria-label="1打増やす">＋</button>
</section>
<div class="sname">${unset ? `<span class="k-unset">未入力</span>` : `<span class="k-${cat(h.s, h.par)}">${scoreName(h.s, h.par)}</span>`}</div>
<section class="rows">
  <div class="row"><span class="lbl">パット</span><div class="chips">${putts}</div></div>
  ${h.par >= 4 ? `<div class="row"><span class="lbl">ティーショット</span><div class="chips">${tee}</div></div>` : ""}
  <div class="row"><span class="lbl">OB・ペナルティ</span><div class="counter"><button data-act="penminus" aria-label="OB・ペナルティを減らす">−</button><span class="n">${h.pen || 0}</span><button data-act="penplus" aria-label="OB・ペナルティを増やす">＋</button></div></div>
</section>
${r.mates.length ? `<h2 class="rows-h">同伴者</h2><section class="rows">${mates}</section>` : ""}
<footer class="play-foot">
  <div class="total"><span>${t.n}ホール</span><span>合計 <b>${t.s}</b>${t.n ? `（${signed(t.diff)}）` : ""}</span><span>${t.pn ? `パット ${t.putts}` : ""}</span></div>
  <div class="nav2">
    ${i > 0 ? `<button class="btn prev" data-act="prev">${ICON.back}前へ</button>` : ""}
    <button class="btn primary" data-act="next">${last ? (r.done ? "スコアカードへ" : "ラウンドを終える") : `次のホール${ICON.next}`}</button>
  </div>
</footer>
</div>`;
  on("[data-act]", "click", (el) => playAct(r, i, el));
}

function playAct(r, i, el) {
  const h = r.holes[i];
  const shown = h.s ?? h.par;
  const act = el.dataset.act;
  let bump = false;
  switch (act) {
    case "minus": h.s = Math.max(1, shown - 1); bump = true; break;
    case "plus": h.s = Math.min(20, shown + 1); bump = true; break;
    case "confirm": if (h.s != null) return; h.s = h.par; bump = true; break;
    // パット・ティーショット・OB を入れたら、そのとき出ている打数も入れたことにする
    case "putt": { const n = Number(el.dataset.n); h.s = shown; h.p = h.p === n ? null : n; break; }
    case "tee": h.s = shown; h.t = h.t === el.dataset.v ? null : el.dataset.v; break;
    case "penminus": h.s = shown; h.pen = Math.max(0, (h.pen || 0) - 1); break;
    case "penplus": h.s = shown; h.pen = Math.min(9, (h.pen || 0) + 1); break;
    // 同伴者は入れなくてもよい（D6）。触ったときだけ入る
    case "mminus": case "mplus": case "mset": {
      const m = r.mates[Number(el.dataset.j)];
      const cur = m.s[i];
      if (act === "mset") { if (cur != null) return; m.s[i] = h.par; }
      else if (act === "mminus") m.s[i] = Math.max(1, (cur ?? h.par) - 1);
      else m.s[i] = Math.min(20, (cur ?? h.par) + 1);
      break;
    }
    case "dot": go(`#/play/${r.id}/${el.dataset.k}`); return;
    case "prev": go(`#/play/${r.id}/${i - 1}`); return;
    case "next":
      // 「次」を押したら、出ている打数で記録する（触らずに進めばパー）
      if (h.s == null) h.s = h.par;
      touch(r);
      if (i < r.holes.length - 1) go(`#/play/${r.id}/${i + 1}`);
      else if (r.done) go(`#/round/${r.id}`);
      else finishRound(r);
      return;
    case "leave": go(r.done ? `#/round/${r.id}` : "#/"); return;
    case "card": go(`#/round/${r.id}`); return;
    case "holeset": openHoleSheet(r, i); return;
    default: return;
  }
  if (h.p != null && h.s != null && h.p > h.s - 1) h.p = Math.max(0, h.s - 1);
  touch(r);
  renderPlay(r.id, i, bump);
}

function finishRound(r) {
  const missing = r.holes.filter((h) => h.s == null).length;
  if (missing && !confirm(`まだ入れていないホールが${missing}ホールあります。ラウンドを終えますか？`)) return;
  r.done = true;
  touch(r);
  justFinished = r.id;
  go(`#/round/${r.id}`);
}

// ホールのパー・ヤードを直す板（パーの数字の横の鉛筆から）
function openHoleSheet(r, i) {
  const h = r.holes[i];
  let par = h.par;
  $sheet.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${h.no}番ホールのパーとヤード">
<div class="grip"></div>
<h3 class="sheet-title">${h.no}番ホール</h3>
<div class="flabel">パー</div>
<div class="par-seg big">${PARS.map((p) => `<button data-par="${p}" class="${p === par ? "on" : ""}">${p}</button>`).join("")}</div>
<div class="flabel">ヤード</div>
<input class="input" id="sh-yd" type="number" inputmode="numeric" min="1" max="999" value="${h.yd ?? ""}" placeholder="未入力">
<div class="sheet-btns"><button class="btn" id="sh-cancel">やめる</button><button class="btn primary" id="sh-ok">決定</button></div>
</div>`;
  $sheet.hidden = false;
  $sheet.onclick = (e) => { if (e.target === $sheet) closeSheet(); };
  $sheet.querySelectorAll("[data-par]").forEach((b) => {
    b.onclick = () => {
      par = Number(b.dataset.par);
      $sheet.querySelectorAll("[data-par]").forEach((x) => x.classList.toggle("on", x === b));
    };
  });
  $sheet.querySelector("#sh-cancel").onclick = closeSheet;
  $sheet.querySelector("#sh-ok").onclick = () => {
    const v = $sheet.querySelector("#sh-yd").value.trim();
    const yd = v === "" ? null : Math.round(Number(v));
    if (yd != null && !(yd >= 1 && yd <= 999)) { toast("ヤードは1〜999で入れてください"); return; }
    h.par = par;
    h.yd = yd;
    if (h.p != null && h.s != null && h.p > h.s - 1) h.p = Math.max(0, h.s - 1);
    if (!r.done) writeBack(r, i);
    touch(r);
    closeSheet();
    renderPlay(r.id, i);
  };
}

function closeSheet() {
  $sheet.hidden = true;
  $sheet.innerHTML = "";
}

// 進行中のラウンドで直したパー・ヤードを、ゴルフ場の登録にも書き戻す（次からはその値で始まる）。
// 終えたラウンドを直したときは書き戻さない（CLAUDE.md）。コースの名前が作ったときと違えば書き戻さない
function writeBack(r, i) {
  const h = r.holes[i];
  const c = courseById(r.courseId);
  if (!c || !Array.isArray(h.src)) return;
  const [ni, k] = h.src;
  const n = c.nines[ni];
  if (!n || n.name !== r.nines[i < 9 ? 0 : 1] || !n.holes[k]) return;
  n.holes[k] = { par: h.par, yd: h.yd };
  c.updatedAt = Date.now();
}

/* ================= スコアカード（1ラウンド） ================= */

function renderRound(id) {
  const r = roundById(id);
  if (!r) return go("#/");
  const t = totals(r);
  const fresh = justFinished === r.id;
  justFinished = null;
  const fulls = data.rounds.filter((x) => x.done && is18(x));
  const others = fulls.filter((x) => x.id !== r.id);
  const prevBest = others.length ? Math.min(...others.map((x) => totals(x).s)) : null;
  const badges = [];
  if (!r.done) badges.push(`<span class="badge sky">ラウンド中</span>`);
  if (r.done && is18(r)) {
    if (fresh && prevBest != null && t.s < prevBest) badges.push(`<span class="badge gold">ベスト更新</span>`);
    else if (bestOf(fulls) === r) badges.push(`<span class="badge gold">ベスト</span>`);
  }
  const halves = r.holes.length > 9 ? [0, 1] : [0];
  const halfHtml = halves.map((hf) => {
    const x = totals(r, hf * 9, hf * 9 + 9);
    return `<span>${esc(r.nines[hf] || (hf ? "後半" : "前半"))}<b>${x.n ? x.s : "—"}</b></span>`;
  }).join("") + (t.pn ? `<span>パット<b>${t.putts}</b></span>` : "");

  let html = bar("スコアカード", { back: "#/", right: `<a class="bar-btn" href="#/round/${r.id}/edit" aria-label="日付・ゴルフ場・天気・同伴者を直す">${ICON.pencil}</a>` });
  html += `<section class="rhead">
${fresh ? `<div class="rhead-hello">おつかれさまでした</div>` : ""}
<div class="rhead-top"><span>${fmtDate(r.date)}</span>${r.weather && WX[r.weather] ? `<span class="wx-s">${WX[r.weather].svg}${WX[r.weather].label}</span>` : ""}</div>
<div class="rhead-name">${esc(courseName(r))}</div>
<div class="rhead-nines">${esc(r.nines.join(" → "))}${r.holes.length === 9 ? "（ハーフ）" : ""}</div>
${badges.length ? `<div class="rhead-badges">${badges.join("")}</div>` : ""}
<div class="rhead-score"><b>${t.n ? t.s : "—"}</b>${t.n ? `<span>${signed(t.diff)}</span>` : ""}</div>
<div class="rhead-halves">${halfHtml}</div>
</section>`;
  if (!r.done) {
    const k = r.holes.findIndex((h) => h.s == null);
    html += `<div class="pad" style="margin-top:10px"><a class="btn primary" href="#/play/${r.id}/${k === -1 ? r.holes.length - 1 : k}">続きから入力${ICON.next}</a></div>`;
  }
  html += scorecard(r);
  html += roundBreakdown(r);
  html += `<div class="card"><h2 class="card-h">メモ</h2><textarea class="input memo" id="memo" rows="3" maxlength="1000">${esc(r.memo)}</textarea></div>`;
  html += `<div class="pad stack" style="padding-bottom:20px">
${r.done ? `<a class="btn" href="#/play/${r.id}/0">${ICON.pencil}スコアを直す</a>` : ""}
<button class="btn danger" data-act="del">${ICON.trash}このラウンドを消す</button></div>`;
  $view.innerHTML = html;

  on(".sc [data-k]", "click", (el) => go(`#/play/${r.id}/${el.dataset.k}`));
  const $memo = document.getElementById("memo");
  let timer = null;
  const saveMemo = () => {
    clearTimeout(timer);
    if (r.memo !== $memo.value) { r.memo = $memo.value; touch(r); }
  };
  $memo.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(saveMemo, 600); });
  $memo.addEventListener("blur", saveMemo);
  on("[data-act=del]", "click", () => {
    if (!confirm(`${fmtDate(r.date)}　${courseName(r)}\nこのラウンドを消します。元に戻せません。`)) return;
    data.rounds = data.rounds.filter((x) => x.id !== r.id);
    save();
    toast("ラウンドを消しました");
    go("#/");
  });
}

function scorecard(r) {
  const halves = r.holes.length > 9 ? [0, 1] : [0];
  return halves.map((hf) => {
    const from = hf * 9;
    const hs = r.holes.slice(from, from + 9);
    const t = totals(r, from, from + 9);
    const ydSum = sum(hs.map((h) => h.yd || 0));
    const me = hs.map((h, k) => `<td data-k="${from + k}">${h.s != null ? `<span class="mark ${cat(h.s, h.par)}">${h.s}</span>` : `<span class="dash">·</span>`}</td>`).join("");
    const mates = r.mates.map((m) => {
      const ms = m.s.slice(from, from + 9);
      const got = ms.filter((x) => x != null);
      return `<tr class="r-mate"><td>${esc(m.name)}</td>${ms.map((x) => `<td>${x ?? ""}</td>`).join("")}<td class="tot">${got.length ? sum(got) : ""}</td></tr>`;
    }).join("");
    return `<div class="card sc-card"><table class="sc">
<thead><tr><th>${esc(r.nines[hf] || "")}</th>${hs.map((h) => `<th>${h.no}</th>`).join("")}<th class="tot">計</th></tr></thead>
<tbody>
<tr class="r-par"><td>パー</td>${hs.map((h) => `<td>${h.par}</td>`).join("")}<td class="tot">${sum(hs.map((h) => h.par))}</td></tr>
${ydSum ? `<tr class="r-yd"><td>ヤード</td>${hs.map((h) => `<td>${h.yd ?? ""}</td>`).join("")}<td class="tot">${ydSum}</td></tr>` : ""}
<tr class="r-me"><td>スコア</td>${me}<td class="tot">${t.n ? t.s : ""}</td></tr>
${t.pn ? `<tr class="r-putt"><td>パット</td>${hs.map((h) => `<td>${h.p ?? ""}</td>`).join("")}<td class="tot">${t.putts}</td></tr>` : ""}
${mates}
</tbody></table></div>`;
  }).join("");
}

function roundBreakdown(r) {
  const st = holeStats([r]);
  if (!st.n) return "";
  return `<div class="card"><h2 class="card-h">このラウンドの内訳</h2>
${distBlock(st.dist, st.n)}
<div class="kv" style="margin-top:8px"><span class="k">パット</span><span class="v">${st.puttN ? `${st.putts}<small>1ホール ${(st.putts / st.puttN).toFixed(2)}</small>` : "—"}</span></div>
<div class="kv"><span class="k">パーオン</span><span class="v">${st.puttN ? `${st.gir}<small>/ ${st.puttN}ホール</small>` : "—"}</span></div>
<div class="kv"><span class="k">フェアウェイキープ</span><span class="v">${st.teeN ? `${st.fw}<small>/ ${st.teeN}ホール</small>` : "—"}</span></div>
<div class="kv"><span class="k">OB・ペナルティ</span><span class="v">${st.pen}</span></div>
</div>`;
}

function distBlock(dist, n) {
  const segs = CATS.filter((c) => dist[c.key]).map((c) => `<i style="width:${(dist[c.key] / n) * 100}%;background:${c.color}"></i>`).join("");
  const legend = CATS.map((c) => `<div><i style="background:${c.color}"></i>${c.label}<b>${Math.round((dist[c.key] / n) * 100)}%</b></div>`).join("");
  return `<div class="bar100">${segs}</div><div class="legend">${legend}</div>`;
}

/* ================= ラウンドの情報を直す ================= */

function renderRoundEdit(id) {
  const r = roundById(id);
  if (!r) return go("#/");
  if (!redit || redit.id !== id) {
    redit = { id, date: r.date, courseId: r.courseId, weather: r.weather, mates: r.mates.map((m, j) => ({ name: m.name, j })) };
  }
  const f = redit;
  const courses = data.courses.slice().sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const known = courses.some((c) => c.id === f.courseId);
  const opts = (known ? "" : `<option value="" selected>${esc(r.courseName)}</option>`)
    + courses.map((c) => `<option value="${c.id}"${c.id === f.courseId ? " selected" : ""}>${esc(c.name)}</option>`).join("");

  let html = bar("ラウンドの情報", { back: `#/round/${r.id}` });
  html += `<div class="field"><label for="f-date">日付</label><input class="input" id="f-date" type="date" value="${esc(f.date)}"></div>
<div class="field"><label for="f-course">ゴルフ場</label><select class="input" id="f-course">${opts}</select></div>
<div class="field"><span class="flabel">天気</span>${weatherRow(f.weather)}</div>
<div class="field"><span class="flabel">同伴者</span>
${f.mates.map((m, x) => `<div class="mate"><input class="input" data-mate="${x}" value="${esc(m.name)}" placeholder="名前" maxlength="12" list="mate-names" autocomplete="off"><button class="x-btn" data-act="rmmate" data-x="${x}" aria-label="外す">${ICON.x}</button></div>`).join("")}
${f.mates.length < MAX_MATES ? `<button class="add-btn" data-act="addmate">${ICON.plus}同伴者を足す</button>` : ""}${mateList()}
<div class="err" id="f-err" hidden></div></div>
<div class="sticky-foot"><button class="btn primary" data-act="save">保存する</button></div>`;
  $view.innerHTML = html;

  const again = () => keepScroll(() => renderRoundEdit(id));
  on("#f-date", "change", (el) => { f.date = el.value; });
  on("#f-course", "change", (el) => { if (el.value) f.courseId = el.value; });
  on("[data-mate]", "input", (el) => { f.mates[el.dataset.mate].name = el.value; });
  on("[data-act]", "click", (el) => {
    switch (el.dataset.act) {
      case "wx": f.weather = f.weather === el.dataset.v ? null : el.dataset.v; again(); break;
      case "addmate": f.mates.push({ name: "", j: null }); again(); $view.querySelector(`[data-mate="${f.mates.length - 1}"]`).focus(); break;
      case "rmmate": {
        const m = f.mates[Number(el.dataset.x)];
        const had = m.j != null && r.mates[m.j].s.some((x) => x != null);
        if (had && !confirm(`${m.name || "この同伴者"}のスコアも消えます。外しますか？`)) return;
        f.mates.splice(Number(el.dataset.x), 1);
        again();
        break;
      }
      case "save": {
        if (!f.date) return showErr("f-err", "日付を入れてください");
        if (f.mates.some((m) => m.j != null && !m.name.trim())) return showErr("f-err", "同伴者の名前を入れてください");
        r.date = f.date;
        const c = courseById(f.courseId);
        if (c && c.id !== r.courseId) { r.courseId = c.id; r.courseName = c.name; }
        r.weather = f.weather;
        r.mates = f.mates.filter((m) => m.name.trim()).map((m) => ({ name: m.name.trim(), s: m.j != null ? r.mates[m.j].s : r.holes.map(() => null) }));
        touch(r);
        redit = null;
        toast("保存しました");
        go(`#/round/${r.id}`);
        break;
      }
    }
  });
}

/* ================= 成績 ================= */

function rangeRounds(range) {
  const done = data.rounds.filter((r) => r.done).sort(byDateAsc);
  if (range === "10") return done.slice(-10);
  if (range === "year") { const y = String(new Date().getFullYear()); return done.filter((r) => r.date.startsWith(y)); }
  return done;
}

function renderStats() {
  const range = data.settings.statsRange || "10";
  const rounds = rangeRounds(range);
  const full = rounds.filter(is18);
  const st = holeStats(rounds);
  let html = bar("成績");
  html += `<div class="seg">${[["10", "直近10回"], ["year", "今年"], ["all", "すべて"]].map(([v, l]) => `<button class="${range === v ? "on" : ""}" data-act="range" data-v="${v}">${l}</button>`).join("")}</div>`;
  if (!rounds.length) {
    html += `<div class="empty">${EMPTY_ART}ラウンドを終えると、ここに成績が出ます</div>`;
  } else {
    const scores = full.map((r) => totals(r).s);
    const best = bestOf(full);
    html += `<div class="tiles">
<div class="tile"><div class="lbl">平均スコア</div><div class="val">${scores.length ? fix1(mean(scores)) : "—"}</div><div class="sub">18ホール</div></div>
<div class="tile"><div class="lbl">ベスト</div><div class="val">${best ? totals(best).s : "—"}</div><div class="sub">${best ? fmtYMD(best.date) : "—"}</div></div>
<div class="tile"><div class="lbl">ラウンド</div><div class="val">${rounds.length}</div><div class="sub">回</div></div></div>`;
    if (full.length) html += `<div class="card"><h2 class="card-h">スコアの推移</h2><div class="chart">${trendChart(full)}</div></div>`;
    if (st.n) {
      html += `<div class="card"><h2 class="card-h">スコアの内訳</h2>${distBlock(st.dist, st.n)}</div>`;
      const lrPct = (x) => (st.teeN ? (x / st.teeN) * 100 : 0);
      html += `<div class="card"><h2 class="card-h">ショット</h2>
<div class="kv"><span class="k">平均パット（18ホール）</span><span class="v">${st.puttN ? `${fix1((st.putts / st.puttN) * 18)}<small>1ホール ${(st.putts / st.puttN).toFixed(2)}</small>` : "—"}</span></div>
<div class="kv"><span class="k">パーオン率</span><span class="v">${st.puttN ? `${pct(st.gir / st.puttN)}<small>${st.gir}/${st.puttN}</small>` : "—"}</span></div>
<div class="kv"><span class="k">フェアウェイキープ率</span><span class="v">${st.teeN ? `${pct(st.fw / st.teeN)}<small>${st.fw}/${st.teeN}</small>` : "—"}</span></div>
${st.teeN ? `<div class="lr"><div class="bar100"><i style="width:${lrPct(st.left)}%;background:#a9bcc9"></i><i style="width:${lrPct(st.fw)}%;background:#2f9e5b"></i><i style="width:${lrPct(st.right)}%;background:#a9bcc9"></i></div>
<div class="lr-lbl"><span>左 ${Math.round(lrPct(st.left))}%</span><span>FW ${Math.round(lrPct(st.fw))}%</span><span>右 ${Math.round(lrPct(st.right))}%</span></div></div>` : ""}
<div class="kv"><span class="k">OB・ペナルティ</span><span class="v">${fix1((st.pen / st.n) * 18)}<small>18ホールあたり</small></span></div></div>`;
      html += `<div class="card"><h2 class="card-h">パー別の平均打数</h2>${[3, 4, 5].map((p) => {
        const b = st.byPar[p];
        return `<div class="kv"><span class="k">パー${p}</span><span class="v">${b.n ? `${b.avg.toFixed(2)}<small>${signedF(b.avg - p, 2)}</small>` : "—"}</span></div>`;
      }).join("")}</div>`;
    }
    if (full.length) {
      const groups = new Map();
      for (const r of full) {
        const k = r.courseId || r.courseName;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      }
      const rows = [...groups.values()].sort((a, b) => b.length - a.length).map((rs) => {
        const s = rs.map((r) => totals(r).s);
        return `<div class="crow"><div class="cn">${esc(courseName(rs[rs.length - 1]))}<small>${rs.length}回</small></div><div class="cv">平均<b>${fix1(mean(s))}</b>　ベスト<b>${Math.min(...s)}</b></div></div>`;
      }).join("");
      html += `<div class="card"><h2 class="card-h">ゴルフ場別（18ホール）</h2>${rows}</div>`;
    }
  }
  $view.innerHTML = html;
  on("[data-act=range]", "click", (el) => { data.settings.statsRange = el.dataset.v; save(); renderStats(); });
}

// スコアの推移の折れ線（数が小さいほど下。金色の点がベスト、空色の点線が平均）
function trendChart(rounds) {
  const W = 340, H = 196, L = 30, R = 14, T = 20, B = 26;
  const ys = rounds.map((r) => totals(r).s);
  const n = ys.length;
  const lo = Math.floor((Math.min(...ys) - 3) / 5) * 5;
  const hi = Math.ceil((Math.max(...ys) + 3) / 5) * 5;
  const step = hi - lo > 30 ? 10 : 5;
  const x = (k) => (n === 1 ? (L + W - R) / 2 : L + (k * (W - L - R)) / (n - 1));
  const y = (v) => T + ((hi - v) * (H - T - B)) / (hi - lo);
  const f1 = (v) => v.toFixed(1);
  let grid = "";
  for (let v = lo; v <= hi; v += step) {
    grid += `<line x1="${L}" x2="${W - R}" y1="${f1(y(v))}" y2="${f1(y(v))}" stroke="#e4ebe6"/><text x="${L - 6}" y="${f1(y(v) + 4)}" text-anchor="end" font-size="11" fill="#94a39a">${v}</text>`;
  }
  const pts = ys.map((v, k) => [x(k), y(v)]);
  const line = pts.map(([px, py], k) => `${k ? "L" : "M"}${f1(px)} ${f1(py)}`).join("");
  const area = n > 1 ? `<path d="${line}L${f1(pts[n - 1][0])} ${H - B}L${f1(pts[0][0])} ${H - B}Z" fill="url(#g-area)"/>` : "";
  const bestK = ys.indexOf(Math.min(...ys));
  const rad = n > 24 ? 2.6 : 4;
  const dots = pts.map(([px, py], k) => (k === bestK ? "" : `<circle cx="${f1(px)}" cy="${f1(py)}" r="${rad}" fill="#fff" stroke="#2f9e5b" stroke-width="2"/>`)).join("");
  const best = `<circle cx="${f1(pts[bestK][0])}" cy="${f1(pts[bestK][1])}" r="${rad + 2}" fill="#e0a82e" stroke="#fff" stroke-width="2"/>`;
  const avg = mean(ys);
  const ay = f1(y(avg));
  const avgLine = `<line x1="${L}" x2="${W - R}" y1="${ay}" y2="${ay}" stroke="#4da3e0" stroke-width="1.5" stroke-dasharray="4 4"/><text x="${W - R}" y="${f1(y(avg) - 6)}" text-anchor="end" font-size="11" font-weight="700" fill="#1f6a9e">平均 ${fix1(avg)}</text>`;
  const xl = n > 1
    ? `<text x="${L}" y="${H - 6}" font-size="11" fill="#94a39a">${fmtYMD(rounds[0].date)}</text><text x="${W - R}" y="${H - 6}" text-anchor="end" font-size="11" fill="#94a39a">${fmtYMD(rounds[n - 1].date)}</text>`
    : `<text x="${f1(x(0))}" y="${H - 6}" text-anchor="middle" font-size="11" fill="#94a39a">${fmtYMD(rounds[0].date)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="スコアの推移"><defs><linearGradient id="g-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f9e5b" stop-opacity=".22"/><stop offset="1" stop-color="#2f9e5b" stop-opacity="0"/></linearGradient></defs>${grid}${area}${avgLine}${n > 1 ? `<path d="${line}" fill="none" stroke="#2f9e5b" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>` : ""}${dots}${best}${xl}</svg>`;
}

/* ================= ゴルフ場 ================= */

function renderCourses() {
  const played = {};
  for (const r of data.rounds) if (r.courseId) played[r.courseId] = (played[r.courseId] || 0) + 1;
  const list = coursesByRecent();
  let html = bar("ゴルフ場", { right: `<a class="bar-btn" href="#/course/new" aria-label="ゴルフ場を追加">${ICON.plus}</a>` });
  if (!list.length) {
    html += `<div class="empty">${EMPTY_ART}ラウンドを始めると、ここにゴルフ場が増えます</div><div class="pad"><a class="btn" href="#/course/new">${ICON.plus}ゴルフ場を追加</a></div>`;
  } else {
    html += `<div class="rounds" style="margin-top:14px">${list.map((c) => `<a class="course-row" href="#/course/${c.id}"><span class="ic">${ICON.flag}</span>
<div class="info"><div class="name">${esc(c.name)}</div><div class="meta">${esc(c.nines.map((n) => n.name).join("・"))}　${courseParText(c)}${played[c.id] ? `　${played[c.id]}回` : ""}</div></div><span class="chev">${ICON.next}</span></a>`).join("")}</div>`;
  }
  $view.innerHTML = html;
}

function renderCourseEdit(key) {
  if (!cedit || cedit.key !== key) {
    const src = key === "new" ? { id: null, name: "", nines: [newNine("OUT"), newNine("IN")] } : courseById(key);
    if (!src) return go("#/courses");
    cedit = { key, dirty: false, c: JSON.parse(JSON.stringify(src)) };
  }
  const c = cedit.c;
  leaveGuard = () => !cedit || !cedit.dirty || confirm("保存せずに戻りますか？");

  let html = bar(key === "new" ? "ゴルフ場を追加" : "ゴルフ場", { back: "#/courses" });
  html += `<div class="field"><label for="c-name">名前</label><input class="input" id="c-name" value="${esc(c.name)}" placeholder="ゴルフ場の名前" maxlength="40" autocomplete="off"><div class="err" id="c-err" hidden></div></div>`;
  c.nines.forEach((n, ni) => {
    html += `<div class="card">
<div class="nine-head"><input class="input" data-nine="${ni}" value="${esc(n.name)}" maxlength="12" aria-label="コースの名前"><span class="nine-sum" id="sum-${ni}">${nineSumText(n)}</span></div>
<table class="holes-ed"><tbody>${n.holes.map((h, k) => `<tr><td class="no">${holeNo(c, ni, k)}</td>
<td><div class="par-seg">${PARS.map((p) => `<button data-act="par" data-ni="${ni}" data-k="${k}" data-p="${p}" class="${h.par === p ? "on" : ""}" aria-label="パー${p}">${p}</button>`).join("")}</div></td>
<td class="ydc"><input class="yd" type="number" inputmode="numeric" min="1" max="999" data-ni="${ni}" data-k="${k}" value="${h.yd ?? ""}" placeholder="ヤード" aria-label="${holeNo(c, ni, k)}番のヤード"></td></tr>`).join("")}</tbody></table>
${c.nines.length > 1 ? `<button class="btn danger small" data-act="rmnine" data-ni="${ni}">${ICON.trash}このコースを外す</button>` : ""}
</div>`;
  });
  html += `<div class="pad"><button class="btn" data-act="addnine">${ICON.plus}9ホールのコースを足す</button></div>`;
  if (key !== "new") html += `<div class="pad"><button class="btn danger" data-act="delcourse">${ICON.trash}このゴルフ場を消す</button></div>`;
  html += `<div class="sticky-foot"><button class="btn primary" data-act="save">保存する</button></div>`;
  $view.innerHTML = html;

  const dirty = () => { cedit.dirty = true; };
  on("#c-name", "input", (el) => { c.name = el.value; dirty(); });
  on("[data-nine]", "input", (el) => { c.nines[el.dataset.nine].name = el.value; dirty(); });
  on(".yd", "input", (el) => {
    const n = c.nines[el.dataset.ni];
    const num = Math.round(Number(el.value));
    n.holes[el.dataset.k].yd = el.value.trim() !== "" && num >= 1 && num <= 999 ? num : null;
    document.getElementById(`sum-${el.dataset.ni}`).textContent = nineSumText(n);
    dirty();
  });
  on("[data-act]", "click", (el) => {
    switch (el.dataset.act) {
      case "par": {
        const n = c.nines[el.dataset.ni];
        n.holes[el.dataset.k].par = Number(el.dataset.p);
        el.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === el));
        document.getElementById(`sum-${el.dataset.ni}`).textContent = nineSumText(n);
        dirty();
        break;
      }
      case "addnine": c.nines.push(newNine(`コース${c.nines.length + 1}`)); dirty(); keepScroll(() => renderCourseEdit(key)); break;
      case "rmnine": {
        const ni = Number(el.dataset.ni);
        if (!confirm(`「${c.nines[ni].name}」を外しますか？`)) return;
        c.nines.splice(ni, 1);
        dirty();
        keepScroll(() => renderCourseEdit(key));
        break;
      }
      case "delcourse": {
        const orig = courseById(key);
        if (!orig || !confirm(`「${orig.name}」を消しますか？\n過去のラウンドの記録は残ります。`)) return;
        data.courses = data.courses.filter((x) => x.id !== key);
        save();
        cedit = null;
        toast("ゴルフ場を消しました");
        go("#/courses");
        break;
      }
      case "save": {
        const name = c.name.trim();
        if (!name) return showErr("c-err", "名前を入れてください");
        if (data.courses.some((x) => x.name === name && x.id !== c.id)) return showErr("c-err", "同じ名前のゴルフ場があります");
        c.name = name;
        c.nines.forEach((n, i) => { n.name = n.name.trim() || `コース${i + 1}`; });
        c.updatedAt = Date.now();
        if (key === "new") {
          c.id = uid("c");
          data.courses.push(c);
        } else {
          const orig = courseById(key);
          Object.assign(orig, { name: c.name, nines: c.nines, updatedAt: c.updatedAt });
          for (const r of data.rounds) if (r.courseId === orig.id) r.courseName = orig.name;
        }
        save();
        cedit = null;
        toast("保存しました");
        go("#/courses");
        break;
      }
    }
  });
}

/* ================= 設定・バックアップ ================= */

function renderSettings() {
  let html = bar("設定");
  html += `<div class="card"><h2 class="card-h">バックアップ</h2>
<p class="set-p">ラウンド ${data.rounds.length}件・ゴルフ場 ${data.courses.length}件<br>最後に書き出した日：${data.settings.lastExport ? fmtDate(data.settings.lastExport) : "まだありません"}</p>
<div class="stack"><button class="btn primary" data-act="export">${ICON.share}記録を書き出す</button>
<button class="btn" data-act="import">${ICON.open}書き出したファイルを読み込む</button></div>
<input type="file" id="import-file" accept=".json,application/json" hidden>
<p class="hint">読み込んでも今の記録は消えません。同じ記録は二重になりません。</p></div>
<div class="card"><h2 class="card-h">保存の状態</h2><p class="set-p" id="persist">確認しています…</p></div>`;
  $view.innerHTML = html;

  on("[data-act=export]", "click", exportData);
  on("[data-act=import]", "click", () => document.getElementById("import-file").click());
  on("#import-file", "change", (el) => { if (el.files[0]) importFile(el.files[0]); el.value = ""; });
  const $p = document.getElementById("persist");
  if (navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted()
      .then((ok) => { $p.textContent = ok ? "消されにくい保存になっています。" : "通常の保存です。念のため、ときどき書き出してください。"; })
      .catch(() => { $p.textContent = "確認できませんでした。念のため、ときどき書き出してください。"; });
  } else {
    $p.textContent = "このブラウザでは確認できません。念のため、ときどき書き出してください。";
  }
}

async function exportData() {
  const payload = JSON.stringify({ app: "golfscore", version: 1, exportedAt: new Date().toISOString(), courses: data.courses, rounds: data.rounds }, null, 1);
  const name = `ゴルフ記録_${today()}.json`;
  const file = new File([payload], name, { type: "application/json" });
  try {
    // iPhone では共有シートが開き、「"ファイル"に保存」や AirDrop で逃がせる
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(file);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
    data.settings.lastExport = today();
    save();
    if (location.hash === "#/settings") renderSettings();
  } catch (e) {
    if (e.name !== "AbortError") toast("書き出しに失敗しました");
  }
}

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const okInt = (v, lo, hi) => v == null || isInt(v, lo, hi);

function validHole(h) {
  return h && isInt(h.par, 3, 6) && okInt(h.s, 1, 20) && okInt(h.p, 0, 19) && okInt(h.yd, 1, 999) && okInt(h.pen, 0, 9)
    && (h.t == null || ["L", "F", "R"].includes(h.t));
}
function validRound(r) {
  return r && typeof r.id === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Array.isArray(r.holes)
    && (r.holes.length === 9 || r.holes.length === 18) && r.holes.every(validHole);
}
function validCourse(c) {
  return c && typeof c.id === "string" && typeof c.name === "string" && Array.isArray(c.nines) && c.nines.length >= 1
    && c.nines.every((n) => n && typeof n.name === "string" && Array.isArray(n.holes) && n.holes.length === 9
      && n.holes.every((h) => h && isInt(h.par, 3, 6) && okInt(h.yd, 1, 999)));
}
// 読み込んだ記録を、このアプリの形にそろえる（欠けた項目を補い、知らない項目は持ち込まない）
function normRound(r) {
  const holes = r.holes.map((h, k) => ({
    no: isInt(h.no, 1, 18) ? h.no : k + 1, par: h.par, yd: h.yd ?? null, s: h.s ?? null, p: h.p ?? null, t: h.t ?? null, pen: h.pen ?? 0,
    src: Array.isArray(h.src) && h.src.length === 2 ? h.src : null,
  }));
  return {
    id: r.id, date: r.date, courseId: typeof r.courseId === "string" ? r.courseId : null, courseName: String(r.courseName ?? ""),
    nines: Array.isArray(r.nines) ? r.nines.map(String) : [],
    holes, weather: WX_KEYS.includes(r.weather) ? r.weather : null, memo: String(r.memo ?? ""),
    mates: (Array.isArray(r.mates) ? r.mates : []).slice(0, MAX_MATES).map((m) => ({
      name: String((m && m.name) || ""), s: holes.map((_, k) => (m && Array.isArray(m.s) && isInt(m.s[k], 1, 20) ? m.s[k] : null)),
    })),
    done: r.done !== false, createdAt: Number(r.createdAt) || Date.now(), updatedAt: Number(r.updatedAt) || Date.now(),
  };
}
function normCourse(c) {
  return { id: c.id, name: c.name, nines: c.nines.map((n) => ({ name: n.name, holes: n.holes.map((h) => ({ par: h.par, yd: h.yd ?? null })) })), updatedAt: Number(c.updatedAt) || Date.now() };
}

// 読み込みは「足し合わせ」：同じ id のものは足さない。今ある記録は消さない
function importFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let d;
    try { d = JSON.parse(reader.result); } catch (e) { toast("ファイルが読めませんでした"); return; }
    if (!d || d.app !== "golfscore" || !Array.isArray(d.rounds) || !Array.isArray(d.courses)) { toast("ゴルフ記録の書き出しファイルではありません"); return; }
    const haveC = new Set(data.courses.map((c) => c.id));
    const haveR = new Set(data.rounds.map((r) => r.id));
    let addC = 0, addR = 0, bad = 0;
    for (const c of d.courses) {
      if (!validCourse(c)) { bad++; continue; }
      if (haveC.has(c.id)) continue;
      data.courses.push(normCourse(c)); haveC.add(c.id); addC++;
    }
    for (const r of d.rounds) {
      if (!validRound(r)) { bad++; continue; }
      if (haveR.has(r.id)) continue;
      data.rounds.push(normRound(r)); haveR.add(r.id); addR++;
    }
    save();
    toast(`ラウンド${addR}件・ゴルフ場${addC}件を足しました${bad ? `（読めない${bad}件は飛ばしました）` : ""}`);
    if (location.hash === "#/settings") renderSettings();
  };
  reader.onerror = () => toast("ファイルが読めませんでした");
  reader.readAsText(file);
}

/* ================= はじめに ================= */

window.addEventListener("hashchange", route);
route();

// 消されにくい保存をお願いする（iPhone ではホーム画面から開いたときに効く）
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// 電波が無くても開けるようにする仕組み（サービスワーカー）。確認用サーバーでは登録しない（CLAUDE.md）
if ("serviceWorker" in navigator && !["127.0.0.1", "localhost"].includes(location.hostname)) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.error(e));
}
