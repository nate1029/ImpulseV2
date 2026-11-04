unsigned long n = 0;
void setup() { Serial.begin(9600); }
void loop() { Serial.print("count="); Serial.println(n++); delay(200); }
