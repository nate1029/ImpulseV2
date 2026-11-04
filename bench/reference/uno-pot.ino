void setup() { Serial.begin(9600); }
void loop() { Serial.print("pot="); Serial.println(analogRead(A0)); delay(250); }
