const { app, BrowserWindow, ipcMain, shell, session, dialog, protocol, net } = require('electron');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { secure: true, standard: true, supportFetchAPI: true } }
]);
const path = require('path');
const fs = require('fs');
const url = require('url');
const { SerialPort } = require('serialport');
const { usb } = require('usb');
const { autoUpdater } = require('electron-updater');

const isDev = !app.isPackaged;
let mainWindow;
let activePort = null;
let simulationInterval = null;
let logStream = null;
let logPath = '';

function writeLog(line) {
  if (logStream) logStream.write(line + '\n');
}

// Space-separated hex bytes: "53 20 53 20 0d 0a"
function formatHex(buffer) {
  return buffer.toString('hex').match(/.{1,2}/g).join(' ');
}

// Replace control bytes with named ASCII abbreviations so they're visible in the log
const CTRL_NAMES = {
  0x00:'<NUL>',0x01:'<SOH>',0x02:'<STX>',0x03:'<ETX>',
  0x04:'<EOT>',0x05:'<ENQ>',0x06:'<ACK>',0x07:'<BEL>',
  0x08:'<BS>', 0x09:'<HT>', 0x0a:'<LF>', 0x0b:'<VT>',
  0x0c:'<FF>', 0x0d:'<CR>', 0x0e:'<SO>', 0x0f:'<SI>',
  0x10:'<DLE>',0x11:'<DC1>',0x12:'<DC2>',0x13:'<DC3>',
  0x14:'<DC4>',0x15:'<NAK>',0x16:'<SYN>',0x17:'<ETB>',
  0x18:'<CAN>',0x19:'<EM>', 0x1a:'<SUB>',0x1b:'<ESC>',
  0x1c:'<FS>', 0x1d:'<GS>', 0x1e:'<RS>', 0x1f:'<US>',
  0x7f:'<DEL>',
};

function sanitizeText(buffer) {
  let result = '';
  for (const byte of buffer) {
    if (byte in CTRL_NAMES) result += CTRL_NAMES[byte];
    else if (byte >= 0x20 && byte < 0x7f) result += String.fromCharCode(byte);
    else result += `<0x${byte.toString(16).padStart(2,'0')}>`;
  }
  return result;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.once('devtools-opened', () => {
      mainWindow.webContents.devToolsWebContents?.executeJavaScript(
        "DevToolsAPI.showPanel('console'); null;"
      );
    });
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadURL('app://localhost');
  }
}

// --- USB Detection ---

function formatUSBDevice(device) {
  return {
    vendorId: device.deviceDescriptor.idVendor,
    productId: device.deviceDescriptor.idProduct,
    busNumber: device.busNumber,
    deviceAddress: device.deviceAddress,
  };
}

ipcMain.handle('usb:list', () => usb.getDeviceList().map(formatUSBDevice));

usb.on('attach', (device) => {
  if (mainWindow) mainWindow.webContents.send('usb:attach', formatUSBDevice(device));
});
usb.on('detach', (device) => {
  if (mainWindow) mainWindow.webContents.send('usb:detach', formatUSBDevice(device));
});

// --- Serial Port ---

ipcMain.handle('serial:list', async () => {
  try {
    const ports = await SerialPort.list();
    return [...ports, { path: 'SIMULATOR', manufacturer: 'Virtual', friendlyName: 'Scale Simulator (SICS)' }];
  } catch {
    return [{ path: 'SIMULATOR', friendlyName: 'Scale Simulator (SICS)' }];
  }
});

ipcMain.handle('serial:getLogPath', () => logPath);

// Try each baud rate in order; return first one that receives recognisable weight data.
// Sends a SICS "S\r\n" poll after opening so polling-mode scales respond too.
ipcMain.handle('serial:autoDetect', async (_event, portPath) => {
  if (portPath === 'SIMULATOR') return { baud: 9600 };

  const BAUD_ORDER = [9600, 19200, 4800, 2400, 38400, 57600, 1200, 115200];

  for (const baud of BAUD_ORDER) {
    if (mainWindow) mainWindow.webContents.send('serial:detectProgress', baud);

    const found = await new Promise((resolve) => {
      let settled = false;
      let port;

      const done = (result) => {
        if (settled) return;
        settled = true;
        try { if (port && port.isOpen) port.close(); } catch {}
        resolve(result);
      };

      const timer = setTimeout(() => done(null), 1400);

      try {
        port = new SerialPort({ path: portPath, baudRate: baud });
        let buf = '';

        port.on('open', () => {
          // Poll SICS-mode scales; harmless for others
          try { port.write('S\r\n'); } catch {}
        });

        port.on('data', (data) => {
          buf += data.toString('latin1');
          // Valid: numeric decimal AND a terminator or unit — avoids matching line noise
          if (buf.length >= 8 &&
              /\d+[.,]\d+/.test(buf) &&
              (/[\r\n]/.test(buf) || /kg|g\b|lb|oz/i.test(buf))) {
            clearTimeout(timer);
            done(baud);
          }
        });

        port.on('error', () => { clearTimeout(timer); done(null); });
      } catch {
        clearTimeout(timer);
        done(null);
      }
    });

    if (found !== null) return { baud: found };
  }

  return { baud: null };
});

ipcMain.on('serial:openLogFolder', () => {
  if (logPath) shell.showItemInFolder(logPath);
});

