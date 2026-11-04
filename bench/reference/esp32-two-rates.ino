unsigned long a = 0, b = 0;
bool la = false, lb = false;
void setup() { pinMode(25, OUTPUT); pinMode(26, OUTPUT); }
void loop() {
  unsigned long now = millis();
  if (now - a >= 500) { a += 500; la = !la; digitalWrite(25, la); }
  if (now - b >= 100) { b += 100; lb = !lb; digitalWrite(26, lb); }
}
