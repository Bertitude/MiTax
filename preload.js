const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // PDF / CSV Parsing
  parsePDF: (filePath) => ipcRenderer.invoke('parse-pdf', filePath),

  // LunchMoney Assets
  getLMAssets:   (apiKey)            => ipcRenderer.invoke('get-lm-assets', apiKey),
  createLMAsset: (apiKey, assetData) => ipcRenderer.invoke('create-lm-asset', { apiKey, assetData }),

  // LunchMoney Payees
  getLMPayees:   (apiKey)                        => ipcRenderer.invoke('get-lm-payees', apiKey),
  processPayees: ({ transactions, existingPayees }) => ipcRenderer.invoke('process-payees', { transactions, existingPayees }),

  // LunchMoney Categories
  getLMCategories: (apiKey) => ipcRenderer.invoke('get-lm-categories', apiKey),

  // Upload Transactions
  uploadTransactions: (payload) => ipcRenderer.invoke('upload-transactions', payload),

  // Coverage from LunchMoney
  getAssetCoverage: ({ apiKey, assetId, year }) => ipcRenderer.invoke('get-asset-coverage', { apiKey, assetId, year }),

  // CSV Export
  exportCSV: (payload) => ipcRenderer.invoke('export-csv', payload),

  // Local Upload Tracker
  getUploads:       ()          => ipcRenderer.invoke('tracker-get-uploads'),
  saveUpload:       (record)    => ipcRenderer.invoke('tracker-save-upload', record),
  getMissingMonths: (accountId) => ipcRenderer.invoke('tracker-get-missing-months', accountId),
  getAllAccounts:   ()          => ipcRenderer.invoke('tracker-get-all-accounts'),

  // S04 Tax
  generateS04: (payload) => ipcRenderer.invoke('generate-s04', payload),

  // File system
  openFileDialog: ()         => ipcRenderer.invoke('open-file-dialog'),
  readFile:       (filePath) => ipcRenderer.invoke('read-file', filePath),
  getAppDataPath: ()         => ipcRenderer.invoke('get-app-data-path'),

  // ─── Auto-updater ────────────────────────────────────────────────────────
  updater: {
    check:      ()  => ipcRenderer.invoke('updater:check'),
    download:   ()  => ipcRenderer.invoke('updater:download'),
    install:    ()  => ipcRenderer.invoke('updater:install'),
    getVersion: ()  => ipcRenderer.invoke('updater:get-version'),

    // Subscribe to updater events pushed from main process
    on: (channel, callback) => {
      const valid = ['updater:checking', 'updater:available', 'updater:not-available',
                     'updater:progress', 'updater:downloaded', 'updater:error'];
      if (!valid.includes(channel)) return;
      const sub = (_, data) => callback(data);
      ipcRenderer.on(channel, sub);
      // Return unsubscribe function
      return () => ipcRenderer.removeListener(channel, sub);
    },
  },
});
