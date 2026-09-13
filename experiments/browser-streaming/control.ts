export {};
// Harness-only administrative actions. Credential stays in the private connection file.
const [file, action, tab, viewer, width, height] = process.argv.slice(2);
if (!file || !action || !tab) throw new Error('Usage: bun control.ts <connection.json> navigate <A|B> OR focus <A|B> <viewer> <width> <height>');
const config = await Bun.file(file).json();
const url = new URL(config.endpoint); url.protocol = 'http:'; url.pathname = '/control';
const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer ' + config.token}, body: JSON.stringify({type: action, tab, viewer, width: Number(width), height: Number(height)})});
if (!response.ok) throw new Error('Control failed: ' + response.status);
console.log(await response.text());
