const {
  CATALOG, FAMILIES, RECORDS, CORES, catalogEntry, familyFor, driftFor, driftText, notesText, searchCatalog, popularBoards, compareVersions,
} = require('../boardRecords');
const { FAMILIES: MCU_FAMILIES } = require('../mcuGuide');

const FQBN = /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_.-]+$/;
const TAGS = new Set(['student', 'industry', 'iot', 'robotics', 'wearable', 'camera', 'audio', 'ml']);

describe('the board catalog', () => {
  it('holds exactly 100 boards with unique ids and ranks 1..100', () => {
    expect(CATALOG).toHaveLength(100);
    expect(new Set(CATALOG.map((b) => b.id)).size).toBe(100);
    expect([...CATALOG].map((b) => b.rank).sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });

  it('names a valid FQBN, platform, family and tags for every board', () => {
    const mcuIds = new Set(MCU_FAMILIES.map((f) => f.id));
    for (const b of CATALOG) {
      expect(b.fqbn).toMatch(FQBN);
      expect(b.platform).toBe(b.fqbn.split(':').slice(0, 2).join(':'));
      expect(FAMILIES[b.family]).toBeDefined();
      expect(mcuIds.has(b.family) || b.family === 'general').toBe(true);
      expect(b.tags.length).toBeGreaterThan(0);
      for (const t of b.tags) expect(TAGS.has(t)).toBe(true);
      expect(typeof b.india).toBe('string');
      expect(['core', 'index', 'doc']).toContain(b.verified);
    }
  });

  it('puts the boards India uses most first', () => {
    const top = popularBoards().slice(0, 10).map((b) => b.id);
    expect(top).toEqual(expect.arrayContaining(['uno', 'nano', 'esp32-devkit-v1', 'nodemcu-v2', 'mega', 'esp32-cam', 'd1-mini']));
    expect(popularBoards()[0]).toMatchObject({ id: 'uno', familyTitle: expect.stringMatching(/Uno R3/) });
  });

  it('has a record for every board and no record without a board', () => {
    const ids = new Set(CATALOG.map((b) => b.id));
    for (const id of Object.keys(RECORDS)) expect(ids.has(id)).toBe(true);
    for (const id of ids) expect(RECORDS[id]).toBeDefined();
  });
});

describe('board notes', () => {
  it('finds the catalog entry from an fqbn with options and prefers the matching option', () => {
    expect(catalogEntry('arduino:avr:uno').id).toBe('uno');
    expect(catalogEntry('arduino:avr:pro:cpu=8MHzatmega328').id).toBe('pro-mini-3v3');
    expect(catalogEntry('arduino:avr:pro:cpu=16MHzatmega328').id).toBe('pro-mini-5v');
    expect(catalogEntry('STMicroelectronics:stm32:GenF4:pnum=BLACKPILL_F401CC').id).toBe('black-pill-f401');
    expect(catalogEntry('esp32:esp32:esp32s3:CDCOnBoot=cdc').id).toBe('esp32-s3-devkitc');
    expect(catalogEntry('vendor:arch:unknown')).toBeNull();
  });

  it('falls back to the family by platform for boards outside the catalog', () => {
    expect(familyFor('esp32:esp32:lolin_s3_pro').id).toBe('esp32-s3');
    expect(familyFor('esp32:esp32:um_tinypico').id).toBe('esp32');
    expect(familyFor('esp8266:esp8266:espino').id).toBe('esp8266');
    expect(familyFor('rp2040:rp2040:cytron_maker_pi_rp2040').id).toBe('rp2040');
    expect(familyFor('arduino:avr:diecimila', 'avr-atmega328p').id).toBe('avr-atmega328p');
  });

  it('tells the Nano clone story and the ESP32-CAM upload story', () => {
    const nano = notesText('arduino:avr:nano:cpu=atmega328old', { coreVersion: '1.8.8' });
    expect(nano).toMatch(/^\[BOARD NOTES\] Arduino Nano \(ATmega328P\)/);
    expect(nano).toMatch(/Old Bootloader/);
    expect(nano).toMatch(/A6 and A7 are analog-only/);
    const cam = notesText('esp32:esp32:esp32cam', { coreVersion: '3.3.12' });
    expect(cam).toMatch(/Pins taken by onboard parts \(do not use\): 0, 2, 4, 5/);
    expect(cam).toMatch(/GPIO0 wired to GND/);
    expect(cam).toMatch(/Brownout/i);
  });

  it('keeps the block short enough to send with every request', () => {
    for (const b of CATALOG) {
      const text = notesText(b.fqbn, { coreVersion: '3.3.12' });
      expect(text.length).toBeLessThan(2700);
    }
  });

  it('returns nothing for a board no layer knows', () => {
    expect(notesText('vendor:arch:board')).toBeNull();
  });
});

describe('core API drift', () => {
  it('compares versions with suffixes', () => {
    expect(compareVersions('3.3.12', '3.0.0')).toBeGreaterThan(0);
    expect(compareVersions('2.0.18-arduino.5', '3.0.0')).toBeLessThan(0);
    expect(compareVersions('1.8.8', '1.8.8')).toBe(0);
  });

  it('tells a core 3.x ESP32 user the new APIs and what 2.x code fails with', () => {
    const d = driftFor('esp32:esp32', '3.3.12');
    expect(d.current.map((t) => t.from)).toEqual(['2.0.0', '3.0.0', '3.2.0']);
    const text = driftText('esp32:esp32', '3.3.12');
    expect(text).toMatch(/ledcAttach\(pin, freq, bits\)/);
    expect(text).toMatch(/esp_now_recv_info_t/);
    expect(text).toMatch(/wifi_tx_info_t/);
  });

  it('tells a core 2.x ESP32 user that the 3.x APIs do not exist yet', () => {
    const text = driftText('esp32:esp32', '2.0.17');
    expect(text).toMatch(/Core 2\.x/);
    expect(text).toMatch(/does not compile here: 'ledcSetup' was not declared/);
    expect(driftText('esp32:esp32', '3.3.12', { compact: true, max: 2 }).split('\n')).toHaveLength(3);
    expect(text).not.toMatch(/rgbLedWrite\(pin, r, g, b\), not/);
  });

  it('knows the other cores and ignores unknown ones', () => {
    expect(driftText('esp8266:esp8266', '3.1.2')).toMatch(/LittleFS/);
    expect(driftText('arduino:renesas_uno', '1.6.0')).toMatch(/WiFiS3/);
    expect(driftText('rp2040:rp2040', '4.4.0')).toMatch(/Pico 2/);
    expect(driftText('nobody:nothing', '1.0.0')).toBeNull();
    for (const [platform, core] of Object.entries(CORES)) {
      expect(core.versions.length).toBeGreaterThan(0);
      for (const t of core.versions) {
        expect(t.from).toMatch(/^\d+\.\d+\.\d+$/);
        for (const c of t.changes) expect(typeof c.what === 'string' && typeof c.new === 'string').toBe(true);
      }
      expect(platform).toMatch(/^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    }
  });
});

describe('catalog search', () => {
  it('finds boards by alias and tag, best rank first', () => {
    expect(searchCatalog('nodemcu')[0].id).toBe('nodemcu-v2');
    expect(searchCatalog('blue pill')[0].id).toBe('blue-pill');
    expect(searchCatalog('supermini').map((b) => b.id)).toEqual(expect.arrayContaining(['esp32-c3-supermini', 'esp32-s3-supermini']));
    expect(searchCatalog('camera')[0].id).toBe('esp32-cam');
    expect(searchCatalog('xiao esp32c3')[0].id).toBe('xiao-esp32c3');
    expect(searchCatalog('zzznotaboard')).toEqual([]);
  });
});

describe('boards a message names', () => {
  const { boardsNamedIn, namedBoardFacts } = require('../boardRecords');

  test('finds catalog boards by name or alias, whole words, longest first', () => {
    expect(boardsNamedIn('Blink the onboard LED of my ESP32-C3 SuperMini').map((b) => b.id)).toEqual(['esp32-c3-supermini']);
    expect(boardsNamedIn('I have an Arduino Nano ESP32 here').map((b) => b.id)).toEqual(['nano-esp32']); // not the classic Nano too
    expect(boardsNamedIn('blink an led, then print hello')).toEqual([]);
    expect(boardsNamedIn('')).toEqual([]);
  });

  test('a named board that is not the selected one brings its facts and a warning', () => {
    const facts = namedBoardFacts('Board: ESP32-C3 SuperMini. Blink the onboard LED.', { fqbn: 'esp32:esp32:esp32c3' });
    expect(facts).toMatch(/^\[NAMED BOARD\] The message names the ESP32-C3 SuperMini \(its own board id: esp32:esp32:nologo_esp32c3_super_mini\)\. Onboard: Blue LED on GPIO8 \(active-LOW\)/);
    expect(facts).toMatch(/Proof: L\d \(/);
    expect(facts).toMatch(/The selected board is esp32:esp32:esp32c3\. Where its facts differ/);
    // Naming the board that is selected adds nothing: the board facts already cover it.
    expect(namedBoardFacts('my ESP32-C3 SuperMini', { fqbn: 'esp32:esp32:nologo_esp32c3_super_mini' })).toBeNull();
    expect(namedBoardFacts('blink an led', { fqbn: 'arduino:avr:uno' })).toBeNull();
  });
});
