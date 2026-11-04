const int TRIG = 4, ECHO = 5;
void setup() { Serial.begin(115200); pinMode(TRIG, OUTPUT); pinMode(ECHO, INPUT); }
void loop() {
  digitalWrite(TRIG, LOW); delayMicroseconds(2);
  digitalWrite(TRIG, HIGH); delayMicroseconds(10); digitalWrite(TRIG, LOW);
  long us = pulseIn(ECHO, HIGH, 30000);
  Serial.print("Distance: "); Serial.print(us / 58); Serial.println(" cm");
  delay(500);
}
