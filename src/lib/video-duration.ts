/**
 * Container duration for the Reverse 3D upload cap.
 * MP4/MOV: movie header, or the longest track header when that is longer.
 * WebM: Info Duration, otherwise the latest cluster or block timestamp.
 * Chrome MediaRecorder often omits Duration and writes an unknown-size Segment.
 */

export const VIDEO_DURATION_SLACK_SECONDS = 0.25;

const CLUSTER_ID = 0x1f43b675;
const SEGMENT_ID = 0x18538067;
const INFO_ID = 0x1549a966;
const SIMPLE_BLOCK_ID = 0xa3;
const BLOCK_ID = 0xa1;
const BLOCK_GROUP_ID = 0xa0;
const TIMESTAMP_ID = 0xe7;
const TIMECODE_SCALE_ID = 0x2ad7b1;
const DURATION_ID = 0x4489;

type Vint = { length: number; data: bigint; unknown: boolean };

function vint(buf: Buffer, offset: number): Vint | null {
  if (offset >= buf.length) return null;
  const marker = buf[offset] ?? 0;
  let mask = 0x80;
  let length = 1;
  while (length <= 8 && (marker & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8 || offset + length > buf.length) return null;
  let data = BigInt(marker & ((mask - 1) & 0xff));
  for (let index = 1; index < length; index += 1) data = (data << 8n) + BigInt(buf[offset + index] ?? 0);
  const width = 7n * BigInt(length);
  return { length, data, unknown: data === (1n << width) - 1n };
}

function elementId(buf: Buffer, offset: number): { value: number; length: number } | null {
  const sized = vint(buf, offset);
  if (!sized) return null;
  let value = 0;
  for (let index = 0; index < sized.length; index += 1) value = value * 256 + (buf[offset + index] ?? 0);
  return { value, length: sized.length };
}

function readUint(buf: Buffer, offset: number, size: number): number | null {
  if (size < 1 || size > 8 || offset + size > buf.length) return null;
  if (size <= 6) return buf.readUIntBE(offset, size);
  const value = buf.readBigUInt64BE(offset + size - 8);
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readFloat(buf: Buffer, offset: number, size: number): number | null {
  if (size === 4 && offset + 4 <= buf.length) return buf.readFloatBE(offset);
  if (size === 8 && offset + 8 <= buf.length) return buf.readDoubleBE(offset);
  return null;
}

function boxSize(buf: Buffer, offset: number): { size: number; header: number } | null {
  if (offset + 8 > buf.length) return null;
  const size32 = buf.readUInt32BE(offset);
  if (size32 === 1) {
    if (offset + 16 > buf.length) return null;
    const size = Number(buf.readBigUInt64BE(offset + 8));
    if (!Number.isSafeInteger(size) || size < 16) return null;
    return { size, header: 16 };
  }
  if (size32 < 8) return null;
  return { size: size32, header: 8 };
}

function headerSeconds(buf: Buffer, content: number, end: number): number | null {
  if (content >= end) return null;
  const version = buf[content] ?? 0;
  if (version === 0) {
    if (content + 20 > end) return null;
    const timescale = buf.readUInt32BE(content + 12);
    const duration = buf.readUInt32BE(content + 16);
    if (timescale === 0) return null;
    return duration / timescale;
  }
  if (version === 1) {
    if (content + 32 > end) return null;
    const timescale = buf.readUInt32BE(content + 20);
    const duration = buf.readBigUInt64BE(content + 24);
    if (timescale === 0) return null;
    return Number(duration) / timescale;
  }
  return null;
}

const ISO_PARENT = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "moof", "mvex"]);

function readIsoDuration(buf: Buffer): number | null {
  let best = 0;
  const walk = (offset: number, end: number) => {
    let cursor = offset;
    while (cursor + 8 <= end) {
      const box = boxSize(buf, cursor);
      if (!box || cursor + box.size > end) return;
      const type = buf.toString("latin1", cursor + 4, cursor + 8);
      const content = cursor + box.header;
      const boxEnd = cursor + box.size;
      if (type === "mvhd" || type === "mdhd") {
        const seconds = headerSeconds(buf, content, boxEnd);
        if (seconds && seconds > best) best = seconds;
      } else if (ISO_PARENT.has(type)) {
        walk(content, boxEnd);
      }
      cursor = boxEnd;
    }
  };
  walk(0, buf.length);
  return best > 0 ? best : null;
}

function blockOffset(buf: Buffer, data: number, end: number): number | null {
  const track = vint(buf, data);
  if (!track) return null;
  const at = data + track.length;
  if (at + 2 > end || at + 2 > buf.length) return null;
  return buf.readInt16BE(at);
}

function findNextCluster(buf: Buffer, from: number, end: number): number | null {
  const limit = Math.min(buf.length, end);
  for (let index = from; index + 8 < limit; index += 1) {
    if (buf[index] !== 0x1f || buf[index + 1] !== 0x43 || buf[index + 2] !== 0xb6 || buf[index + 3] !== 0x75) continue;
    const size = vint(buf, index + 4);
    if (!size) continue;
    const data = index + 4 + size.length;
    if (data >= limit || buf[data] !== TIMESTAMP_ID) continue;
    const tsSize = vint(buf, data + 1);
    if (!tsSize || tsSize.unknown || tsSize.data < 1n || tsSize.data > 8n) continue;
    return index;
  }
  return null;
}

