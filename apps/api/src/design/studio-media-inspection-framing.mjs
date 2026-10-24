// Completeness checks complement the demuxer, whose normal playback recovery
// intentionally accepts some truncated files. These check declared byte ranges,
// not media quality or codec decoding. They only inspect the held byte array.
export function completeStudioContainer(bytes, mediaType) {
  try {
    if (mediaType === "audio/wav") return wave(bytes);
    if (mediaType === "video/mp4") return mp4(bytes);
    if (mediaType === "video/webm") return webm(bytes);
    if (mediaType === "audio/mpeg") return mp3(bytes);
    return false;
  } catch { return false; }
}
const ascii = (bytes, from, count) => String.fromCharCode(...bytes.subarray(from, from + count));
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
function wave(bytes) {
  const data = view(bytes), kind = ascii(bytes, 0, 4), little = kind !== "RIFX", rf64 = kind === "RF64";
  if (!["RIFF", "RIFX", "RF64"].includes(kind) || ascii(bytes, 8, 4) !== "WAVE") return false;
  let end = data.getUint32(4, little) + 8, dataSize, block = 0, audioChunks = 0, chunks = 0;
  if (rf64) {
    if (ascii(bytes, 12, 4) !== "ds64" || data.getUint32(16, true) < 28) return false;
    end = Number(data.getBigUint64(20, true)) + 8; dataSize = Number(data.getBigUint64(28, true));
  }
  if (end !== bytes.length || !Number.isSafeInteger(dataSize ?? 0)) return false;
  let at = 12;
  while (at < end) {
    if (++chunks > 100_000 || at + 8 > end) return false;
    const id = ascii(bytes, at, 4), raw = data.getUint32(at + 4, little);
    const size = rf64 && id === "data" && raw === 0xffffffff ? dataSize : raw;
    if (!Number.isSafeInteger(size) || size < 0 || at + 8 + size + (size % 2) > end) return false;
    if (id === "fmt ") { if (size < 16 || block) return false; block = data.getUint16(at + 20, little); }
    if (id === "data") { if (++audioChunks > 1 || !block || !size || size % block) return false; }
    at += 8 + size + (size % 2);
  }
  return at === end && audioChunks === 1;
}
function mp4(bytes) {
  const data = view(bytes), containers = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "mvex", "moof", "traf"]);
  let boxes = 0, movie = false, fileType = false;
  const range = (from, end, depth) => {
    if (depth > 16) return false;
    for (let at = from; at < end;) {
      if (++boxes > 100_000 || at + 8 > end) return false;
      let size = data.getUint32(at), header = 8;
      const type = ascii(bytes, at + 4, 4);
      if (size === 1) { if (at + 16 > end) return false; size = Number(data.getBigUint64(at + 8)); header = 16; }
      if (size === 0) size = end - at;
      if (!Number.isSafeInteger(size) || size < header || at + size > end) return false;
      if (!depth && type === "ftyp") fileType = true;
      if (!depth && type === "moov") movie = true;
      if (containers.has(type) && !range(at + header, at + size, depth + 1)) return false;
      at += size;
    }
    return true;
  };
  return range(0, bytes.length, 0) && fileType && movie;
}
function webm(bytes) {
  const masters = new Set([0x1a45dfa3, 0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe0, 0xe1, 0x1f43b675, 0xa0, 0x1c53bb6b, 0xbb, 0xb7, 0x114d9b74, 0x4dbb, 0x1254c367, 0x7373, 0x67c8]);
  let elements = 0, segment = false;
  const vint = (at, id) => {
    const first = bytes[at];
    if (!first) throw new Error();
    let width = 1, marker = 128;
    while (!(first & marker)) { marker >>= 1; width++; }
    if (width > (id ? 4 : 8) || at + width > bytes.length) throw new Error();
    let value = BigInt(id ? first : first & (marker - 1));
    for (let n = 1; n < width; n++) value = value * 256n + BigInt(bytes[at + n]);
    const unknown = !id && value === (1n << BigInt(width * 7)) - 1n;
    return { width, value: Number(value), unknown };
  };
  const range = (from, end, depth) => {
    if (depth > 16) return false;
    for (let at = from; at < end;) {
      if (++elements > 100_000) return false;
      const id = vint(at, true), size = vint(at + id.width, false), start = at + id.width + size.width;
      if (start > end || size.unknown && ![0x18538067, 0x1f43b675].includes(id.value)) return false;
      const next = size.unknown ? end : start + size.value;
      if (!Number.isSafeInteger(next) || next > end || next < start) return false;
      if (id.value === 0x18538067) segment = true;
      if (masters.has(id.value) && !range(start, next, depth + 1)) return false;
      at = next;
    }
    return true;
  };
  return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3 && range(0, bytes.length, 0) && segment;
}
function mp3(bytes) {
  let at = 0, end = bytes.length, frames = 0;
  while (ascii(bytes, at, 3) === "ID3") {
    if (at + 10 > end || bytes.subarray(at + 6, at + 10).some(value => value & 128)) return false;
    const size = bytes.subarray(at + 6, at + 10).reduce((total, value) => total * 128 + value, 0);
    at += 10 + size;
    if (at > end) return false;
  }
  if (end - at >= 128 && ascii(bytes, end - 128, 3) === "TAG") end -= 128;
  const mpeg1 = { 3: [0,32,64,96,128,160,192,224,256,288,320,352,384,416,448], 2: [0,32,48,56,64,80,96,112,128,160,192,224,256,320,384], 1: [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] };
  const mpeg2 = { 3: [0,32,48,56,64,80,96,112,128,144,160,176,192,224,256], 2: [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160], 1: [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160] };
  while (at < end) {
    if (at + 4 > end || bytes[at] !== 255 || (bytes[at + 1] & 224) !== 224 || ++frames > 100_000) return false;
    const version = (bytes[at + 1] >> 3) & 3, layer = (bytes[at + 1] >> 1) & 3, rateIndex = (bytes[at + 2] >> 2) & 3;
    if (version === 1 || !layer || rateIndex === 3) return false;
    const bitrate = (version === 3 ? mpeg1 : mpeg2)[layer][bytes[at + 2] >> 4];
    if (!bitrate) return false;
    const rate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4), padding = (bytes[at + 2] >> 1) & 1;
    const size = layer === 3 ? (Math.floor(12 * bitrate * 1000 / rate) + padding) * 4
      : Math.floor((layer === 1 && version !== 3 ? 72 : 144) * bitrate * 1000 / rate) + padding;
    if (size < 4 || at + size > end) return false;
    at += size;
  }
  return at === end && frames > 0;
}
