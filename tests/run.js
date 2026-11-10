// Ejecuta todas las pruebas en orden: npm test
const { spawnSync } = require('child_process');
const path = require('path');
let failed = false;
for (const f of ['main.test.js', 'ui.test.js']) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit', timeout: 300000 });
  if (r.status !== 0) failed = true;
}
console.log(failed ? '\nHAY PRUEBAS QUE FALLAN' : '\nTODAS LAS PRUEBAS PASARON');
process.exit(failed ? 1 : 0);
