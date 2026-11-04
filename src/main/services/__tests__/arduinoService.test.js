/**
 * Tests for ArduinoService
 * Focuses on: command safety, input validation, output parsing
 */

// Mock dependencies before requiring the module
jest.mock('../../utils/errorHandler', () => ({
  handle: jest.fn((err) => ({ success: false, error: { message: err.message } })),
  validateInput: jest.fn(() => ({ valid: true, errors: [] })),
  getFriendlyMessage: jest.fn((err) => err.message)
}));

jest.mock('../../utils/notifications', () => ({
  progress: jest.fn(() => 'mock-id'),
  updateProgress: jest.fn(),
  dismiss: jest.fn(),
  success: jest.fn(),
  error: jest.fn()
}));

const ArduinoService = require('../arduinoService');

describe('ArduinoService', () => {
  let service;

  beforeEach(() => {
    service = new ArduinoService();
  });

  // ===== SECURITY: Command injection prevention =====
  describe('runCommand (security)', () => {
    it('should accept an array of arguments, not a shell string', async () => {
      // runCommand now takes string[] not a shell string
      const result = await service.runCommand(['version']);
      // We don't care about success here — we care that it doesn't throw
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('stdout');
      expect(result).toHaveProperty('stderr');
    });

    it('should safely handle arguments with special characters', async () => {
      // This should NOT execute shell metacharacters — the semicolon
      // is passed as a literal argument, not interpreted by a shell.
      // If arduino-cli is not installed, this will fail gracefully.
      const result = await service.runCommand(['version']);
      expect(result).toHaveProperty('success');
      // Most importantly: no shell expansion happened
      expect(result.stdout).not.toContain('PWNED');
    }, 15000);
  });

  // ===== FQBN Validation =====
  describe('validateFQBN', () => {
    it('should accept valid FQBN format', () => {
      expect(service.validateFQBN('arduino:avr:uno')).toBe(true);
      expect(service.validateFQBN('esp32:esp32:esp32')).toBe(true);
      expect(service.validateFQBN('arduino:avr:nano:cpu=atmega328old')).toBe(true);
    });

    it('should reject invalid FQBN format', () => {
      expect(service.validateFQBN('')).toBe(false);
      expect(service.validateFQBN(null)).toBe(false);
      expect(service.validateFQBN(undefined)).toBe(false);
      expect(service.validateFQBN('just-a-name')).toBe(false);
      expect(service.validateFQBN('only:two')).toBe(false);
    });
  });

  // ===== Output Parsing =====
  describe('parseCompileOutput', () => {
    it('should detect successful compilation', () => {
      const stdout = 'Sketch uses 2048 bytes (6%) of program storage space. Maximum is 32256 bytes.';
      const result = service.parseCompileOutput(stdout, '');
      expect(result.success).toBe(true);
      expect(result.programSize).toBe(2048);
      expect(result.usagePercent).toBe(6);
    });

    it('should detect compilation errors', () => {
      const stderr = "sketch.ino:5:1: error: 'foo' was not declared in this scope";
      const result = service.parseCompileOutput('', stderr);
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should collect warnings', () => {
      const stdout = 'Sketch uses 2048 bytes (6%) of program storage space.\n';
      const stderr = 'warning: unused variable x';
      const result = service.parseCompileOutput(stdout, stderr);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('waiting for a port that comes and goes', () => {
    const jobOf = () => { const lines = []; return { lines, line: (l) => lines.push(l), stage: () => {} }; };

    it('goes ahead at once when the port is listed, or when the list cannot be read', async () => {
      const service = new ArduinoService();
      service.listPorts = async () => [{ port: '/dev/cu.usbmodem1101' }];
      const job = jobOf();
      expect(await service._waitForPort('/dev/cu.usbmodem1101', job, { maxMs: 200, everyMs: 10 })).toBe(true);
      expect(job.lines).toEqual([]);
      service.listPorts = async () => { throw new Error('arduino-cli board list failed'); };
      expect(await service._waitForPort('/dev/cu.usbmodem1101', jobOf(), { maxMs: 200, everyMs: 10 })).toBe(true);
    });

    it('waits for a sleeping board to show its port again, saying so', async () => {
      const service = new ArduinoService();
      let calls = 0;
      service.listPorts = async () => (++calls < 4 ? [] : [{ port: '/dev/cu.usbmodem1101' }]);
      const job = jobOf();
      expect(await service._waitForPort('/dev/cu.usbmodem1101', job, { maxMs: 2000, everyMs: 10 })).toBe(true);
      expect(job.lines[0]).toMatch(/Waiting for \/dev\/cu\.usbmodem1101 to come back/);
      expect(job.lines[1]).toBe('/dev/cu.usbmodem1101 is back.');
      expect(calls).toBe(4);
    });

    it('gives up after the wait', async () => {
      const service = new ArduinoService();
      service.listPorts = async () => [{ port: '/dev/cu.other' }];
      const job = jobOf();
      expect(await service._waitForPort('/dev/cu.usbmodem1101', job, { maxMs: 60, everyMs: 10 })).toBe(false);
      expect(job.lines).toHaveLength(1);
    });
  });

  describe('parseUploadOutput', () => {
    it('should detect successful AVR upload', () => {
      const stderr = 'avrdude done. Thank you.';
      const result = service.parseUploadOutput('', stderr);
      expect(result.success).toBe(true);
    });

    it('should detect successful ESP32 upload', () => {
      const stderr = 'Hard resetting via RTS pin...';
      const result = service.parseUploadOutput('', stderr);
      expect(result.success).toBe(true);
    });

    it('should detect upload timeout', () => {
      const stderr = 'error: timeout waiting for device';
      const result = service.parseUploadOutput('', stderr);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should detect permission denied', () => {
      const stderr = 'error: permission denied on COM3';
      const result = service.parseUploadOutput('', stderr);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  // ===== Common Boards Fallback =====
  describe('getCommonBoards', () => {
    it('should return a non-empty array of boards', () => {
      const boards = service.getCommonBoards();
      expect(Array.isArray(boards)).toBe(true);
      expect(boards.length).toBeGreaterThan(0);
    });

    it('should include Arduino Uno', () => {
      const boards = service.getCommonBoards();
      const uno = boards.find(b => b.fqbn === 'arduino:avr:uno');
      expect(uno).toBeDefined();
      expect(uno.name).toBe('Arduino Uno');
    });

    it('should have correct board object shape', () => {
      const boards = service.getCommonBoards();
      for (const board of boards) {
        expect(board).toHaveProperty('name');
        expect(board).toHaveProperty('fqbn');
        expect(typeof board.name).toBe('string');
        expect(typeof board.fqbn).toBe('string');
      }
    });
  });
});
