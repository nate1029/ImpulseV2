#include <EEPROM.h>
void setup() {
  Serial.begin(9600);
  unsigned long n; EEPROM.get(0, n);
  if (n == 0xFFFFFFFFUL) n = 0;
  n++; EEPROM.put(0, n);
  Serial.print("boot "); Serial.println(n);
}
void loop() {}
