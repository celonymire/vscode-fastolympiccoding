
const { Worker, isMainThread } = require('worker_threads');

if (isMainThread) {
  // Spawn 3 workers + main thread = 4 threads burning CPU
  for (let i = 0; i < 3; i++) {
    new Worker(__filename);
  }
  
  while (true) {
    // Burn CPU
  }
} else {
  // Worker thread
  while (true) {
    // Burn CPU
  }
}
