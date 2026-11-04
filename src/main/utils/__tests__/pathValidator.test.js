/**
 * Tests for pathValidator
 * Focuses on: path traversal prevention, directory approval, sandboxing
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { validatePath, approveDirectory, revokeDirectory, getApprovedDirectories, onApprovedRootsChange } = require('../pathValidator');

describe('pathValidator', () => {
  afterEach(() => {
    // Clean up approved directories between tests
    for (const dir of getApprovedDirectories()) {
      revokeDirectory(dir);
    }
  });

  describe('validatePath (no approved dirs)', () => {
    it('should deny every path when no directories are approved', () => {
      const result = validatePath('/some/random/path');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('outside the folders you opened');
    });

    it('should reject null/undefined/empty paths', () => {
      expect(validatePath(null).valid).toBe(false);
      expect(validatePath(undefined).valid).toBe(false);
      expect(validatePath('').valid).toBe(false);
    });

    it('should reject paths with null bytes', () => {
      const result = validatePath('/path/with\0null');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('null bytes');
    });
  });

  describe('validatePath (with approved dirs)', () => {
    it('should allow paths within approved directory', () => {
      const root = path.resolve('/projects/my-sketch');
      approveDirectory(root);

      const result = validatePath(path.join(root, 'sketch.ino'));
      expect(result.valid).toBe(true);
    });

    it('should reject paths outside approved directories', () => {
      const root = path.resolve('/projects/my-sketch');
      approveDirectory(root);

      const result = validatePath(path.resolve('/etc/passwd'));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('outside the folders you opened');
    });

    it('should not treat a sibling with a shared prefix as inside', () => {
      const root = path.resolve('/projects/my-sketch');
      approveDirectory(root);
      expect(validatePath(path.resolve('/projects/my-sketch-evil/x.ino')).valid).toBe(false);
    });

    it('should allow reads but deny writes in read-only roots', () => {
      const root = path.resolve('/libraries/Servo/examples');
      approveDirectory(root, { readOnly: true });
      const file = path.join(root, 'Sweep', 'Sweep.ino');
      expect(validatePath(file).valid).toBe(true);
      const write = validatePath(file, { write: true });
      expect(write.valid).toBe(false);
      expect(write.error).toContain('read-only');
    });

    it('should keep a root writable if it was approved writable first', () => {
      const root = path.resolve('/projects/shared');
      approveDirectory(root);
      approveDirectory(root, { readOnly: true });
      expect(validatePath(path.join(root, 'a.ino'), { write: true }).valid).toBe(true);
    });

    // Creating symlinks needs admin rights on Windows.
    (process.platform === 'win32' ? it.skip : it)('should block symlinks that escape an approved root', () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-pv-'));
      const root = path.join(base, 'project');
      const outside = path.join(base, 'secret');
      fs.mkdirSync(root);
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'key.txt'), 'x');
      fs.symlinkSync(outside, path.join(root, 'link'));
      approveDirectory(root);
      expect(validatePath(path.join(root, 'link', 'key.txt')).valid).toBe(false);
      expect(validatePath(path.join(root, 'new-file.ino'), { write: true }).valid).toBe(true);
    });

    it('should notify listeners when roots change', () => {
      const seen = [];
      const off = onApprovedRootsChange(roots => seen.push(roots.length));
      approveDirectory(path.resolve('/projects/listen'));
      off();
      expect(seen).toEqual([1]);
    });

    it('should block path traversal attempts', () => {
      const root = path.resolve('/projects/my-sketch');
      approveDirectory(root);

      const traversal = path.join(root, '..', '..', 'etc', 'passwd');
      const result = validatePath(traversal);
      expect(result.valid).toBe(false);
    });

    it('should allow paths in any of multiple approved directories', () => {
      const root1 = path.resolve('/projects/sketch-a');
      const root2 = path.resolve('/projects/sketch-b');
      approveDirectory(root1);
      approveDirectory(root2);

      expect(validatePath(path.join(root1, 'main.ino')).valid).toBe(true);
      expect(validatePath(path.join(root2, 'main.ino')).valid).toBe(true);
    });
  });

  describe('approveDirectory / revokeDirectory', () => {
    it('should track approved directories', () => {
      const dir = path.resolve('/test/dir');
      approveDirectory(dir);
      expect(getApprovedDirectories()).toContain(dir);
    });

    it('should revoke approved directories', () => {
      const dir = path.resolve('/test/dir');
      approveDirectory(dir);
      revokeDirectory(dir);
      expect(getApprovedDirectories()).not.toContain(dir);
    });

    it('should handle null/undefined gracefully', () => {
      expect(() => approveDirectory(null)).not.toThrow();
      expect(() => revokeDirectory(undefined)).not.toThrow();
    });
  });
});
