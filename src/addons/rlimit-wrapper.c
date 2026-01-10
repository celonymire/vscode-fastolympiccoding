/*
 * rlimit-wrapper: Resource limit enforcement wrapper for macOS
 * 
 * Usage: rlimit-wrapper <cpu_seconds> <memory_bytes> <command> [args...]
 * 
 * Sets RLIMIT_CPU and RLIMIT_AS (virtual address space) resource limits
 * before executing the target command. The kernel enforces these limits
 * and sends SIGXCPU/SIGKILL when exceeded.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <sys/resource.h>
#include <unistd.h>

int main(int argc, char *argv[]) {
  if (argc < 4) {
    fprintf(stderr, "Usage: %s <cpu_seconds> <memory_bytes> <command> [args...]\n", argv[0]);
    return 1;
  }

  // Parse CPU limit (seconds)
  char *endptr;
  long cpu_seconds = strtol(argv[1], &endptr, 10);
  if (*endptr != '\0' || cpu_seconds < 0) {
    fprintf(stderr, "Error: Invalid cpu_seconds: %s\n", argv[1]);
    return 1;
  }

  // Parse memory limit (bytes)
  long long memory_bytes = strtoll(argv[2], &endptr, 10);
  if (*endptr != '\0' || memory_bytes < 0) {
    fprintf(stderr, "Error: Invalid memory_bytes: %s\n", argv[2]);
    return 1;
  }

  // Set RLIMIT_CPU (CPU time limit)
  if (cpu_seconds > 0) {
    struct rlimit cpu_limit;
    cpu_limit.rlim_cur = (rlim_t)cpu_seconds;
    cpu_limit.rlim_max = (rlim_t)cpu_seconds;
    
    if (setrlimit(RLIMIT_CPU, &cpu_limit) != 0) {
      fprintf(stderr, "Error: Failed to set RLIMIT_CPU: %s\n", strerror(errno));
      return 1;
    }
  }

  // Set RLIMIT_AS (virtual address space limit)
  // Use 1.5x the memory limit to account for virtual address space overhead
  if (memory_bytes > 0) {
    struct rlimit mem_limit;
    rlim_t limit = (rlim_t)(memory_bytes * 1.5);
    mem_limit.rlim_cur = limit;
    mem_limit.rlim_max = limit;
    
    if (setrlimit(RLIMIT_AS, &mem_limit) != 0) {
      fprintf(stderr, "Error: Failed to set RLIMIT_AS: %s\n", strerror(errno));
      return 1;
    }
  }

  // Execute the target command
  // argv[3] is the command, argv[4..] are its arguments
  execvp(argv[3], &argv[3]);
  
  // If execvp returns, an error occurred
  fprintf(stderr, "Error: Failed to execute %s: %s\n", argv[3], strerror(errno));
  return 1;
}
