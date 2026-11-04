// Microcontroller definitions for the AVR simulator.
//
// avr8js ships ATmega328P configs; the ATmega2560 ones below follow
// avr/iomxx0_1.h from avr-libc. Interrupt vectors are word addresses:
// avr-libc's _VECTOR(n) lives at n * 2.

import {
  INT0, INT1, PCINT0, PCINT1, PCINT2,
  portAConfig, portBConfig, portCConfig, portDConfig, portEConfig, portFConfig,
  portGConfig, portHConfig, portJConfig, portKConfig, portLConfig,
  timer0Config, timer1Config, timer2Config,
  usart0Config, adcConfig, atmega328Channels, twiConfig, spiConfig,
  eepromConfig, watchdogConfig, ADCMuxInputType, ADCReference,
} from 'avr8js';
import { tinyTimer1Config } from './tiny-timer1.js';
import { usiConfig } from './usi.js';
import { usb32u4Config } from './usb32u4.js';
import { timer4Config } from './timer4.js';

const vec = (n) => n * 2;

// ── ATmega328P (Uno, Nano, Pro Mini) ───────────────────────────────────────

export const ATMEGA328P = {
  id: 'atmega328p',
  name: 'ATmega328P',
  flashBytes: 32 * 1024,
  sramBytes: 2048,
  eepromBytes: 1024,
  ports: {
    B: portBConfig,
    C: portCConfig,
    D: portDConfig,
  },
  timers: [timer0Config, timer1Config, timer2Config],
  usarts: [usart0Config],
  adc: adcConfig,
  adcChannels: 8,
  twi: twiConfig,
  spi: spiConfig,
  eeprom: eepromConfig,
  watchdog: watchdogConfig,
};

// ── ATmega2560 (Mega 2560) ─────────────────────────────────────────────────

const EICRA = 0x69;
const EICRB = 0x6a;
const EIMSK = 0x3d;
const EIFR = 0x3c;
const extInt = (index, EICR, iscOffset) => ({ EICR, EIMSK, EIFR, index, iscOffset, interrupt: vec(index + 1) });

const PCICR = 0x68;
const PCIFR = 0x3b;
const pcint = (n, PCMSK, mask, offset) => ({ PCIE: n, PCICR, PCIFR, PCMSK, pinChangeInterrupt: vec(9 + n), mask, offset });

const mega = {
  INT: [0, 1, 2, 3].map(i => extInt(i, EICRA, i * 2)).concat([4, 5, 6, 7].map(i => extInt(i, EICRB, (i - 4) * 2))),
  PCINT0: pcint(0, 0x6b, 0xff, 0),
  PCINT1E: pcint(1, 0x6c, 0x01, 0), // PCINT8 = PE0
  PCINT1J: pcint(1, 0x6c, 0x7f, 1), // PCINT9..15 = PJ0..PJ6
  PCINT2: pcint(2, 0x6d, 0xff, 0),
};

const megaTimerBits = {
  TOV: 1, OCFA: 2, OCFB: 4, OCFC: 8,
  TOIE: 1, OCIEA: 2, OCIEB: 4, OCIEC: 8,
};

const timer16 = (base, n, firstVector, TIFR, TIMSK, oc) => ({
  ...megaTimerBits,
  bits: 16,
  dividers: timer1Config.dividers,
  captureInterrupt: vec(firstVector),
  compAInterrupt: vec(firstVector + 1),
  compBInterrupt: vec(firstVector + 2),
  compCInterrupt: vec(firstVector + 3),
  ovfInterrupt: vec(firstVector + 4),
  TIFR,
  TCCRA: base, TCCRB: base + 1, TCCRC: base + 2,
  TCNT: base + 4, ICR: base + 6, OCRA: base + 8, OCRB: base + 10, OCRC: base + 12,
  TIMSK,
  compPortA: oc.A[0], compPinA: oc.A[1],
  compPortB: oc.B[0], compPinB: oc.B[1],
  compPortC: oc.C[0], compPinC: oc.C[1],
  externalClockPort: 0,
  externalClockPin: 0,
  timerNumber: n,
});

const P = (cfg) => cfg.PORT;

