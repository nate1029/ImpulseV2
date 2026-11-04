#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <Wire.h>
Adafruit_MPU6050 mpu;
void setup() {
  Serial.begin(115200);
  Wire.begin();
  if (!mpu.begin()) { Serial.println("MPU6050 not found"); while (true) delay(10); }
  Serial.println("MPU6050 ready");
}
void loop() { delay(100); }
