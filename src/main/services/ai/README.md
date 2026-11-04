# AI Agent Architecture

## Overview

The AI Agent layer provides intelligent assistance for Arduino development workflows. It uses Large Language Models (LLMs) to understand user queries, execute tools, and learn from past experiences.

## Architecture Components

### 1. Core Agent (`agent.js`)
The main orchestrator that:
- Manages LLM provider selection and switching
- Processes user queries with tool use
- Coordinates between memory, tools, and LLM
- Maintains conversation history

### 2. Provider System (`providers/`)
Multi-model support with provider-agnostic interface:

- **BaseProvider** (`baseProvider.js`) - Abstract interface all providers implement
- **OpenAIProvider** (`openaiProvider.js`) - OpenAI GPT-4, GPT-3.5 support
- **GeminiProvider** (`geminiProvider.js`) - Google Gemini models
- **ClaudeProvider** (`claudeProvider.js`) - Anthropic Claude models

All providers:
- Support function calling/tool use
- Format tools according to provider schema
- Parse tool calls from responses
- Validate API keys

### 3. Tool System (`tools/`)

#### Tool Schema (`toolSchema.js`)
Defines all available tools with:
- Name and description
- Parameter schemas (JSON Schema)
- Required vs optional parameters
- Validation logic

Available Tools:
- **Arduino Operations**: `compile_sketch`, `upload_sketch`, `list_boards`, `list_ports`
- **Serial Monitor**: `connect_serial`, `disconnect_serial`, `send_serial`, `read_serial`, `auto_detect_baud`
- **Analysis**: `analyze_error`, `search_memory`, `record_fix`

#### Tool Executor (`toolExecutor.js`)
Executes structured tool instructions:
- Validates tool calls against schema
- Routes to appropriate service (ArduinoService, SerialMonitor, etc.)
- Returns structured results
- Records executions in memory
- Buffers serial output for analysis

### 4. Memory System (`memory/simpleMemory.js`)

JSON-file memory of past errors, fixes and tool executions, used to suggest fixes that worked before.

### 5. Configuration (`config/apiKeyManager.js`)

API keys are encrypted with the OS credential store through Electron `safeStorage` (macOS Keychain, Windows DPAPI, libsecret) and kept in the main process; the renderer only sees the last four characters.
- Secure retrieval

### 6. Prompts (`prompts/systemPrompt.js`)

System prompts for:
- General assistance
- Error analysis
- Serial output analysis

## Data Flow

```
User Query
    ↓
AI Agent (agent.js)
    ↓
[Check Memory First]
    ↓
LLM Provider (OpenAI/Gemini/Claude)
    ↓
Tool Calls (Structured JSON)
    ↓
Tool Executor (toolExecutor.js)
    ↓
Service Layer (ArduinoService, SerialMonitor, etc.)
    ↓
Results
    ↓
[Record in Memory]
    ↓
Return to User
```

## Tool Execution Flow

1. **Agent receives query** → Processes with LLM
2. **LLM returns tool calls** → Structured JSON instructions
3. **Tool Executor validates** → Checks schema compliance
4. **Executor routes to service** → ArduinoService, SerialMonitor, etc.
5. **Service performs action** → Compile, upload, read serial, etc.
6. **Results returned** → Structured response
7. **Memory updated** → Error patterns, fixes, outcomes recorded
8. **Agent continues** → May make additional tool calls or return final answer

## Memory-First Strategy

The agent follows a "memory-first" approach:

1. **Before querying LLM**: Search memory for similar past errors
2. **If exact match found**: Return stored fix immediately
3. **If similar matches**: Include in LLM context
4. **After successful fix**: Record to memory for future use

This reduces:
- API costs
- Response latency
- LLM token usage

## Provider Switching

Providers can be switched at runtime:

```javascript
// Set OpenAI
aiAgent.setProvider('openai', 'sk-...', 'gpt-4-turbo-preview');

// Switch to Gemini
aiAgent.setProvider('gemini', 'AIza...', 'gemini-pro');

// Switch to Claude
aiAgent.setProvider('claude', 'sk-ant-...', 'claude-3-5-sonnet-20241022');
```

## Error Analysis Flow

1. **Error occurs** (compilation, upload, runtime)
2. **Generate error signature** (hash of normalized message)
3. **Search memory** for exact or similar matches
4. **If found**: Return stored fixes with confidence scores
5. **If not found**: Query LLM with error context
6. **LLM analyzes** and suggests fixes
7. **Record to memory** for future reference

## Serial Monitor Integration

The agent can:
- Connect to serial ports
- Read recent output
- Analyze patterns
- Auto-detect baud rates
- Send commands
- Detect anomalies

Serial data is buffered in ToolExecutor for analysis.

## Security

- API keys stored encrypted using `electron-store`
- Keys never exposed to renderer process
- Validation before provider initialization
- Secure IPC communication

## Usage Example

```javascript
// Initialize agent
const agent = new AIAgent(arduinoService, serialMonitor, errorMemory);
agent.initializeProviders();

// Set provider
agent.setProvider('openai', apiKey, 'gpt-4-turbo-preview');

// Process query
const result = await agent.processQuery(
  'Compile my sketch at /path/to/sketch.ino for Arduino Uno'
);

// Analyze error
const analysis = await agent.analyzeError(
  'undefined reference to `setup()\'',
  { sketchPath: '/path/to/sketch.ino', board: 'arduino:avr:uno' }
);
```

## Future Enhancements

- Multi-turn conversation memory
- Code generation capabilities
- Library recommendation system
- Hardware troubleshooting guides
- Project templates
- Performance optimization suggestions

