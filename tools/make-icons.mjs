/**
 * 生成扩展图标。
 *
 *   node tools/make-icons.mjs
 *
 * 不引第三方依赖，用 zlib 手写最小的 PNG 编码器；图形用 4x4 超采样做抗锯齿，
 * 保证 16px 下也清晰。改配色或图形只要动下面的常量。
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'icons');
const SIZES = [16, 32, 48, 128];

/** 背景渐变（左上 -> 右下） */
const BG_FROM = [99, 102, 241];
const BG_TO = [67, 56, 202];
const FG = [255, 255, 255];

/** 圆角矩形背景的圆角比例 */
const CORNER_RATIO = 0.24;

/** 三根音柱：宽度、间距、高度，都是相对边长的比例 */
const BAR_WIDTH = 0.125;
const BAR_GAP = 0.095;
const BAR_HEIGHTS = [0.36, 0.62, 0.46];

const SS = 4; // 每个像素每个方向 4 个采样点

function sdRoundRect(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius);
  const qy = Math.abs(py - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * CORNER_RATIO;
  const center = size / 2;

  const barW = size * BAR_WIDTH;
  const barGap = size * BAR_GAP;
  const totalW = BAR_HEIGHTS.length * barW + (BAR_HEIGHTS.length - 1) * barGap;
  const startX = (size - totalW) / 2;

  const bars = BAR_HEIGHTS.map((ratio, index) => {
    const x0 = startX + index * (barW + barGap);
    return {
      cx: x0 + barW / 2,
      cy: center,
      halfW: barW / 2,
      halfH: (size * ratio) / 2,
    };
  });

  const step = 1 / SS;
  const samples = SS * SS;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgCoverage = 0;
      let fgCoverage = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) * step;
          const py = y + (sy + 0.5) * step;

          if (sdRoundRect(px, py, center, center, size / 2, size / 2, radius) > 0) continue;
          bgCoverage++;

          for (const bar of bars) {
            if (sdRoundRect(px, py, bar.cx, bar.cy, bar.halfW, bar.halfH, bar.halfW) <= 0) {
              fgCoverage++;
              break;
            }
          }
        }
      }

      if (!bgCoverage) continue;

      const alpha = bgCoverage / samples;
      const mix = fgCoverage / bgCoverage;

      // 渐变按对角线插值
      const t = (x + y) / (2 * size - 2);
      const bg = [
        BG_FROM[0] + (BG_TO[0] - BG_FROM[0]) * t,
        BG_FROM[1] + (BG_TO[1] - BG_FROM[1]) * t,
        BG_FROM[2] + (BG_TO[2] - BG_FROM[2]) * t,
      ];

      const offset = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        pixels[offset + c] = Math.round(bg[c] + (FG[c] - bg[c]) * mix);
      }
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }

  return pixels;
}

/* ------------------------------------------------------------ PNG 编码 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));

  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型：RGBA
  ihdr[10] = 0; // 压缩方法
  ihdr[11] = 0; // 过滤方法
  ihdr[12] = 0; // 非隔行

  // 每行前面加一个 filter 字节（0 = None）
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ 主流程 */

mkdirSync(OUT_DIR, { recursive: true });

for (const size of SIZES) {
  const png = encodePng(renderIcon(size), size);
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, png);
  console.log(`生成 ${file}（${png.length} 字节）`);
}
