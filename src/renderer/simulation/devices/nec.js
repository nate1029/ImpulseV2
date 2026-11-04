// NEC infrared protocol as seen on a demodulating receiver's output (active
// LOW): 9 ms burst, 4.5 ms space, 32 bits LSB first (address, ~address,
// command, ~command), each a 562.5 µs burst followed by a 562.5 µs (0) or
// 1687.5 µs (1) space, then a final burst. Held buttons send repeat codes
// every 108 ms.

const T = 562.5;

/** [level, microseconds] segments; level is the receiver output (0 = burst). */
export function necFrame(address, command) {
  const seg = [[0, 9000], [1, 4500]];
  const bytes = [address & 0xff, ~address & 0xff, command & 0xff, ~command & 0xff];
  for (const byte of bytes) {
    for (let bit = 0; bit < 8; bit++) {
      seg.push([0, T]);
      seg.push([1, (byte >> bit) & 1 ? 3 * T : T]);
    }
  }
  seg.push([0, T]);
  return seg;
}

export function necRepeat() {
  return [[0, 9000], [1, 2250], [0, T]];
}

/** Total duration of a segment list in µs. */
export function duration(segments) {
  return segments.reduce((a, s) => a + s[1], 0);
}
