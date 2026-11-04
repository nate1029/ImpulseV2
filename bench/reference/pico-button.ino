int last = -1;
void setup() { Serial.begin(115200); while (!Serial && millis() < 5000) delay(10); pinMode(14, INPUT_PULLUP); pinMode(15, OUTPUT); }
void loop() {
  int pressed = digitalRead(14) == LOW;
  digitalWrite(15, pressed ? HIGH : LOW);
  if (pressed != last) { Serial.println(pressed ? "pressed" : "released"); last = pressed; }
  delay(20);
}
