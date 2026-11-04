int last = -1;
void setup() { Serial.begin(115200); pinMode(3, INPUT_PULLUP); pinMode(5, OUTPUT); }
void loop() {
  int pressed = digitalRead(3) == LOW;
  digitalWrite(5, pressed ? HIGH : LOW);
  if (pressed != last) { Serial.println(pressed ? "pressed" : "released"); last = pressed; }
  delay(20);
}
