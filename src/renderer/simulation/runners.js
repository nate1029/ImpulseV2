// The runner for a board: AVR boards run on avr8js, the Raspberry Pi Pico on
// rp2040js, ESP32 boards in Espressif's QEMU (through the main process). All
// present the same surface to the engine and the UI.

import { AvrRunner } from './avr-runner.js';
import { Rp2040Runner } from './rp2040-runner.js';
import { Esp32Runner } from './esp32-runner.js';
import { boardById } from './boards.js';

/** 'avr', 'rp2040' or 'esp32'. */
export const runnerFamily = (boardId) => {
  const family = boardById(boardId).family;
  return family === 'rp2040' || family === 'esp32' ? family : 'avr';
};

export function createRunner(boardId) {
  const family = runnerFamily(boardId);
  if (family === 'rp2040') return new Rp2040Runner();
  if (family === 'esp32') return new Esp32Runner();
  return new AvrRunner();
}

/** The program in a compile result: HEX text for AVR boards, UF2 bytes for the Pico, a flash image (built and kept by the main process) for ESP32 boards. */
export const programOf = (result) => result?.hex ?? result?.uf2 ?? result?.esp32 ?? null;
