const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toastActions', {
  click: (toastId, index) => ipcRenderer.send('toast-action', { action: 'click', toastId, index }),

  //? legacy
  yes: (toastId) => ipcRenderer.send('toast-action', { action: 'yes', toastId }),
  no: (toastId) => ipcRenderer.send('toast-action', { action: 'no', toastId })
});
