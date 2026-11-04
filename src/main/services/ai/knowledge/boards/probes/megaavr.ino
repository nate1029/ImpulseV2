// Probe: Nano Every (Serial1 on 0/1, Wire, new-style registers; no AVR timer registers).
#include <Arduino.h>
#include <Wire.h>
#include <EEPROM.h>
void setup() {
  Serial.begin(115200);
  Serial1.begin(9600);
  Wire.begin();
  EEPROM.update(0, 1);
  pinMode(LED_BUILTIN, OUTPUT);
  PORTE.DIRSET = PIN2_bm; // pin 13 is PE2 on the Nano Every
}
void loop() {
  digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));
  analogWrite(3, analogRead(A0) / 4);
  delay(200);
}
