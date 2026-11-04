// Probe: what the AVR notes claim compiles (Uno, Nano, Mega, Pro Mini, Leonardo).
#include <Arduino.h>
#include <avr/pgmspace.h>
#include <Wire.h>
#include <SPI.h>
#include <EEPROM.h>
const char table[] PROGMEM = "stored in flash";
void setup() {
  Serial.begin(9600);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.println(F("literal in flash"));
  Serial.print(pgm_read_byte(&table[0]));
  Wire.begin();
  SPI.begin();
  EEPROM.update(0, 1);
  analogReference(DEFAULT);
}
void loop() {
  digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));
  analogWrite(3, analogRead(A0) / 4);
  delay(500);
}
