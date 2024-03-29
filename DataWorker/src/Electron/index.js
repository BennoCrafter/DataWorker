const { app, BrowserWindow, ipcMain, globalShortcut} = require('electron');
const path = require('path');

const fsWrite = require("fs").promises;
const fsRead = require("fs");
// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // and load the index.html of the app.
  mainWindow.loadFile(path.join(__dirname, '../index.html'));

  // Toggle open/close the DevTools.
  globalShortcut.register('CommandorControl+D', () => {
    if(mainWindow.webContents.isDevToolsOpened()) {
      mainWindow.webContents.closeDevTools();
    } else {
      mainWindow.webContents.openDevTools();
    }
  });
  handleCommunication();
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createWindow);

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.

const handleCommunication = () => {
  ipcMain.removeHandler("saveTable");
  ipcMain.removeHandler("restoreTables");
  ipcMain.handle("saveTable", async (event, data, tableName) => {
    try {
      const filePath = path.join(__dirname, `../SavedTables/${tableName}.json`); // Set your desired file path here
      await fsWrite.writeFile(filePath, data, "utf8");

      return { success: true };
    } catch (error) {
      return { error };
    }
  });
  

  ipcMain.handle("restoreTables", async () => {
    try {
      const directoryPath = path.join(__dirname, '../SavedTables/');
      const files = await fsRead.promises.readdir(directoryPath);
      
      const filesData = await Promise.all(files.map(async (file) => {
        const filePath = path.join(directoryPath, file);
        const data = await fsRead.promises.readFile(filePath, "utf8");
        return JSON.parse(data);
      }));
      
      
      return { success: true, filesData: filesData };
    } catch (error) {
      console.error('Error:', error);
      return { error };
    }
  });

}