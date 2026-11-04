void setup() { Serial.begin(115200); }
void loop() { Serial.printf("raw=%d mv=%d\n", analogRead(1), analogReadMilliVolts(1)); delay(250); }