export const ATMEGA2560 = {
  id: 'atmega2560',
  name: 'ATmega2560',
  flashBytes: 256 * 1024,
  // Data space is 0x0000-0x21FF: registers + extended I/O up to 0x1FF, then 8 KB SRAM.
  sramBytes: 8192 + 0x100,
  eepromBytes: 4096,
  ports: {
    A: portAConfig,
    B: { ...portBConfig, pinChange: mega.PCINT0, externalInterrupts: [] },
    C: portCConfig,
    D: { ...portDConfig, pinChange: undefined, externalInterrupts: mega.INT.slice(0, 4) },
    E: { ...portEConfig, pinChange: mega.PCINT1E, externalInterrupts: [null, null, null, null, ...mega.INT.slice(4, 8)] },
    F: portFConfig,
    G: portGConfig,
    H: portHConfig,
    J: { ...portJConfig, pinChange: mega.PCINT1J },
    K: { ...portKConfig, pinChange: mega.PCINT2 },
    L: portLConfig,
  },
  timers: [
    {
      ...timer0Config,
      compAInterrupt: vec(21), compBInterrupt: vec(22), ovfInterrupt: vec(23),
      compPortA: P(portBConfig), compPinA: 7, // OC0A = PB7 (pin 13)
      compPortB: P(portGConfig), compPinB: 5, // OC0B = PG5 (pin 4)
      externalClockPort: 0, externalClockPin: 0,
    },
    timer16(0x80, 1, 16, 0x36, 0x6f, { A: [P(portBConfig), 5], B: [P(portBConfig), 6], C: [P(portBConfig), 7] }),
    {
      ...timer2Config,
      compAInterrupt: vec(13), compBInterrupt: vec(14), ovfInterrupt: vec(15),
      compPortA: P(portBConfig), compPinA: 4, // OC2A = PB4 (pin 10)
      compPortB: P(portHConfig), compPinB: 6, // OC2B = PH6 (pin 9)
    },
    timer16(0x90, 3, 31, 0x38, 0x71, { A: [P(portEConfig), 3], B: [P(portEConfig), 4], C: [P(portEConfig), 5] }),
    timer16(0xa0, 4, 41, 0x39, 0x72, { A: [P(portHConfig), 3], B: [P(portHConfig), 4], C: [P(portHConfig), 5] }),
    timer16(0x120, 5, 46, 0x3a, 0x73, { A: [P(portLConfig), 3], B: [P(portLConfig), 4], C: [P(portLConfig), 5] }),
  ],
  usarts: [
    { ...usart0Config, rxCompleteInterrupt: vec(25), dataRegisterEmptyInterrupt: vec(26), txCompleteInterrupt: vec(27) },
    { rxCompleteInterrupt: vec(36), dataRegisterEmptyInterrupt: vec(37), txCompleteInterrupt: vec(38), UCSRA: 0xc8, UCSRB: 0xc9, UCSRC: 0xca, UBRRL: 0xcc, UBRRH: 0xcd, UDR: 0xce },
    { rxCompleteInterrupt: vec(51), dataRegisterEmptyInterrupt: vec(52), txCompleteInterrupt: vec(53), UCSRA: 0xd0, UCSRB: 0xd1, UCSRC: 0xd2, UBRRL: 0xd4, UBRRH: 0xd5, UDR: 0xd6 },
    { rxCompleteInterrupt: vec(54), dataRegisterEmptyInterrupt: vec(55), txCompleteInterrupt: vec(56), UCSRA: 0x130, UCSRB: 0x131, UCSRC: 0x132, UBRRL: 0x134, UBRRH: 0x135, UDR: 0x136 },
  ],
  adc: {
    ...adcConfig,
    adcInterrupt: vec(29),
    numChannels: 16,
    muxInputMask: 0x3f,
    muxChannels: {
      ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i, { type: ADCMuxInputType.SingleEnded, channel: i }])),
      ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [0x20 + i, { type: ADCMuxInputType.SingleEnded, channel: 8 + i }])),
      0x1e: { type: ADCMuxInputType.Constant, voltage: 1.1 },
      0x1f: { type: ADCMuxInputType.Constant, voltage: 0 },
    },
  },
  adcChannels: 16,
  twi: { ...twiConfig, twiInterrupt: vec(39) },
  spi: { ...spiConfig, spiInterrupt: vec(24) },
  eeprom: { ...eepromConfig, eepromReadyInterrupt: vec(30) },
  watchdog: { ...watchdogConfig, watchdogInterrupt: vec(12) },
};

