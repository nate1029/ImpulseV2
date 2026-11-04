// Registers the parts Impulse draws itself (everything not in @wokwi/elements).

import { BreadboardElement } from './breadboard.js';
import { HC595Element, L293DElement, Attiny85Element, Lm35Element, NpnElement, A4988Element, LdrElement, ReedSwitchElement, Dht11Element, Ds18b20Element } from './chips.js';
import { Max7219MatrixElement, RelayModuleElement, DcMotorElement, SensorModuleElement } from './modules.js';
import { BatteryElement, DiodeElement, CapacitorElement, MosfetElement } from './power.js';
import { AndGateElement, NandGateElement, OrGateElement, NorGateElement, XorGateElement, NotGateElement, FlipFlopDElement } from './logic.js';
import { Tm1637Element, Stepper28byjElement, L298nElement } from './kits.js';
import { PiPicoElement } from './boards.js';
import { Esp32S3DevKitElement, Esp32C3DevKitElement, NanoEsp32Element } from './esp32.js';
import { LeonardoElement } from './leonardo.js';

const ELEMENTS = {
  'impulse-breadboard': BreadboardElement,
  'impulse-74hc595': HC595Element,
  'impulse-l293d': L293DElement,
  'impulse-lm35': Lm35Element,
  'impulse-npn-transistor': NpnElement,
  'impulse-a4988': A4988Element,
  'impulse-ldr': LdrElement,
  'impulse-reed-switch': ReedSwitchElement,
  'impulse-max7219-matrix': Max7219MatrixElement,
  'impulse-relay-module': RelayModuleElement,
  'impulse-dc-motor': DcMotorElement,
  'impulse-sensor-module': SensorModuleElement,
  'impulse-dht11': Dht11Element,
  'impulse-ds18b20': Ds18b20Element,
  'impulse-battery': BatteryElement,
  'impulse-diode': DiodeElement,
  'impulse-capacitor': CapacitorElement,
  'impulse-mosfet': MosfetElement,
  'impulse-gate-and': AndGateElement,
  'impulse-gate-nand': NandGateElement,
  'impulse-gate-or': OrGateElement,
  'impulse-gate-nor': NorGateElement,
  'impulse-gate-xor': XorGateElement,
  'impulse-gate-not': NotGateElement,
  'impulse-flipflop-d': FlipFlopDElement,
  'impulse-tm1637': Tm1637Element,
  'impulse-stepper-28byj48': Stepper28byjElement,
  'impulse-l298n': L298nElement,
  'impulse-pi-pico': PiPicoElement,
  'impulse-attiny85': Attiny85Element,
  'impulse-esp32-s3-devkitc': Esp32S3DevKitElement,
  'impulse-esp32-c3-devkitm': Esp32C3DevKitElement,
  'impulse-nano-esp32': NanoEsp32Element,
  'impulse-arduino-leonardo': LeonardoElement,
};

if (typeof customElements !== 'undefined') {
  for (const [tag, cls] of Object.entries(ELEMENTS)) {
    if (!customElements.get(tag)) customElements.define(tag, cls);
  }
}

export { ELEMENTS };