type Timing = { scale: number; infoTicks: number | null; maxTick: number | null };

function note(timing: Timing, tick: number) {
  if (!Number.isFinite(tick)) return;
  timing.maxTick = timing.maxTick === null ? tick : Math.max(timing.maxTick, tick);
}

function readCluster(buf: Buffer, start: number, end: number, timing: Timing) {
  let timestamp: number | null = null;
  const offsets: number[] = [];
  const limit = Math.min(buf.length, end);
  let offset = start;
  while (offset + 2 <= limit) {
    const id = elementId(buf, offset);
    const size = id ? vint(buf, offset + id.length) : null;
    if (!id || !size) break;
    const data = offset + id.length + size.length;
    if (data > limit) break;
    const childEnd = size.unknown ? limit : Math.min(limit, data + Number(size.data));
    if (id.value === TIMESTAMP_ID && !size.unknown) {
      const value = readUint(buf, data, Number(size.data));
      if (value !== null) timestamp = value;
    } else if ((id.value === SIMPLE_BLOCK_ID || id.value === BLOCK_ID) && !size.unknown) {
      const rel = blockOffset(buf, data, childEnd);
      if (rel !== null) offsets.push(rel);
    }
    if (id.value === BLOCK_GROUP_ID && !size.unknown) {
      let inner = data;
      const groupEnd = childEnd;
      while (inner + 2 <= groupEnd) {
        const innerId = elementId(buf, inner);
        const innerSize = innerId ? vint(buf, inner + innerId.length) : null;
        if (!innerId || !innerSize || innerSize.unknown) break;
        const innerData = inner + innerId.length + innerSize.length;
        const innerEnd = Math.min(groupEnd, innerData + Number(innerSize.data));
        if (innerEnd < innerData || innerEnd > buf.length) break;
        if (innerId.value === BLOCK_ID) {
          const rel = blockOffset(buf, innerData, innerEnd);
          if (rel !== null) offsets.push(rel);
        }
        if (innerEnd <= inner) break;
        inner = innerEnd;
      }
    }
    if (size.unknown || childEnd <= offset) break;
    offset = childEnd;
  }
  const base = timestamp ?? 0;
  if (timestamp !== null) note(timing, timestamp);
  for (const rel of offsets) note(timing, base + rel);
}

function readWebmDuration(buf: Buffer): number | null {
  const timing: Timing = { scale: 1_000_000, infoTicks: null, maxTick: null };
  const walk = (offset: number, end: number) => {
    const limit = Math.min(buf.length, end);
    let cursor = offset;
    while (cursor + 2 <= limit) {
      const id = elementId(buf, cursor);
      const size = id ? vint(buf, cursor + id.length) : null;
      if (!id || !size) return;
      const data = cursor + id.length + size.length;
      if (data > limit) return;
      if (id.value === CLUSTER_ID && size.unknown) {
        const next = findNextCluster(buf, data, limit);
        const childEnd = next ?? limit;
        readCluster(buf, data, childEnd, timing);
        if (next === null) return;
        cursor = next;
        continue;
      }
      if (size.unknown) {
        if (id.value === SEGMENT_ID || id.value === 0x1a45dfa3) {
          walk(data, limit);
        }
        return;
      }
      const declared = data + Number(size.data);
      if (!Number.isFinite(declared) || declared < data) return;
      const childEnd = Math.min(limit, declared);
      const truncated = declared > limit;
      if (id.value === TIMECODE_SCALE_ID) {
        const scale = readUint(buf, data, Number(size.data));
        if (scale && scale > 0) timing.scale = scale;
      } else if (id.value === DURATION_ID) {
        const ticks = readFloat(buf, data, Number(size.data));
        if (ticks !== null && Number.isFinite(ticks) && ticks > 0) timing.infoTicks = ticks;
      } else if (id.value === CLUSTER_ID) {
        readCluster(buf, data, childEnd, timing);
      } else if (id.value === SEGMENT_ID || id.value === INFO_ID || id.value === 0x1a45dfa3) {
        walk(data, childEnd);
      }
      if (truncated || childEnd <= cursor) return;
      cursor = childEnd;
    }
  };
  walk(0, buf.length);
  const fromInfo = timing.infoTicks !== null ? (timing.infoTicks * timing.scale) / 1e9 : null;
  const fromClusters = timing.maxTick !== null ? (timing.maxTick * timing.scale) / 1e9 : null;
  if (fromInfo === null && fromClusters === null) return null;
  return Math.max(fromInfo ?? 0, fromClusters ?? 0);
}

/** Seconds, or null when the container has no duration and no timestamps. */
export function readContainerDurationSeconds(buf: Buffer): number | null {
  if (buf.length >= 12 && buf.toString("latin1", 4, 8) === "ftyp") return readIsoDuration(buf);
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return readWebmDuration(buf);
  }
  return null;
}

export function durationOverCap(seconds: number, maxSeconds: number): boolean {
  return seconds > maxSeconds + VIDEO_DURATION_SLACK_SECONDS;
}
