/**
 * Tool Schema Definitions
 * Structured tool instructions that the AI Agent can output
 */

const TOOL_SCHEMA = {
  // Arduino Operations
  COMPILE_SKETCH: {
    name: 'compile_sketch',
    description: 'Compile an Arduino sketch using Arduino CLI. If sketchPath or boardFQBN are omitted, uses the currently open sketch and selected board from the IDE.',
    parameters: {
      type: 'object',
      properties: {
        sketchPath: {
          type: 'string',
          description: 'Full path to the .ino sketch file. Optional: uses currently open sketch if omitted.'
        },
        boardFQBN: {
          type: 'string',
          description: 'Fully Qualified Board Name (e.g., arduino:avr:uno). Optional: uses selected board if omitted.'
        }
      },
      required: []
    }
  },

  UPLOAD_SKETCH: {
    name: 'upload_sketch',
    description: 'Upload compiled code to an Arduino board. If sketchPath, boardFQBN, or port are omitted, uses the currently open sketch, selected board, and selected port from the IDE.',
    parameters: {
      type: 'object',
      properties: {
        sketchPath: {
          type: 'string',
          description: 'Full path to the .ino sketch file. Optional: uses currently open sketch if omitted.'
        },
        boardFQBN: {
          type: 'string',
          description: 'Fully Qualified Board Name. Optional: uses selected board if omitted.'
        },
        port: {
          type: 'string',
          description: 'Serial port (e.g., COM3, /dev/ttyUSB0). Optional: uses selected port if omitted.'
        }
      },
      required: []
    }
  },

  LIST_BOARDS: {
    name: 'list_boards',
    description: 'List all available Arduino boards',
    parameters: {
      type: 'object',
      properties: {}
    }
  },

  LIST_PORTS: {
    name: 'list_ports',
    description: 'List all available serial ports',
    parameters: {
      type: 'object',
      properties: {}
    }
  },

  // Serial Monitor Operations
  // The serial monitor as one tool: fewer schemas in every request, same reach.
  SERIAL: {
    name: 'serial',
    description: 'The serial monitor. action: "connect" (port, baudRate; default 115200) opens the port and starts buffering; "read" (lines; default 50) returns the latest buffered lines; "send" (data) writes to the port; "disconnect" closes it (an upload needs the port free); "auto_baud" (port) tries common rates until the output is readable; "get_baud" / "set_baud" (baudRate) read or change the rate; "baud_rates" lists the rates. Garbled output means the wrong baud rate (or the wrong clock for the board).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['connect', 'read', 'send', 'disconnect', 'auto_baud', 'get_baud', 'set_baud', 'baud_rates'], description: 'What to do' },
        port: { type: 'string', description: 'Serial port path (connect, auto_baud); defaults to the selected port' },
        baudRate: { type: 'number', description: 'Baud rate (connect, set_baud): 9600, 115200, 74880…' },
        data: { type: 'string', description: 'Text to send (send)' },
        lines: { type: 'number', description: 'How many recent lines to read (read), up to 200' }
      },
      required: ['action']
    }
  },

  // Libraries: the index decides what exists, not the model's memory.
  LIBRARIES: {
    name: 'libraries',
    description: 'Arduino libraries. action: "search" (query) returns matching libraries from the index with what each provides and whether it is installed; "installed" lists what this computer has; "missing" (code, or the open sketch when omitted) says which of the sketch\'s #includes nothing installed provides and what would provide them; "install" (name, version) installs one. Never name a library you have not seen in search or installed: if search finds nothing, say so instead of guessing. A build installs a missing library by itself, so prefer compiling over installing by hand.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'installed', 'missing', 'install'], description: 'What to do' },
        query: { type: 'string', description: 'What to search for: a library name or a header like DHT.h' },
        name: { type: 'string', description: 'Library name, exactly as search returned it (install)' },
        version: { type: 'string', description: 'Optional version (install); the newest is used when omitted' },
        code: { type: 'string', description: 'Sketch to check (missing); the open sketch is used when omitted' }
      },
      required: ['action']
    }
  },

  // Official documentation, for what the knowledge layer does not carry.
  READ_DOCS: {
    name: 'read_docs',
    description: 'The board maker\'s own documentation. action: "list" names the official pages Impulse knows for the selected board and its chip; "read" (url, focus) fetches one and returns the part about `focus`. Only documentation sites are allowed. Use it when a fact about the hardware decides the code and you are not certain: a peripheral\'s behaviour, a vendor pinout, a core API. Quote what the page says and name it; if it cannot be read, say so rather than guessing.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read'], description: 'What to do' },
        url: { type: 'string', description: 'The page to read (from list, or a documentation URL)' },
        focus: { type: 'string', description: 'What you are looking for on the page: "GPIO", "I2C pins", "deep sleep"' }
      },
      required: ['action']
    }
  },

  // Tool packs the model loads when it needs them (see TOOL_PACKS): the standing set stays small.
  LOAD_TOOLS: {
    name: 'load_tools',
    description: 'Make more tools available for the rest of this turn. pack: "boards" (list_boards, list_ports, search_boards, get_mcu_guide: finding boards and ports, chip-level limits), "memory" (analyze_error, search_memory, record_fix: past errors and fixes), "project" (save_sketch, get_current_sketch_path), "playground" (update_playground: step-by-step hardware instructions for the user). Call it once per pack you need.',
    parameters: {
      type: 'object',
      properties: {
        pack: { type: 'string', enum: ['boards', 'memory', 'project', 'playground'], description: 'Which pack to load' }
      },
      required: ['pack']
    }
  },

  GET_EDITOR_CODE: {
    name: 'get_editor_code',
    description: 'Get the current code content from the editor. If the result is empty or whitespace-only, the user has no code yet—use set_editor_code to write code when they ask for it.',
    parameters: {
      type: 'object',
      properties: {}
    }
  },

  SET_EDITOR_CODE: {
    name: 'set_editor_code',
    description: 'Replace the entire code content in the editor. Use when the editor is empty and the user asks for code, or after confirming replacement of existing code.',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'The new code to set in the editor'
        }
      },
      required: ['code']
    }
  },

  EDIT_CODE: {
    name: 'edit_code',
    description: 'Edit specific lines or sections of code in the editor. Can insert, replace, or delete code.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          description: 'Operation type: "replace", "insert", or "delete"',
          enum: ['replace', 'insert', 'delete']
        },
        startLine: {
          type: 'number',
          description: 'Starting line number (1-indexed)'
        },
        endLine: {
          type: 'number',
          description: 'Ending line number (1-indexed, inclusive). For insert, this is ignored.'
        },
        newCode: {
          type: 'string',
          description: 'New code to insert or replace with. Not needed for delete.'
        }
      },
      required: ['operation', 'startLine']
    }
  },

  SEARCH_CODE: {
    name: 'search_code',
    description: 'Search for text or patterns in the current editor code',
    parameters: {
      type: 'object',
      properties: {
        searchText: {
          type: 'string',
          description: 'Text or regex pattern to search for'
        },
        isRegex: {
          type: 'boolean',
          description: 'Whether to treat searchText as a regex pattern',
          default: false
        }
      },
      required: ['searchText']
    }
  },

  REPLACE_IN_CODE: {
    name: 'replace_in_code',
    description: 'Find and replace text in the editor code',
    parameters: {
      type: 'object',
      properties: {
        searchText: {
          type: 'string',
          description: 'Text to find'
        },
        replaceText: {
          type: 'string',
          description: 'Text to replace with'
        },
        replaceAll: {
          type: 'boolean',
          description: 'Replace all occurrences or just the first',
          default: false
        }
      },
      required: ['searchText', 'replaceText']
    }
  },

  GET_CURRENT_SKETCH_PATH: {
    name: 'get_current_sketch_path',
    description: 'Get the file path of the currently open sketch',
    parameters: {
      type: 'object',
      properties: {}
    }
  },

  SAVE_SKETCH: {
    name: 'save_sketch',
    description: 'Save the current editor content to the sketch file',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Optional file path. If not provided, saves to current sketch path.'
        }
      }
    }
  },

  // Analysis Operations
  ANALYZE_ERROR: {
    name: 'analyze_error',
    description: 'Analyze an error message and suggest fixes',
    parameters: {
      type: 'object',
      properties: {
        errorMessage: {
          type: 'string',
          description: 'The error message to analyze'
        },
        context: {
          type: 'object',
          description: 'Additional context (sketch path, board type, etc.)'
        }
      },
      required: ['errorMessage']
    }
  },

  SEARCH_MEMORY: {
    name: 'search_memory',
    description: 'Search the error memory database for similar past errors',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Error message or pattern to search for'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results',
          default: 10
        }
      },
      required: ['query']
    }
  },

  RECORD_FIX: {
    name: 'record_fix',
    description: 'Record a successful fix to the memory database',
    parameters: {
      type: 'object',
      properties: {
        errorSignature: {
          type: 'string',
          description: 'Signature/pattern of the error'
        },
        fix: {
          type: 'string',
          description: 'The fix that resolved the error'
        },
        context: {
          type: 'object',
          description: 'Additional context (board, sketch, etc.)'
        }
      },
      required: ['errorSignature', 'fix']
    }
  },

  // Board and hardware knowledge
  GET_BOARD_INFO: {
    name: 'get_board_info',
    description: 'Real facts about the selected board (or the board given), read from its installed Arduino core: chip, clock, flash and RAM, LED_BUILTIN and any RGB LED (with how to drive it), I2C/SPI/Serial pins, analog pins, board options (e.g. USB CDC On Boot) and notes on traps. Call it before writing code that depends on a pin.',
    parameters: {
      type: 'object',
      properties: {
        fqbn: { type: 'string', description: 'Board FQBN such as arduino:avr:uno or esp32:esp32:esp32s3. Optional: the selected board when omitted.' },
        raw: { type: 'boolean', description: 'Also list every pin definition as written in the core (long).' }
      }
    }
  },

  GET_MCU_GUIDE: {
    name: 'get_mcu_guide',
    description: 'Rules for a microcontroller family: voltage and per-pin current limits, pins to avoid (strapping, flash, input-only), ADC/DAC/PWM/timer behaviour, interrupts, USB Serial, core API changes (e.g. ESP32 core 2.x vs 3.x) and common mistakes, plus embedded fundamentals.',
    parameters: {
      type: 'object',
      properties: {
        chip: { type: 'string', description: 'A family or chip, e.g. "esp32-s3", "esp32", "esp8266", "atmega328p", "atmega2560", "atmega32u4", "rp2040", "samd21", "renesas-ra4m1", "nrf52840", "attiny-x5", "stm32", or "general". Optional: the selected board\'s chip when omitted.' },
        fqbn: { type: 'string', description: 'A board FQBN instead of a chip name.' }
      }
    }
  },

  GET_COMPONENT_GUIDE: {
    name: 'get_component_guide',
    description: 'How to use a sensor, display, motor, driver or module with an Arduino-compatible board: interface, supply and logic voltage, I2C address(es), the library to use, the mistakes that make it not work, and for common parts the wiring and a known-good sketch for the selected board\'s family (compiled by Impulse): start from that sketch instead of memory.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name, part number or I2C address, e.g. "SSD1306", "DHT22", "HC-SR04", "A4988", "WS2812B", "0x27".' }
      },
      required: ['query']
    }
  },

  SEARCH_BOARDS: {
    name: 'search_boards',
    description: 'Find boards by name across the installed cores and every core in the Boards Manager index. Returns each board\'s FQBN when its core is installed, and the core to install when it isn\'t.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Board name or part of it, e.g. "uno r4", "xiao", "esp32-c3", "pico 2".' }
      },
      required: ['query']
    }
  },

  // Get Current State
  GET_CURRENT_STATE: {
    name: 'get_current_state',
    description: 'Get the current application state including selected board, port, baud rate, serial connection status, and open sketch path',
    parameters: {
      type: 'object',
      properties: {}
    }
  },

  // The circuit on the simulator canvas
  GET_CIRCUIT: {
    name: 'get_circuit',
    description: 'The circuit wired on the simulator canvas (saved as diagram.json next to the sketch): every board pin and the parts on it, the wiring check\'s warnings, and who changed it last. Call it before writing code for hardware the user has drawn; when nothing is drawn, suggest drawing it in the simulator so you can check the wiring.',
    parameters: {
      type: 'object',
      properties: {}
    }
  },

  // Playground — hardware task instructions
  UPDATE_PLAYGROUND: {
    name: 'update_playground',
    description: 'Display hardware instructions in the Playground tab. Use this to tell the user what physical steps to perform: wiring, component placement, connections, circuit setup, breadboard layout, pin mapping, etc. Content is shown as text in the Playground panel at the bottom of the IDE.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The hardware instructions or task description to display. Can include wiring steps, pin connections, component lists, or any physical setup instructions.'
        },
        append: {
          type: 'boolean',
          description: 'If true (default), appends to existing playground content. If false, replaces all existing content.'
        }
      },
      required: ['content']
    }
  }
};

