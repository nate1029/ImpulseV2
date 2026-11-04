void setup() { Serial.begin(115200); }
void loop() { Serial.printf("raw=%d mv=%d\n", analogRead(34), analogReadMilliVolts(34)); delay(250); }
