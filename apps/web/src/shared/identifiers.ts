export function uuid7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const timestamp_ms = Date.now();
  const timestamp_high = Math.floor(timestamp_ms / 0x100000000) & 0xffff;
  const timestamp_low = timestamp_ms >>> 0;
  bytes[0] = (timestamp_high >>> 8) & 0xff;
  bytes[1] = timestamp_high & 0xff;
  bytes[2] = (timestamp_low >>> 24) & 0xff;
  bytes[3] = (timestamp_low >>> 16) & 0xff;
  bytes[4] = (timestamp_low >>> 8) & 0xff;
  bytes[5] = timestamp_low & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return format_hex(bytes);
}

function format_hex(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
