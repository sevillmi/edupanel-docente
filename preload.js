const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('sigma', {
  // IA y ajustes
  getSettings: () => call('settings:get'),
  saveSettings: (data) => call('settings:save', data),
  deleteKey: (provider) => call('settings:deleteKey', provider),
  setAutolock: (min) => call('settings:autolock', min),
  generate: (system, prompt) => call('ai:generate', system, prompt),
  openLink: (url) => call('open:external', url),
  // datos cifrados
  dbLoad: () => call('db:load'),
  dbSave: (json) => call('db:save', json),
  // candado
  pinStatus: () => call('pin:status'),
  pinUnlock: (pin) => call('pin:unlock', pin),
  pinSet: (pin, current) => call('pin:set', pin, current),
  pinDisable: (pin) => call('pin:disable', pin),
  pinLock: () => call('pin:lock'),
  pinRecover: (code, pin) => call('pin:recover', code, pin),
  activity: () => call('app:activity'),
  resetAll: () => call('app:resetAll'),
  onLock: (cb) => { ipcRenderer.on('app:lock', () => cb()); },
  // información y errores
  appInfo: () => call('app:info'),
  logError: (entry) => call('log:error', entry),
  logGet: () => call('log:get'),
  logClear: () => call('log:clear')
});