// ── ATmega32U4 (Leonardo, Micro, Esplora, Yún…) ────────────────────────────
//
// avr/iom32u4.h: the Mega's register addresses for what they share, INT0-3 on
// PD0-PD3 and INT6 on PE6, PCINT0-7 on port B, Timer0/1/3, USART1 (Serial1),
// a 14-channel ADC with MUX5 in ADCSRB, Timer4 (the 10-bit PWM timer behind
// pins 6 and 13, timer4.js), and the USB device controller, which is Serial
// (usb32u4.js).

const u4Int = [0, 1, 2, 3].map(i => extInt(i, EICRA, i * 2));
const u4Ports = { B: portBConfig, C: portCConfig, D: portDConfig, E: portEConfig, F: portFConfig };

export const ATMEGA32U4 = {
  id: 'atmega32u4',
  name: 'ATmega32U4',
  flashBytes: 32 * 1024,
  sramBytes: 2560,
  eepromBytes: 1024,
  ports: {
    B: { ...portBConfig, pinChange: mega.PCINT0, externalInterrupts: [] },
    C: portCConfig,
    D: { ...portDConfig, pinChange: undefined, externalInterrupts: u4Int },
    E: { ...portEConfig, pinChange: undefined, externalInterrupts: [null, null, null, null, null, null, extInt(6, EICRB, 4)] },
    F: portFConfig,
  },
  timers: [
    {
      ...timer0Config,
      compAInterrupt: vec(21), compBInterrupt: vec(22), ovfInterrupt: vec(23),
      compPortA: P(u4Ports.B), compPinA: 7, // OC0A = PB7 (pin 11)
      compPortB: P(u4Ports.D), compPinB: 0, // OC0B = PD0 (pin 3)
      externalClockPort: 0, externalClockPin: 0,
    },
    timer16(0x80, 1, 16, 0x36, 0x6f, { A: [P(u4Ports.B), 5], B: [P(u4Ports.B), 6], C: [P(u4Ports.B), 7] }),
    timer16(0x90, 3, 31, 0x38, 0x71, { A: [P(u4Ports.C), 6], B: [0, 0], C: [0, 0] }),
  ],
  usarts: [
    { rxCompleteInterrupt: vec(25), dataRegisterEmptyInterrupt: vec(26), txCompleteInterrupt: vec(27), UCSRA: 0xc8, UCSRB: 0xc9, UCSRC: 0xca, UBRRL: 0xcc, UBRRH: 0xcd, UDR: 0xce },
  ],
  // Serial is USB; the USART is Serial1.
  usartPortOffset: 1,
  adc: {
    ...adcConfig,
    adcInterrupt: vec(29),
    numChannels: 14,
    muxInputMask: 0x3f,
    muxChannels: {
      ...Object.fromEntries([0, 1, 4, 5, 6, 7].map(i => [i, { type: ADCMuxInputType.SingleEnded, channel: i }])),
      ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [0x20 + i, { type: ADCMuxInputType.SingleEnded, channel: 8 + i }])),
      0x1e: { type: ADCMuxInputType.Constant, voltage: 1.1 },
      0x1f: { type: ADCMuxInputType.Constant, voltage: 0 },
      0x27: { type: ADCMuxInputType.Temperature },
    },
  },
  adcChannels: 14,
  twi: { ...twiConfig, twiInterrupt: vec(36) },
  spi: { ...spiConfig, spiInterrupt: vec(24) },
  eeprom: { ...eepromConfig, eepromReadyInterrupt: vec(30) },
  watchdog: { ...watchdogConfig, watchdogInterrupt: vec(12) },
  usb: usb32u4Config,
  timer4: timer4Config,
};

// The 328P keeps avr8js' own ADC channel map (temperature sensor on 8).
ATMEGA328P.adc = { ...adcConfig, muxChannels: atmega328Channels };
ATMEGA328P.ports.B = { ...portBConfig, pinChange: PCINT0, externalInterrupts: [] };
ATMEGA328P.ports.C = { ...portCConfig, pinChange: PCINT1, externalInterrupts: [] };
ATMEGA328P.ports.D = { ...portDConfig, pinChange: PCINT2, externalInterrupts: [null, null, INT0, INT1] };

// ── ATtiny85 ────────────────────────────────────────────────────────────────
//
// From the ATtiny25/45/85 datasheet (register summary and table 9-1). Flash is
// 8 KB, so each interrupt vector is a single word: vector n sits at word n.
// One port (B), Timer0, the ATtiny Timer/Counter1, the USI (I²C and SPI), a
// 4-channel ADC, EEPROM and the watchdog; no UART, TWI or SPI peripheral.

