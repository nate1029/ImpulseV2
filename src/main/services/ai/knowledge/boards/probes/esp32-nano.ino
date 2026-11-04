// Probe: Arduino Nano ESP32 (Arduino's ESP32 core 2.0.x): LEDC through analogWrite, RGB LED pins.
#include <Arduino.h>
#include <WiFi.h>
void setup() {
  Serial.begin(115200);
  pinMode(LED_RED, OUTPUT);
  pinMode(LED_BUILTIN, OUTPUT);
  WiFi.mode(WIFI_STA);
}
void loop() { analogWrite(LED_BUILTIN, 64); digitalWrite(LED_RED, LOW); delay(500); }
