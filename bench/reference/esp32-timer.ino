hw_timer_t *timer = nullptr;
volatile bool level = false;
void IRAM_ATTR onTimer() { level = !level; digitalWrite(2, level); }
void setup() {
  pinMode(2, OUTPUT);
  timer = timerBegin(1000000);
  timerAttachInterrupt(timer, &onTimer);
  timerAlarm(timer, 250000, true, 0);
}
void loop() {}
