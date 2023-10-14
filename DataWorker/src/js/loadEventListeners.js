
const fields = document.querySelectorAll("th[contenteditable=true]")
fields.forEach(field => {
    field.addEventListener("keydown", function(event) {
        if (event.key === "Enter") {
        event.preventDefault();
        this.blur(); // Save changes on Enter key press
        }
        });
    });

// Add event listener to each cell
const cells = document.querySelectorAll("td[contenteditable=true]");
cells.forEach(cell => {
cell.addEventListener("keydown", function(event) {
    if (event.key === "Enter") {
    event.preventDefault();
    this.blur(); // Save changes on Enter key press
    }
});
});