// Build an Intel HEX image from 16-bit AVR instruction words.
export function wordsToHex(words) {
  const bytes = [];
  for (const w of words) bytes.push(w & 0xff, (w >> 8) & 0xff);
  const lines = [];
  for (let addr = 0; addr < bytes.length; addr += 16) {
    const chunk = bytes.slice(addr, addr + 16);
    const record = [chunk.length, (addr >> 8) & 0xff, addr & 0xff, 0, ...chunk];
    const checksum = (0x100 - (record.reduce((a, b) => a + b, 0) & 0xff)) & 0xff;
    lines.push(':' + [...record, checksum].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase());
  }
  lines.push(':00000001FF');
  return lines.join('\n');
}

// sbi DDRB,5 ; loop: sbi PORTB,5 ; cbi PORTB,5 ; rjmp loop  → D13 square wave
export const TOGGLE_D13 = [0x9a25, 0x9a2d, 0x982d, 0xcffd];
