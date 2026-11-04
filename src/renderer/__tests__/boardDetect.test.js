// Selecting the connected board: what arduino-cli recognised by USB id, and
// when the IDE may change the user's selection.
import { pickDetectedBoard } from '../board-detect.js';

const uno = { name: 'Arduino Uno', fqbn: 'arduino:avr:uno' };
const mega = { name: 'Arduino Mega or Mega 2560', fqbn: 'arduino:avr:mega' };
const s3 = [{ name: 'ESP32S3 Dev Module', fqbn: 'esp32:esp32:esp32s3' }, { name: 'Adafruit Feather ESP32-S3', fqbn: 'esp32:esp32:adafruit_feather_esp32s3' }];

describe('a board plugged in while the IDE runs', () => {
  test('is selected, with its port', () => {
    const ports = [{ port: '/dev/cu.usbmodem1101', boards: [uno] }];
    expect(pickDetectedBoard({ ports, added: ports, isBaseline: false, selectedBoard: 'arduino:avr:nano', selectedPort: '' }))
      .toMatchObject({ port: '/dev/cu.usbmodem1101', fqbn: 'arduino:avr:uno', name: 'Arduino Uno', reason: 'plugged-in' });
  });

  test('the newest of several wins; unrecognised adapters are skipped', () => {
    const ports = [{ port: 'COM3', boards: [uno] }, { port: 'COM7', boards: [mega] }, { port: 'COM9', boards: [] }];
    const added = [{ port: 'COM3' }, { port: 'COM7' }, { port: 'COM9' }];
    expect(pickDetectedBoard({ ports, added, isBaseline: false }).port).toBe('COM7');
  });

  test('a CH340 clone (no match) changes nothing', () => {
    const ports = [{ port: 'COM4', boards: [] }];
    expect(pickDetectedBoard({ ports, added: ports, isBaseline: false, selectedBoard: 'arduino:avr:nano' })).toBeNull();
  });

  test('several possible boards: keep the selected one if it fits, else ask', () => {
    const ports = [{ port: '/dev/cu.usbmodem2101', boards: s3 }];
    const keep = pickDetectedBoard({ ports, added: ports, isBaseline: false, selectedBoard: 'esp32:esp32:esp32s3:CDCOnBoot=cdc' });
    expect(keep).toMatchObject({ fqbn: 'esp32:esp32:esp32s3', keepBoard: true, port: '/dev/cu.usbmodem2101' });
    const ask = pickDetectedBoard({ ports, added: ports, isBaseline: false, selectedBoard: 'arduino:avr:uno' });
    expect(ask).toMatchObject({ fqbn: null, port: '/dev/cu.usbmodem2101' });
    expect(ask.choices).toHaveLength(2);
  });

  test('boards from cores that are not installed are not offered', () => {
    const ports = [{ port: 'COM5', boards: s3 }];
    expect(pickDetectedBoard({ ports, added: ports, isBaseline: false, installed: (f) => f.startsWith('arduino:') })).toBeNull();
  });
});

describe('at launch', () => {
  test('selects the one recognised board when nothing usable is selected', () => {
    const ports = [{ port: 'COM3', boards: [uno] }, { port: 'COM1', boards: [] }];
    expect(pickDetectedBoard({ ports, added: [], isBaseline: true }))
      .toMatchObject({ fqbn: 'arduino:avr:uno', port: 'COM3', reason: 'launch' });
    // The saved port is gone: the connected board takes over.
    expect(pickDetectedBoard({ ports, added: [], isBaseline: true, selectedBoard: 'arduino:avr:mega', selectedPort: 'COM8' }).fqbn).toBe('arduino:avr:uno');
  });

  test('leaves a working selection alone, and guesses nothing between two boards', () => {
    const ports = [{ port: 'COM3', boards: [uno] }, { port: 'COM7', boards: [mega] }];
    expect(pickDetectedBoard({ ports, added: [], isBaseline: true, selectedBoard: 'arduino:avr:nano', selectedPort: 'COM3' })).toBeNull();
    expect(pickDetectedBoard({ ports, added: [], isBaseline: true })).toBeNull();
  });

  test('already selected on that port: nothing to do', () => {
    const ports = [{ port: 'COM3', boards: [uno] }];
    expect(pickDetectedBoard({ ports, added: ports, isBaseline: false, selectedBoard: 'arduino:avr:uno', selectedPort: 'COM3' })).toBeNull();
  });
});
