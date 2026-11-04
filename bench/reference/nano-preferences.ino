#include <Preferences.h>
Preferences prefs;
void setup() {
  Serial.begin(115200);
  prefs.begin("bench", false);
  unsigned int n = prefs.getUInt("boots", 0) + 1;
  prefs.putUInt("boots", n);
  prefs.end();
  Serial.printf("boots=%u\n", n);
}
void loop() {}
