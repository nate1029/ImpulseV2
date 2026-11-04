#include <Arduino.h>

int counter = 0;

int twice(int x) {
  int y = x * 2;
  return y;
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.println("pio ready");
}

void loop() {
  counter = twice(counter + 1);
  digitalWrite(LED_BUILTIN, counter & 2);
  delay(250);
}
