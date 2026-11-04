void setup() {
  Serial.begin(115200);
  ledcAttach(6, 1000, 10);
  ledcWrite(6, 256);
  Serial.println("PWM on");
}
void loop() {}
