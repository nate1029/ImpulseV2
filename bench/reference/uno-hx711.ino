#include <HX711.h>
HX711 scale;
void setup() { Serial.begin(9600); scale.begin(3, 2); scale.set_scale(420.0); scale.tare(); }
void loop() {
  if (scale.is_ready()) { Serial.print("Weight: "); Serial.print(scale.get_units(5), 1); Serial.println(" g"); }
  delay(500);
}
