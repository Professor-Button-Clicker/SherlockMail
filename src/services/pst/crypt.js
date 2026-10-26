// Data-block encodings of a PST (MS-PST sections 5.1 and 5.2). Outlook writes NDB_CRYPT_PERMUTE by
// default; NDB_CRYPT_CYCLIC is rarer. Both apply only to the data of external (non-internal) blocks.
// mpbbCrypt from the specification: three 256-byte tables R, S and I (I is the inverse of R).
const CRYPT = Buffer.from(
  '41361362a8216ebbf416cc047f64e85d1ef2cb2a74c55e35d295479e962d9a884c7d843fdbac31b6485ff6c4d8398be7233b388ec8c1df25b120a546604e9cfb' +
  'aad35651457c550007c92b9d859b09a08fadb30f63ab894bd7a7155a716642bf264a6b98faea7753b270052cfd593a867ece06eb827857c78d43afb41cd45bcd' +
  'e2e9274fc3087280cfb0eff5286dbe304d3492d50e3c2232e5e4f99fc2d10a8112e1ee918376e397e6618a1779a4b7dc907a5c8c02a6ca69de501a1193b95287' +
  '58fced1d37491b6ae0293399bd6cd994f340546ff0c673b8d63e6518441fdd6710f10c19ecae03a1147ba90bfff8a3c0a201f72ebc2468750dfeba2fb5d0da3d' +
  '14530f56b3c87a9ceb65481716159f02cc547c83000d0c0ba262a876dbd9edc7c5a4dcac8574d6d0a79bae9a967166c36399b8dd73928e847da55ed15d93b157' +
  '5150808952944f4e0a6bbc8d7f6e47464140440111cb033ff7f4e1a98f3c3af9fbf0193082092ec99da08649ee6f4d6dc42d813425871b88aafc06a11238fd4c' +
  '4272641337246a757743ffe6b44b365ce4d8353d45b92cecb7312b290768a30e697b189e2139be281a5b78f523ca2ab0af3efe048ce7e5983295d3f64ae8a6ea' +
  'e9f3d52f7020f21f0567ad5510cecde3273bdabad7c226d4911dd21c2233f8faf15aefcf90b68bb5bdc0bf08971e6ce261e0c6c159abbb58de5fdf60797eb28a' +
  '47f1b4e60b6a7248854e9eebe2f89453e0bba002e85a09abdbe3bac67cc310dd39059630f53760828cc9134a6b1df3fb8f2697ca911701c4322d6e3195ffd923' +
  'd1005e79dc443b1a28c5615720903d83b943be67d2464276c06d5b7eb20f16293ca903540dda5ddff6b7c762cd8d06d3695c86d614f7a56675acb1e94521700c' +
  '879f74a4224c6fbf1f56aa2eb3783350b0a392bccf191ca763cb1e4d3e4b1b9b4fe7f0eead3ab55904ea40552551e57a893868527bfc27aed7bdfa07f4cc8e5f' +
  'ef359c842b15d5773449b6120a7f7188fd9d18417d93d8582ccefe24afdeb836c8a180a69998a82f0e816573e4c2a28ad4e111d0088b2af2ed9a643fc16cf9ec',
  'hex');
const R = CRYPT.subarray(0, 256);
const S = CRYPT.subarray(256, 512);
const I = CRYPT.subarray(512, 768);

export const CRYPT_NONE = 0x00;
export const CRYPT_PERMUTE = 0x01;
export const CRYPT_CYCLIC = 0x02;

// Decodes a block's data in place.
export function decodeBlock(buf, method, bid) {
  if (method === CRYPT_PERMUTE) {
    for (let k = 0; k < buf.length; k++) buf[k] = I[buf[k]];
  } else if (method === CRYPT_CYCLIC) {
    const key = Number(BigInt(bid) & 0xFFFFFFFFn);
    let w = (key ^ (key >>> 16)) & 0xFFFF;
    for (let k = 0; k < buf.length; k++) {
      let b = buf[k];
      b = (b + (w & 0xFF)) & 0xFF;
      b = R[b];
      b = (b + (w >> 8)) & 0xFF;
      b = S[b];
      b = (b - (w >> 8)) & 0xFF;
      b = I[b];
      b = (b - (w & 0xFF)) & 0xFF;
      buf[k] = b;
      w = (w + 1) & 0xFFFF;
    }
  } else if (method !== CRYPT_NONE) {
    throw new Error(`Unsupported PST encoding 0x${method.toString(16)} (Windows Information Protection encrypted PSTs cannot be read)`);
  }
  return buf;
}

// Encodes a block's data in place (used by tests to produce encoded PSTs).
export function encodeBlock(buf, method, bid) {
  if (method === CRYPT_PERMUTE) {
    for (let k = 0; k < buf.length; k++) buf[k] = R[buf[k]];
    return buf;
  }
  return decodeBlock(buf, method, bid);  // the cyclic cipher is symmetric
}
