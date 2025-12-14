<h1 align="center">⚡ Fast Olympic Coding ⚡</h1>

![Testcases Gif](media/banner.png)

<p align="center">
<img src="https://vsmarketplacebadges.dev/version-short/sam20908.vscode-fastolympiccoding.svg">
<img src="https://vsmarketplacebadges.dev/installs-short/sam20908.vscode-fastolympiccoding.svg">
<img src="https://vsmarketplacebadges.dev/rating-short/sam20908.vscode-fastolympiccoding.svg">
</p>

<p align="center"><i>Once a mighty Competitive Programming plugin... Reborn with the powers of VSCode!</i></p>

### ⚡ Overview

- [📜](#-judge) Minimal and _adaptive_ UI for maximized functionality and view utilization
- [🐞](#-stress-tester) Built-in stress tester to aid your debugging
- [👜](#-inserting-prewritten-code) Insert file templates without leaving your code
- [🛜](#-competitive-companion) Support for [Competitive Companion](https://github.com/jmerle/competitive-companion) for efficient problem gathering
- ⚡ **_BLAZINGLY FAST!_** Asynchronous design + optimizations = **99%** spam proof!

### 💻 Keybinds

- Compile and run all testcases: `Ctrl+Alt+B`
- Stop all testcases: `Ctrl+Alt+K`
- Delete all testcases: `Ctrl+Alt+D`
- Save all testcases: `Ctrl+Alt+S`
- Run stress test: `Ctrl+Alt+G`
- Stop stress test: `Ctrl+Alt+H`
- Insert file template: `Ctrl+Alt+I`

### 📥 Install within VSCode or at [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=sam20908.vscode-fastolympiccoding)

---

### </> Setting Up

Provide run settings for the languages you use in `settings.json`. Here are some examples for C++, Python, and Java:

```json
{
  "fastolympiccoding.runSettings": {
    ".cpp": {
      "compileCommand": "g++ ${path:${file}} -o ${path:${fileDirname}/${fileBasenameNoExtension}${exeExtname}}",
      "runCommand": "${path:${fileDirname}/${fileBasenameNoExtension}${exeExtname}}"
    },
    ".py": {
      "runCommand": "python ${path:${file}}"
    },
    ".java": {
      "compileCommand": "javac ${path:${file}}",
      "runCommand": "java -cp ${fileDirname} ${fileBasenameNoExtension}"
    }
  }
}
```

We can use the following variables in the syntax of `${...}`

- Most of [VSCode's built-in variables](https://code.visualstudio.com/docs/editor/variables-reference)
- `${exeExtname}` returns `.exe` for Windows and an empty string for other platforms
- `${path:*value*}` normalizes \*value\* into a valid path string for the current platform

<details>
  <summary>Settings per language</summary>

- `compileCommand` (optional): Command to run before `runCommand` when the file content changed
- `runCommand`: Command to run the solution
- `currentWorkingDirectory` (optional): sets the current working directory for `runCommand`
- `debugCommand` (optional): Command to start the solution under a debug server/wrapper (the extension will pipe testcase stdin to this process)
- `debugAttachConfig` (optional): Name of `launch.json` attach configuration.
</details>

<details>
  <summary>Attach configuration example (Microsoft C/C++)</summary>

VS Code debug adapters generally do not support arbitrary stdin injection in a universal way.
Fast Olympic Coding keeps stdin control by starting your program under a debug server (`debugCommand`) and then asking VS Code to attach (`debugAttachConfig`).

1. Add these settings for `.cpp`:

```json
{
  "fastolympiccoding.runSettings": {
    ".cpp": {
      // compile and run configurations from above...
      "debugCommand": "gdbserver :2345 ${path:${fileDirname}/${fileBasenameNoExtension}${exeExtname}}",
      "debugAttachConfig": "C/C++: Attach"
    }
  }
}
```

2. Create an attach configuration in `.vscode/launch.json`:

```json
{
  "configurations": [
    {
      "name": "C/C++: Attach",
      "type": "cppdbg",
      "request": "launch",
      "MIMode": "gdb",
      "miDebuggerServerAddress": "localhost:2345",
      "program": "${fileDirname}/${fileBasenameNoExtension}${exeExtname}"
    }
  ]
}
```

</details>

---

### 📜 Judge

The UI adapts to VSCode's theme, font family and font size. Minimalism from the old plugin has been improved with [VSCode Codicons](https://microsoft.github.io/vscode-codicons/dist/codicon.html) and the native look of VSCode. The new UI experience is integrated into both Judge and Stress Tester windows.

- Run, edit, hide, skip testcases, you name it!
- Hidden optimizations such as batched IO, truncating huge IO, and cached compilations.
- Dedicated popup for compiler errors with color support
- ... and so much more!

<img src="media/judge.gif" alt="Judge Demo Gif"/>

<details>
  <summary>General setting for both Testcase Window and Stress Tester</summary>

- `maxDisplayCharacters`: Maximum number of characters to display for each output
- `maxDisplayLines`: Maximum number of lines to display for each output
</details>

---

### 🐞 Stress Tester

Required files (naming scheme can be configured in settings):

- `<name>.[ext]`: the solution to bruteforce against
- `<name>__Good.[ext]`: the solution that outputs the correct answer
- `<name>__Generator.[ext]`: to generate inputs for the other 2 files
  - **The extension provides a 64-bit integer seed input for random number generators!**

- **💡TIP**: To stress test for **Runtime Error** instead of **Wrong Answer**, have the good solution be the same as the one to bruteforce against!

|                   ![Stress Tester Gif](media/stress_tester.gif)                    |
| :--------------------------------------------------------------------------------: |
| _Stress Tester was able to find an counterexample due to an integer overflow bug!_ |

<details>
  <summary>Settings for Stress Tester</summary>

- `goodSolutionFile`: Full path for good solution file (supports `${...}`)
- `generatorFile`: Full path for generator file (supports `${...}`)
- `delayBetweenTestcases`: Amount of delay between generated testcases in milliseconds **(minimum: `5`)**
- `stressTestcaseTimeLimit`: Maximum time in milliseconds the Stress Tester is allowed to spend on one testcase **(`0` for no limit)**
- `stressTimeLimit`: Maximum time in milliseconds the Stress Tester is allowed to run **(`0` for no limit)**
</details>

---

### 👜 Inserting Prewritten Code

- Add the root directory of the templates to the settings
- **NOTE**: Remove trailing newlines for fold to work (folding is optional via settings)
  - Folding depends on VSCode support, which may require other extensions depending on the language.

| ![Insert File Template Gif](media/insert_file_template.gif) |
| :---------------------------------------------------------: |
| _Adding a tree reroot DP template without switching files_  |

<details>
  <summary>Possible settings</summary>

- `fileTemplatesBaseDirectory`: Full path to the base directory of all prewritten files (supports `${...}`)
- `fileTemplatesDependencies` (optional): Maps a template path relative to base directory to a list of other relative template paths that this one depends on
- `foldFileTemplate` (default: `false`): Whether to fold the newly inserted prewritten code
</details>

---

### 🛜 Competitive Companion

|      ![Problem Parsing Gif](media/problem_parsing.gif)      |
| :---------------------------------------------------------: |
| _Using Competitive Companion to parse a CodeForces problem_ |

| ![Contest Parsing Gif](media/contest_parsing.gif) |
| :-----------------------------------------------: |
|   _We can parse an entire CodeForces Contest!_    |

<details>
  <summary>Settings for Competitive Companion integration</summary>

- `openSelectedFiles` (default: `true`): Whether to open all the selected files
- `askForWhichFile` (default: `false`): Ask for which file to write testcase onto, even when a file is currently opened and only a single problem has been received
- `includePattern` (default: `**/*`): Glob pattern to filter in the included files for asking prompt
- `excludePattern` (default: _empty_): Glob pattern to filter out the included files for asking prompt
- `port` (default: _1327_): Port number to listen from Competitive Companion
</details>

---

### © Attributions

- [FastOlympicCoding](https://github.com/Jatana/FastOlympicCoding): The original Sublime Text package that inspired this extension 💖
- [Flaticon](https://www.flaticon.com/): Icon for this extension 💖
