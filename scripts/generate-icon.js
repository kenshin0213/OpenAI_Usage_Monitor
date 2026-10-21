/**
 * scripts/generate-icon.js
 * 
 * Node.js 내장 모듈(Buffer, zlib)만을 사용하여
 * 64x64 RGBA 트레이 아이콘(PNG)을 생성하는 유틸리티 스크립트.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC32 테이블 생성
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = data.length;
  const header = Buffer.alloc(4);
  header.writeUInt32BE(len, 0);

  const toCrc = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(toCrc), 0);

  return Buffer.concat([header, typeBuf, data, crc]);
}

function createPng(width, height, pixelBuffer) {
  // PNG 서명 (8바이트)
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR 청크
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8);   // bit depth: 8
  ihdrData.writeUInt8(6, 9);   // color type: 6 (RGBA)
  ihdrData.writeUInt8(0, 10);  // compression method
  ihdrData.writeUInt8(0, 11);  // filter method
  ihdrData.writeUInt8(0, 12);  // interlace method: 0 (no interlace)
  const ihdrChunk = makeChunk('IHDR', ihdrData);

  // IDAT 청크 (각 스캔라인 앞에 필터 바이트 0x00 추가 후 zlib 압축)
  const rowSize = 1 + width * 4;
  const rawData = Buffer.alloc(rowSize * height);

  for (let y = 0; y < height; y++) {
    rawData[y * rowSize] = 0; // Filter: None
    pixelBuffer.copy(rawData, y * rowSize + 1, y * width * 4, (y + 1) * width * 4);
  }

  const deflatedData = zlib.deflateSync(rawData, { level: 9 });
  const idatChunk = makeChunk('IDAT', deflatedData);

  // IEND 청크
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function generateMonitorIcon(size = 64) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const maxR = size * 0.46; // 외곽 반경 (~29.4)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx); // -PI ~ PI

      if (dist > maxR + 1) {
        // 투명 영역
        buf[idx] = 0;
        buf[idx + 1] = 0;
        buf[idx + 2] = 0;
        buf[idx + 3] = 0;
      } else {
        // 부드러운 안티앨리어싱
        let alpha = 1.0;
        if (dist > maxR - 1) {
          alpha = Math.max(0, Math.min(1, maxR + 1 - dist));
        }

        // 기본 배경: 짙은 다크 차콜 (#151718)
        let r = 21;
        let g = 23;
        let b = 24;
        let a = 255 * alpha;

        // 외부 링 (Slot 1 표시 게이지 - 에메랄드 그린 #10a37f)
        const outerRingInner = size * 0.35;
        const outerRingOuter = size * 0.44;
        if (dist >= outerRingInner && dist <= outerRingOuter) {
          // 게이지 느낌: 상단 270도 호 (arc)
          const normAngle = (angle + Math.PI * 0.5 + Math.PI * 2) % (Math.PI * 2);
          if (normAngle < Math.PI * 1.6) {
            r = 16;
            g = 163;
            b = 127;
            a = 255 * alpha;
          } else {
            // 미사용 잔여 게이지 트랙
            r = 45;
            g = 55;
            b = 60;
            a = 200 * alpha;
          }
        }

        // 내부 링 (Slot 2 표시 게이지 - 시안/스카이블루 #0ea5e9)
        const innerRingInner = size * 0.23;
        const innerRingOuter = size * 0.31;
        if (dist >= innerRingInner && dist <= innerRingOuter) {
          const normAngle = (angle + Math.PI * 0.5 + Math.PI * 2) % (Math.PI * 2);
          if (normAngle < Math.PI * 1.3) {
            r = 14;
            g = 165;
            b = 233;
            a = 240 * alpha;
          } else {
            r = 38;
            g = 48;
            b = 58;
            a = 180 * alpha;
          }
        }

        // 중심 코어 (빛나는 인디케이터 도트 - 화이트/에메랄드 틴트)
        const coreR = size * 0.12;
        if (dist <= coreR) {
          const coreT = 1 - (dist / coreR);
          r = Math.round(240 * coreT + 16 * (1 - coreT));
          g = Math.round(255 * coreT + 163 * (1 - coreT));
          b = Math.round(250 * coreT + 127 * (1 - coreT));
          a = 255 * alpha;
        }

        buf[idx] = r;
        buf[idx + 1] = g;
        buf[idx + 2] = b;
        buf[idx + 3] = Math.round(a);
      }
    }
  }

  return createPng(size, size, buf);
}

/**
 * 복수의 PNG 버퍼를 하나의 Windows .ico 포맷 버퍼로 패키징합니다.
 * @param {Array<{ width: number, height: number, buffer: Buffer }>} pngEntries 
 * @returns {Buffer}
 */
function createIco(pngEntries) {
  const count = pngEntries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // ICO type (1 = icon)
  header.writeUInt16LE(count, 4); // number of images

  const entries = [];
  let offset = 6 + count * 16;

  for (const img of pngEntries) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(img.width >= 256 ? 0 : img.width, 0);
    entry.writeUInt8(img.height >= 256 ? 0 : img.height, 1);
    entry.writeUInt8(0, 2); // palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(img.buffer.length, 8); // size
    entry.writeUInt32LE(offset, 12); // offset
    entries.push(entry);
    offset += img.buffer.length;
  }

  return Buffer.concat([header, ...entries, ...pngEntries.map(e => e.buffer)]);
}

// assets 디렉터리 생성 및 파일 저장
const assetsDir = path.resolve(__dirname, '..', 'assets');
if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
}

// 1. icon.png (64x64) 저장
const iconPngPath = path.join(assetsDir, 'icon.png');
const pngData = generateMonitorIcon(64);
fs.writeFileSync(iconPngPath, pngData);
console.log(`Successfully generated: ${iconPngPath} (${pngData.length} bytes)`);

// 2. icon.ico (16, 24, 32, 64px 멀티 해상도) 저장
const iconIcoPath = path.join(assetsDir, 'icon.ico');
const p16 = generateMonitorIcon(16);
const p24 = generateMonitorIcon(24);
const p32 = generateMonitorIcon(32);
const p64 = generateMonitorIcon(64);
const icoData = createIco([
  { width: 16, height: 16, buffer: p16 },
  { width: 24, height: 24, buffer: p24 },
  { width: 32, height: 32, buffer: p32 },
  { width: 64, height: 64, buffer: p64 },
]);
fs.writeFileSync(iconIcoPath, icoData);
console.log(`Successfully generated: ${iconIcoPath} (${icoData.length} bytes)`);

module.exports = {
  crc32,
  makeChunk,
  createPng,
  createIco,
  generateMonitorIcon,
};
