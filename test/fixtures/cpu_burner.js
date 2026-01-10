
const { Worker, isMainThread } = require('worker_threads');

if (isMainThread) {
  // Spawn 3 workers + main thread = 4 threads burning CPU
  for (let i = 0; i < 3; i++) {
    new Worker(__filename);
  }
  
  const start = Date.now();
  while (true) {
    // Burn CPU
  }
} else {
  // Worker thread
  const start = Date.now();
  while (true) {
    // Burn CPU
  }
}
