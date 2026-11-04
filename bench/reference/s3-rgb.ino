const char *names[] = {"red", "green", "blue"};
void setup() { Serial.begin(115200); }
void loop() {
  for (int i = 0; i < 3; i++) {
    rgbLedWrite(RGB_BUILTIN, i == 0 ? 40 : 0, i == 1 ? 40 : 0, i == 2 ? 40 : 0);
    Serial.println(names[i]);
    delay(1000);
  }
}
