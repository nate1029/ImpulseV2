#include <ESP32Servo.h>
Servo s;
void setup() { s.attach(13); s.write(90); }
void loop() {}
