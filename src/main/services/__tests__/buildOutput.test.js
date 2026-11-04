const {
  stageOf, progressOf, isNoteworthy, parseMemory, summaryLines, parseDiagnostics, classifyFailure, firstErrorLine,
} = require('../buildOutput');

const UNO_OK = `Detecting libraries used...
/Users/x/Library/Arduino15/packages/arduino/tools/avr-gcc/7.3.0-atmel3.6.1-arduino7/bin/avr-g++ -c -g -Os -w -std=gnu++11 -fpermissive -fno-exceptions -ffunction-sections -fdata-sections -fno-threadsafe-statics -Wno-error=narrowing -MMD -flto -mmcu=atmega328p -DF_CPU=16000000L -DARDUINO=10607 -DARDUINO_AVR_UNO -DARDUINO_ARCH_AVR -I/Users/x/Library/Arduino15/packages/arduino/hardware/avr/1.8.6/cores/arduino -I/Users/x/Library/Arduino15/packages/arduino/hardware/avr/1.8.6/variants/standard /tmp/arduino/sketches/ABC/sketch/Blink.ino.cpp -o /dev/null
Generating function prototypes...
Compiling sketch...
Compiling libraries...
Compiling core...
Linking everything together...
Using board 'uno' from platform in folder: /Users/x/Library/Arduino15/packages/arduino/hardware/avr/1.8.6
Using core 'arduino' from platform in folder: /Users/x/Library/Arduino15/packages/arduino/hardware/avr/1.8.6
Sketch uses 924 bytes (2%) of program storage space. Maximum is 32256 bytes.
Global variables use 9 bytes (0%) of dynamic memory, leaving 2039 bytes for local variables. Maximum is 2048 bytes.
`;

const UNO_TOO_BIG = `Linking everything together...
/Users/x/Library/Arduino15/packages/arduino/tools/avr-gcc/7.3.0-atmel3.6.1-arduino7/bin/../lib/gcc/avr/7.3.0/../../../../avr/bin/ld: address 0x80a000 of /tmp/arduino/sketches/ABC/Big.ino.elf section \`.text' is not within region \`text'
Sketch uses 40,102 bytes (124%) of program storage space. Maximum is 32,256 bytes.
Global variables use 9 bytes (0%) of dynamic memory, leaving 2039 bytes for local variables. Maximum is 2048 bytes.
Sketch too big; see https://support.arduino.cc/hc/en-us/articles/360013825179 for tips on reducing it.
text section exceeds available space in board
Error during build: text section exceeds available space in board
`;

const ESP32_UPLOAD = `esptool.py v4.6
Serial port /dev/cu.usbserial-0001
Connecting....
Chip is ESP32-D0WD-V3 (revision v3.1)
Features: WiFi, BT, Dual Core, 240MHz, VRef calibration in efuse, Coding Scheme None
Crystal is 40MHz
MAC: 24:0a:c4:00:00:00
Uploading stub...
Running stub...
Stub running...
Changing baud rate to 921600
Changed.
Configuring flash size...
Flash will be erased from 0x00001000 to 0x00005fff...
Compressed 17536 bytes to 12176...
Writing at 0x00001000... (100 %)
Wrote 17536 bytes (12176 compressed) at 0x00001000 in 0.4 seconds (effective 345.2 kbit/s)...
Hash of data verified.
Compressed 262000 bytes to 143000...
Writing at 0x00010000... (12 %)
Writing at 0x0001d000... (25 %)
Writing at 0x00037000... (62 %)
Writing at 0x0004a000... (100 %)
Hash of data verified.

Leaving...
Hard resetting via RTS pin...
`;

