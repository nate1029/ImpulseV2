/**
 * AI circuit generator — turns an Arduino sketch into a wired circuit spec.
 * Single-shot completion against the user's configured provider; the renderer
 * sends its parts catalog (so the model only uses parts that exist) and
 * validates the result before placing anything.
 * @module main/services/ai/circuitGenerator
 */

const BOARD_NOTES = {
  uno: 'Arduino Uno (type "wokwi-arduino-uno", id "uno"). Pins "0".."13", "A0".."A5", power "5V", "3.3V", "VIN", grounds "GND.1", "GND.2", "GND.3". PWM: 3, 5, 6, 9, 10, 11. I2C: SDA = "A4", SCL = "A5". SPI: SS 10, MOSI 11, MISO 12, SCK 13. Interrupts: 2, 3.',
  nano: 'Arduino Nano (type "wokwi-arduino-nano", id "nano"). Pins "0".."13", "A0".."A7" (A6/A7 analog only), power "5V", "3.3V", "VIN", grounds "GND.1", "GND.2". PWM: 3, 5, 6, 9, 10, 11. I2C: SDA = "A4", SCL = "A5". SPI: SS 10, MOSI 11, MISO 12, SCK 13.',
  mega: 'Arduino Mega 2560 (type "wokwi-arduino-mega", id "mega"). Pins "0".."53", "A0".."A15", power "5V", "3.3V", "VIN", grounds "GND.1".."GND.5". PWM: 2-13, 44-46. I2C: SDA = "20", SCL = "21". SPI: SS 53, MOSI 51, MISO 50, SCK 52. Serial1 18/19, Serial2 16/17, Serial3 14/15. Interrupts: 2, 3, 18, 19, 20, 21.',
};

const FALLBACK_CATALOG = `wokwi-led — LED. attrs {"color": "red"}. Pins: A (anode), C (cathode).
wokwi-resistor — attrs {"value": "220"}. Pins: 1, 2.
wokwi-pushbutton — Pins: 1.l, 1.r (side 1), 2.l, 2.r (side 2). Pressing joins side 1 to side 2.
wokwi-potentiometer — Pins: GND, SIG, VCC.
wokwi-servo — Pins: GND, V+, PWM.
wokwi-buzzer — Pins: 1 (−), 2 (+).
wokwi-lcd1602 — I2C LCD, attrs {"pins": "i2c"}. Pins: GND, VCC, SDA, SCL.
wokwi-ssd1306 — I2C OLED. Pins: DATA (SDA), CLK (SCL), VIN, GND.
wokwi-hc-sr04 — Pins: VCC, TRIG, ECHO, GND.
wokwi-dht22 — Pins: VCC, SDA (data), NC, GND.`;

function systemPrompt(board, catalog) {
  return `You are the circuit synthesis engine of Impulse IDE's 2D hardware simulator.
Given an Arduino sketch, output the EXACT physical circuit it needs, as JSON.
The circuit must be electrically correct: if a human wired the real parts exactly
as you output and flashed the same sketch, it would work identically.

BOARD
${BOARD_NOTES[board] || BOARD_NOTES.uno}

AVAILABLE PARTS (use these exact "type" strings and pin names, nothing else):
${catalog || FALLBACK_CATALOG}

WIRING RULES (mandatory — real-hardware correctness):
1. Read the sketch's pin constants/defines carefully. Wire each component to the EXACT pin number used in the code.
2. Every discrete LED needs a series resistor: board:<pin> → resistor:1, resistor:2 → led:A, led:C → board:GND.x. Value "220".
3. Pushbutton with INPUT_PULLUP: one side to the digital pin, the other side to GND. With plain INPUT: other side to 5V plus a 10k resistor from the pin to GND.
4. Analog parts (potentiometer, sensors with analog outputs): signal → the analog pin the code reads, power from 5V, ground to GND.
5. Servo: PWM → the attach() pin, V+ → 5V, GND → GND.
6. I2C devices: SDA/SCL (or DATA/CLK on the OLED) to the board's I2C pins listed above, power and ground too.
7. SPI devices: MOSI/MISO/SCK to the board's SPI pins; CS/DC/RST to the pins the code uses.
8. Motors are driven through a driver (L293D, A4988, relay module or transistor), never straight from a pin.
9. Use the part whose library the sketch includes (e.g. LiquidCrystal_I2C → I2C LCD with matching address attr, Adafruit_SSD1306 → OLED, Adafruit_NeoPixel → NeoPixel parts with the right pixel count, Keypad → keypad).
10. Spread ground connections across the board's GND pins to keep wiring readable.
11. Only include parts the sketch actually uses. Do not invent extra components.
12. If the sketch only blinks LED_BUILTIN with no other hardware, still add an LED + resistor on pin 13 so the user sees a component.

OUTPUT FORMAT — respond with ONLY this JSON, no markdown fences, no commentary:
{
  "parts": [
    {"type": "<board type>", "id": "<board id>"},
    {"type": "wokwi-led", "id": "led1", "attrs": {"color": "red"}},
    {"type": "wokwi-resistor", "id": "r1", "attrs": {"value": "220"}}
  ],
  "connections": [
    ["<board id>:13", "r1:1"],
    ["r1:2", "led1:A"],
    ["led1:C", "<board id>:GND.1"]
  ]
}
ids: short lowercase (led1, btn1, r1, pot1, servo1, lcd1). Every connection endpoint is "<id>:<pin>".`;
}

/**
 * Generate a circuit spec for the given sketch using the active AI provider.
 * @param {import('./agent')} aiAgent
 * @param {string} sketchCode
 * @param {{ board?: string, catalog?: string }} [options]
 * @returns {Promise<{success: boolean, circuit?: object, error?: string}>}
 */
async function generateCircuit(aiAgent, sketchCode, options = {}) {
  if (!aiAgent || !aiAgent.currentProvider) {
    return { success: false, error: 'No AI provider configured. Add an API key in the AI panel first.' };
  }
  if (!sketchCode || !sketchCode.trim()) {
    return { success: false, error: 'The editor is empty — write or open a sketch first.' };
  }

  const messages = [
    { role: 'system', content: systemPrompt(options.board, options.catalog) },
    { role: 'user', content: `Generate the circuit for this Arduino sketch:\n\n${sketchCode}` },
  ];

  let raw;
  try {
    const res = await aiAgent.currentProvider.chat(messages, { temperature: 0, max_tokens: 8000, effort: 'medium', tools: [] });
    raw = res?.content ?? '';
  } catch (err) {
    return { success: false, error: `AI request failed: ${err.message}` };
  }

  const circuit = extractJson(raw);
  if (!circuit) {
    return { success: false, error: 'The AI response was not valid JSON. Try again.' };
  }
  if (!Array.isArray(circuit.parts) || !Array.isArray(circuit.connections)) {
    return { success: false, error: 'The AI response is missing "parts" or "connections".' };
  }
  return { success: true, circuit };
}

/** Pull the first JSON object out of a possibly fenced/noisy response. */
function extractJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

module.exports = { generateCircuit, systemPrompt, extractJson };
