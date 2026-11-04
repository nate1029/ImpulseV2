#include <DHT.h>
DHT dht(2, DHT22);
void setup() { Serial.begin(115200); dht.begin(); }
void loop() {
  float t = dht.readTemperature(), h = dht.readHumidity();
  Serial.print("T="); Serial.print(t, 1); Serial.print(" H="); Serial.println(h, 1);
  delay(2000);
}
