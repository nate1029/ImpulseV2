// Probe: the ESP32 core 3.x APIs the notes recommend (LEDC, timers, ESP-NOW callbacks, Preferences, LittleFS).
#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <Preferences.h>
#include <LittleFS.h>
Preferences prefs;
hw_timer_t *timer = nullptr;
volatile uint32_t ticks = 0;
void IRAM_ATTR onTimer() { ticks++; }
void onRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) { (void)info; (void)data; (void)len; }
#if ESP_ARDUINO_VERSION >= ESP_ARDUINO_VERSION_VAL(3, 2, 0)
void onSent(const wifi_tx_info_t *info, esp_now_send_status_t status) { (void)info; (void)status; }
#else
void onSent(const uint8_t *mac, esp_now_send_status_t status) { (void)mac; (void)status; }
#endif
void setup() {
  Serial.begin(115200);
  ledcAttach(2, 5000, 8);
  ledcWrite(2, 128);
  timer = timerBegin(1000000);
  timerAttachInterrupt(timer, &onTimer);
  timerAlarm(timer, 1000000, true, 0);
  WiFi.mode(WIFI_STA);
  Serial.println(WiFi.macAddress());
  if (esp_now_init() == ESP_OK) {
    esp_now_register_recv_cb(onRecv);
    esp_now_register_send_cb(onSent);
  }
  prefs.begin("impulse", false);
  prefs.putUInt("boots", prefs.getUInt("boots", 0) + 1);
  LittleFS.begin(true);
}
void loop() {
  analogWrite(4, 64);
  delay(1000);
}
