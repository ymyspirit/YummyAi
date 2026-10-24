// Mediabunny 1.62.1 is used unchanged under MPL-2.0. Its source and LICENSE stay
// in the pinned dependency. This worker only demuxes already-held original bytes;
// it does not fetch URLs, open files, transcode or claim codec-level decoding.
import { parentPort, workerData } from "node:worker_threads";
import { BufferSource, EncodedPacketSink, Input, MP3, MP4, WAVE, WEBM } from "mediabunny";
import { completeStudioContainer } from "./studio-media-inspection-framing.mjs";

const limit = 20 * 1024 * 1024, durationLimit = 86_400, packetLimit = 100_000;
const invalid = code => ({ status: "failed", code });
const dimensions = value => Number.isInteger(value) && value > 0 && value <= 65_535;

async function inspect() {
  const { bytes, mediaType } = workerData;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 16) return invalid("invalid_media");
  if (bytes.byteLength > limit) return invalid("size_limit");
  if (!completeStudioContainer(bytes, mediaType)) return invalid("invalid_media");
  const input = new Input({ source: new BufferSource(bytes), formats: [MP4, WEBM, MP3, WAVE] });
  try {
    const format = await input.getFormat();
    const expected = ({ "video/mp4": MP4, "video/webm": WEBM, "audio/mpeg": MP3, "audio/wav": WAVE })[mediaType];
    if (format !== expected) return invalid("media_type_mismatch");
    const tracks = await input.getTracks();
    if (!tracks.length || tracks.length > 8) return invalid("invalid_media");
    const videos = tracks.filter(track => track.isVideoTrack());
    if (mediaType.startsWith("video/") ? !videos.length : videos.length !== 0) return invalid("media_type_mismatch");
    let packets = 0, packetBytes = 0, duration = 0;
    for (const track of tracks) {
      if ((!track.isVideoTrack() && !track.isAudioTrack()) || await track.isLive() || !(await track.getCodec())) return invalid("invalid_media");
      let count = 0, end = 0;
      // Read all actual packet data, not metadata-only offsets or only a probe.
      // The parent can terminate this entire loop even if a parser never yields.
      for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { verifyKeyPackets: true })) {
        if (++packets > packetLimit || !packet.data.byteLength || packet.data.byteLength !== packet.byteLength ||
          !Number.isFinite(packet.timestamp) || !Number.isFinite(packet.duration) || packet.duration < 0 ||
          packet.timestamp < -durationLimit || packet.timestamp > durationLimit || packet.timestamp + packet.duration > durationLimit) return invalid("invalid_media");
        packetBytes += packet.byteLength;
        if (packetBytes > limit * 2) return invalid("invalid_media");
        count++; end = Math.max(end, packet.timestamp + packet.duration);
      }
      if (!count) return invalid("invalid_media");
      const declaredDuration = await track.getDurationFromMetadata();
      // A missing tail must not pass merely because the demuxer yielded a valid
      // prefix. Small timestamp rounding and encoder padding remain tolerated.
      if (declaredDuration !== null && (!Number.isFinite(declaredDuration) || declaredDuration > durationLimit || end > 0 && declaredDuration - end > Math.max(0.1, declaredDuration * 0.01))) return invalid("invalid_media");
      if (!(end > 0) && declaredDuration !== null) end = declaredDuration;
      if (!(end > 0)) return invalid("invalid_media");
      duration = Math.max(duration, end);
    }
    if (!(duration > 0) || duration > durationLimit) return invalid("invalid_media");
    if (!videos.length) return { status: "verified", kind: "audio", durationSeconds: duration, validation: "container_and_packets" };
    const track = videos[0];
    const [encodedWidth, encodedHeight, displayWidth, displayHeight, rotation] = await Promise.all([
      track.getCodedWidth(), track.getCodedHeight(), track.getDisplayWidth(), track.getDisplayHeight(), track.getRotation(),
    ]);
    if (![encodedWidth, encodedHeight, displayWidth, displayHeight].every(dimensions) || ![0, 90, 180, 270].includes(rotation) || encodedWidth * encodedHeight > 64_000_000 || displayWidth * displayHeight > 64_000_000) return invalid("invalid_media");
    return { status: "verified", kind: "video", encodedWidth, encodedHeight, displayWidth, displayHeight, rotation, durationSeconds: duration, validation: "container_and_packets" };
  } catch { return invalid("invalid_media"); }
  finally { input.dispose(); }
}

parentPort.postMessage(await inspect());
