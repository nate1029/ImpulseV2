void setup() { Serial.begin(115200); }
void loop() { Serial.print("raw="); Serial.println(analogRead(26)); delay(250); }
