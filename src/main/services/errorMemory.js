const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);

function getAppDataDir() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch (_) { /* not in Electron */ }
  const fallback = process.env.APPDATA ||
    (process.platform === 'darwin' ? path.join(process.env.HOME, 'Library/Preferences') : path.join(process.env.HOME, '.config'));
  return path.join(fallback, 'arduino-ide-cursor');
}

class ErrorMemory {
  constructor() {
    this.memoryPath = path.join(getAppDataDir(), 'error-memory.json');
    this.memory = {
      errors: [],
      patterns: [],
      fixes: []
    };
    this.loadMemory();
  }

  async ensureDirectory() {
    const dir = path.dirname(this.memoryPath);
    try {
      await mkdir(dir, { recursive: true });
    } catch (error) {
      // Directory might already exist
    }
  }

  async loadMemory() {
    try {
      await this.ensureDirectory();
      const data = await readFile(this.memoryPath, 'utf8');
      this.memory = JSON.parse(data);
    } catch (error) {
      // File doesn't exist yet, use default memory
      this.memory = {
        errors: [],
        patterns: [],
        fixes: []
      };
    }
  }

  async saveMemory() {
    try {
      await this.ensureDirectory();
      await writeFile(this.memoryPath, JSON.stringify(this.memory, null, 2), 'utf8');
    } catch (error) {
      console.error('Failed to save error memory:', error);
    }
  }

  extractErrorPattern(errorMessage) {
    // Extract common error patterns
    const patterns = {
      undefinedReference: /undefined reference to ['"](.+?)['"]/i,
      notDeclared: /'(.+?)' was not declared/i,
      multipleDefinition: /multiple definition of ['"](.+?)['"]/i,
      portNotFound: /port.*not found/i,
      permissionDenied: /permission denied|access denied/i,
      timeout: /timeout|timed out/i,
      compilationError: /error:.*/i,
      uploadError: /upload.*error/i
    };

    for (const [type, pattern] of Object.entries(patterns)) {
      const match = errorMessage.match(pattern);
      if (match) {
        return {
          type,
          pattern: match[0],
          details: match[1] || match[0]
        };
      }
    }

    return {
      type: 'unknown',
      pattern: errorMessage.substring(0, 100),
      details: errorMessage
    };
  }

  async analyzeError(error) {
    const errorMessage = error.message || error.toString();
    const errorPattern = this.extractErrorPattern(errorMessage);

    // Find similar errors in memory
    const similarErrors = this.memory.errors.filter(e => 
      e.pattern.type === errorPattern.type ||
      e.message.toLowerCase().includes(errorPattern.details.toLowerCase()) ||
      errorMessage.toLowerCase().includes(e.pattern.details.toLowerCase())
    );

    // Find fixes for similar errors
    const relatedFixes = similarErrors
      .map(e => e.fixId)
      .filter(id => id)
      .map(id => this.memory.fixes.find(f => f.id === id))
      .filter(f => f);

    // Store the error
    const errorRecord = {
      id: Date.now().toString(),
      timestamp: new Date().toISOString(),
      message: errorMessage,
      pattern: errorPattern,
      fixId: relatedFixes.length > 0 ? relatedFixes[0].id : null,
      count: 1
    };

    // Check if similar error exists
    const existingError = similarErrors.find(e => 
      e.pattern.type === errorPattern.type &&
      Math.abs(new Date(e.timestamp) - new Date()) < 3600000 // Within 1 hour
    );

    if (existingError) {
      existingError.count++;
      existingError.timestamp = new Date().toISOString();
      errorRecord.id = existingError.id;
    } else {
      this.memory.errors.push(errorRecord);
    }

    await this.saveMemory();

    return {
      error: errorRecord,
      suggestions: relatedFixes.map(f => ({
        title: f.title,
        description: f.description,
        solution: f.solution,
        confidence: this.calculateConfidence(errorPattern, f)
      })),
      similarErrors: similarErrors.length
    };
  }

  calculateConfidence(errorPattern, fix) {
    // Simple confidence calculation based on pattern matching
    let confidence = 0.5;

    if (fix.errorPatterns && fix.errorPatterns.includes(errorPattern.type)) {
      confidence = 0.9;
    }

    if (fix.keywords) {
      const keywordMatches = fix.keywords.filter(kw => 
        errorPattern.details.toLowerCase().includes(kw.toLowerCase())
      );
      confidence += keywordMatches.length * 0.1;
    }

    return Math.min(confidence, 1.0);
  }

  async addFix(errorId, fix) {
    const fixRecord = {
      id: Date.now().toString(),
      errorId: errorId,
      title: fix.title || 'User-provided fix',
      description: fix.description || '',
      solution: fix.solution || '',
      keywords: fix.keywords || [],
      errorPatterns: fix.errorPatterns || [],
      timestamp: new Date().toISOString()
    };

    this.memory.fixes.push(fixRecord);

    // Link fix to error
    const error = this.memory.errors.find(e => e.id === errorId);
    if (error) {
      error.fixId = fixRecord.id;
    }

    await this.saveMemory();
    return fixRecord;
  }

  async getHistory(limit = 50) {
    const errors = this.memory.errors
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit)
      .map(error => {
        const fix = error.fixId 
          ? this.memory.fixes.find(f => f.id === error.fixId)
          : null;
        
        return {
          ...error,
          fix: fix
        };
      });

    return errors;
  }

  async getStats() {
    return {
      totalErrors: this.memory.errors.length,
      totalFixes: this.memory.fixes.length,
      errorTypes: this.memory.errors.reduce((acc, e) => {
        acc[e.pattern.type] = (acc[e.pattern.type] || 0) + e.count;
        return acc;
      }, {}),
      mostCommonErrors: this.memory.errors
        .sort((a, b) => b.count - a.count)
        .slice(0, 10)
    };
  }
}

module.exports = ErrorMemory;

