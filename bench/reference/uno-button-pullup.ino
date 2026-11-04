int last = -1;
void setup() { Serial.begin(9600); pinMode(2, INPUT_PULLUP); pinMode(LED_BUILTIN, OUTPUT); }
void loop() {
  int pressed = digitalRead(2) == LOW;
  digitalWrite(LED_BUILTIN, pressed ? HIGH : LOW);
  if (pressed != last) { Serial.println(pressed ? "pressed" : "released"); last = pressed; }
  delay(20);
}
