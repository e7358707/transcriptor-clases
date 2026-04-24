'use strict';

const { app, BrowserWindow, session } = require('electron');
const path = require('path');

// Enable speech dispatcher on Linux
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-speech-dispatcher');
}

app.whenReady().then(() => {
  // Allow microphone access from the renderer
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'microphone');
  });

  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    if (permission === 'media' || permission === 'microphone') return true;
    return null;
  });

  // Add CORS headers so the Anthropic API fetch works from file:// origin
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: Object.assign({}, details.responseHeaders, {
        'Access-Control-Allow-Origin':  ['*'],
        'Access-Control-Allow-Headers': ['*'],
      }),
    });
  });

  const win = new BrowserWindow({
    width:  1024,
    height: 800,
    minWidth:  600,
    minHeight: 500,
    title: 'Transcriptor de Clases',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
    },
  });

  win.loadFile(path.join(app.getAppPath(), 'www', 'index.html'));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    // re-trigger ready logic by calling createWindow inline
    const win = new BrowserWindow({
      width: 1024, height: 800, minWidth: 600, minHeight: 500,
      title: 'Transcriptor de Clases',
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    win.loadFile(path.join(app.getAppPath(), 'www', 'index.html'));
  }
});
