import { HD44780 } from '../hd44780.js';

// Send one nibble / byte through a PCF8574 backpack the way LiquidCrystal_I2C does.
function sendNibble(lcd, nibble, rs) {
  const base = (nibble << 4) | (rs ? 0x01 : 0) | 0x08;
  lcd.writePcf(base | 0x04);
  lcd.writePcf(base);
}
function sendByte(lcd, byte, rs) {
  sendNibble(lcd, byte >> 4, rs);
  sendNibble(lcd, byte & 0x0f, rs);
}
// LiquidCrystal(_I2C)::begin(): three 8-bit function sets, then switch to 4-bit.
function init(lcd) {
  sendNibble(lcd, 0x3, false);
  sendNibble(lcd, 0x3, false);
  sendNibble(lcd, 0x3, false);
  sendNibble(lcd, 0x2, false);
  sendByte(lcd, 0x28, false); // 4-bit, 2 lines
  sendByte(lcd, 0x0c, false); // display on
  sendByte(lcd, 0x01, false); // clear
  sendByte(lcd, 0x06, false); // entry mode: increment
}
const text = (lcd) => String.fromCharCode(...lcd.toCharacters());

describe('HD44780', () => {
  it('renders text written over I2C, including the second row', () => {
    const lcd = new HD44780(16, 2);
    init(lcd);
    for (const ch of 'Hi') sendByte(lcd, ch.charCodeAt(0), true);
    sendByte(lcd, 0x80 | 0x40, false); // set DDRAM address: row 2
    for (const ch of 'OK') sendByte(lcd, ch.charCodeAt(0), true);
    expect(text(lcd).slice(0, 16).trimEnd()).toBe('Hi');
    expect(text(lcd).slice(16).trimEnd()).toBe('OK');
  });

  it('clears the display and honours display off', () => {
    const lcd = new HD44780();
    init(lcd);
    sendByte(lcd, 'X'.charCodeAt(0), true);
    sendByte(lcd, 0x01, false);
    expect(text(lcd).trim()).toBe('');
    sendByte(lcd, 'Y'.charCodeAt(0), true);
    sendByte(lcd, 0x08, false); // display off
    expect(text(lcd).trim()).toBe('');
  });

  it('tracks the backlight bit', () => {
    const lcd = new HD44780();
    lcd.writePcf(0x00);
    expect(lcd.backlight).toBe(false);
  });

  it('works over an 8-bit parallel bus', () => {
    const lcd = new HD44780(16, 2);
    for (const b of [0x38, 0x0c, 0x01, 0x06]) lcd.writeParallelByte(false, b);
    for (const ch of 'Bus') lcd.writeParallelByte(true, ch.charCodeAt(0));
    expect(text(lcd).slice(0, 3)).toBe('Bus');
    expect(lcd.eightBit).toBe(true);
  });

  it('stores custom characters and maps rows of a 20x4 module', () => {
    const lcd = new HD44780(20, 4);
    init(lcd);
    sendByte(lcd, 0x40, false); // CGRAM address 0
    const heart = [0x00, 0x0a, 0x1f, 0x1f, 0x0e, 0x04, 0x00, 0x00];
    for (const row of heart) sendByte(lcd, row, true);
    sendByte(lcd, 0x80 | 0x14, false); // row 3 starts at 0x14
    sendByte(lcd, 0x00, true);
    sendByte(lcd, 'A'.charCodeAt(0), true);
    const chars = lcd.toCharacters();
    expect(chars[40]).toBe(0);
    expect(chars[41]).toBe(65);
    const font = lcd.patchFont(new Uint8Array(256 * 8));
    // 0x0a = .X.X. → mirrored bit order for the element: bits 1 and 3
    expect(font[1]).toBe(0b01010);
    expect(font[2]).toBe(0b11111);
  });

  it('scrolls the display and reports the cursor cell', () => {
    const lcd = new HD44780(16, 2);
    init(lcd);
    for (const ch of 'ABC') sendByte(lcd, ch.charCodeAt(0), true);
    expect(lcd.cursorCell()).toEqual({ x: 3, y: 0 });
    sendByte(lcd, 0x18, false); // shift display left
    expect(text(lcd).slice(0, 2)).toBe('BC');
  });
});
