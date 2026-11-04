#include <stdint.h>
#include "soc/soc_caps.h"
#define USB_VID 0x303a
#define USB_PID 0x1001
#define PIN_RGB_LED 48
// BUILTIN_LED can be used in new Arduino API digitalWrite() like in Blink.ino
static const uint8_t LED_BUILTIN = SOC_GPIO_PIN_COUNT + PIN_RGB_LED;
#define BUILTIN_LED  LED_BUILTIN // backward compatibility
#define LED_BUILTIN LED_BUILTIN  // allow testing #ifdef LED_BUILTIN
#define RGB_BUILTIN LED_BUILTIN
#define RGB_BRIGHTNESS 64
static const uint8_t TX = 43;
static const uint8_t RX = 44;
static const uint8_t SDA = 8;
static const uint8_t SCL = 9;
static const uint8_t A0 = 1;
static const uint8_t T1 = 1;
