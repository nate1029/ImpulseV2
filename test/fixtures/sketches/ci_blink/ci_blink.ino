// Run by CI through the bundled impulse-test (see docs/TESTING.md).
// @run 2.2s
// @expect serial contains "ready"
// @expect pin LED_BUILTIN frequency 1Hz ±5%

void setup() {
  Serial.begin(9600);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.println("ready");
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
}
