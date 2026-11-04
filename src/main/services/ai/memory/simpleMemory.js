const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

/**
 * Simple JSON-based Memory System
 * No external dependencies - uses plain JSON files for persistence
 */
class SimpleMemory {
  constructor() {
    this.memoryPath = this.getMemoryPath();
    this.memory = {
      errors: [],
      fixes: [],
      executions: [],
      boards: []
    };
    this.loaded = false;
  }

  getMemoryPath() {
    let appDataDir;
    try {
      const { app } = require('electron');
      if (app && typeof app.getPath === 'function') {
        appDataDir = app.getPath('userData');
      }
    } catch (_) { /* not in Electron */ }
    if (!appDataDir) {
      appDataDir = path.join(
        process.env.APPDATA ||
          (process.platform === 'darwin'
            ? path.join(process.env.HOME, 'Library/Preferences')
            : path.join(process.env.HOME, '.config')),
        'arduino-ide-cursor'
      );
    }
    return path.join(appDataDir, 'memory.json');
  }

  async ensureLoaded() {
    if (this.loaded) return;
    await this.load();
  }

  async load() {
    try {
      const dir = path.dirname(this.memoryPath);
      await fs.mkdir(dir, { recursive: true });
      
      const data = await fs.readFile(this.memoryPath, 'utf8');
      this.memory = JSON.parse(data);
    } catch (error) {
      // File doesn't exist or is corrupted, use defaults
      this.memory = {
        errors: [],
        fixes: [],
        executions: [],
        boards: []
      };
    }
    this.loaded = true;
  }

  async save() {
    try {
      const dir = path.dirname(this.memoryPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.memoryPath, JSON.stringify(this.memory, null, 2), 'utf8');
    } catch (error) {
      console.error('Failed to save memory:', error);
    }
  }

  generateSignature(text) {
    return crypto.createHash('sha256')
      .update(text.toLowerCase().replace(/\s+/g, ' ').trim())
      .digest('hex')
      .substring(0, 16);
  }

  async recordError(errorMessage, errorType = null, context = null) {
    await this.ensureLoaded();
    
    const signature = this.generateSignature(errorMessage);
    const existing = this.memory.errors.find(e => e.signature === signature);
    
    if (existing) {
      existing.count++;
      existing.lastSeen = new Date().toISOString();
    } else {
      this.memory.errors.push({
        id: Date.now().toString(),
        signature,
        message: errorMessage,
        type: errorType,
        context,
        count: 1,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString()
      });
    }
    
    await this.save();
    return signature;
  }

  async searchSimilarErrors(query, limit = 10) {
    await this.ensureLoaded();
    
    const querySignature = this.generateSignature(query);
    const queryLower = query.toLowerCase();
    
    // Exact match
    const exactMatch = this.memory.errors.find(e => e.signature === querySignature);
    if (exactMatch) {
      const fixes = this.memory.fixes.filter(f => f.errorSignature === querySignature);
      return {
        match: exactMatch,
        fixes,
        confidence: 1.0
      };
    }
    
    // Similar matches (simple text matching)
    const similar = this.memory.errors
      .filter(e => e.message.toLowerCase().includes(queryLower) || 
                   queryLower.includes(e.message.toLowerCase().substring(0, 50)))
      .slice(0, limit)
      .map(e => ({
        error: e,
        fixes: this.memory.fixes.filter(f => f.errorSignature === e.signature),
        confidence: 0.5
      }));
    
    return {
      matches: similar,
      count: similar.length
    };
  }

  async recordFix(errorSignature, fixDescription, context = null) {
    await this.ensureLoaded();
    
    const fix = {
      id: Date.now().toString(),
      errorSignature,
      description: fixDescription,
      context,
      createdAt: new Date().toISOString()
    };
    
    this.memory.fixes.push(fix);
    await this.save();
    return fix;
  }

  /**
   * Record a tool execution. Signature matches aiMemory.recordExecution(toolCall, result)
   * so toolExecutor can call either SimpleMemory or AIMemory without change.
   */
  async recordExecution(toolCall, result) {
    await this.ensureLoaded();

    const toolName = toolCall && typeof toolCall === 'object' ? toolCall.name : String(toolCall);
    const args = toolCall && typeof toolCall === 'object' ? toolCall.arguments : undefined;
    const success = result && typeof result === 'object' ? result.success !== false : !!result;
    const error = result && typeof result === 'object' ? result.error ?? null : null;

    this.memory.executions.push({
      tool: toolName,
      args,
      success,
      error,
      timestamp: new Date().toISOString()
    });

    if (this.memory.executions.length > 100) {
      this.memory.executions = this.memory.executions.slice(-100);
    }

    await this.save();
  }

  async getStats() {
    await this.ensureLoaded();
    
    const successCount = this.memory.executions.filter(e => e.success).length;
    
    return {
      errorSignatures: this.memory.errors.length,
      fixes: this.memory.fixes.length,
      executions: this.memory.executions.length,
      successRate: this.memory.executions.length > 0 
        ? successCount / this.memory.executions.length 
        : 0
    };
  }

  async close() {
    await this.save();
  }
}

module.exports = SimpleMemory;

