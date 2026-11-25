// The page's own script. `eesha` is already there - see index.html.

const $ = id => document.getElementById(id);

const show = (element, text, isError) => {
    element.textContent = text;
    element.classList.toggle("error", Boolean(isError));
};

// 1. Call into index.js. `handle` runs there, in the plugin's sandbox.
$("hello").addEventListener("submit", async event => {

    event.preventDefault();

    try {
        const reply = await eesha.call("hello", { name: $("who").value.trim() });
        show($("answer"), reply.text);
    } catch (error) {
        show($("answer"), error.message, true);
    }
});

// 2. What the panel knows, kept current. `eesha.state` holds the latest.
eesha.onState(state => {
    $("state").textContent = JSON.stringify(state, null, 2);
});

// 3. This plugin's own SQLite tables, read from the page.
async function refresh() {

    const body = $("history").querySelector("tbody");

    try {
        // Through handle(), which owns the query - or straight from the
        // page with eesha.db.all(...). Both reach the same file.
        const rows = await eesha.call("history");

        body.innerHTML = "";

        for (const row of rows) {
            const tr = document.createElement("tr");
            tr.innerHTML = `<td></td><td></td>`;
            tr.children[0].textContent = row.name;
            tr.children[1].textContent = row.at;
            body.appendChild(tr);
        }

        if (!rows.length)
            body.innerHTML = `<tr><td colspan="2" class="muted">Nothing yet - run the Greet task.</td></tr>`;

    } catch (error) {
        body.innerHTML = "";
        show($("answer"), error.message, true);
    }
}

$("refresh").addEventListener("click", refresh);

$("clear").addEventListener("click", async () => {
    // Straight from the page this time, to show eesha.db works too.
    await eesha.db.run("DELETE FROM greetings");
    await refresh();
});

// 4. Start a task from the page. In the run panel this is the tasks.yml
// task id; in the spec panel it would be a phase name.
$("run").addEventListener("click", async () => {
    try {
        await eesha.run("greet");
    } catch (error) {
        show($("answer"), error.message, true);
    }
});

refresh();

// The table refreshes on its own when a run finishes.
let wasRunning = false;
eesha.onState(state => {
    if (wasRunning && !state.running)
        refresh();
    wasRunning = state.running;
});
