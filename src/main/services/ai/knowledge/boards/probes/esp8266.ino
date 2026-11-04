// Probe: ESP8266 core 3.x (LittleFS, analogWriteRange, hostname, D-pin names).
#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <LittleFS.h>
#include <Ticker.h>
Ticker ticker;
void setup() {
  Serial.begin(115200);
  pinMode(D4, OUTPUT);
  analogWriteRange(1023);
  WiFi.setHostname("impulse-probe");
  WiFi.mode(WIFI_STA);
  LittleFS.begin();
  ticker.attach(1.0, [] { digitalWrite(D4, !digitalRead(D4)); });
}
void loop() {
  analogWrite(D5, analogRead(A0));
  yield();
}
