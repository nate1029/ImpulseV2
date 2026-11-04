#include <WiFi.h>
#include <esp_now.h>
void onRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  const uint8_t *m = info->src_addr;
  Serial.printf("from %02X:%02X:%02X:%02X:%02X:%02X\n", m[0], m[1], m[2], m[3], m[4], m[5]);
}
void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  if (esp_now_init() != ESP_OK) { Serial.println("ESP-NOW failed"); return; }
  esp_now_register_recv_cb(onRecv);
  Serial.println("ESP-NOW ready");
}
void loop() {}
