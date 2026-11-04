// Probe: SAMD21 (12-bit ADC, DAC, USB Serial, Serial1).
#include <Arduino.h>
#include <Wire.h>
void setup() { Serial.begin(115200); Serial1.begin(9600); analogReadResolution(12); analogWriteResolution(10); Wire.begin(); pinMode(LED_BUILTIN, OUTPUT); }
void loop() { analogWrite(A0, analogRead(A1) / 4); delay(100); }
