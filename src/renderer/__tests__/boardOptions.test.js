import { baseFqbn, composeFqbn, suggestedChoices, describePort, sortPorts } from '../board-options.js';

// The shape arduino-cli reports for esp32:esp32:esp32s3 (trimmed).
const S3 = [
  { option: 'USBMode', label: 'USB Mode', values: [{ value: 'hwcdc', label: 'Hardware CDC and JTAG', isDefault: true }, { value: 'default', label: 'USB-OTG (TinyUSB)', isDefault: false }] },
  { option: 'CDCOnBoot', label: 'USB CDC On Boot', values: [{ value: 'default', label: 'Disabled', isDefault: true }, { value: 'cdc', label: 'Enabled', isDefault: false }] },
  { option: 'FlashSize', label: 'Flash Size', values: [{ value: '4M', label: '4MB (32Mb)', isDefault: true }, { value: '16M', label: '16MB (128Mb)', isDefault: false }] },
  { option: 'PSRAM', label: 'PSRAM', values: [{ value: 'disabled', label: 'Disabled', isDefault: true }, { value: 'opi', label: 'OPI PSRAM', isDefault: false }] },
];

describe('board options', () => {
  it('strips options to get the base FQBN', () => {
    expect(baseFqbn('esp32:esp32:esp32s3:CDCOnBoot=cdc,PSRAM=opi')).toBe('esp32:esp32:esp32s3');
    expect(baseFqbn('arduino:avr:uno')).toBe('arduino:avr:uno');
  });

  it('writes only choices that differ from the defaults and exist for the board', () => {
    expect(composeFqbn('esp32:esp32:esp32s3', S3, {})).toBe('esp32:esp32:esp32s3');
    expect(composeFqbn('esp32:esp32:esp32s3', S3, { USBMode: 'hwcdc', CDCOnBoot: 'cdc', FlashSize: '16M', PSRAM: 'opi', Bogus: 'x' }))
      .toBe('esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashSize=16M,PSRAM=opi');
    expect(composeFqbn('esp32:esp32:esp32s3', S3, { FlashSize: '64M' })).toBe('esp32:esp32:esp32s3');
  });

  it('turns on USB CDC On Boot for an ESP32 on its built-in USB port only', () => {
    expect(suggestedChoices(S3, { vid: '0x303A', pid: '0x1001' })).toEqual({ CDCOnBoot: 'cdc' });
    expect(suggestedChoices(S3, { vid: '0x10C4', pid: '0xEA60' })).toEqual({}); // CP2102 bridge on UART0
    expect(suggestedChoices(S3, null)).toEqual({});
    expect(suggestedChoices([], { vid: '0x303A', pid: '0x1001' })).toEqual({});
  });

  it('names ports by board, else by USB vendor, and lists USB ports first', () => {
    expect(describePort({ board: 'Arduino Uno', vid: '0x2341' })).toBe('Arduino Uno');
    expect(describePort({ board: 'Serial Port (USB)', vid: '0x303A', pid: '0x1001' })).toBe('Espressif native USB (ESP32-S3/C3/C6)');
    expect(describePort({ board: 'Serial Port (USB)', vid: '0x1A86' })).toBe('CH340 USB serial');
    expect(describePort({ board: 'Serial Port (USB)', vid: '0x9999' })).toBe('USB serial device');
    expect(describePort({ board: 'Serial Port' })).toBe('Not USB (Bluetooth or system port)');
    const sorted = sortPorts([{ port: 'bt' }, { port: 'usb', vid: '0x303A' }, { port: 'dbg' }]);
    expect(sorted.map(p => p.port)).toEqual(['usb', 'bt', 'dbg']);
  });
});
