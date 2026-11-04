// Impulse simulator bridge for ESP32 boards.
//
// Impulse adds this file to a copy of the sketch only when the sketch runs in
// its simulator (Espressif's QEMU); uploads to a real board never contain it.
// QEMU emulates the CPU, memory, flash, timers and UARTs, but not the GPIO
// matrix, LEDC (PWM), ADC, RMT or I2C controllers. So the Arduino functions
// that use them are replaced here: pin activity goes to the simulator over a
// spare UART, and input levels, analog voltages and I2C replies come back.
//
// Messages are ASCII lines; times are microseconds since boot.
//   to Impulse:  B<chip>,<t>                   bridge ready
//                S<t>                          setup() starts
//                H<t>                          heartbeat (time passes)
//                M<pin>,<mode>,<t>             pinMode
//                W<pin>,<level>,<t>            digitalWrite
//                P<pin>,<duty>,<bits>,<hz>,<t> PWM (duty -1 = released)
//                N<pin>,<r>,<g>,<b>,<t>        RGB LED (neopixelWrite)
//                Q<id>,<pin>,<level>,<timeout>,<t>   pulseIn, answered by q
//                T<bus>,<addr>,<hex>,<t>       I2C write to a device that is present
//                R<id>,<bus>,<addr>,<n>,<t>    I2C read, answered by r
//                X<id>,<bus>,<addr>,<hex>,<n>,<t>   I2C write then read, answered by r
//                Z<bus>,<hex>,<t>              SPI bytes out (nothing back)
//                Y<id>,<bus>,<hex>,<t>         SPI transfer, answered by y
//                O<count>                      messages dropped (the sketch outran the bridge)
//                Fjoin,<ssid> / Fap            joined the pretend Wi-Fi network / started an access point
//   from Impulse: G                 go: the circuit's starting state has been sent
//                I<pin>,<level>   input level (-1 = nothing drives it)
//                A<pin>,<mV>       analog voltage
//                D<addr>,<addr>…   I2C devices present (hex addresses)
//                q<id>,<us>        pulseIn result
//                r<id>,<ok>,<hex>  I2C read result
//                y<id>,<hex>       SPI transfer result

// Boards that number pins the Arduino way (Nano ESP32) remap them with macros
// in the sketch; this file defines the functions themselves, by GPIO number.
#define ARDUINO_CORE_BUILD
#include <Arduino.h>
#include "driver/uart.h"
#include "driver/gpio.h"
#include "esp32-hal-spi.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "esp_netif.h"
#include "esp_event.h"
#if __has_include("esp_mac.h")
#include "esp_mac.h"
#endif
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"

#if CONFIG_IDF_TARGET_ESP32
#define SIM_CHIP "esp32"
#elif CONFIG_IDF_TARGET_ESP32S3
#define SIM_CHIP "esp32s3"
#elif CONFIG_IDF_TARGET_ESP32C3
#define SIM_CHIP "esp32c3"
#elif CONFIG_IDF_TARGET_ESP32S2
#define SIM_CHIP "esp32s2"
#else
#define SIM_CHIP "esp32"
#endif

#define SIM_UART UART_NUM_1
#define SIM_PINS 64
#define SIM_RING 16384

extern "C" {

static volatile uint8_t simMode[SIM_PINS];
static volatile uint8_t simOut[SIM_PINS];
static volatile int8_t simIn[SIM_PINS];        // -1: nothing drives the pin
static volatile uint16_t simMv[SIM_PINS];
static volatile uint8_t simIntMode[SIM_PINS];
static void *volatile simIntFn[SIM_PINS];
static void *volatile simIntArg[SIM_PINS];
static volatile bool simIntHasArg[SIM_PINS];
static volatile uint8_t simAdcBits = 12;
static volatile bool simReady = false;

// ── Outgoing messages: a ring the sketch (or an interrupt) writes, a task sends ──

static char simRing[SIM_RING];
static volatile uint32_t simHead = 0, simTail = 0, simDropped = 0;
static portMUX_TYPE simLock = portMUX_INITIALIZER_UNLOCKED;
static TaskHandle_t simTx = NULL;

static void simPut(const char *s, size_t n) {
  if (!simReady) return;
  portENTER_CRITICAL_SAFE(&simLock);
  if (simHead - simTail + n <= SIM_RING) {
    for (size_t i = 0; i < n; i++) simRing[(simHead + i) % SIM_RING] = s[i];
    simHead += n;
  } else {
    simDropped++;
  }
  portEXIT_CRITICAL_SAFE(&simLock);
  if (!simTx) return;
  if (xPortInIsrContext()) {
    vTaskNotifyGiveFromISR(simTx, NULL);
  } else {
    xTaskNotifyGive(simTx);
  }
}

static void simSendf(const char *fmt, ...) {
  char buf[96];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  if (n > 0) simPut(buf, n < (int)sizeof buf ? n : sizeof buf - 1);
}

static unsigned long simNow() { return (unsigned long)esp_timer_get_time(); }

static void simTxTask(void *) {
  static char chunk[512];
  for (;;) {
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(10));
    bool sent = false;
    for (;;) {
      size_t n = 0;
      portENTER_CRITICAL(&simLock);
      while (simTail != simHead && n < sizeof chunk) chunk[n++] = simRing[simTail++ % SIM_RING];
      uint32_t dropped = simDropped;
      simDropped = 0;
      portEXIT_CRITICAL(&simLock);
      if (dropped) {
        char d[24];
        int m = snprintf(d, sizeof d, "O%lu\n", (unsigned long)dropped);
        uart_write_bytes(SIM_UART, d, m);
      }
      if (!n) break;
      uart_write_bytes(SIM_UART, chunk, n);
      sent = true;
    }
    if (!sent) {
      char h[24];
      int m = snprintf(h, sizeof h, "H%lu\n", simNow());
      uart_write_bytes(SIM_UART, h, m);
    }
  }
}

// ── Replies Impulse sends back to a waiting call ──

static SemaphoreHandle_t simGo = NULL;
static SemaphoreHandle_t simReplyLock = NULL;   // one waiting call at a time
static SemaphoreHandle_t simReplyDone = NULL;
static volatile uint32_t simReplyId = 0;
static volatile long simReplyValue = 0;
static uint8_t simReplyData[256];
static volatile size_t simReplyLen = 0;

static bool simI2cPresent[128];

