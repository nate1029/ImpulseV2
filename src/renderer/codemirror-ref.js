/**
 * Shared CodeMirror reference so the editor is available regardless of bundle order.
 * main.js calls setCodeMirror() after importing codemirror; renderer uses getCodeMirror().
 */
let codeMirrorInstance = null;

export function setCodeMirror(cm) {
  codeMirrorInstance = cm;
}

export function getCodeMirror() {
  return codeMirrorInstance;
}