describe('buildOutput', () => {
  describe('stageOf', () => {
    it('reads arduino-cli compile stages in order', () => {
      const stages = UNO_OK.split('\n').map(stageOf).filter(Boolean);
      expect(stages).toEqual(['detecting', 'compiling-sketch', 'compiling-sketch', 'compiling-libraries', 'compiling-core', 'linking', 'sizing', 'sizing']);
    });
    it('reads esptool upload stages', () => {
      const stages = [...new Set(ESP32_UPLOAD.split('\n').map(stageOf).filter(Boolean))];
      expect(stages).toEqual(['connecting', 'erasing', 'writing', 'verifying', 'resetting']);
    });
    it('reads avrdude stages', () => {
      expect(stageOf('avrdude: AVR device initialized and ready to accept instructions')).toBe('connecting');
      expect(stageOf('avrdude: writing flash (924 bytes):')).toBe('writing');
      expect(stageOf('Reading | ################################################## | 100% 0.00s')).toBe('verifying');
    });
    it('reads picotool and bossac stages', () => {
      expect(stageOf('Loading into Flash: [==============================]  100%')).toBe('writing');
      expect(stageOf('Verifying Flash:    [==============================]  100%')).toBe('verifying');
      expect(stageOf('The device was rebooted to start the application.')).toBe('resetting');
      expect(stageOf('Write 12345 bytes to flash (49 pages)')).toBe('writing');
      expect(stageOf('Verify successful')).toBe('verifying');
      expect(stageOf('CPU reset.')).toBe('resetting');
    });
    it('ignores ordinary compiler lines', () => {
      expect(stageOf('In file included from /tmp/x.ino:1:0:')).toBeNull();
      expect(stageOf('')).toBeNull();
    });
  });

  describe('progressOf', () => {
    it('reads each tool\'s progress bar', () => {
      expect(progressOf('Writing | ########                                           | 15% 0.01s')).toBe(15);
      expect(progressOf('Writing at 0x0001d000... (25 %)')).toBe(25);
      expect(progressOf('Loading into Flash: [===============               ]  50%')).toBe(50);
      expect(progressOf('[==========                    ] 33% (123/372 pages)')).toBe(33);
      expect(progressOf('Download\t[=======                  ]  28%        73728 bytes')).toBe(28);
    });
    it('does not mistake other percentages for progress', () => {
      expect(progressOf('Sketch uses 924 bytes (2%) of program storage space.')).toBeNull();
      expect(progressOf('warning: 50% of something')).toBeNull();
    });
  });

  describe('isNoteworthy', () => {
    it('hides the long compiler command lines and keeps the rest', () => {
      const lines = UNO_OK.split('\n');
      expect(isNoteworthy(lines[1])).toBe(false);
      expect(isNoteworthy('Compiling sketch...')).toBe(true);
      expect(isNoteworthy('Blink.ino:5:3: warning: unused variable')).toBe(true);
      expect(isNoteworthy('   ')).toBe(false);
    });
  });

  describe('parseMemory and summaryLines', () => {
    it('reads Arduino IDE\'s two size lines', () => {
      const m = parseMemory(UNO_OK);
      expect(m.flash).toEqual({ used: 924, percent: 2, max: 32256 });
      expect(m.ram).toEqual({ used: 9, percent: 0, left: 2039, max: 2048 });
      expect(summaryLines(m)).toEqual([
        'Sketch uses 924 bytes (2%) of program storage space. Maximum is 32,256 bytes.',
        'Global variables use 9 bytes (0%) of dynamic memory, leaving 2,039 bytes for local variables. Maximum is 2,048 bytes.',
      ]);
    });
    it('reads sizes with thousands separators and the low-memory warning', () => {
      const m = parseMemory(`${UNO_TOO_BIG}\nLow memory available, stability problems may occur.`);
      expect(m.flash).toEqual({ used: 40102, percent: 124, max: 32256 });
      expect(m.lowMemory).toBe(true);
      expect(summaryLines(m)[2]).toBe('Low memory available, stability problems may occur.');
    });
    it('reads PlatformIO\'s size lines', () => {
      const m = parseMemory('RAM:   [=         ]  10.2% (used 2088 bytes from 20480 bytes)\nFlash: [==        ]  12.3% (used 12345 bytes from 100000 bytes)');
      expect(m.flash).toEqual({ used: 12345, percent: 12, max: 100000 });
      expect(m.ram).toEqual({ used: 2088, percent: 10, max: 20480, left: 18392 });
    });
    it('returns null when nothing is known', () => {
      expect(parseMemory('nothing here')).toBeNull();
      expect(summaryLines(null)).toEqual([]);
    });
  });

  describe('parseDiagnostics', () => {
    it('reads file:line:col diagnostics without repeats', () => {
      const text = `/tmp/x/Blink.ino:5:3: error: 'digitalWrit' was not declared in this scope; did you mean 'digitalWrite'?
/tmp/x/Blink.ino:5:3: error: 'digitalWrit' was not declared in this scope; did you mean 'digitalWrite'?
/tmp/x/Blink.ino:9:1: warning: unused variable 'x' [-Wunused-variable]
/tmp/x/Blink.ino:12: note: declared here
exit status 1`;
      const d = parseDiagnostics(text);
      expect(d).toHaveLength(3);
      expect(d[0]).toEqual({ file: '/tmp/x/Blink.ino', line: 5, col: 3, level: 'error', message: "'digitalWrit' was not declared in this scope; did you mean 'digitalWrite'?" });
      expect(d[1].level).toBe('warning');
      expect(d[2]).toMatchObject({ line: 12, col: null, level: 'note' });
    });
  });

  describe('classifyFailure', () => {
    it('names a sketch that is too big, with the numbers', () => {
      const memory = parseMemory(UNO_TOO_BIG);
      const f = classifyFailure(UNO_TOO_BIG, 'compile', { memory });
      expect(f.code).toBe('SKETCH_TOO_BIG');
      expect(f.title).toBe("The sketch is too big: 40,102 bytes, and this board's flash holds 32,256");
      expect(f.hint).toMatch(/PROGMEM/);
    });
    it('names a missing library by its header', () => {
      const f = classifyFailure('Blink.ino:1:10: fatal error: Adafruit_SSD1306.h: No such file or directory', 'compile');
      expect(f.code).toBe('LIBRARY_MISSING');
      expect(f.title).toBe('The library that provides Adafruit_SSD1306.h is not installed');
      expect(f.hint).toMatch(/Adafruit_SSD1306/);
    });
    it('names a plain compile error', () => {
      const f = classifyFailure("/tmp/x/Blink.ino:5:3: error: 'foo' was not declared in this scope", 'compile');
      expect(f.code).toBe('CODE_ERROR');
    });
    it('reads the upload tools\' failures', () => {
      expect(classifyFailure('avrdude: stk500_recv(): programmer is not responding\navrdude: stk500_getsync() attempt 1 of 10: not in sync: resp=0x00', 'upload').code).toBe('UPLOAD_SYNC');
      expect(classifyFailure('A fatal error occurred: Failed to connect to ESP32: Wrong boot mode detected (0x13)! The chip needs to be in download mode.', 'upload').code).toBe('UPLOAD_BOOTMODE');
      expect(classifyFailure('avrdude: ser_open(): can\'t open device "/dev/cu.usbmodem1101": Resource busy', 'upload').code).toBe('PORT_BUSY');
      expect(classifyFailure('No accessible RP2040 devices in BOOTSEL mode were found.', 'upload').code).toBe('UPLOAD_NO_BOOTSEL');
      expect(classifyFailure('avrdude: Expected signature for ATmega328P is 1E 95 0F\n         Double check chip, or use -F to override this check.', 'upload').code).toBe('UPLOAD_SIGNATURE');
      expect(classifyFailure('avrdude: ser_open(): can\'t open device "/dev/cu.usbserial-0001": No such file or directory', 'upload').code).toBe('PORT_GONE');
    });
    it('falls back to a generic code', () => {
      expect(classifyFailure('exit status 1', 'compile').code).toBe('COMPILE_FAILED');
      expect(classifyFailure('something odd', 'upload').code).toBe('UPLOAD_FAILED');
    });
  });

  describe('firstErrorLine', () => {
    it('prefers the first diagnostic, then an error-looking line', () => {
      expect(firstErrorLine('Compiling sketch...\n/tmp/x.ino:3:1: error: expected \';\'\nexit status 1')).toBe("/tmp/x.ino:3:1: error: expected ';'");
      expect(firstErrorLine('Connecting...\nA fatal error occurred: Failed to connect')).toBe('A fatal error occurred: Failed to connect');
    });
  });
});