/**
 * The standing tool set of agent mode: what almost every build turn needs.
 * Everything else sits in a pack the model loads with load_tools, so a request
 * carries about half the schema tokens it used to.
 */
const CORE_TOOL_NAMES = [
  'get_current_state', 'get_editor_code', 'set_editor_code', 'edit_code', 'replace_in_code', 'search_code',
  'compile_sketch', 'upload_sketch', 'serial', 'libraries', 'get_board_info', 'get_component_guide', 'get_circuit', 'load_tools',
];

const TOOL_PACKS = {
  boards: ['list_boards', 'list_ports', 'search_boards', 'get_mcu_guide', 'read_docs'],
  memory: ['analyze_error', 'search_memory', 'record_fix'],
  project: ['save_sketch', 'get_current_sketch_path'],
  playground: ['update_playground'],
};

/** Debug mode: the standing set plus the memory pack (it must read, edit, compile and watch serial to fix anything). */
const DEBUG_TOOL_NAMES = [...CORE_TOOL_NAMES, ...TOOL_PACKS.memory];

/** Plan mode reads the project and the hardware but changes nothing. */
const PLAN_TOOL_NAMES = [
  'get_editor_code', 'get_current_sketch_path', 'search_code', 'get_current_state', 'list_boards', 'list_ports',
  'get_board_info', 'get_mcu_guide', 'get_component_guide', 'search_boards', 'search_memory',
  'get_circuit', 'libraries', 'read_docs',
];

