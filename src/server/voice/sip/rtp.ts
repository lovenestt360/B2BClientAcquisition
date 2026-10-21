/**
 * Minimal RTP (RFC 3550) framing for Asterisk externalMedia (slin16 = 16-bit signed linear PCM,
 * 16 kHz, big-endian per RFC 3551 L16). Used by the future SIP media bridge; no network I/O here.
 */
export interface RtpPacket {
  version: number;
  payloadType: number;
  sequence: number;
  timestamp: number;
  ssrc: number;
  marker: boolean;
  payload: Buffer;
}

export function parseRtp(buf: Buffer): RtpPacket {
  if (buf.length < 12) throw new Error("RTP packet too short");
  const b0 = buf[0];
  const version = b0 >> 6;
  if (version !== 2) throw new Error(`unsupported RTP version ${version}`);
  const csrcCount = b0 & 0x0f;
  const hasExtension = (b0 & 0x10) !== 0;
  const padding = (b0 & 0x20) !== 0;
  let offset = 12 + csrcCount * 4;
  if (hasExtension) {
    const extLen = buf.readUInt16BE(offset + 2);
    offset += 4 + extLen * 4;
  }
  let end = buf.length;
  if (padding) end -= buf[buf.length - 1];
  return {
    version,
    marker: (buf[1] & 0x80) !== 0,
    payloadType: buf[1] & 0x7f,
    sequence: buf.readUInt16BE(2),
    timestamp: buf.readUInt32BE(4),
    ssrc: buf.readUInt32BE(8),
    payload: buf.subarray(offset, end),
  };
}

export function buildRtp(p: Omit<RtpPacket, "version">): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = (p.marker ? 0x80 : 0) | (p.payloadType & 0x7f);
  header.writeUInt16BE(p.sequence & 0xffff, 2);
  header.writeUInt32BE(p.timestamp >>> 0, 4);
  header.writeUInt32BE(p.ssrc >>> 0, 8);
  return Buffer.concat([header, p.payload]);
}

/** Split PCM into 20 ms frames (slin16: 16000 Hz × 2 bytes × 0.02 s = 640 bytes). */
export function framePcm(pcm: Buffer, frameBytes = 640): Buffer[] {
  const frames: Buffer[] = [];
  for (let i = 0; i < pcm.length; i += frameBytes) {
    const f = pcm.subarray(i, i + frameBytes);
    frames.push(f.length === frameBytes ? f : Buffer.concat([f, Buffer.alloc(frameBytes - f.length)]));
  }
  return frames;
}