const TINY = { PINB: 0x36, DDRB: 0x37, PORTB: 0x38, GIMSK: 0x5b, GIFR: 0x5a, MCUCR: 0x55, PCMSK: 0x35, TIFR: 0x58, TIMSK: 0x59 };

export const ATTINY85 = {
  id: 'attiny85',
  name: 'ATtiny85',
  flashBytes: 8 * 1024,
  sramBytes: 512,
  eepromBytes: 512,
  ports: {
    B: {
      PIN: TINY.PINB, DDR: TINY.DDRB, PORT: TINY.PORTB,
      pinChange: { PCIE: 5, PCICR: TINY.GIMSK, PCIFR: TINY.GIFR, PCMSK: TINY.PCMSK, pinChangeInterrupt: 2, mask: 0x3f, offset: 0 },
      // INT0 is PB2.
      externalInterrupts: [null, null, { EICR: TINY.MCUCR, EIMSK: TINY.GIMSK, EIFR: TINY.GIFR, index: 6, iscOffset: 0, interrupt: 1 }],
    },
  },
  timers: [{
    bits: 8,
    captureInterrupt: 0, compAInterrupt: 10, compBInterrupt: 11, compCInterrupt: 0, ovfInterrupt: 5,
    TIFR: TINY.TIFR, OCRA: 0x49, OCRB: 0x48, OCRC: 0, ICR: 0, TCNT: 0x52, TCCRA: 0x4a, TCCRB: 0x53, TCCRC: 0, TIMSK: TINY.TIMSK,
    dividers: timer0Config.dividers,
    compPortA: TINY.PORTB, compPinA: 0, compPortB: TINY.PORTB, compPinB: 1, compPortC: 0, compPinC: 0,
    externalClockPort: TINY.PORTB, externalClockPin: 2,
    TOV: 1 << 1, OCFA: 1 << 4, OCFB: 1 << 3, OCFC: 0, TOIE: 1 << 1, OCIEA: 1 << 4, OCIEB: 1 << 3, OCIEC: 0,
  }],
  tinyTimer1: tinyTimer1Config,
  usi: usiConfig,
  usarts: [],
  adc: {
    ADMUX: 0x27, ADCSRA: 0x26, ADCSRB: 0x23, ADCL: 0x24, ADCH: 0x25, DIDR0: 0x34,
    adcInterrupt: 8,
    numChannels: 4,
    muxInputMask: 0x0f,
    muxChannels: {
      0: { type: ADCMuxInputType.SingleEnded, channel: 0 }, // PB5
      1: { type: ADCMuxInputType.SingleEnded, channel: 1 }, // PB2
      2: { type: ADCMuxInputType.SingleEnded, channel: 2 }, // PB4
      3: { type: ADCMuxInputType.SingleEnded, channel: 3 }, // PB3
      12: { type: ADCMuxInputType.Constant, voltage: 1.1 },
      13: { type: ADCMuxInputType.Constant, voltage: 0 },
      15: { type: ADCMuxInputType.Temperature },
    },
    adcReferences: [ADCReference.AVCC, ADCReference.AREF, ADCReference.Internal1V1, ADCReference.Internal2V56],
  },
  // REFS2 is ADMUX bit 4 here (avr8js looks for it at bit 3, where this chip
  // has MUX3), so the runner reads the reference with this instead.
  // REFS2:0 = x00 VCC, x01 AREF (PB0), 010 1.1 V, 11x 2.56 V, 011 reserved.
  adcReferenceOf(admux) {
    const refs = ((admux >> 6) & 3) | (admux & 0x10 ? 4 : 0);
    return [ADCReference.AVCC, ADCReference.AREF, ADCReference.Internal1V1, ADCReference.Reserved,
      ADCReference.AVCC, ADCReference.AREF, ADCReference.Internal2V56, ADCReference.Internal2V56][refs];
  },
  // TinySoftwareSerial's RX start-bit interrupt (ANA_COMP).
  analogComparator: { ACSR: 0x28, interrupt: 7, ain0: 0, ain1: 1, bandgap: 1.1 },
  adcChannels: 4,
  twi: null,
  spi: null,
  eeprom: { ...eepromConfig, EECR: 0x3c, EEDR: 0x3d, EEARL: 0x3e, EEARH: 0x3f, eepromReadyInterrupt: 6 },
  watchdog: { ...watchdogConfig, MCUSR: 0x54, WDTCSR: 0x41, watchdogInterrupt: 12 },
  // CLKPR is an I/O register here; avr8js' default (0x61) is SRAM on this chip.
  clock: { CLKPR: 0x46 },
};