/**
 * Get all available tools as an array
 */
function getAllTools() {
  return Object.values(TOOL_SCHEMA);
}

/** The standing set of agent mode. */
function getCoreTools() {
  return CORE_TOOL_NAMES.map((n) => getTool(n)).filter(Boolean);
}

/** The tools of one pack (load_tools), or [] for an unknown pack. */
function getPackTools(pack) {
  return (TOOL_PACKS[pack] || []).map((n) => getTool(n)).filter(Boolean);
}

/**
 * Get tools for debug mode (analysis and memory only)
 */
function getDebugTools() {
  return Object.values(TOOL_SCHEMA).filter(t => DEBUG_TOOL_NAMES.includes(t.name));
}

/**
 * Get tools for plan mode (read-only)
 */
function getPlanTools() {
  return Object.values(TOOL_SCHEMA).filter(t => PLAN_TOOL_NAMES.includes(t.name));
}

/**
 * Get tool by name
 */
function getTool(name) {
  return Object.values(TOOL_SCHEMA).find(tool => tool.name === name);
}

/**
 * Validate tool call structure
 */
const JSON_TYPES = {
  string: v => typeof v === 'string',
  number: v => typeof v === 'number' && Number.isFinite(v),
  integer: v => Number.isInteger(v),
  boolean: v => typeof v === 'boolean',
  array: v => Array.isArray(v),
  object: v => v !== null && typeof v === 'object' && !Array.isArray(v)
};

