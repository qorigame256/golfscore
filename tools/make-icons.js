// ホーム画面用アイコン（緑の地に、グリーン・白い旗竿・珊瑚色の旗・白いボール）を app/icons/ に PNG で書き出す。
// 外部の道具を使わず Node.js だけで描く（TA管理アプリの tools/make-icons.js と同じ書き出し方）。
// 使い方: node tools/make-icons.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.join(__dirname, "..", "app", "icons");
fs.mkdirSync(OUT, { recursive: true });

const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
function inTriangle(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const s = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = s(x, y, ax, ay, bx, by), d2 = s(x, y, bx, by, cx, cy), d3 = s(x, y, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

const TOP = hex("#3bab67"), BOTTOM = hex("#23854a");
const GREEN = hex("#93dbab"), HOLE = hex("#1f6e40"), WHITE = [255, 255, 255], FLAG = hex("#ff8a5b");

// 0〜1 の座標の色（後に書いたものほど手前）
function color(x, y) {
  let c = mix(TOP, BOTTOM, y);
  if (inEllipse(x, y, 0.5, 0.745, 0.33, 0.09)) c = GREEN;
  if (inEllipse(x, y, 0.575, 0.75, 0.034, 0.015)) c = HOLE;
  if (x >= 0.562 && x <= 0.588 && y >= 0.19 && y <= 0.75) c = WHITE;
  if (inTriangle(x, y, [0.586, 0.195], [0.81, 0.29], [0.586, 0.385])) c = FLAG;
  if (inEllipse(x, y, 0.355, 0.715, 0.043, 0.043)) c = WHITE;
  return c;
}

function png(size) {
  const SS = 4; // 縁をなめらかにするため 4x4 で数える
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let j = 0; j < size; j++) {
    raw[j * (size * 3 + 1)] = 0;
    for (let i = 0; i < size; i++) {
      const acc = [0, 0, 0];
      for (let a = 0; a < SS; a++) {
        for (let b = 0; b < SS; b++) {
          const c = color((i + (a + 0.5) / SS) / size, (j + (b + 0.5) / SS) / size);
          acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
        }
      }
      const o = j * (size * 3 + 1) + 1 + i * 3;
      for (let k = 0; k < 3; k++) raw[o + k] = Math.round(acc[k] / (SS * SS));
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type), body]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(tb));
    return Buffer.concat([len, tb, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const s of [180, 192, 512]) {
  fs.writeFileSync(path.join(OUT, `icon-${s}.png`), png(s));
  console.log(`icon-${s}.png`);
}