// ── ATmega8 (Arduino NG and older) ──────────────────────────────────────────
//
// From the ATmega8 datasheet (register summary, interrupt vectors table 18).
// Everything sits at older, lower addresses than on the 328P, its three timers
// share TIMSK and TIFR, Timer0 has no compare unit, Timer2 has one control
// register (TCCR2), UCSRC shares its address with UBRRH (URSEL picks), and SRAM
// starts at 0x60. 8 KB of flash: one-word interrupt vectors. Registers avr8js
// expects but this chip lacks point at spare bytes past the end of SRAM
// (0x4f0-0x4ff); setup() splits TCCR2 and UBRRH/UCSRC into them.

const M8 = { TIMSK: 0x59, TIFR: 0x58, spare: (n) => 0x4f0 + n };
const m8Timer = (extra) => ({
  bits: 8, captureInterrupt: 0, compCInterrupt: 0, OCRC: 0, ICR: 0, TCCRC: 0, OCFC: 0, OCIEC: 0,
  compPortC: 0, compPinC: 0, externalClockPort: 0, externalClockPin: 0,
  TIFR: M8.TIFR, TIMSK: M8.TIMSK, dividers: timer0Config.dividers, ...extra,
});

export const ATMEGA8 = {
  id: 'atmega8',
  name: 'ATmega8',
  flashBytes: 8 * 1024,
  sramBytes: 1024,
  eepromBytes: 512,
  ports: {
    B: { PIN: 0x36, DDR: 0x37, PORT: 0x38, externalInterrupts: [] },
    C: { PIN: 0x33, DDR: 0x34, PORT: 0x35, externalInterrupts: [] },
    D: {
      PIN: 0x30, DDR: 0x31, PORT: 0x32,
      // INT0 on PD2, INT1 on PD3: GICR bits 6/7, sense in MCUCR.
      externalInterrupts: [null, null,
        { EICR: 0x55, EIMSK: 0x5b, EIFR: 0x5a, index: 6, iscOffset: 0, interrupt: 1 },
        { EICR: 0x55, EIMSK: 0x5b, EIFR: 0x5a, index: 7, iscOffset: 2, interrupt: 2 }],
    },
  },
  timers: [
    // Timer0: overflow only (millis), TCCR0 holds the clock select.
    m8Timer({
      compAInterrupt: 0, compBInterrupt: 0, ovfInterrupt: 9,
      TCCRA: M8.spare(0), TCCRB: 0x53, TCNT: 0x52, OCRA: M8.spare(1), OCRB: M8.spare(2),
      TOV: 1, OCFA: 0, OCFB: 0, TOIE: 1, OCIEA: 0, OCIEB: 0,
      compPortA: 0, compPinA: 0, compPortB: 0, compPinB: 0,
    }),
    {
      ...timer1Config, captureInterrupt: 5, compAInterrupt: 6, compBInterrupt: 7, ovfInterrupt: 8,
      TIFR: M8.TIFR, TIMSK: M8.TIMSK, TOV: 1 << 2, OCFA: 1 << 4, OCFB: 1 << 3, TOIE: 1 << 2, OCIEA: 1 << 4, OCIEB: 1 << 3,
      TCCRA: 0x4f, TCCRB: 0x4e, TCNT: 0x4c, OCRA: 0x4a, OCRB: 0x48, ICR: 0x46,
      compPortA: 0x38, compPinA: 1, compPortB: 0x38, compPinB: 2, // OC1A = PB1, OC1B = PB2
    },
    // Timer2: TCCR2 is split into the A/B pair by setup(). OC2 = PB3 (pin 11).
    m8Timer({
      compAInterrupt: 3, compBInterrupt: 0, ovfInterrupt: 4,
      TCCRA: M8.spare(3), TCCRB: M8.spare(4), TCNT: 0x44, OCRA: 0x43, OCRB: M8.spare(5),
      TOV: 1 << 6, OCFA: 1 << 7, OCFB: 0, TOIE: 1 << 6, OCIEA: 1 << 7, OCIEB: 0,
      compPortA: 0x38, compPinA: 3, compPortB: 0, compPinB: 0,
      dividers: timer2Config.dividers,
    }),
  ],
  usarts: [{
    rxCompleteInterrupt: 11, dataRegisterEmptyInterrupt: 12, txCompleteInterrupt: 13,
    UCSRA: 0x2b, UCSRB: 0x2a, UCSRC: M8.spare(6), UBRRL: 0x29, UBRRH: M8.spare(7), UDR: 0x2c,
  }],
  adc: {
    ...adcConfig,
    ADMUX: 0x27, ADCSRA: 0x26, ADCSRB: M8.spare(8), ADCL: 0x24, ADCH: 0x25, DIDR0: M8.spare(9),
    adcInterrupt: 14,
    numChannels: 8,
    muxInputMask: 0x0f,
    muxChannels: {
      ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i, { type: ADCMuxInputType.SingleEnded, channel: i }])),
      14: { type: ADCMuxInputType.Constant, voltage: 1.3 },
      15: { type: ADCMuxInputType.Constant, voltage: 0 },
    },
  },
  adcChannels: 8,
  twi: { ...twiConfig, TWBR: 0x20, TWSR: 0x21, TWAR: 0x22, TWDR: 0x23, TWCR: 0x56, twiInterrupt: 17 },
  spi: { ...spiConfig, SPCR: 0x2d, SPSR: 0x2e, SPDR: 0x2f, spiInterrupt: 10 },
  eeprom: { ...eepromConfig, EECR: 0x3c, EEDR: 0x3d, EEARL: 0x3e, EEARH: 0x3f, eepromReadyInterrupt: 15 },
  watchdog: { ...watchdogConfig, MCUSR: 0x54, WDTCSR: 0x41, watchdogInterrupt: 0 },
  clock: { CLKPR: M8.spare(10) },
  /** Registers that pack two of avr8js' registers into one address. */
  setup(cpu) {
    // TCCR2 = FOC2 WGM20 COM21 COM20 WGM21 CS22 CS21 CS20 → TCCR2A (COM, WGM1:0) and TCCR2B (CS).
    cpu.writeHooks[0x45] = (value) => {
      cpu.data[0x45] = value;
      cpu.writeData(M8.spare(3), (value & 0x30) << 2 | (value & 0x40 ? 1 : 0) | (value & 0x08 ? 2 : 0));
      cpu.writeData(M8.spare(4), value & 0x07);
      return true;
    };
    // UBRRH and UCSRC share 0x40: URSEL (bit 7) set means UCSRC.
    cpu.writeHooks[0x40] = (value) => {
      cpu.data[0x40] = value;
      if (value & 0x80) cpu.writeData(M8.spare(6), value & 0x7f);
      else cpu.writeData(M8.spare(7), value & 0x0f);
      return true;
    };
  },
};

