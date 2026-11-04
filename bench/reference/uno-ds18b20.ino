#include <OneWire.h>
#include <DallasTemperature.h>
OneWire oneWire(2);
DallasTemperature sensors(&oneWire);
void setup() { Serial.begin(9600); sensors.begin(); }
void loop() {
  sensors.requestTemperatures();
  Serial.print("Temperature: "); Serial.print(sensors.getTempCByIndex(0), 1); Serial.println(" C");
  delay(1000);
}
