// Intel HEX → AVR program memory (16-bit words).
// Supports extended segment (02) and extended linear (04) address records,
// which avr-gcc emits for images above 64 KB (Mega 2560).

export function parseHex(hexString, flashBytes = 32 * 1024) {
  const progMem = new Uint8Array(flashBytes);
  let base = 0;

  for (const line of String(hexString).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(':')) continue;

    const byteCount = parseInt(trimmed.substring(1, 3), 16);
    const address = parseInt(trimmed.substring(3, 7), 16);
    const recordType = parseInt(trimmed.substring(7, 9), 16);
    const data = (i) => parseInt(trimmed.substring(9 + i * 2, 11 + i * 2), 16);

    if (recordType === 0x00) {
      for (let i = 0; i < byteCount; i++) {
        const at = base + address + i;
        if (at < progMem.length) progMem[at] = data(i);
      }
    } else if (recordType === 0x01) {
      break;
    } else if (recordType === 0x02) {
      base = ((data(0) << 8) | data(1)) * 16;
    } else if (recordType === 0x04) {
      base = ((data(0) << 8) | data(1)) << 16;
    }
  }

  return new Uint16Array(progMem.buffer);
}

/** Highest byte address written by a HEX image (to check it fits the flash). */
export function hexImageSize(hexString) {
  let base = 0;
  let end = 0;
  for (const line of String(hexString).split('\n')) {
    const t = line.trim();
    if (!t.startsWith(':')) continue;
    const count = parseInt(t.substring(1, 3), 16);
    const address = parseInt(t.substring(3, 7), 16);
    const type = parseInt(t.substring(7, 9), 16);
    if (type === 0x00) end = Math.max(end, base + address + count);
    else if (type === 0x01) break;
    else if (type === 0x02) base = parseInt(t.substring(9, 13), 16) * 16;
    else if (type === 0x04) base = parseInt(t.substring(9, 13), 16) << 16;
  }
  return end;
}
