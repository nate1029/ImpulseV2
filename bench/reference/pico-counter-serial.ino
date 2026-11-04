unsigned long n = 0;
void setup() { Serial.begin(115200); while (!Serial && millis() < 5000) delay(10); }
void loop() { Serial.print("count="); Serial.println(n++); delay(200); }
