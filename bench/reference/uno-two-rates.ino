unsigned long last9 = 0, last10 = 0;
void setup() { pinMode(9, OUTPUT); pinMode(10, OUTPUT); }
void loop() {
  unsigned long now = millis();
  if (now - last9 >= 500) { last9 += 500; digitalWrite(9, !digitalRead(9)); }
  if (now - last10 >= 125) { last10 += 125; digitalWrite(10, !digitalRead(10)); }
}
