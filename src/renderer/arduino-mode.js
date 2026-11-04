// C++ mode plus the Arduino core API, so pinMode/HIGH/Serial read as built-ins.

const words = (s) => Object.fromEntries(s.split(/\s+/).filter(Boolean).map(w => [w, true]));

const ARDUINO_BUILTINS = `
  pinMode digitalWrite digitalRead analogRead analogWrite analogReference analogReadResolution
  analogWriteResolution tone noTone shiftOut shiftIn pulseIn pulseInLong
  millis micros delay delayMicroseconds
  min max abs constrain map pow sqrt sq sin cos tan random randomSeed
  bit bitRead bitWrite bitSet bitClear lowByte highByte
  attachInterrupt detachInterrupt digitalPinToInterrupt interrupts noInterrupts
  isAlpha isAlphaNumeric isAscii isControl isDigit isGraph isHexadecimalDigit isLowerCase
  isPrintable isPunct isSpace isUpperCase isWhitespace
  Serial Serial1 Serial2 Serial3 SerialUSB Wire SPI EEPROM Keyboard Mouse String
  setup loop yield
`;

const ARDUINO_ATOMS = `
  HIGH LOW INPUT OUTPUT INPUT_PULLUP INPUT_PULLDOWN LED_BUILTIN
  A0 A1 A2 A3 A4 A5 A6 A7 DEC HEX OCT BIN
  CHANGE RISING FALLING LSBFIRST MSBFIRST DEFAULT INTERNAL EXTERNAL
  true false nullptr NULL
`;

const ARDUINO_TYPES = `
  boolean byte word size_t
  int8_t uint8_t int16_t uint16_t int32_t uint32_t int64_t uint64_t
`;

// clike accepts either a word set or a predicate; combine without losing either.
function union(base, extra) {
  const set = words(extra);
  return (word) => set[word] === true
    || (typeof base === 'function' ? base(word) : !!(base && Object.prototype.propertyIsEnumerable.call(base, word)));
}

export function defineArduinoMode(CodeMirror) {
  const cpp = CodeMirror.resolveMode('text/x-c++src');
  CodeMirror.defineMIME('text/x-arduino', {
    ...cpp,
    name: 'clike',
    builtin: union(cpp.builtin, ARDUINO_BUILTINS),
    atoms: union(cpp.atoms, ARDUINO_ATOMS),
    types: union(cpp.types, ARDUINO_TYPES),
  });
}
