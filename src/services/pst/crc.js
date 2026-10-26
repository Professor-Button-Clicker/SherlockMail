import zlib from 'zlib';

// MS-PST section 5.3 CRC: the standard reflected CRC-32, seeded with 0 and with no final XOR.
// zlib's CRC-32 inverts on the way in and out, so seeding it with all ones and inverting the
// result gives the same value at native speed; the table version covers runtimes without it.
const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c >>> 0;
}

export function pstCrc(buf, start = 0, end = buf.length) {
  if (zlib.crc32) return end > start ? (zlib.crc32(buf.subarray(start, end), 0xFFFFFFFF) ^ 0xFFFFFFFF) >>> 0 : 0;
  let crc = 0;
  for (let i = start; i < end; i++) crc = TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return crc >>> 0;
}

// MS-PST section 5.5: XOR the file offset with the BID, then fold the high and low 16 bits.
export function blockSignature(ib, bid) {
  const x = Number((BigInt(ib) ^ BigInt(bid)) & 0xFFFFFFFFn);
  return ((x >>> 16) ^ x) & 0xFFFF;
}
