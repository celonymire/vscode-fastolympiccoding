# 3.0.0

### Added

- **Available on Open VSX!**
- Walkthrough to conveniently add a new `runSettings.json`
- Command to clear the compiled cache

### Changed

- Moved `goodSolutionFile`, `generatorFile`, and `interactorFile` to `runSettings.json` for greater customizability
- Allow mixed languages of different files for interactive problems and Stress Tester

### Removed

- `${path:...}` variable since it's not needed anymore
- `${exeExtname}` because that falls under compiler's responsibility to know they're in Windows
