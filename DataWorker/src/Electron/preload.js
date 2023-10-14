const { contextBridge, ipcRenderer} = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  saveTable(data, tableName) {
    return ipcRenderer.invoke("saveData", data, tableName);
  },
  restoreTables() {
    return ipcRenderer.invoke("restoreTables");
  },
});