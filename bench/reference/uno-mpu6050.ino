#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <Wire.h>
Adafruit_MPU6050 mpu;
void setup() {
  Serial.begin(115200);
  if (!mpu.begin()) { Serial.println("MPU6050 not found"); while (true) delay(10); }
  Serial.println("MPU6050 ready");
}
void loop() {
  sensors_event_t a, g, t; mpu.getEvent(&a, &g, &t);
  Serial.print(a.acceleration.x); Serial.print(' '); Serial.print(a.acceleration.y); Serial.print(' '); Serial.println(a.acceleration.z);
  delay(500);
}
