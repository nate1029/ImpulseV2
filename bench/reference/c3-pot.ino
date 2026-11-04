void setup() { Serial.begin(115200); }
void loop() { Serial.printf("raw=%d mv=%d\n", analogRead(2), analogReadMilliVolts(2)); delay(250); }
