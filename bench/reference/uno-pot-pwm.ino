void setup() { pinMode(9, OUTPUT); }
void loop() { analogWrite(9, analogRead(A0) / 4); delay(10); }