/**
 * Validate a model-produced tool call against the tool's JSON schema
 * (required fields, primitive types, enums). Model output is untrusted, and
 * streamed tool inputs can arrive truncated.
 */
function validateToolCall(toolCall) {
  if (!toolCall || !toolCall.name) {
    return { valid: false, error: 'Tool name is required' };
  }

  const tool = getTool(toolCall.name);
  if (!tool) {
    return { valid: false, error: `Unknown tool: ${toolCall.name}` };
  }

  const args = toolCall.arguments ?? {};
  if (!JSON_TYPES.object(args)) {
    return { valid: false, error: `Arguments for ${toolCall.name} must be an object` };
  }

  for (const param of tool.parameters.required || []) {
    if (args[param] === undefined || args[param] === null) {
      return { valid: false, error: `Missing required parameter: ${param}` };
    }
  }

  const props = tool.parameters.properties || {};
  for (const [key, value] of Object.entries(args)) {
    const spec = props[key];
    if (!spec || value === undefined || value === null) continue;
    const types = Array.isArray(spec.type) ? spec.type : (spec.type ? [spec.type] : []);
    if (types.length && !types.some(t => JSON_TYPES[t] ? JSON_TYPES[t](value) : true)) {
      return { valid: false, error: `Parameter "${key}" must be ${types.join(' or ')}` };
    }
    if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
      return { valid: false, error: `Parameter "${key}" must be one of: ${spec.enum.join(', ')}` };
    }
  }

  return { valid: true };
}

module.exports = {
  TOOL_SCHEMA,
  getAllTools,
  getDebugTools,
  getPlanTools,
  getTool,
  validateToolCall,
  getCoreTools,
  getPackTools,
  TOOL_PACKS,
  CORE_TOOL_NAMES
};
