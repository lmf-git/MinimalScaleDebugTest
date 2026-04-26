const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  version: process.versions.electron,
});

contextBridge.exposeInMainWorld('serialAPI', {
  listPorts:    ()               => ipcRenderer.invoke('serial:list'),
  openPort:     (path, baudRate) => ipcRenderer.send('serial:open', { path, baudRate }),
  closePort:    ()               => ipcRenderer.send('serial:close'),
  // callback receives { timestamp, hex, text, eventType }
  onData:       (cb) => ipcRenderer.on('serial:data',   (_e, data)   => cb(data)),
  onStatus:     (cb) => ipcRenderer.on('serial:status', (_e, status) => cb(status)),
  getLogPath:        ()         => ipcRenderer.invoke('serial:getLogPath'),
  openLogFolder:     ()         => ipcRenderer.send('serial:openLogFolder'),
  autoDetect:        (portPath) => ipcRenderer.invoke('serial:autoDetect', portPath),
  onDetectProgress:  (cb)       => ipcRenderer.on('serial:detectProgress', (_e, baud) => cb(baud)),
});

contextBridge.exposeInMainWorld('usbAPI', {
  listDevices: ()     => ipcRenderer.invoke('usb:list'),
  onAttach:    (cb)   => ipcRenderer.on('usb:attach', (_e, d) => cb(d)),
  onDetach:    (cb)   => ipcRenderer.on('usb:detach', (_e, d) => cb(d)),
});
