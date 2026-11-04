// Circuit check: wiring problems found without running the sketch (missing
// resistors and power, floating logic inputs, I²C clashes, batteries on pins),
// plus any shorts the last run reported.

import { staticTopology } from './engine.js';
import { partDef } from './parts/catalog.js';
import { BOARDS, basePinName, boardByTag, boardPinNumber, pinLabel } from './boards.js';

/**
 * @param {{ parts: {id, type, attrs, el?}[], wires: object[], links?: [string, string][] }} model
 * @param {{ shorts?: { tags: string[] }[] }} [options]
 * @returns {{ level: 'error'|'warn'|'info', part?: string, text: string }[]}
 */
export function circuitChecks(model, { shorts = [] } = {}) {
  const issues = [];
  const boardPart = model.parts.find(p => partDef(p.type)?.board) || null;
  const board = (boardPart && boardByTag(partDef(boardPart.type).tag)) || BOARDS.uno;
  if (!boardPart) issues.push({ level: 'error', text: 'There is no Arduino board. Pick one from the board menu.' });
  const circuit = staticTopology(model);
  // Connected to another part: a button's own contacts or a pot's track don't count.
  const linked = (node) => {
    const net = circuit.netOf(node);
    if (net < 0) return false;
    const own = `${node.slice(0, node.indexOf(':'))}:`;
    const foreign = (n) => circuit.nodesOf(n).some(x => !x.startsWith(own));
    return foreign(net) || circuit.resistiveNeighbors(net, 1).some(r => foreign(r.net));
  };
  const onBoard = (node) => {
    const net = circuit.netOf(node);
    return !!boardPart && net >= 0 && circuit.nodesOf(net).some(n => n.startsWith(`${boardPart.id}:`));
  };
  // The board header pin a node is ("GND.2" → "GND"), or null for other parts' pins.
  const boardPin = (n) => (boardPart && n.startsWith(`${boardPart.id}:`) ? basePinName(n.slice(boardPart.id.length + 1)) : null);
  // Whether a node shares a net with one of the board's I/O pins.
  const onGpio = (node) => {
    const net = circuit.netOf(node);
    return net >= 0 && circuit.nodesOf(net).some(n => {
      const name = boardPart && n.startsWith(`${boardPart.id}:`) ? n.slice(boardPart.id.length + 1) : null;
      return name !== null && boardPinNumber(board, name) !== null;
    });
  };
  const i2c = new Map();
  for (const part of model.parts) {
    const def = partDef(part.type);
    if (!def || def.board || def.category === 'Breadboards') continue;
    const pins = part.el?.pinInfo?.map(p => p.name) || def.pinNames(part.attrs || {});
    if (pins.length && !pins.some(p => linked(`${part.id}:${p}`))) {
      issues.push({ level: 'info', part: part.id, text: `${part.id} (${def.label}) isn't connected to anything yet.` });
      continue;
    }
    if (part.type === 'wokwi-led') {
      if (onBoard(`${part.id}:A`)) issues.push({ level: 'warn', part: part.id, text: `${part.id} has no series resistor. On real hardware add 220 Ω so the LED and the pin survive.` });
      if (!linked(`${part.id}:C`)) issues.push({ level: 'warn', part: part.id, text: `${part.id}'s cathode (C) isn't connected, so it can't light. Wire it to GND.` });
      if (!linked(`${part.id}:A`)) issues.push({ level: 'warn', part: part.id, text: `${part.id}'s anode (A) isn't connected. Wire it to a pin through a resistor.` });
    }
    if (/^impulse-(gate-|flipflop)/.test(part.type)) {
      for (const pin of pins.filter(p => !['Y', 'Q', 'QN'].includes(p))) {
        if (!linked(`${part.id}:${pin}`)) issues.push({ level: 'warn', part: part.id, text: `${part.id}'s input ${pin} isn't connected. It reads LOW here, but a floating input on a real chip picks up noise: tie it to 5V, GND or a pin.` });
      }
    }
    if (part.type === 'impulse-battery' && boardPart) {
      const volts = Number(part.attrs.voltage ?? 9);
      const net = circuit.netOf(`${part.id}:+`);
      // Supply inputs: VIN, the Pico's VSYS and VBUS up to 5.5 V, and a bare chip's VCC.
      const fine = (p) => p === 'VIN' || ((p === 'VSYS' || p === 'VBUS') && volts <= 5.5) || (p === 'VCC' && volts <= 5.5);
      const pinName = net >= 0 && circuit.nodesOf(net).map(boardPin).find(p => p && !fine(p)) || null;
      const label = pinName && boardPinNumber(board, pinName) !== null ? pinLabel(board, boardPinNumber(board, pinName)) : pinName;
      if (pinName && /^A?GND/.test(pinName)) issues.push({ level: 'error', part: part.id, text: `${part.id}'s + is wired to GND, which shorts the battery.` });
      else if (pinName === 'VSYS' || pinName === 'VBUS') issues.push({ level: 'error', part: part.id, text: `${part.id} puts ${volts} V on ${pinName}, which takes at most 5.5 V. Use a battery of 5.5 V or less (3×AA, a Li-ion cell), or a regulator.` });
      else if (pinName === 'VCC') issues.push({ level: 'error', part: part.id, text: `${part.id} puts ${volts} V on the ${board.short}'s VCC, which takes at most 5.5 V. Use 3×AA (4.5 V), a Li-ion cell, or a 5 V regulator.` });
      else if (pinName && volts > board.maxPinVolts + 0.5) {
        const via = board.family === 'rp2040' ? 'power the Pico through VSYS (up to 5.5 V)' : 'power the board through VIN';
        issues.push({ level: 'error', part: part.id, text: `${part.id} puts ${volts} V straight onto ${label}. ${board.short} pins take at most ${board.maxPinVolts} V: ${via}, or switch the battery with a transistor or relay.` });
      }
    }
    // 3.3 V boards: 5 V on an I/O pin damages the chip.
    if (boardPart && board.maxPinVolts < 5) {
      const fiveVolt = (n) => ['5V', 'VBUS', 'VSYS', 'VIN'].includes(boardPin(n) || '');
      const supply = (def.supplyPins || pins.filter(p => /^(VCC|VIN|VDD|5V|V\+)$/.test(p)))[0];
      const supplyNet = supply ? circuit.netOf(`${part.id}:${supply}`) : -1;
      if (supplyNet >= 0 && circuit.nodesOf(supplyNet).some(fiveVolt)) {
        const signals = pins.filter(p => p !== supply && !/^(GND|VSS|VCC|VIN|VDD|5V|V\+|3V3|3\.3V)/.test(p) && onGpio(`${part.id}:${p}`));
        if (signals.length) {
          issues.push({ level: 'warn', part: part.id, text: `${part.id} (${def.label}) runs from 5 V, so ${signals.join(', ')} can reach 5 V on a ${board.short} pin that takes at most ${board.maxPinVolts} V. Power it from 3V3 if it works at 3.3 V, or put a level shifter or a 1 kΩ/2 kΩ divider on the lines into the ${board.short}.` });
        }
      }
    }
    if (part.type === 'impulse-ds18b20' && boardPart && linked(`${part.id}:DQ`)) {
      const net = circuit.netOf(`${part.id}:DQ`);
      const supply = (n) => ['5V', '3.3V', '3V3', 'IOREF', 'VBUS'].includes(boardPin(n) || '');
      const pulled = circuit.resistiveNeighbors(net, 1).some(nb => circuit.nodesOf(nb.net).some(supply));
      if (!pulled) issues.push({ level: 'info', part: part.id, text: `${part.id} has no 4.7 kΩ pull-up from DQ to 5V. The simulator adds one, but a real 1-Wire bus needs it.` });
    }
    // A part can name its own supply pins (the L298N runs from 12V; its 5V pin is an output).
    const power = def.supplyPins || pins.filter(p => /^(VCC|VIN|VDD|5V|V\+)$/.test(p));
    const ground = pins.filter(p => /^(GND|VSS)$/.test(p));
    if (power.length && !power.some(p => linked(`${part.id}:${p}`))) {
      const to = /^\d+V$/.test(power[0]) && power[0] !== '5V' ? 'a battery or supply' : board.maxPinVolts < 5 ? '3V3' : '5V';
      issues.push({ level: 'warn', part: part.id, text: `${part.id} (${def.label}) has no power: wire its ${power[0]} pin to ${to}.` });
    }
    if (ground.length && !ground.some(p => linked(`${part.id}:${p}`))) {
      issues.push({ level: 'warn', part: part.id, text: `${part.id} (${def.label}) has no ground: wire its ${ground[0]} pin to GND on the board.` });
    }
    const lcdAddr = part.attrs.pins === 'i2c' ? (part.attrs.i2cAddress || '0x27') : null;
    const addr = { 'wokwi-lcd1602': lcdAddr, 'wokwi-lcd2004': lcdAddr, 'wokwi-ssd1306': part.attrs.i2cAddress || '0x3c', 'wokwi-ds1307': '0x68', 'wokwi-mpu6050': '0x68' }[part.type];
    if (addr) {
      const key = addr.toLowerCase();
      if (i2c.has(key)) issues.push({ level: 'warn', part: part.id, text: `${i2c.get(key)} and ${part.id} both use I²C address ${key}; only one of them will answer.` });
      else i2c.set(key, part.id);
    }
  }
  if (boardPart && board.resetPin !== undefined) issues.push(...bareChipChecks(model, boardPart, board, circuit));
  for (const s of shorts) issues.push({ level: 'error', text: `Short circuit: ${s.tags.join(' and ')} are wired together while driving different levels. On real hardware this can damage the board.` });
  return issues;
}

