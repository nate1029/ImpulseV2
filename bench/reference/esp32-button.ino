int last = -1;
void setup() { Serial.begin(115200); pinMode(15, INPUT_PULLUP); }
void loop() {
  int pressed = digitalRead(15) == LOW;
  if (pressed != last) { Serial.println(pressed ? "pressed" : "released"); last = pressed; }
  delay(20);
}
