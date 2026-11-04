// Probe: Arduino-Pico pin setters, PWM range, second core.
#include <Arduino.h>
#include <Wire.h>
#include <SPI.h>
void setup() {
  Serial.begin(115200);
  Serial1.setRX(1);
  Serial1.setTX(0);
  Serial1.begin(9600);
  Wire.setSDA(4);
  Wire.setSCL(5);
  Wire.begin();
  analogWriteFreq(1000);
  analogWriteRange(255);
  pinMode(LED_BUILTIN, OUTPUT);
}
void loop() { analogWrite(LED_BUILTIN, 128); delay(100); }
void setup1() {}
void loop1() { rp2040.fifo.push(analogRead(A0)); delay(10); }