static int simHex(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static void simCallIsr(int pin) {
  void *fn = simIntFn[pin];
  if (!fn) return;
  if (simIntHasArg[pin]) ((void (*)(void *))fn)(simIntArg[pin]);
  else ((void (*)(void))fn)();
}

static void simLevelChanged(int pin, int before, int after) {
  uint8_t m = simIntMode[pin] & 0x07;
  if (!simIntFn[pin] || !m) return;
  bool fire = (m == RISING && !before && after) || (m == FALLING && before && !after) || (m == CHANGE && before != after)
    || (m == ONLOW && !after) || (m == ONHIGH && after);
  if (fire) simCallIsr(pin);
}

static int simLevel(int pin);

static void simHandle(char *line) {
  char kind = line[0];
  char *p = line + 1;
  long a = strtol(p, &p, 10);
  if (kind == 'I' || kind == 'A') {
    if (*p != ',' || a < 0 || a >= SIM_PINS) return;
    long b = strtol(p + 1, NULL, 10);
    if (kind == 'A') { simMv[a] = (uint16_t)(b < 0 ? 0 : b > 3300 ? 3300 : b); return; }
    int before = simLevel(a);
    simIn[a] = (int8_t)(b < 0 ? -1 : b ? 1 : 0);
    int after = simLevel(a);
    if (before != after) simLevelChanged(a, before, after);
  } else if (kind == 'G') {
    if (simGo) xSemaphoreGive(simGo);
  } else if (kind == 'D') {
    for (int i = 0; i < 128; i++) simI2cPresent[i] = false;
    char *s = line + 1;
    while (*s) {
      long addr = strtol(s, &s, 16);
      if (addr > 0 && addr < 128) simI2cPresent[addr] = true;
      if (*s != ',') break;
      s++;
    }
  } else if (kind == 'q' || kind == 'r' || kind == 'y') {
    if ((uint32_t)a != simReplyId || *p != ',') return;
    long v = 1;
    if (kind == 'y') p++;  // y<id>,<hex>
    else v = strtol(p + 1, &p, 10);
    size_t n = 0;
    if ((kind == 'r' && *p == ',') || kind == 'y') {
      if (kind == 'r') p++;
      while (n < sizeof simReplyData && simHex(p[0]) >= 0 && simHex(p[1]) >= 0) {
        simReplyData[n++] = (uint8_t)(simHex(p[0]) << 4 | simHex(p[1]));
        p += 2;
      }
    }
    simReplyValue = v;
    simReplyLen = n;
    xSemaphoreGive(simReplyDone);
  }
}

static void simRxTask(void *) {
  static char line[600];
  size_t len = 0;
  uint8_t buf[256];
  for (;;) {
    // Wake on the first byte, then take what else has arrived: a reply is
    // handled at once instead of when a full buffer or the timeout comes.
    int n = uart_read_bytes(SIM_UART, buf, 1, portMAX_DELAY);
    if (n <= 0) continue;
    size_t more = 0;
    uart_get_buffered_data_len(SIM_UART, &more);
    if (more) {
      int m = uart_read_bytes(SIM_UART, buf + 1, more < sizeof buf - 1 ? more : sizeof buf - 1, 0);
      if (m > 0) n += m;
    }
    for (int i = 0; i < n; i++) {
      char c = (char)buf[i];
      if (c == '\n') {
        line[len] = 0;
        if (len) simHandle(line);
        len = 0;
      } else if (len < sizeof line - 1) {
        line[len++] = c;
      }
    }
  }
}

/** Send a request and wait for its reply; false when Impulse doesn't answer in time. */
static uint32_t simNextId = 0;
static bool simAsk(const char *msg, size_t n, uint32_t id, uint32_t waitMs) {
  if (!simReady) return false;
  xSemaphoreTake(simReplyDone, 0);
  simReplyId = id;
  simPut(msg, n);
  bool ok = xSemaphoreTake(simReplyDone, pdMS_TO_TICKS(waitMs)) == pdTRUE;
  simReplyId = 0;
  return ok;
}

static void simStart() {
  if (simReady) return;
  for (int i = 0; i < SIM_PINS; i++) { simIn[i] = -1; simMv[i] = 0; }
  uart_config_t cfg = {};
  cfg.baud_rate = 2000000;
  cfg.data_bits = UART_DATA_8_BITS;
  cfg.parity = UART_PARITY_DISABLE;
  cfg.stop_bits = UART_STOP_BITS_1;
  cfg.flow_ctrl = UART_HW_FLOWCTRL_DISABLE;
  if (uart_driver_install(SIM_UART, 2048, 4096, 0, NULL, 0) != ESP_OK) return;
  uart_param_config(SIM_UART, &cfg);
  // Every byte raises the receive interrupt: messages are short, and the
  // emulator doesn't time out a part-filled FIFO promptly.
  uart_set_rx_full_threshold(SIM_UART, 1);
  uart_set_rx_timeout(SIM_UART, 1);
  simGo = xSemaphoreCreateBinary();
  simReplyLock = xSemaphoreCreateMutex();
  simReplyDone = xSemaphoreCreateBinary();
  simReady = true;
  xTaskCreatePinnedToCore(simTxTask, "impulse-tx", 3072, NULL, 5, &simTx, 0);
  xTaskCreatePinnedToCore(simRxTask, "impulse-rx", 4096, NULL, 6, NULL, 0);
  simSendf("B%s,%lu\n", SIM_CHIP, simNow());
  // setup() starts once Impulse has sent the circuit's input levels and I2C devices.
  xSemaphoreTake(simGo, pdMS_TO_TICKS(3000));
  simSendf("S%lu\n", simNow());
}

// ── Arduino: start the bridge before setup() ──

void __real_initArduino(void);
void __wrap_initArduino(void) {
  __real_initArduino();
  simStart();
}

// ── Digital pins ──

static int simLevel(int pin) {
  uint8_t mode = simMode[pin];
  if ((mode & OUTPUT) == OUTPUT && !(mode & OPEN_DRAIN)) return simOut[pin];
  int8_t in = simIn[pin];
  if ((mode & OPEN_DRAIN) && !simOut[pin]) return 0;
  if (in >= 0) return in;
  return (mode & PULLUP) ? 1 : 0;
}

// The pins' registers aren't emulated, so nothing reaches them: no GPIO setup here.
void pinMode(uint8_t pin, uint8_t mode) {
  if (pin >= SIM_PINS) return;
  simMode[pin] = mode;
  simSendf("M%u,%u,%lu\n", pin, mode, simNow());
}

void digitalWrite(uint8_t pin, uint8_t val) {
#ifdef RGB_BUILTIN
  if (pin == RGB_BUILTIN) {
    uint8_t v = val ? RGB_BRIGHTNESS : 0;
    simSendf("N%u,%u,%u,%u,%lu\n", (unsigned)(RGB_BUILTIN - SOC_GPIO_PIN_COUNT), v, v, v, simNow());
    return;
  }
#endif
  if (pin >= SIM_PINS) return;
  uint8_t level = val ? 1 : 0;
  simOut[pin] = level;
  simSendf("W%u,%u,%lu\n", pin, level, simNow());
}

int digitalRead(uint8_t pin) {
  return pin < SIM_PINS ? simLevel(pin) : 0;
}

// ── ESP-IDF's own GPIO calls: the same pins as digitalWrite ──
// Sketches that drive pins through the IDF driver (gpio_set_level and
// friends) simulate too. The real calls still run, since the core's own
// drivers use them; the circuit hears about a pin only once the bridge is up.
esp_err_t __real_gpio_set_level(gpio_num_t gpio_num, uint32_t level);
int __real_gpio_get_level(gpio_num_t gpio_num);
esp_err_t __real_gpio_set_direction(gpio_num_t gpio_num, gpio_mode_t mode);
esp_err_t __real_gpio_reset_pin(gpio_num_t gpio_num);
esp_err_t __real_gpio_config(const gpio_config_t *cfg);
esp_err_t __real_gpio_set_pull_mode(gpio_num_t gpio_num, gpio_pull_mode_t pull);

static uint8_t simIdfMode(gpio_mode_t mode, uint8_t pulls) {
  if (mode == GPIO_MODE_OUTPUT_OD || mode == GPIO_MODE_INPUT_OUTPUT_OD) return OUTPUT_OPEN_DRAIN;
  if (mode == GPIO_MODE_OUTPUT || mode == GPIO_MODE_INPUT_OUTPUT) return OUTPUT;
  if (mode == GPIO_MODE_DISABLE) return INPUT;
  return INPUT | pulls;
}

static void simIdfSetMode(int pin, uint8_t mode) {
  if (!simReady || pin < 0 || pin >= SIM_PINS) return;
  simMode[pin] = mode;
  simSendf("M%u,%u,%lu\n", pin, mode, simNow());
}

esp_err_t __wrap_gpio_set_level(gpio_num_t gpio_num, uint32_t level) {
  esp_err_t r = __real_gpio_set_level(gpio_num, level);
  int pin = (int)gpio_num;
  if (simReady && pin >= 0 && pin < SIM_PINS) {
    uint8_t l = level ? 1 : 0;
    simOut[pin] = l;
    simSendf("W%u,%u,%lu\n", pin, l, simNow());
  }
  return r;
}

int __wrap_gpio_get_level(gpio_num_t gpio_num) {
  int pin = (int)gpio_num;
  if (simReady && pin >= 0 && pin < SIM_PINS) return simLevel(pin);
  return __real_gpio_get_level(gpio_num);
}

esp_err_t __wrap_gpio_set_direction(gpio_num_t gpio_num, gpio_mode_t mode) {
  esp_err_t r = __real_gpio_set_direction(gpio_num, mode);
  int pin = (int)gpio_num;
  if (pin >= 0 && pin < SIM_PINS) simIdfSetMode(pin, simIdfMode(mode, simMode[pin] & (PULLUP | PULLDOWN)));
  return r;
}

esp_err_t __wrap_gpio_reset_pin(gpio_num_t gpio_num) {
  esp_err_t r = __real_gpio_reset_pin(gpio_num);
  simIdfSetMode((int)gpio_num, INPUT_PULLUP);  // IDF: input disabled, pull-up on
  return r;
}

esp_err_t __wrap_gpio_config(const gpio_config_t *cfg) {
  esp_err_t r = __real_gpio_config(cfg);
  if (cfg) {
    uint8_t pulls = (cfg->pull_up_en ? PULLUP : 0) | (cfg->pull_down_en ? PULLDOWN : 0);
    for (int pin = 0; pin < SIM_PINS; pin++) {
      if (cfg->pin_bit_mask & (1ULL << pin)) simIdfSetMode(pin, simIdfMode(cfg->mode, pulls));
    }
  }
  return r;
}

esp_err_t __wrap_gpio_set_pull_mode(gpio_num_t gpio_num, gpio_pull_mode_t pull) {
  esp_err_t r = __real_gpio_set_pull_mode(gpio_num, pull);
  int pin = (int)gpio_num;
  if (pin >= 0 && pin < SIM_PINS && !((simMode[pin] & OUTPUT) == OUTPUT)) {
    uint8_t pulls = pull == GPIO_PULLUP_ONLY ? PULLUP : pull == GPIO_PULLDOWN_ONLY ? PULLDOWN : pull == GPIO_PULLUP_PULLDOWN ? (PULLUP | PULLDOWN) : 0;
    simIdfSetMode(pin, INPUT | pulls);
  }
  return r;
}

static void simAttach(uint8_t pin, void *fn, void *arg, bool hasArg, int mode) {
  if (pin >= SIM_PINS) return;
  simIntFn[pin] = NULL;
  simIntArg[pin] = arg;
  simIntHasArg[pin] = hasArg;
  simIntMode[pin] = (uint8_t)mode;
  simIntFn[pin] = fn;
}

void attachInterrupt(uint8_t pin, void (*fn)(void), int mode) { simAttach(pin, (void *)fn, NULL, false, mode); }
void attachInterruptArg(uint8_t pin, void (*fn)(void *), void *arg, int mode) { simAttach(pin, (void *)fn, arg, true, mode); }
void detachInterrupt(uint8_t pin) { if (pin < SIM_PINS) { simIntFn[pin] = NULL; simIntMode[pin] = 0; } }

// attachInterrupt(pin, std::function, mode) from FunctionalInterrupt.h ends here.
void __wrap___attachInterruptFunctionalArg(uint8_t pin, void (*fn)(void *), void *arg, int mode, bool functional) {
  (void)functional;
  simAttach(pin, (void *)fn, arg, true, mode);
}

unsigned long __wrap_pulseIn(uint8_t pin, uint8_t state, unsigned long timeout) {
  if (!simReady || !simReplyLock) return 0;
  xSemaphoreTake(simReplyLock, portMAX_DELAY);
  uint32_t id = ++simNextId;
  char msg[64];
  int n = snprintf(msg, sizeof msg, "Q%lu,%u,%u,%lu,%lu\n", (unsigned long)id, pin, state ? 1 : 0, timeout, simNow());
  long us = simAsk(msg, n, id, timeout / 1000 + 2000) ? simReplyValue : 0;
  xSemaphoreGive(simReplyLock);
  return us > 0 ? (unsigned long)us : 0;
}

unsigned long __wrap_pulseInLong(uint8_t pin, uint8_t state, unsigned long timeout) {
  return __wrap_pulseIn(pin, state, timeout);
}

// ── Analog inputs ──

static uint32_t simRaw(uint8_t pin, uint8_t bits) {
  uint32_t mv = pin < SIM_PINS ? simMv[pin] : 0;
  uint32_t max = (1u << bits) - 1;
  uint32_t raw = (mv * max + 1650) / 3300;
  return raw > max ? max : raw;
}

uint16_t analogRead(uint8_t pin) { return (uint16_t)simRaw(pin, simAdcBits); }
uint16_t analogReadRaw(uint8_t pin) { return (uint16_t)simRaw(pin, 12); }
uint32_t analogReadMilliVolts(uint8_t pin) { return pin < SIM_PINS ? simMv[pin] : 0; }
void analogReadResolution(uint8_t bits) { if (bits >= 1 && bits <= 16) simAdcBits = bits; }
void analogSetWidth(uint8_t bits) { if (bits >= 9 && bits <= 12) simAdcBits = bits; }
bool adcAttachPin(uint8_t pin) { return pin < SIM_PINS; }

// ── PWM (LEDC), analogWrite, tone and the RGB LED ──
// Core 2.x drives LEDC by channel (ledcSetup, ledcAttachPin, ledcWrite(channel)),
// core 3.x by pin (ledcAttach, ledcWrite(pin)); both keep this table.

#define SIM_CHANNELS 16
static int8_t simChanPin[SIM_CHANNELS] = {-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1};
static uint32_t simChanFreq[SIM_CHANNELS];
static uint8_t simChanBits[SIM_CHANNELS];
static uint32_t simChanDuty[SIM_CHANNELS];

static void simPwm(int chan) {
  if (chan < 0 || chan >= SIM_CHANNELS || simChanPin[chan] < 0) return;
  simSendf("P%d,%lu,%u,%lu,%lu\n", simChanPin[chan], (unsigned long)simChanDuty[chan], simChanBits[chan],
    (unsigned long)simChanFreq[chan], simNow());
}

static int simChanOf(uint8_t pin) {
  for (int c = 0; c < SIM_CHANNELS; c++) if (simChanPin[c] == pin) return c;
  return -1;
}

static int simFreeChan() {
  for (int c = SIM_CHANNELS - 1; c >= 0; c--) if (simChanPin[c] < 0) return c;
  return -1;
}

static void simRelease(uint8_t pin) {
  for (int c = 0; c < SIM_CHANNELS; c++) {
    if (simChanPin[c] != pin) continue;
    simChanPin[c] = -1;
    simSendf("P%u,-1,0,0,%lu\n", pin, simNow());
  }
}

static uint32_t simTone(int chan, uint32_t freq) {
  if (chan < 0) return 0;
  simChanFreq[chan] = freq;
  simChanBits[chan] = 10;
  simChanDuty[chan] = freq ? 0x1FF : 0;
  simPwm(chan);
  return freq;
}

static uint32_t simNoteFreq(note_t note, uint8_t octave) {
  static const uint16_t base[] = {4186, 4435, 4699, 4978, 5274, 5588, 5920, 6272, 6645, 7040, 7459, 7902};
  if (octave > 8 || note >= NOTE_MAX) return 0;
  return base[note] / (1 << (8 - octave));
}

static uint32_t simWriteFreq = 1000;
static uint8_t simWriteBits = 8;

void __wrap_analogWrite(uint8_t pin, int value) {
  if (pin >= SIM_PINS) return;
  int chan = simChanOf(pin);
  if (chan < 0) {
    chan = simFreeChan();
    if (chan < 0) return;
    simChanPin[chan] = (int8_t)pin;
    simChanFreq[chan] = simWriteFreq;
    simChanBits[chan] = simWriteBits;
    simMode[pin] = OUTPUT;
  }
  uint32_t max = (1u << simChanBits[chan]) - 1;
  simChanDuty[chan] = value < 0 ? 0 : (uint32_t)value > max ? max : (uint32_t)value;
  simPwm(chan);
}

#if ESP_ARDUINO_VERSION_MAJOR >= 3

static bool simLedcAttach(uint8_t pin, uint32_t freq, uint8_t bits, int chan) {
  if (pin >= SIM_PINS || bits < 1 || bits > 20 || chan < 0 || chan >= SIM_CHANNELS) return false;
  simRelease(pin);
  simChanPin[chan] = (int8_t)pin;
  simChanFreq[chan] = freq;
  simChanBits[chan] = bits;
  simChanDuty[chan] = 0;
  simMode[pin] = OUTPUT;
  simPwm(chan);
  return true;
}

bool __wrap_ledcAttach(uint8_t pin, uint32_t freq, uint8_t bits) { return simLedcAttach(pin, freq, bits, simFreeChan()); }
bool __wrap_ledcAttachChannel(uint8_t pin, uint32_t freq, uint8_t bits, uint8_t chan) { return simLedcAttach(pin, freq, bits, chan); }

bool __wrap_ledcWrite(uint8_t pin, uint32_t duty) {
  int chan = simChanOf(pin);
  if (chan < 0) return false;
  simChanDuty[chan] = duty;
  simPwm(chan);
  return true;
}

bool __wrap_ledcWriteChannel(uint8_t chan, uint32_t duty) {
  if (chan >= SIM_CHANNELS || simChanPin[chan] < 0) return false;
  simChanDuty[chan] = duty;
  simPwm(chan);
  return true;
}

uint32_t __wrap_ledcRead(uint8_t pin) { int c = simChanOf(pin); return c < 0 ? 0 : simChanDuty[c]; }
uint32_t __wrap_ledcReadFreq(uint8_t pin) { int c = simChanOf(pin); return c < 0 || !simChanDuty[c] ? 0 : simChanFreq[c]; }

uint32_t __wrap_ledcWriteTone(uint8_t pin, uint32_t freq) {
  int chan = simChanOf(pin);
  if (chan < 0 && !simLedcAttach(pin, freq ? freq : 1000, 10, simFreeChan())) return 0;
  return simTone(simChanOf(pin), freq);
}

uint32_t __wrap_ledcWriteNote(uint8_t pin, note_t note, uint8_t octave) { return __wrap_ledcWriteTone(pin, simNoteFreq(note, octave)); }

bool __wrap_ledcDetach(uint8_t pin) { simRelease(pin); return true; }

uint32_t __wrap_ledcChangeFrequency(uint8_t pin, uint32_t freq, uint8_t bits) {
  int chan = simChanOf(pin);
  if (chan < 0 || bits < 1 || bits > 20) return 0;
  simChanFreq[chan] = freq;
  simChanBits[chan] = bits;
  simPwm(chan);
  return freq;
}

bool __wrap_ledcOutputInvert(uint8_t pin, bool invert) { (void)invert; return simChanOf(pin) >= 0; }

// Fades jump to their end; the "done" callback comes when the fade would have ended.
struct SimFade { void (*fn)(void *); void *arg; bool hasArg; };
static void simFadeDone(void *p) {
  SimFade *f = (SimFade *)p;
  if (f->hasArg) f->fn(f->arg);
  else ((void (*)(void))f->fn)();
  delete f;
}

static bool simFade(uint8_t pin, uint32_t target, int ms, void (*fn)(void *), void *arg, bool hasArg) {
  if (!__wrap_ledcWrite(pin, target)) return false;
  if (!fn) return true;
  esp_timer_create_args_t args = {};
  args.callback = simFadeDone;
  args.arg = new SimFade{fn, arg, hasArg};
  esp_timer_handle_t timer;
  if (esp_timer_create(&args, &timer) != ESP_OK) return false;
  esp_timer_start_once(timer, (uint64_t)(ms > 0 ? ms : 1) * 1000);
  return true;
}

bool __wrap_ledcFade(uint8_t pin, uint32_t start, uint32_t target, int ms) { (void)start; return simFade(pin, target, ms, NULL, NULL, false); }
bool __wrap_ledcFadeWithInterrupt(uint8_t pin, uint32_t start, uint32_t target, int ms, void (*fn)(void)) {
  (void)start;
  return simFade(pin, target, ms, (void (*)(void *))fn, NULL, false);
}
bool __wrap_ledcFadeWithInterruptArg(uint8_t pin, uint32_t start, uint32_t target, int ms, void (*fn)(void *), void *arg) {
  (void)start;
  return simFade(pin, target, ms, fn, arg, true);
}
bool __wrap_ledcFadeGamma(uint8_t pin, uint32_t start, uint32_t target, int ms) { return __wrap_ledcFade(pin, start, target, ms); }
bool __wrap_ledcFadeGammaWithInterrupt(uint8_t pin, uint32_t start, uint32_t target, int ms, void (*fn)(void)) {
  return __wrap_ledcFadeWithInterrupt(pin, start, target, ms, fn);
}
bool __wrap_ledcFadeGammaWithInterruptArg(uint8_t pin, uint32_t start, uint32_t target, int ms, void (*fn)(void *), void *arg) {
  return __wrap_ledcFadeWithInterruptArg(pin, start, target, ms, fn, arg);
}

void __wrap_analogWriteFrequency(uint8_t pin, uint32_t freq) {
  if (!freq) return;
  int chan = simChanOf(pin);
  if (chan < 0) { simWriteFreq = freq; return; }
  simChanFreq[chan] = freq;
  simPwm(chan);
}

void __wrap_analogWriteResolution(uint8_t pin, uint8_t bits) {
  if (bits < 1 || bits > 16) return;
  int chan = simChanOf(pin);
  if (chan < 0) { simWriteBits = bits; return; }
  simChanBits[chan] = bits;
  simPwm(chan);
}

void __wrap_rgbLedWriteOrdered(uint8_t pin, rgb_led_color_order_t order, uint8_t r, uint8_t g, uint8_t b) {
  (void)order;
#ifdef RGB_BUILTIN
  if (pin == RGB_BUILTIN) pin = RGB_BUILTIN - SOC_GPIO_PIN_COUNT;
#endif
  simSendf("N%u,%u,%u,%u,%lu\n", pin, r, g, b, simNow());
}

void __wrap_rgbLedWrite(uint8_t pin, uint8_t r, uint8_t g, uint8_t b) { __wrap_rgbLedWriteOrdered(pin, LED_COLOR_ORDER_GRB, r, g, b); }

#else  // core 2.x

uint32_t __wrap_ledcSetup(uint8_t chan, uint32_t freq, uint8_t bits) {
  if (chan >= SIM_CHANNELS || bits < 1 || bits > 20) return 0;
  simChanFreq[chan] = freq;
  simChanBits[chan] = bits;
  simPwm(chan);
  return freq;
}

uint32_t __wrap_ledcChangeFrequency(uint8_t chan, uint32_t freq, uint8_t bits) {
  return __wrap_ledcSetup(chan, freq, bits);
}

void __wrap_ledcAttachPin(uint8_t pin, uint8_t chan) {
  if (chan >= SIM_CHANNELS || pin >= SIM_PINS) return;
  simChanPin[chan] = (int8_t)pin;
  simMode[pin] = OUTPUT;
  simPwm(chan);
}

void __wrap_ledcDetachPin(uint8_t pin) { simRelease(pin); }

void __wrap_ledcWrite(uint8_t chan, uint32_t duty) {
  if (chan >= SIM_CHANNELS) return;
  simChanDuty[chan] = duty;
  simPwm(chan);
}

uint32_t __wrap_ledcRead(uint8_t chan) { return chan < SIM_CHANNELS ? simChanDuty[chan] : 0; }
uint32_t __wrap_ledcReadFreq(uint8_t chan) { return chan < SIM_CHANNELS && simChanDuty[chan] ? simChanFreq[chan] : 0; }
uint32_t __wrap_ledcWriteTone(uint8_t chan, uint32_t freq) { return chan < SIM_CHANNELS ? simTone(chan, freq) : 0; }
uint32_t __wrap_ledcWriteNote(uint8_t chan, note_t note, uint8_t octave) { return __wrap_ledcWriteTone(chan, simNoteFreq(note, octave)); }

void __wrap_analogWriteFrequency(uint32_t freq) { if (freq) simWriteFreq = freq; }
void __wrap_analogWriteResolution(uint8_t bits) { if (bits >= 1 && bits <= 16) simWriteBits = bits; }

#endif

void __wrap_neopixelWrite(uint8_t pin, uint8_t r, uint8_t g, uint8_t b) {
#ifdef RGB_BUILTIN
  if (pin == RGB_BUILTIN) pin = RGB_BUILTIN - SOC_GPIO_PIN_COUNT;
#endif
  simSendf("N%u,%u,%u,%u,%lu\n", pin, r, g, b, simNow());
}

// ── I2C (Wire) ──

static bool simI2cOn[2];

esp_err_t __wrap_i2cInit(uint8_t num, int8_t sda, int8_t scl, uint32_t hz) {
  if (num > 1) return ESP_FAIL;
  simI2cOn[num] = true;
  simSendf("C%u,%d,%d,%lu\n", num, sda, scl, (unsigned long)hz);
  return ESP_OK;
}

esp_err_t __wrap_i2cDeinit(uint8_t num) {
  if (num > 1) return ESP_FAIL;
  simI2cOn[num] = false;
  return ESP_OK;
}

bool __wrap_i2cIsInit(uint8_t num) { return num < 2 && simI2cOn[num]; }
esp_err_t __wrap_i2cSetClock(uint8_t num, uint32_t hz) { (void)num; (void)hz; return ESP_OK; }
esp_err_t __wrap_i2cGetClock(uint8_t num, uint32_t *hz) { (void)num; if (hz) *hz = 100000; return ESP_OK; }

static size_t simPutHex(char *out, const uint8_t *data, size_t n) {
  static const char digits[] = "0123456789abcdef";
  for (size_t i = 0; i < n; i++) {
    out[i * 2] = digits[data[i] >> 4];
    out[i * 2 + 1] = digits[data[i] & 15];
  }
  return n * 2;
}

esp_err_t __wrap_i2cWrite(uint8_t num, uint16_t addr, const uint8_t *buf, size_t size, uint32_t timeoutMs) {
  (void)timeoutMs;
  if (addr >= 128 || !simI2cPresent[addr]) return ESP_FAIL;
  // Writes don't wait for Impulse: the device is known to be there.
  size_t done = 0;
  do {
    size_t part = size - done > 120 ? 120 : size - done;
    char msg[300];
    int n = snprintf(msg, sizeof msg, "T%u,%u,", num, addr);
    n += simPutHex(msg + n, buf + done, part);
    n += snprintf(msg + n, sizeof msg - n, ",%lu\n", simNow());
    simPut(msg, n);
    done += part;
  } while (done < size);
  return ESP_OK;
}

static esp_err_t simI2cRead(char *msg, int n, uint32_t id, uint8_t *buf, size_t size, size_t *count) {
  bool answered = simAsk(msg, n, id, 1000);
  esp_err_t err = !answered ? ESP_ERR_TIMEOUT : simReplyValue ? ESP_OK : ESP_FAIL;
  size_t got = 0;
  if (err == ESP_OK) {
    got = simReplyLen < size ? simReplyLen : size;
    memcpy(buf, simReplyData, got);
    for (size_t i = got; i < size; i++) buf[i] = 0xFF;
    got = size;
  }
  if (count) *count = got;
  return err;
}

esp_err_t __wrap_i2cRead(uint8_t num, uint16_t addr, uint8_t *buf, size_t size, uint32_t timeoutMs, size_t *count) {
  (void)timeoutMs;
  if (count) *count = 0;
  if (addr >= 128 || !simI2cPresent[addr]) return ESP_FAIL;
  if (size > sizeof simReplyData) size = sizeof simReplyData;
  xSemaphoreTake(simReplyLock, portMAX_DELAY);
  uint32_t id = ++simNextId;
  char msg[64];
  int n = snprintf(msg, sizeof msg, "R%lu,%u,%u,%u,%lu\n", (unsigned long)id, num, addr, (unsigned)size, simNow());
  esp_err_t err = simI2cRead(msg, n, id, buf, size, count);
  xSemaphoreGive(simReplyLock);
  return err;
}

esp_err_t __wrap_i2cWriteReadNonStop(uint8_t num, uint16_t addr, const uint8_t *wbuf, size_t wsize, uint8_t *rbuf,
    size_t rsize, uint32_t timeoutMs, size_t *count) {
  (void)timeoutMs;
  if (count) *count = 0;
  if (addr >= 128 || !simI2cPresent[addr]) return ESP_FAIL;
  if (rsize > sizeof simReplyData) rsize = sizeof simReplyData;
  if (wsize > 120) wsize = 120;
  xSemaphoreTake(simReplyLock, portMAX_DELAY);
  uint32_t id = ++simNextId;
  char msg[320];
  int n = snprintf(msg, sizeof msg, "X%lu,%u,%u,", (unsigned long)id, num, addr);
  n += simPutHex(msg + n, wbuf, wsize);
  n += snprintf(msg + n, sizeof msg - n, ",%u,%lu\n", (unsigned)rsize, simNow());
  esp_err_t err = simI2cRead(msg, n, id, rbuf, rsize, count);
  xSemaphoreGive(simReplyLock);
  return err;
}

// ── SPI ──
// The bus handle is a stand-in (the SPI controller isn't emulated), so every
// driver function that takes it is answered here. Bytes go to Impulse's SPI
// devices in order with the pin changes (chip select is a digitalWrite);
// writes don't wait, transfers wait for the bytes the devices answer.

#define SIM_SPI_BUSES 4
struct SimSpi { uint8_t num; uint32_t clockDiv; uint8_t mode; uint8_t bitOrder; };
static SimSpi simSpi[SIM_SPI_BUSES];

static SimSpi *simSpiOf(spi_t *spi) { return (SimSpi *)spi; }

spi_t *__wrap_spiStartBus(uint8_t num, uint32_t clockDiv, uint8_t mode, uint8_t bitOrder) {
  if (num >= SIM_SPI_BUSES) return NULL;
  simSpi[num] = { num, clockDiv, mode, bitOrder };
  return (spi_t *)&simSpi[num];
}

void __wrap_spiStopBus(spi_t *spi) { (void)spi; }
void __wrap_spiAttachSCK(spi_t *spi, int8_t pin) { (void)spi; (void)pin; }
void __wrap_spiAttachMISO(spi_t *spi, int8_t pin) { (void)spi; (void)pin; }
void __wrap_spiAttachMOSI(spi_t *spi, int8_t pin) { (void)spi; (void)pin; }
void __wrap_spiDetachSCK(spi_t *spi, int8_t pin) { (void)spi; (void)pin; }
void __wrap_spiDetachMISO(spi_t *spi, int8_t pin) { (void)spi; (void)pin; }
void __wrap_spiDetachMOSI(spi_t *spi, int8_t pin) { (void)spi; (void)pin; }
void __wrap_spiAttachSS(spi_t *spi, uint8_t cs, int8_t pin) { (void)spi; (void)cs; (void)pin; }
void __wrap_spiDetachSS(spi_t *spi, int8_t pin) { (void)spi; (void)pin; }
void __wrap_spiEnableSSPins(spi_t *spi, uint8_t mask) { (void)spi; (void)mask; }
void __wrap_spiDisableSSPins(spi_t *spi, uint8_t mask) { (void)spi; (void)mask; }
void __wrap_spiSSEnable(spi_t *spi) { (void)spi; }
void __wrap_spiSSDisable(spi_t *spi) { (void)spi; }
void __wrap_spiSSSet(spi_t *spi) { (void)spi; }
void __wrap_spiSSClear(spi_t *spi) { (void)spi; }
void __wrap_spiWaitReady(spi_t *spi) { (void)spi; }
uint32_t __wrap_spiGetClockDiv(spi_t *spi) { return spi ? simSpiOf(spi)->clockDiv : 0; }
uint8_t __wrap_spiGetDataMode(spi_t *spi) { return spi ? simSpiOf(spi)->mode : 0; }
uint8_t __wrap_spiGetBitOrder(spi_t *spi) { return spi ? simSpiOf(spi)->bitOrder : 0; }
void __wrap_spiSetClockDiv(spi_t *spi, uint32_t div) { if (spi) simSpiOf(spi)->clockDiv = div; }
void __wrap_spiSetDataMode(spi_t *spi, uint8_t mode) { if (spi) simSpiOf(spi)->mode = mode; }
void __wrap_spiSetBitOrder(spi_t *spi, uint8_t order) { if (spi) simSpiOf(spi)->bitOrder = order; }
void __wrap_spiTransaction(spi_t *spi, uint32_t div, uint8_t mode, uint8_t order) {
  if (!spi) return;
  simSpiOf(spi)->clockDiv = div;
  simSpiOf(spi)->mode = mode;
  simSpiOf(spi)->bitOrder = order;
}
void __wrap_spiSimpleTransaction(spi_t *spi) { (void)spi; }
void __wrap_spiEndTransaction(spi_t *spi) { (void)spi; }

/** Bytes out, nothing back: sent ahead in chunks. */
static void simSpiWrite(spi_t *spi, const uint8_t *data, size_t len) {
  if (!spi || !simReady) return;
  size_t done = 0;
  while (done < len) {
    size_t part = len - done > 120 ? 120 : len - done;
    char msg[300];
    int n = snprintf(msg, sizeof msg, "Z%u,", simSpiOf(spi)->num);
    n += simPutHex(msg + n, data + done, part);
    n += snprintf(msg + n, sizeof msg - n, ",%lu\n", simNow());
    simPut(msg, n);
    done += part;
  }
}

/** Bytes out and the bytes the selected devices answer (0xFF from none). */
static void simSpiTransfer(spi_t *spi, const uint8_t *data, uint8_t *out, size_t len) {
  if (!spi || !simReady || !simReplyLock) { if (out) memset(out, 0xff, len); return; }
  size_t done = 0;
  while (done < len) {
    size_t part = len - done > 120 ? 120 : len - done;
    xSemaphoreTake(simReplyLock, portMAX_DELAY);
    uint32_t id = ++simNextId;
    char msg[320];
    int n = snprintf(msg, sizeof msg, "Y%lu,%u,", (unsigned long)id, simSpiOf(spi)->num);
    n += simPutHex(msg + n, data + done, part);
    n += snprintf(msg + n, sizeof msg - n, ",%lu\n", simNow());
    bool ok = simAsk(msg, n, id, 1000);
    if (out) {
      for (size_t i = 0; i < part; i++) out[done + i] = ok && i < simReplyLen ? simReplyData[i] : 0xff;
    }
    xSemaphoreGive(simReplyLock);
    done += part;
  }
}

/** A 16- or 32-bit value as bytes on the wire, in the bus's bit order. */
static size_t simSpiWord(spi_t *spi, uint32_t value, int bytes, uint8_t *buf) {
  bool lsb = spi && simSpiOf(spi)->bitOrder == 0;  // SPI_LSBFIRST
  for (int i = 0; i < bytes; i++) buf[i] = (uint8_t)(value >> (lsb ? 8 * i : 8 * (bytes - 1 - i)));
  return bytes;
}

static uint32_t simSpiValue(spi_t *spi, const uint8_t *buf, int bytes) {
  bool lsb = spi && simSpiOf(spi)->bitOrder == 0;
  uint32_t v = 0;
  for (int i = 0; i < bytes; i++) v |= (uint32_t)buf[i] << (lsb ? 8 * i : 8 * (bytes - 1 - i));
  return v;
}

void __wrap_spiWriteByte(spi_t *spi, uint8_t data) { simSpiWrite(spi, &data, 1); }
void __wrap_spiWriteByteNL(spi_t *spi, uint8_t data) { simSpiWrite(spi, &data, 1); }
void __wrap_spiWriteWord(spi_t *spi, uint16_t data) { uint8_t b[2]; simSpiWrite(spi, b, simSpiWord(spi, data, 2, b)); }
void __wrap_spiWriteShortNL(spi_t *spi, uint16_t data) { __wrap_spiWriteWord(spi, data); }
void __wrap_spiWriteLong(spi_t *spi, uint32_t data) { uint8_t b[4]; simSpiWrite(spi, b, simSpiWord(spi, data, 4, b)); }
void __wrap_spiWriteLongNL(spi_t *spi, uint32_t data) { __wrap_spiWriteLong(spi, data); }
void __wrap_spiWriteNL(spi_t *spi, const void *data, uint32_t len) { simSpiWrite(spi, (const uint8_t *)data, len); }
void __wrap_spiWrite(spi_t *spi, const uint32_t *data, uint8_t len) {
  for (uint8_t i = 0; i < len; i++) __wrap_spiWriteLong(spi, data[i]);
}

// 16-bit pixels, high byte first (what displays expect).
void __wrap_spiWritePixelsNL(spi_t *spi, const void *data, uint32_t len) {
  const uint8_t *p = (const uint8_t *)data;
  uint8_t buf[120];
  size_t n = 0;
  for (uint32_t i = 0; i + 1 < len; i += 2) {
    buf[n++] = p[i + 1];
    buf[n++] = p[i];
    if (n == sizeof buf) { simSpiWrite(spi, buf, n); n = 0; }
  }
  if (n) simSpiWrite(spi, buf, n);
}

uint8_t __wrap_spiTransferByte(spi_t *spi, uint8_t data) { uint8_t r; simSpiTransfer(spi, &data, &r, 1); return r; }
uint8_t __wrap_spiTransferByteNL(spi_t *spi, uint8_t data) { return __wrap_spiTransferByte(spi, data); }
uint16_t __wrap_spiTransferWord(spi_t *spi, uint16_t data) {
  uint8_t b[2], r[2];
  simSpiTransfer(spi, b, r, simSpiWord(spi, data, 2, b));
  return (uint16_t)simSpiValue(spi, r, 2);
}
uint16_t __wrap_spiTransferShortNL(spi_t *spi, uint16_t data) { return __wrap_spiTransferWord(spi, data); }
uint32_t __wrap_spiTransferLong(spi_t *spi, uint32_t data) {
  uint8_t b[4], r[4];
  simSpiTransfer(spi, b, r, simSpiWord(spi, data, 4, b));
  return simSpiValue(spi, r, 4);
}
uint32_t __wrap_spiTransferLongNL(spi_t *spi, uint32_t data) { return __wrap_spiTransferLong(spi, data); }
void __wrap_spiTransferBytes(spi_t *spi, const uint8_t *data, uint8_t *out, uint32_t size) {
  if (data) {
    simSpiTransfer(spi, data, out, size);
    return;
  }
  // No data: clock out 0xFF (SD cards read this way).
  uint8_t ones[120];
  memset(ones, 0xff, sizeof ones);
  for (uint32_t done = 0; done < size;) {
    uint32_t part = size - done > sizeof ones ? sizeof ones : size - done;
    simSpiTransfer(spi, ones, out ? out + done : NULL, part);
    done += part;
  }
}
void __wrap_spiTransferBytesNL(spi_t *spi, const void *data, uint8_t *out, uint32_t size) {
  __wrap_spiTransferBytes(spi, (const uint8_t *)data, out, size);
}
void __wrap_spiTransfer(spi_t *spi, uint32_t *data, uint8_t len) {
  for (uint8_t i = 0; i < len; i++) data[i] = __wrap_spiTransferLong(spi, data[i]);
}
void __wrap_spiTransferBits(spi_t *spi, uint32_t data, uint32_t *out, uint8_t bits) {
  uint32_t r = bits <= 8 ? __wrap_spiTransferByte(spi, (uint8_t)data) : bits <= 16 ? __wrap_spiTransferWord(spi, (uint16_t)data) : __wrap_spiTransferLong(spi, data);
  if (out) *out = r;
}
void __wrap_spiTransferBitsNL(spi_t *spi, uint32_t data, uint32_t *out, uint8_t bits) { __wrap_spiTransferBits(spi, data, out, bits); }

// ── Wi-Fi: a pretend network ──
// The emulator has no radio: starting it would touch hardware QEMU doesn't
// model and crash the chip. So the Wi-Fi driver's API answers here instead:
// WiFi.begin() joins a pretend network after a moment and gets 10.0.2.15,
// scans find two networks, and a soft AP starts. Nothing goes on air, so
// requests to the internet don't get answers (the network interface stays
// down, and connecting fails the way it does with no route).

static wifi_mode_t simWifiMode = WIFI_MODE_NULL;
static bool simWifiStarted = false;
static bool simStaConnected = false;
static wifi_config_t simStaConfig;
static wifi_config_t simApConfig;
static esp_netif_t *simStaNetif = NULL;
static esp_netif_t *simApNetif = NULL;
static esp_netif_ip_info_t simStaIp;
static esp_timer_handle_t simJoinTimer = NULL;
static const uint8_t SIM_BSSID[6] = {0x02, 0x49, 0x4d, 0x50, 0x4c, 0x53};
static const char *const SIM_NETWORKS[] = {"Impulse-WiFi", "Impulse-Guest"};

static void simPost(esp_event_base_t base, int32_t id, const void *data, size_t size) {
  esp_event_post(base, id, (void *)data, size, pdMS_TO_TICKS(100));  // IDF 4.4 takes a non-const pointer
}

static void simJoined(void *) {
  if (!simWifiStarted || simStaConnected) return;
  wifi_event_sta_connected_t c = {};
  memcpy(c.ssid, simStaConfig.sta.ssid, sizeof c.ssid);
  c.ssid_len = strnlen((const char *)simStaConfig.sta.ssid, sizeof simStaConfig.sta.ssid);
  memcpy(c.bssid, SIM_BSSID, 6);
  c.channel = 6;
  c.authmode = simStaConfig.sta.password[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
  simStaConnected = true;
  simPost(WIFI_EVENT, WIFI_EVENT_STA_CONNECTED, &c, sizeof c);
  ip_event_got_ip_t got = {};
  got.esp_netif = simStaNetif;
  got.ip_info.ip.addr = ESP_IP4TOADDR(10, 0, 2, 15);
  got.ip_info.netmask.addr = ESP_IP4TOADDR(255, 255, 255, 0);
  got.ip_info.gw.addr = ESP_IP4TOADDR(10, 0, 2, 2);
  got.ip_changed = true;
  simStaIp = got.ip_info;
  simPost(IP_EVENT, IP_EVENT_STA_GOT_IP, &got, sizeof got);
  char msg[64];
  int n = snprintf(msg, sizeof msg, "Fjoin,%.32s\n", (const char *)simStaConfig.sta.ssid);
  simPut(msg, n);
}

static void simLeave(uint8_t reason) {
  if (!simStaConnected) return;
  simStaConnected = false;
  wifi_event_sta_disconnected_t d = {};
  memcpy(d.ssid, simStaConfig.sta.ssid, sizeof d.ssid);
  d.ssid_len = strnlen((const char *)simStaConfig.sta.ssid, sizeof simStaConfig.sta.ssid);
  memcpy(d.bssid, SIM_BSSID, 6);
  d.reason = reason;
  simPost(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, &d, sizeof d);
}

esp_err_t __wrap_esp_wifi_init(const wifi_init_config_t *config) { (void)config; return ESP_OK; }
esp_err_t __wrap_esp_wifi_deinit(void) { simWifiStarted = false; simStaConnected = false; return ESP_OK; }
esp_err_t __wrap_esp_wifi_set_mode(wifi_mode_t mode) { simWifiMode = mode; return ESP_OK; }
esp_err_t __wrap_esp_wifi_get_mode(wifi_mode_t *mode) { if (mode) *mode = simWifiMode; return ESP_OK; }

esp_err_t __wrap_esp_wifi_start(void) {
  if (simWifiStarted) return ESP_OK;
  simWifiStarted = true;
  if (simWifiMode == WIFI_MODE_STA || simWifiMode == WIFI_MODE_APSTA) simPost(WIFI_EVENT, WIFI_EVENT_STA_START, NULL, 0);
  if (simWifiMode == WIFI_MODE_AP || simWifiMode == WIFI_MODE_APSTA) {
    simPost(WIFI_EVENT, WIFI_EVENT_AP_START, NULL, 0);
    simPut("Fap\n", 4);
  }
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_stop(void) {
  if (!simWifiStarted) return ESP_OK;
  simLeave(WIFI_REASON_ASSOC_LEAVE);
  simWifiStarted = false;
  if (simWifiMode == WIFI_MODE_STA || simWifiMode == WIFI_MODE_APSTA) simPost(WIFI_EVENT, WIFI_EVENT_STA_STOP, NULL, 0);
  if (simWifiMode == WIFI_MODE_AP || simWifiMode == WIFI_MODE_APSTA) simPost(WIFI_EVENT, WIFI_EVENT_AP_STOP, NULL, 0);
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_restore(void) {
  memset(&simStaConfig, 0, sizeof simStaConfig);
  memset(&simApConfig, 0, sizeof simApConfig);
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_set_config(wifi_interface_t iface, wifi_config_t *conf) {
  if (!conf) return ESP_ERR_INVALID_ARG;
  if (iface == WIFI_IF_STA) simStaConfig = *conf;
  else simApConfig = *conf;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_get_config(wifi_interface_t iface, wifi_config_t *conf) {
  if (!conf) return ESP_ERR_INVALID_ARG;
  *conf = iface == WIFI_IF_STA ? simStaConfig : simApConfig;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_connect(void) {
  if (!simWifiStarted) return ESP_ERR_WIFI_NOT_STARTED;
  if (!simJoinTimer) {
    esp_timer_create_args_t args = {};
    args.callback = simJoined;
    args.name = "impulse-wifi";
    esp_timer_create(&args, &simJoinTimer);
  }
  esp_timer_stop(simJoinTimer);
  esp_timer_start_once(simJoinTimer, 400000);  // a real join takes a moment
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_disconnect(void) {
  if (simJoinTimer) esp_timer_stop(simJoinTimer);
  simLeave(WIFI_REASON_ASSOC_LEAVE);
  return ESP_OK;
}

static uint16_t simScanCount = 0;
static esp_timer_handle_t simScanTimer = NULL;

static void simScanned(void *) {
  simScanCount = 2;
  wifi_event_sta_scan_done_t done = {};
  done.status = 0;
  done.number = simScanCount;
  simPost(WIFI_EVENT, WIFI_EVENT_SCAN_DONE, &done, sizeof done);
}

// Like a real scan, it ends a moment later (Arduino's scanNetworks() clears
// its "done" flag after starting the scan, so an instant answer would be lost).
esp_err_t __wrap_esp_wifi_scan_start(const wifi_scan_config_t *config, bool block) {
  (void)config;
  if (block) {
    simScanCount = 2;
    return ESP_OK;
  }
  if (!simScanTimer) {
    esp_timer_create_args_t args = {};
    args.callback = simScanned;
    args.name = "impulse-scan";
    esp_timer_create(&args, &simScanTimer);
  }
  esp_timer_stop(simScanTimer);
  esp_timer_start_once(simScanTimer, 300000);
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_scan_stop(void) { return ESP_OK; }
esp_err_t __wrap_esp_wifi_scan_get_ap_num(uint16_t *number) { if (number) *number = simScanCount; return ESP_OK; }

esp_err_t __wrap_esp_wifi_scan_get_ap_records(uint16_t *number, wifi_ap_record_t *records) {
  if (!number || !records) return ESP_ERR_INVALID_ARG;
  uint16_t n = *number < simScanCount ? *number : simScanCount;
  for (uint16_t i = 0; i < n; i++) {
    memset(&records[i], 0, sizeof records[i]);
    strncpy((char *)records[i].ssid, SIM_NETWORKS[i], sizeof records[i].ssid - 1);
    memcpy(records[i].bssid, SIM_BSSID, 6);
    records[i].bssid[5] += i;
    records[i].primary = i ? 11 : 6;
    records[i].rssi = i ? -71 : -48;
    records[i].authmode = i ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;
  }
  *number = n;
  simScanCount = 0;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_sta_get_ap_info(wifi_ap_record_t *ap) {
  if (!simStaConnected) return ESP_ERR_WIFI_NOT_CONNECT;
  if (!ap) return ESP_ERR_INVALID_ARG;
  memset(ap, 0, sizeof *ap);
  memcpy(ap->ssid, simStaConfig.sta.ssid, sizeof ap->ssid);
  memcpy(ap->bssid, SIM_BSSID, 6);
  ap->primary = 6;
  ap->rssi = -48;
  ap->authmode = simStaConfig.sta.password[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
  return ESP_OK;
}

// The emulated chip's eFuses are blank, so its MAC would read 00:00:00:00:00:00:
// use a fixed one with Espressif's prefix (the access point's is one higher).
esp_err_t __wrap_esp_wifi_get_mac(wifi_interface_t iface, uint8_t mac[6]) {
  if (!mac) return ESP_ERR_INVALID_ARG;
  esp_read_mac(mac, iface == WIFI_IF_STA ? ESP_MAC_WIFI_STA : ESP_MAC_WIFI_SOFTAP);
  bool blank = true;
  for (int i = 0; i < 6; i++) if (mac[i]) blank = false;
  if (blank) {
    static const uint8_t sim[6] = {0x24, 0x0a, 0xc4, 0x1d, 0x5e, 0x10};
    memcpy(mac, sim, 6);
    if (iface != WIFI_IF_STA) mac[5] += 1;
  }
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_get_channel(uint8_t *primary, wifi_second_chan_t *second) {
  if (primary) *primary = 6;
  if (second) *second = WIFI_SECOND_CHAN_NONE;
  return ESP_OK;
}

esp_err_t __wrap_esp_wifi_set_channel(uint8_t primary, wifi_second_chan_t second) { (void)primary; (void)second; return ESP_OK; }
esp_err_t __wrap_esp_wifi_set_ps(wifi_ps_type_t type) { (void)type; return ESP_OK; }
esp_err_t __wrap_esp_wifi_set_storage(wifi_storage_t storage) { (void)storage; return ESP_OK; }
esp_err_t __wrap_esp_wifi_set_protocol(wifi_interface_t iface, uint8_t protocols) { (void)iface; (void)protocols; return ESP_OK; }
esp_err_t __wrap_esp_wifi_get_protocol(wifi_interface_t iface, uint8_t *protocols) {
  (void)iface;
  if (protocols) *protocols = WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G | WIFI_PROTOCOL_11N;
  return ESP_OK;
}
esp_err_t __wrap_esp_wifi_set_bandwidth(wifi_interface_t iface, wifi_bandwidth_t bw) { (void)iface; (void)bw; return ESP_OK; }
esp_err_t __wrap_esp_wifi_set_max_tx_power(int8_t power) { (void)power; return ESP_OK; }
esp_err_t __wrap_esp_wifi_get_max_tx_power(int8_t *power) { if (power) *power = 80; return ESP_OK; }

esp_err_t __wrap_esp_wifi_ap_get_sta_list(wifi_sta_list_t *sta) {
  if (sta) memset(sta, 0, sizeof *sta);
  return ESP_OK;
}

// The interfaces exist (sketches read their MAC, hostname and IP), with no radio driver behind them.
static esp_netif_t *simNetif(const esp_netif_config_t *cfg, wifi_interface_t iface) {
  esp_netif_t *netif = esp_netif_new(cfg);
  uint8_t mac[6];
  if (netif && __wrap_esp_wifi_get_mac(iface, mac) == ESP_OK) esp_netif_set_mac(netif, mac);  // core 3.x reads it here
  return netif;
}

esp_netif_t *__wrap_esp_netif_create_default_wifi_sta(void) {
  esp_netif_config_t cfg = ESP_NETIF_DEFAULT_WIFI_STA();
  simStaNetif = simNetif(&cfg, WIFI_IF_STA);
  return simStaNetif;
}

esp_netif_t *__wrap_esp_netif_create_default_wifi_ap(void) {
  esp_netif_config_t cfg = ESP_NETIF_DEFAULT_WIFI_AP();
  simApNetif = simNetif(&cfg, WIFI_IF_AP);
  return simApNetif;
}

esp_err_t __real_esp_netif_get_ip_info(esp_netif_t *netif, esp_netif_ip_info_t *ip);
esp_err_t __wrap_esp_netif_get_ip_info(esp_netif_t *netif, esp_netif_ip_info_t *ip) {
  if (netif && netif == simStaNetif && ip) {
    if (simStaConnected) *ip = simStaIp;
    else memset(ip, 0, sizeof *ip);
    return ESP_OK;
  }
  return __real_esp_netif_get_ip_info(netif, ip);
}

bool __real_esp_netif_is_netif_up(esp_netif_t *netif);
bool __wrap_esp_netif_is_netif_up(esp_netif_t *netif) {
  if (netif && netif == simStaNetif) return simStaConnected;
  if (netif && netif == simApNetif) return simWifiStarted;
  return __real_esp_netif_is_netif_up(netif);
}

// ── Arduino Nano ESP32: no double-tap detection ──
// Its startup code keeps a marker at the top of PSRAM's address window, which
// the emulator doesn't map. The marker only detects a double press of RESET.

void __wrap_double_tap_init(void) {}
void __wrap_double_tap_mark(void) {}
void __wrap_double_tap_invalidate(void) {}
bool __wrap_double_tap_check_match(void) { return false; }

}  // extern "C"
