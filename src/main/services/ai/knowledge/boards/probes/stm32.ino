// Probe: STM32duino pin names, extra UART, PWM frequency.
#include <Arduino.h>
#include <Wire.h>
HardwareSerial Serial2(PA3, PA2);
void setup() { Serial.begin(115200); Serial2.begin(9600); Wire.setSDA(PB7); Wire.setSCL(PB6); Wire.begin(); pinMode(PC13, OUTPUT); analogWriteFrequency(1000); analogReadResolution(12); }
void loop() { digitalWrite(PC13, !digitalRead(PC13)); analogWrite(PA8, analogRead(PA0) / 16); delay(200); }
