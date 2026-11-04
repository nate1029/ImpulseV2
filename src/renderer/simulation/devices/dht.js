// DHT11 / DHT22 (AM2302) single-wire response.
//
// The host pulls the line LOW (≥1 ms for DHT22, ≥18 ms for DHT11) and
// releases it. The sensor answers ~30 µs later: 80 µs LOW, 80 µs HIGH, then
// 40 bits, each 50 µs LOW followed by 26 µs (0) or 70 µs (1) HIGH, and a final
// 50 µs LOW before letting the line go.

export function dhtBytes(model, temperature, humidity) {
  let b;
  if (model === 'dht11') {
    const h = Math.max(0, Math.min(99, Math.round(humidity)));
    const t = Math.max(0, Math.min(60, temperature));
    const ti = Math.floor(t);
    const tf = Math.round((t - ti) * 10) % 10;
    b = [h, 0, ti, tf];
  } else {
    const h = Math.max(0, Math.min(1000, Math.round(humidity * 10)));
    const tAbs = Math.min(1250, Math.round(Math.abs(temperature) * 10));
    const t = temperature < 0 ? (0x8000 | tAbs) : tAbs;
    b = [h >> 8, h & 0xff, t >> 8, t & 0xff];
  }
  b.push((b[0] + b[1] + b[2] + b[3]) & 0xff);
  return b;
}

/**
 * Response as [level, microseconds] segments the sensor drives, starting
 * after the host releases the line.
 */
export function dhtWaveform(model, temperature, humidity) {
  const seg = [[1, 30], [0, 80], [1, 80]];
  for (const byte of dhtBytes(model, temperature, humidity)) {
    for (let bit = 7; bit >= 0; bit--) {
      seg.push([0, 50]);
      seg.push([1, (byte >> bit) & 1 ? 70 : 26]);
    }
  }
  seg.push([0, 50]);
  return seg;
}

/** Minimum start-signal LOW time the sensor accepts (µs). */
export const DHT_START_US = { dht22: 800, dht11: 10000 };
