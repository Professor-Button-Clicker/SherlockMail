const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd || cmd === 'serve' || cmd === 'dashboard') {
  import('./src/ui/server.js');
} else {
  import('./src/cli/index.js');
}