// Simulator: cycles through realistic Ohaus/Mettler SICS-like messages
// covering every event type the operator needs to capture.
const SIM_MESSAGES = [
  Buffer.from('S I     +    0.000 kg\r\n'),   // motion — weight being placed
  Buffer.from('S I     +    0.112 kg\r\n'),   // motion — still settling
  Buffer.from('S I     +    0.238 kg\r\n'),   // motion — almost stable
  Buffer.from('S S     +    0.245 kg\r\n'),   // STABLE reading
  Buffer.from('S S     +    0.245 kg\r\n'),   // stable (repeat, normal poll)
  Buffer.from('T       +    0.000 kg\r\n'),   // TARE button pressed
  Buffer.from('S S     +    0.000 kg\r\n'),   // stable after tare
  Buffer.from('S I     +    0.560 kg\r\n'),   // motion — new weight
  Buffer.from('S S     +    0.560 kg\r\n'),   // stable
  Buffer.from('OL\r\n'),                       // OVERLOAD
  Buffer.from('S I     +    0.000 kg\r\n'),   // motion — removing weight
  Buffer.from('S S     +    0.000 kg\r\n'),   // stable at zero
];
let simStep = 0;

ipcMain.on('serial:open', (_event, { path: portPath, baudRate }) => {
  if (activePort || simulationInterval) stopActiveConnection();

  if (portPath === 'SIMULATOR') {
    mainWindow.webContents.send('serial:status', 'Connected to Simulator (SICS)');
    writeLog(`[${new Date().toISOString()}] OPEN: Simulator`);
    simStep = 0;
    simulationInterval = setInterval(() => {
      const buf = SIM_MESSAGES[simStep % SIM_MESSAGES.length];
      simStep++;
      const timestamp = new Date().toISOString();
      const hex = formatHex(buf);
      const text = sanitizeText(buf);
      writeLog(`[${timestamp}] SIM  HEX: ${hex} | TEXT: ${text}`);
      mainWindow.webContents.send('serial:data', { timestamp, hex, text, eventType: 'data' });
    }, 1500);

  } else {
    try {
      activePort = new SerialPort({ path: portPath, baudRate: parseInt(baudRate) || 9600 });

      activePort.on('open', () => {
        const ts = new Date().toISOString();
        const msg = `Connected to ${portPath} @ ${baudRate || 9600} baud`;
        writeLog(`[${ts}] OPEN: ${msg}`);
        mainWindow.webContents.send('serial:status', msg);
      });

      activePort.on('data', (data) => {
        const timestamp = new Date().toISOString();
        const hex = formatHex(data);
        const text = sanitizeText(data);
        writeLog(`[${timestamp}] DATA HEX: ${hex} | TEXT: ${text}`);
        mainWindow.webContents.send('serial:data', { timestamp, hex, text, eventType: 'data' });
      });

      // Fires with err.disconnected=true when the cable is physically pulled
      activePort.on('close', (err) => {
        if (err && err.disconnected) {
          const timestamp = new Date().toISOString();
          writeLog(`[${timestamp}] DISCONNECT: cable removed`);
          mainWindow.webContents.send('serial:data', {
            timestamp, hex: '', text: 'Physical disconnect — cable removed', eventType: 'disconnect',
          });
          mainWindow.webContents.send('serial:status', 'Disconnected: cable removed');
        }
        activePort = null;
      });

      activePort.on('error', (err) => {
        const timestamp = new Date().toISOString();
        writeLog(`[${timestamp}] ERROR: ${err.message} (code: ${err.code || 'unknown'})`);
        mainWindow.webContents.send('serial:status', `Error [${err.code || 'ERR'}]: ${err.message}`);
      });

    } catch (err) {
      mainWindow.webContents.send('serial:status', `Failed to open: ${err.message}`);
    }
  }
});

ipcMain.on('serial:close', () => {
  stopActiveConnection();
  writeLog(`[${new Date().toISOString()}] CLOSE: user initiated`);
  mainWindow.webContents.send('serial:status', 'Disconnected');
});

function stopActiveConnection() {
  if (simulationInterval) { clearInterval(simulationInterval); simulationInterval = null; }
  if (activePort && activePort.isOpen) { activePort.close(); activePort = null; }
}

// --- App Lifecycle ---

app.whenReady().then(async () => {
  // Register custom protocol to handle absolute paths in production
  if (!isDev) {
    protocol.handle('app', (request) => {
      const { pathname } = new URL(request.url);
      const filePath = pathname === '/' ? 'index.html' : pathname.slice(1);
      const resolvedPath = path.join(__dirname, '../build', filePath);
      return net.fetch(url.pathToFileURL(resolvedPath).toString());
    });
  }

  if (isDev) {
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData({ storages: ['serviceworkers'] });
  } else {
    autoUpdater.checkForUpdatesAndNotify();
  }

  logPath = path.join(app.getPath('userData'), 'scale_debug_raw.log');
  logStream = fs.createWriteStream(logPath, { flags: 'a' });
  writeLog(`\n=== Session Start: ${new Date().toISOString()} ===`);
  createWindow();
});

// --- Auto Updater Events ---

autoUpdater.on('update-available', () => {
  writeLog(`[${new Date().toISOString()}] Update available.`);
});

autoUpdater.on('update-downloaded', (info) => {
  writeLog(`[${new Date().toISOString()}] Update downloaded; version ${info.version}`);
  dialog.showMessageBox({
    type: 'info',
    title: 'Update Ready',
    message: `A new version (${info.version}) has been downloaded. The app will restart to apply the update.`,
    buttons: ['Restart', 'Later']
  }).then((result) => {
    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });
});

autoUpdater.on('error', (err) => {
  writeLog(`[${new Date().toISOString()}] Updater error: ${err.message}`);
});

app.on('window-all-closed', () => {
  stopActiveConnection();
  writeLog(`=== Session End: ${new Date().toISOString()} ===\n`);
  if (logStream) logStream.end();
  if (process.platform !== 'darwin') app.quit();
});
