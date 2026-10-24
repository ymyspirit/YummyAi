import sharp from "sharp";
import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } from "mediabunny";

/** All bytes are generated locally. The VP8 frame is genuinely encoded by
 * libwebp; the WebM contains two timed intra packets, not magic-header stubs. */
export async function studioOriginalMedia() {
  const width = 640, height = 360;
  const image = sharp({ create: { width, height, channels: 3, background: { r: 27, g: 83, b: 173 } } });
  const png = await image.clone().png().toBuffer();
  const jpeg = await image.clone().jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const imageWebp = await image.clone().webp({ quality: 75 }).toBuffer();
  const webp = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#285eb2" } }).webp({ quality: 70 }).toBuffer();
  let frame: Buffer | undefined;
  for (let offset = 12; offset + 8 <= webp.length;) {
    const length = webp.readUInt32LE(offset + 4), end = offset + 8 + length;
    if (end > webp.length) throw new Error("studio_original_fixture_webp_invalid");
    if (webp.toString("ascii", offset, offset + 4) === "VP8 ") frame = webp.subarray(offset + 8, end);
    offset = end + (length & 1);
  }
  if (!frame?.length) throw new Error("studio_original_fixture_vp8_missing");
  const id = (hex: string) => Buffer.from(hex, "hex");
  const size = (length: number) => {
    let bytes = 1; while (length >= 2 ** (7 * bytes) - 1) bytes++;
    const value = Buffer.alloc(bytes); let left = length;
    for (let offset = bytes - 1; offset >= 0; offset--) { value[offset] = left & 255; left = Math.floor(left / 256); }
    value[0]! |= 1 << (8 - bytes); return value;
  };
  const element = (hex: string, body: Buffer) => Buffer.concat([id(hex), size(body.length), body]);
  const uint = (value: number) => {
    let bytes = 1; while (value >= 2 ** (8 * bytes)) bytes++;
    const body = Buffer.alloc(bytes); let left = value;
    for (let offset = bytes - 1; offset >= 0; offset--) { body[offset] = left & 255; left = Math.floor(left / 256); }
    return body;
  };
  const number = (hex: string, value: number) => element(hex, uint(value));
  const text = (hex: string, value: string) => element(hex, Buffer.from(value));
  const duration = Buffer.alloc(8); duration.writeDoubleBE(1000);
  const header = element("1a45dfa3", Buffer.concat([number("4286", 1), number("42f7", 1), number("42f2", 4),
    number("42f3", 8), text("4282", "webm"), number("4287", 4), number("4285", 2)]));
  const info = element("1549a966", Buffer.concat([number("2ad7b1", 1_000_000), text("4d80", "YummyAI synthetic fixture"),
    text("5741", "YummyAI synthetic fixture"), element("4489", duration)]));
  const video = element("e0", Buffer.concat([number("b0", 64), number("ba", 48)]));
  const tracks = element("1654ae6b", element("ae", Buffer.concat([number("d7", 1), number("73c5", 1), number("83", 1),
    number("23e383", 500_000_000), text("86", "V_VP8"), video])));
  const block = (time: number) => { const prefix = Buffer.alloc(4); prefix[0] = 0x81; prefix.writeInt16BE(time, 1); prefix[3] = 0x80;
    return element("a3", Buffer.concat([prefix, frame!])); };
  const cluster = element("1f43b675", Buffer.concat([number("e7", 0), block(0), block(500)]));
  const webm = Buffer.concat([header, element("18538067", Buffer.concat([info, tracks, cluster]))]);
  const target = new BufferTarget(), mp4Output = new Output({ format: new Mp4OutputFormat(), target });
  const videoSource = new EncodedVideoPacketSource("vp8");
  mp4Output.addVideoTrack(videoSource, { frameRate: 2, rotation: 90 }); await mp4Output.start();
  await videoSource.add(new EncodedPacket(new Uint8Array(frame), "key", 0, 0.5), { decoderConfig: { codec: "vp8", codedWidth: 64, codedHeight: 48 } });
  await videoSource.add(new EncodedPacket(new Uint8Array(frame), "key", 0.5, 0.5)); await mp4Output.finalize();
  if (!target.buffer) throw new Error("studio_original_fixture_mp4_missing");
  const mp4 = Buffer.from(target.buffer);
  const samples = 1600, sampleRate = 8000, wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) wav.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / sampleRate) * 2500), 44 + index * 2);
  // MPEG-1 Layer III, 128 kbit/s, 44.1 kHz stereo. Zero side information
  // declares zero spectral coefficients and no reservoir dependency per frame.
  // These locally constructed silent frames carry no external recording.
  const silentFrame = Buffer.alloc(417); Buffer.from([0xff, 0xfb, 0x90, 0x00]).copy(silentFrame);
  const mp3Frames = 4, mp3 = Buffer.concat(Array.from({ length: mp3Frames }, () => silentFrame));
  return { png, jpeg, imageWebp, webm, mp4, wav, mp3, width, height, videoWidth: 64, videoHeight: 48,
    videoDuration: 1, audioDuration: samples / sampleRate, mp3Duration: mp3Frames * 1152 / 44100 };
}
