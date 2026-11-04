// Probe: Uno R4 (WiFiS3 on the WiFi, 14-bit ADC, DAC).
#include <Arduino.h>
#include <Wire.h>
#include <EEPROM.h>
void setup() {
  Serial.begin(115200);
  analogReadResolution(14);
  analogWriteResolution(12);
  pinMode(LED_BUILTIN, OUTPUT);
  Wire.begin();
  EEPROM.update(0, 1);
}
void loop() { analogWrite(A0, analogRead(A1) / 4); digitalWrite(LED_BUILTIN, HIGH); delay(100); }
