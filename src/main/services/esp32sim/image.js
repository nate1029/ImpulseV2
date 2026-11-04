/**
 * The flash image QEMU boots: bootloader, partition table, boot_app0 (the OTA
 * data that selects the app) and the app, at the offsets esptool writes them
 * to a real board, in an erased (0xFF) flash of the board's size.
 * @module main/services/esp32sim/image
 */

const SIZES = { '2MB': 2, '4MB': 4, '8MB': 8, '16MB': 16 };

/** Flash size in bytes from build.flash_size ("4MB"); QEMU takes 2, 4, 8 or 16 MB. */
function flashBytes(flashSize) {
  return (SIZES[String(flashSize || '').toUpperCase()] || 4) * 1024 * 1024;
}

/**
 * @param {{ bootloader: Buffer, bootloaderAddr: number, partitions: Buffer, bootApp0?: Buffer|null, app: Buffer, flashSize?: string }} parts
 * @returns {Buffer}
 */
function buildFlashImage({ bootloader, bootloaderAddr, partitions, bootApp0, app, flashSize }) {
  const size = flashBytes(flashSize);
  const image = Buffer.alloc(size, 0xff);
  const put = (data, offset, name) => {
    if (!data?.length) throw new Error(`The ${name} is missing from the build.`);
    if (offset + data.length > size) throw new Error(`The ${name} doesn't fit in ${size / 1048576} MB of flash.`);
    data.copy(image, offset);
  };
  put(bootloader, bootloaderAddr, 'bootloader');
  put(partitions, 0x8000, 'partition table');
  if (bootApp0?.length) put(bootApp0, 0xe000, 'boot_app0 data');
  put(app, 0x10000, 'app');
  return image;
}

module.exports = { buildFlashImage, flashBytes };
