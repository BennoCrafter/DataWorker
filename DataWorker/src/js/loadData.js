const myTable = 0

let tables = await window.electronAPI.restoreTables()
let data = tables.filesData[myTable].data
export {data}