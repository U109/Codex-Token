'use strict';
// 仅用于离线制作资源；发布构建直接使用已提交的 ICO，无需 Sharp 或 Codex 内置依赖运行环境。
const fs = require('node:fs');
const path = require('node:path');
// Sharp 只用于重新制作图标；普通构建直接使用 assets 中已提交的资源。
const sharp = require(process.env.SHARP_MODULE || 'sharp');
const directory = path.resolve(__dirname, '../assets');
const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

function dib(rgba, size) {
  const stride = Math.ceil(size / 32) * 4;
  const result = Buffer.alloc(40 + size * size * 4 + stride * size);
  result.writeUInt32LE(40, 0);
  result.writeInt32LE(size, 4);
  result.writeInt32LE(size * 2, 8);
  result.writeUInt16LE(1, 12);
  result.writeUInt16LE(32, 14);
  result.writeUInt32LE(result.length - 40, 20);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const source = (y * size + x) * 4,
        target = 40 + ((size - 1 - y) * size + x) * 4;
      result[target] = rgba[source + 2];
      result[target + 1] = rgba[source + 1];
      result[target + 2] = rgba[source];
      result[target + 3] = rgba[source + 3];
      if (rgba[source + 3] === 0)
        result[40 + size * size * 4 + (size - 1 - y) * stride + (x >> 3)] |= 128 >> (x & 7);
    }
  return result;
}

async function main() {
  const svg = fs.readFileSync(path.join(directory, 'codex-token.svg'));
  const frames = [];
  for (const size of sizes) {
    // 各尺寸分别从矢量母版栅格化，不放大小位图；通过超采样保持圆角边缘平滑。
    const large = await sharp(svg)
      .resize(size * 4, size * 4)
      .png()
      .toBuffer();
    const rgba = await sharp(large).resize(size, size).ensureAlpha().raw().toBuffer();
    // 清除重采样在圆角底板外产生的微弱透明度振铃，保留可见的抗锯齿边缘。
    for (let alpha = 3; alpha < rgba.length; alpha += 4)
      if (rgba[alpha] <= 3) rgba.fill(0, alpha - 3, alpha + 1);
    const png = await sharp(rgba, { raw: { width: size, height: size, channels: 4 } })
      .png()
      .toBuffer();
    frames.push({ size, png, bytes: size === 256 ? png : dib(rgba, size) });
  }
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, bytes }, i) => {
    const entry = 6 + i * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(bytes.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += bytes.length;
  });
  fs.writeFileSync(
    path.join(directory, 'codex-token.ico'),
    Buffer.concat([header, ...frames.map((frame) => frame.bytes)]),
  );
  fs.writeFileSync(path.join(directory, 'codex-token.png'), frames.at(-1).png);

  const width = 560,
    height = 336;
  const background = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><path fill="#F3F5F2" d="M0 0h560v168H0z"/><path fill="#101914" d="M0 168h560v168H0z"/></svg>`,
  );
  const layers = [];
  for (const row of [0, 1]) {
    let left = 24;
    for (const size of [16, 20, 24, 32, 48, 64, 128]) {
      layers.push({
        input: frames.find((frame) => frame.size === size).png,
        left,
        top: row * 168 + Math.round((168 - size) / 2),
      });
      left += size + 24;
    }
  }
  const artifacts = path.resolve(__dirname, '../.artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  await sharp(background)
    .composite(layers)
    .png()
    .toFile(path.join(artifacts, 'app-icon-preview.png'));
  console.log('Created vector-derived Windows icon frames: ' + sizes.join(', ') + ' px');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
