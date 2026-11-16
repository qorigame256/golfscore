"use strict";
// QR コードを描く（外部ライブラリを使わない。同伴者に共有のリンクを渡すため：仕様書 D15）。
// 規格（ISO/IEC 18004）どおり：文字は UTF-8 のバイトで入れ、誤り訂正は M（約15%が欠けても読める）、
// 型番（大きさ）は入る最小のもの、マスクは減点のいちばん少ないものを選ぶ。
// 手順は Project Nayuki の QR Code generator（MIT）と同じ考え方で書いている。
const QR = (() => {
  // 型番ごとの [誤り訂正の符号語の数（1ブロックあたり）, ブロックの数]（誤り訂正 M。0番目は使わない）
  const EC_LEN = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
  const EC_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
  const ECL_BITS = 0; // 形式情報での M の値

  // 決まった模様を除いた、データを置けるマスの数
  function rawModules(ver) {
    let n = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const a = Math.floor(ver / 7) + 2;
      n -= (25 * a - 10) * a - 55;
      if (ver >= 7) n -= 36;
    }
    return n;
  }
  const dataCodewords = (ver) => Math.floor(rawModules(ver) / 8) - EC_LEN[ver] * EC_BLOCKS[ver];

  // GF(256) の掛け算（既約多項式 x^8+x^4+x^3+x^2+1 = 0x11D）
  function mul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }
  // リード・ソロモン符号の生成多項式（根は α^0 … α^(deg-1)）
  function divisor(deg) {
    const r = new Array(deg).fill(0);
    r[deg - 1] = 1;
    let root = 1;
    for (let i = 0; i < deg; i++) {
      for (let j = 0; j < deg; j++) {
        r[j] = mul(r[j], root);
        if (j + 1 < deg) r[j] ^= r[j + 1];
      }
      root = mul(root, 2);
    }
    return r;
  }
  function remainder(data, div) {
    const r = new Array(div.length).fill(0);
    for (const b of data) {
      const f = b ^ r.shift();
      r.push(0);
      div.forEach((c, i) => { r[i] ^= mul(c, f); });
    }
    return r;
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  // 文字列を QR コードのマス目にする。戻り値は { size, mod: mod[行][列] = 黒か }
  function encode(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    let ver = 1;
    while (ver <= 40 && 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver) * 8) ver++;
    if (ver > 40) throw new Error("QR に入りきりません");

    // データ：バイトのモード（0100）・文字数・中身・終わりの印・埋め草
    const cap = dataCodewords(ver) * 8;
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4);
    put(bytes.length, ver <= 9 ? 8 : 16);
    bytes.forEach((b) => put(b, 8));
    put(0, Math.min(4, cap - bits.length));
    put(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

    // ブロックに分けて誤り訂正の符号を付け、互い違いに並べる
    const nb = EC_BLOCKS[ver];
    const ecl = EC_LEN[ver];
    const raw = Math.floor(rawModules(ver) / 8);
    const nShort = nb - (raw % nb);
    const shortLen = Math.floor(raw / nb);
    const div = divisor(ecl);
    const blocks = [];
    for (let i = 0, k = 0; i < nb; i++) {
      const d = data.slice(k, k + shortLen - ecl + (i < nShort ? 0 : 1));
      k += d.length;
      const e = remainder(d, div);
      if (i < nShort) d.push(0);
      blocks.push(d.concat(e));
    }
    const cw = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((b, j) => { if (i !== shortLen - ecl || j >= nShort) cw.push(b[i]); });
    }

    // 決まった模様（位置合わせの四角・タイミング・形式情報・型番情報）
    const size = ver * 4 + 17;
    const mod = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || x >= size || y < 0 || y >= size) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          set(x, y, d !== 2 && d !== 4);
        }
      }
    };
    finder(3, 3);
    finder(size - 4, 3);
    finder(3, size - 4);
    const align = [];
    if (ver > 1) {
      const n = Math.floor(ver / 7) + 2;
      const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
      align.push(6);
      for (let pos = size - 7; align.length < n; pos -= step) align.splice(1, 0, pos);
    }
    const last = align.length - 1;
    align.forEach((ay, i) => align.forEach((ax, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    const drawFormat = (mask) => {
      const d = (ECL_BITS << 3) | mask;
      let rem = d;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const b = ((d << 10) | rem) ^ 0x5412;
      const bit = (i) => ((b >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6));
      set(8, 8, bit(7));
      set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, true);
    };
    drawFormat(0); // 場所を押さえるだけ。マスクを決めたあとで描き直す
    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const b = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const dark = ((b >>> i) & 1) === 1;
        const a = size - 11 + (i % 3);
        const c = Math.floor(i / 3);
        set(a, c, dark);
        set(c, a, dark);
      }
    }

    // 符号語を右下から2列ずつジグザグに置く
    let bi = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const up = ((right + 1) & 2) === 0;
          const y = up ? size - 1 - vert : vert;
          if (!fn[y][x] && bi < cw.length * 8) {
            mod[y][x] = ((cw[bi >>> 3] >>> (7 - (bi & 7))) & 1) === 1;
            bi++;
          }
        }
      }
    }

    // 8種類のマスクを試し、読み取りにくい模様（同じ色の連続・2×2・位置合わせに似た並び・白黒の偏り）の減点が最少のものを使う
    const applyMask = (m) => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[m](x, y)) mod[y][x] = !mod[y][x];
    };
    const penalty = () => {
      let score = 0;
      const lines = (get) => {
        for (let a = 0; a < size; a++) {
          let color = false;
          let run = 0;
          const hist = [0, 0, 0, 0, 0, 0, 0];
          const add = (len) => { if (hist[0] === 0) len += size; hist.pop(); hist.unshift(len); };
          const count = () => {
            const n = hist[1];
            const core = n > 0 && hist[2] === n && hist[3] === n * 3 && hist[4] === n && hist[5] === n;
            return (core && hist[0] >= n * 4 && hist[6] >= n ? 1 : 0) + (core && hist[6] >= n * 4 && hist[0] >= n ? 1 : 0);
          };
          for (let b = 0; b < size; b++) {
            if (get(a, b) === color) {
              run++;
              if (run === 5) score += 3;
              else if (run > 5) score++;
            } else {
              add(run);
              if (!color) score += count() * 40;
              color = get(a, b);
              run = 1;
            }
          }
          if (color) { add(run); run = 0; }
          add(run + size);
          score += count() * 40;
        }
      };
      lines((a, b) => mod[a][b]);
      lines((a, b) => mod[b][a]);
      for (let y = 0; y < size - 1; y++) {
        for (let x = 0; x < size - 1; x++) {
          const c = mod[y][x];
          if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) score += 3;
        }
      }
      let dark = 0;
      for (const row of mod) for (const c of row) if (c) dark++;
      const total = size * size;
      score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
      return score;
    };
    let best = 0;
    let min = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m);
      drawFormat(m);
      const p = penalty();
      if (p < min) { min = p; best = m; }
      applyMask(m);
    }
    applyMask(best);
    drawFormat(best);
    return { size, mod, ver, mask: best };
  }

  // SVG にする。まわりに白い余白（4マス）を付ける
  function svg(text) {
    const { size, mod } = encode(text);
    const q = 4;
    let d = "";
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (mod[y][x]) d += `M${x + q} ${y + q}h1v1h-1z`;
    const n = size + q * 2;
    return `<svg class="qr" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="共有のリンクの QR コード"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#14241b"/></svg>`;
  }

  return { encode, svg };
})();
