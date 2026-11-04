#include <WiFi.h>
void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.begin("ImpulseNet", "impulse123");
  while (WiFi.status() != WL_CONNECTED) delay(100);
  Serial.print("IP: "); Serial.println(WiFi.localIP());
}
void loop() {}
