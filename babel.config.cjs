// Only Jest uses this (Vite and Electron don't): lets tests import the
// renderer's ES modules.
module.exports = {
  presets: [['@babel/preset-env', { targets: { node: 'current' } }]]
};
