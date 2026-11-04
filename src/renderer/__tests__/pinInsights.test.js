import { analyzePinUsage, diagnosePins, describePin, maskCode, collectConstants } from '../pin-insights.js';

const wiringWith = (pins) => ({ hasCircuit: true, pins });

describe('maskCode / collectConstants', () => {
  it('ignores pins mentioned in comments and strings', () => {
    const usages = analyzePinUsage('// digitalWrite(5, HIGH);\nSerial.println("pinMode(6, OUTPUT)");');
    expect(usages).toEqual([]);
    expect(maskCode('a /* b */ c').length).toBe('a /* b */ c'.length);
  });

  it('resolves #define, const and plain int pin names, including chains', () => {
    const constants = collectConstants('#define LED 13\nconst int BUTTON = 2;\nint pot = A0;\nconst byte ALIAS = LED;');
    expect(Object.fromEntries(constants)).toEqual({ LED: '13', BUTTON: '2', pot: 'A0', ALIAS: 'LED' });
    const usages = analyzePinUsage('const byte ALIAS = LED;\n#define LED 13\nvoid setup(){ pinMode(ALIAS, OUTPUT); }');
    expect(usages[0]).toMatchObject({ pin: 13, fn: 'pinMode', mode: 'OUTPUT', token: 'ALIAS', line: 2 });
  });
});

describe('analyzePinUsage', () => {
  it('records position and length of every pin argument', () => {
    const code = 'void loop() {\n  digitalWrite(LED_BUILTIN, HIGH);\n  int v = analogRead(A2);\n  servo.attach(9);\n}';
    const usages = analyzePinUsage(code);
    expect(usages.map(u => [u.fn, u.pin, u.line, u.ch, u.length])).toEqual([
      ['digitalWrite', 13, 1, 15, 11],
      ['analogRead', 16, 2, 21, 2],
      ['servo.attach', 9, 3, 15, 1]
    ]);
  });

  it('treats analogRead(0) as A0', () => {
    expect(analyzePinUsage('analogRead(0);')[0].pin).toBe(14);
  });
});

describe('diagnosePins', () => {
  const diagnose = (code, wiring) => diagnosePins(analyzePinUsage(code), { code, wiring });

  it('flags digitalWrite without pinMode OUTPUT (the dim LED bug)', () => {
    const issues = diagnose('void loop(){ digitalWrite(7, HIGH); }');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('never set to OUTPUT');
    expect(diagnose('void setup(){ pinMode(7, OUTPUT); } void loop(){ digitalWrite(7, HIGH); }')).toEqual([]);
  });

  it('flags analogWrite on a pin without PWM', () => {
    expect(diagnose('analogWrite(7, 128);')[0].message).toContain('no PWM');
    expect(diagnose('analogWrite(9, 128);')).toEqual([]);
  });

  it('flags Serial with I²C on the ATtiny85, where both use PB0', () => {
    const tiny = { hasCircuit: false, pins: {}, board: 'attiny85' };
    const code = '#include <Wire.h>\nvoid setup() {\n  Wire.begin();\n  Serial.begin(9600);\n}';
    const issues = diagnose(code, tiny);
    expect(issues).toEqual([expect.objectContaining({ line: 4, severity: 'warning', message: expect.stringContaining('PB0, which is also I²C SDA') })]);
    expect(diagnose('void setup() { Serial.begin(9600); }', tiny)).toEqual([]);
    expect(diagnose(code, { hasCircuit: false, pins: {}, board: 'uno' })).toEqual([]);
  });

  it('flags pins 0 and 1 when Serial is in use', () => {
    const issues = diagnose('void setup(){ Serial.begin(9600); pinMode(1, OUTPUT); }');
    expect(issues[0].message).toContain('Serial TX');
  });

  it('uses circuit wiring when there is a circuit', () => {
    const button = { id: 'btn1', type: 'wokwi-pushbutton', label: 'Pushbutton btn1', pin: '1.l' };
    const led = { id: 'led1', type: 'wokwi-led', label: 'LED led1', pin: 'A' };
    expect(diagnose('pinMode(4, OUTPUT); digitalWrite(4, HIGH);', wiringWith({ 4: [button] }))[0].message)
      .toContain('which is an input part');
    expect(diagnose('pinMode(5, INPUT); digitalRead(5);', wiringWith({ 5: [led] }))[0].message)
      .toContain('which the Arduino should drive');
    expect(diagnose('pinMode(8, OUTPUT);', wiringWith({}))[0]).toMatchObject({ severity: 'info', message: 'Nothing is wired to D8 in the circuit.' });
    expect(diagnose('pinMode(13, OUTPUT);', wiringWith({}))).toEqual([]);
  });
});

describe('describePin', () => {
  it('summarises capabilities and wiring', () => {
    expect(describePin(9)).toBe('D9 (PWM)');
    expect(describePin(14)).toBe('A0 (analog in 0)');
    expect(describePin(9, wiringWith({ 9: [{ label: 'Servo s1', pin: 'PWM' }] }))).toBe('D9 (PWM) → Servo s1 PWM');
    expect(describePin(3, wiringWith({}))).toBe('D3 (PWM): not wired in the circuit');
  });
});