/** A bare chip (the ATtiny85): its supply, and its RESET pin used as I/O. */
function bareChipChecks(model, boardPart, board, circuit) {
  const issues = [];
  const node = (pin) => `${boardPart.id}:${pin}`;
  const breadboards = new Set(model.parts.filter(p => partDef(p.type)?.category === 'Breadboards').map(p => p.id));
  const partOf = (n) => n.slice(0, n.indexOf(':'));
  // Another part's pin on the same net (breadboard holes and the chip's own pins don't count).
  const touchesPart = (n) => {
    const net = circuit.netOf(n);
    return net >= 0 && circuit.nodesOf(net).some(x => partOf(x) !== boardPart.id && !breadboards.has(partOf(x)));
  };
  const batteries = model.parts.filter(p => p.type === 'impulse-battery');
  const supply = circuit.netOf(node('VCC'));
  const ground = circuit.netOf(node('GND'));
  const feeding = batteries.filter(b => supply >= 0 && circuit.netOf(`${b.id}:+`) === supply && circuit.netOf(`${b.id}:-`) === ground);
  const others = model.parts.some(p => p !== boardPart && !breadboards.has(p.id));
  if (others && !feeding.length) {
    issues.push({ level: 'info', part: boardPart.id, text: `Nothing powers the ${board.short} yet. On a real breadboard wire VCC and GND to a 2.7–5.5 V supply (3×AA, a Li-ion cell or USB 5 V); the simulator runs it at 5 V either way.` });
  }
  for (const bat of feeding) {
    const volts = Number(bat.attrs.voltage ?? 9);
    if (volts < 2.7) issues.push({ level: 'warn', part: bat.id, text: `${bat.id} gives the ${board.short} ${volts} V, below the 2.7 V it needs to run.` });
  }
  const resetName = pinLabel(board, board.resetPin);
  if (touchesPart(node(resetName))) {
    issues.push({ level: 'info', part: boardPart.id, text: `${resetName} is the ${board.short}'s RESET pin: pulling it LOW resets the chip. As an I/O pin it needs the RSTDISBL fuse, after which only a high-voltage programmer can reprogram the chip. The simulator treats it as an ordinary pin.` });
  }
  return issues;
}
