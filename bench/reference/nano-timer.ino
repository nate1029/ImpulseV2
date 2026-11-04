hw_timer_t *timer = nullptr;
volatile bool level = false;
void IRAM_ATTR onTimer() { level = !level; digitalWrite(D4, level); }
void setup() {
  pinMode(D4, OUTPUT);
  timer = timerBegin(0, 80, true);
  timerAttachInterrupt(timer, &onTimer, true);
  timerAlarmWrite(timer, 250000, true);
  timerAlarmEnable(timer);
}
void loop() {}
