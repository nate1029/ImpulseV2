const int TRIG = 9, ECHO = 10;
void setup() { Serial.begin(9600); pinMode(TRIG, OUTPUT); pinMode(ECHO, INPUT); }
void loop() {
  digitalWrite(TRIG, LOW); delayMicroseconds(2);
  digitalWrite(TRIG, HIGH); delayMicroseconds(10); digitalWrite(TRIG, LOW);
  long us = pulseIn(ECHO, HIGH, 30000);
  Serial.print("Distance: "); Serial.print(us / 58); Serial.println(" cm");
  delay(500);
}
