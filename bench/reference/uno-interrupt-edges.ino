volatile unsigned long edges = 0;
void onEdge() { edges++; }
void setup() { Serial.begin(9600); analogWrite(9, 128); pinMode(2, INPUT); attachInterrupt(digitalPinToInterrupt(2), onEdge, RISING); }
void loop() {
  delay(1000);
  noInterrupts(); unsigned long n = edges; edges = 0; interrupts();
  Serial.print("edges/s: "); Serial.println(n);
}