// Smaller siblings: the same peripherals at the same addresses, less memory.
// The ATmega1280's 128 KB keeps a 16-bit program counter (2-byte return
// addresses), which its compiled code relies on.
export const ATMEGA168 = { ...ATMEGA328P, id: 'atmega168', name: 'ATmega168', flashBytes: 16 * 1024, sramBytes: 1024, eepromBytes: 512 };
export const ATMEGA1280 = { ...ATMEGA2560, id: 'atmega1280', name: 'ATmega1280', flashBytes: 128 * 1024 };
export const ATTINY45 = { ...ATTINY85, id: 'attiny45', name: 'ATtiny45', flashBytes: 4 * 1024, sramBytes: 256, eepromBytes: 256 };
export const ATTINY25 = { ...ATTINY85, id: 'attiny25', name: 'ATtiny25', flashBytes: 2 * 1024, sramBytes: 128, eepromBytes: 128 };
// The Gemma runs Arduino's own core on its ATtiny85: no software Serial on PB0/PB1.
export const ATTINY85_GEMMA = { ...ATTINY85, id: 'attiny85-gemma', noSoftSerial: true };

export const MCUS = {
  [ATMEGA328P.id]: ATMEGA328P,
  [ATMEGA168.id]: ATMEGA168,
  [ATMEGA2560.id]: ATMEGA2560,
  [ATMEGA1280.id]: ATMEGA1280,
  [ATTINY85.id]: ATTINY85,
  [ATTINY45.id]: ATTINY45,
  [ATTINY25.id]: ATTINY25,
  [ATMEGA32U4.id]: ATMEGA32U4,
  [ATTINY85_GEMMA.id]: ATTINY85_GEMMA,
  [ATMEGA8.id]: ATMEGA8,
};
