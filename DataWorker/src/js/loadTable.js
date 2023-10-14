import { data } from "./loadData.js";

const tablePath = document.querySelector(".table-container").querySelector("#table")
let currentRow = 0
// load fields
const fields = Object.keys(data[0])

fields.forEach(field => {
    tablePath.querySelector("#head").querySelector("#head-content").innerHTML += `
    <th contenteditable="true">${field}</th>
    ` 
})

// load rows
data.forEach(row => {
    tablePath.querySelector("#body").innerHTML += `
    <tr id=row${currentRow}></tr>
    `
    Object.values(row).forEach(entry =>{
        tablePath.querySelector("#body").querySelector(`#row${currentRow}`).innerHTML += `
        <td contenteditable="true">${entry}</td>
        `
    })
    currentRow++;
    });