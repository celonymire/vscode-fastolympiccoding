<h1 align="center">⚡ Fast Olympic Coding ⚡</h1>

![Testcases Gif](media/banner.png)

<p align="center">
<img src="https://vsmarketplacebadges.dev/version-short/sam20908.vscode-fastolympiccoding.svg">
<img src="https://vsmarketplacebadges.dev/installs-short/sam20908.vscode-fastolympiccoding.svg">
<img src="https://vsmarketplacebadges.dev/rating-short/sam20908.vscode-fastolympiccoding.svg">
</p>
<p align="center">
<img src="https://img.shields.io/open-vsx/v/sam20908/vscode-fastolympiccoding">
<img src="https://img.shields.io/open-vsx/dt/sam20908/vscode-fastolympiccoding?style=flat">
<img src="https://img.shields.io/open-vsx/rating/sam20908/vscode-fastolympiccoding">
</p>

<p align="center"><i>Once a mighty Competitive Programming plugin... Reborn with the powers of VSCode!</i></p>

## ⚡ Overview

- [📜](#-judge) Minimal and **adaptive** UI for maximized functionality and view utilization
- [🪲](#-debugging) Extension agnostic configuration for VSCode debugging UX with real-time inputs
- [🐞](#-stress-tester) Built-in stress tester as a first-class feature
- [🗨️](#️-interactive-mode) First-class support for interactive problems within **both** [Judge](#-judge) and [Stress Tester](#-stress-tester)!
- [🛜](#-competitive-companion) Support for [Competitive Companion](https://github.com/jmerle/competitive-companion) to gather problem inputs easily
- [👜](#-inserting-prewritten-code) Insert file templates without leaving your code
- ⚡ **_BLAZINGLY FAST!_** Asynchronous design + optimizations = **99%** spam proof!

#### 📥 Fast Olympic Coding is available on [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=sam20908.vscode-fastolympiccoding) and [Open VSX Registry](https://open-vsx.org/extension/sam20908/vscode-fastolympiccoding)

---

### </> Setting Up

Provide run settings for the languages you use in `runSettings.json` at the root folder. Here is the default example configuration for C++, Python, and Java:

```json
{
  ".cpp": {
    "compileCommand": ["g++", "${file}", "-o", "${fileDirname}/${fileBasenameNoExtension}"],
    "runCommand": ["${fileDirname}/${fileBasenameNoExtension}"]
  },
  ".py": {
    "runCommand": ["python", "${file}"]
  },
  ".java": {
    "compileCommand": ["javac", "${file}"],
    "runCommand": ["java", "-cp", "${fileDirname}", "${fileBasenameNoExtension}"]
  }
}
```

We can use [VSCode's built-in variables](https://code.visualstudio.com/docs/editor/variables-reference) which has the syntax of `${...}` and will get resolved by the extension. **`${defaultBuildTask}` is not supported because it requires resolving the entire build configuration which is super slow!**

💡 Since `runSettings.json` applies recursively to subdirectories, you can specialize parts of the configuration within specific directories. The extension traverses from the workspace root directory up to the file folder, merging the settings along the way in that order.

**Example structure:**

```
workspace/
├── runSettings.json          # Base settings for entire workspace
├── contests/
│   ├── runSettings.json      # Overrides for contests folder
│   └── codeforces/
│       ├── runSettings.json  # Overrides for codeforces folder
│       └── solution.cpp      # Uses merged settings from all 3 files
```

<details>
  <summary>Settings per language</summary>

- `compileCommand` (optional): Command to run before `runCommand` when the file content changed
- `runCommand`: Command to run the solution
- `currentWorkingDirectory` (optional): sets the current working directory for `runCommand`
</details>

---

### 📜 Judge

Minimalistic UI from the old plugin have been reimagined to integrate VSCode's capabilities while maintaining the principle of maximum functionality within minimized space. The new UI experience is integrated into both Judge and Stress Tester views.

ℹ️ **You can mix languages!** For example, you can have a C++ solution and a Python interactor. This automatically applies to stress tester as well!

- Run, edit, hide, skip testcases, you name it!
- Hidden optimizations such as batched IO, truncating huge IO, and cached compilations.
- Icons and tooltips to save space while being self-explanatory
- Dedicated popup for compiler errors with color support
- ... and so much more!

<img src="media/judge.gif" alt="Judge Demo Gif"/>

<details>
  <summary>General setting for both Testcase Window and Stress Tester</summary>

- `maxDisplayCharacters`: Maximum number of characters to display for each output
- `maxDisplayLines`: Maximum number of lines to display for each output
</details>

---

### 🪲 Debugging

The extension typically attaches the debugger to an existing process, which allows custom inputs to be propagated to the program. However, each language has its own set of tooling. Adapt the commands as necessary!

**🚨Please use `${debugPort}` as the port for your debugging servers!** The hand-picked port provides the following benefits:

1. The port is free
2. Detects when the debugging server fails to launch at the chosen port within a timeframe
3. Frees the port when error occurs

**‼️NOT ALL DEBUGGERS ARE EQUAL!** Between debugging servers for the same language, they may not have the same set of features or work the same way! Same warning applies to VSCode debugger extensions!

![Debugging Gif](media/debugging.gif)

<details>
  <summary>Additional language settings for debugging support</summary>

- `debugCommand`: Command to start the solution under a debug server
- `debugAttachConfig`: Name of `launch.json` attach configuration.
</details>

<details>
  <summary>©️ Example C++ configuration</summary>

I recommend either Microsoft's official [**C/C++**](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) or [**Native Debug**](https://marketplace.visualstudio.com/items?itemName=webfreak.debug). CodeLLDB does not work because `lldb-server` cannot send real-time inputs.

**‼️C++ (and other compiled languages) requires debug symbols to be compiled in!** Easiest way is to add `-g` flag to your compile command.

🔔 Since both of them work with `gdbserver`, ensure that is installed, which is also what I tested with.

Here are the steps for **Native Debug**, which should be very similar with **Microsoft C/C++**:

1. Add these settings for `.cpp`:

```json
{
  ".cpp": {
    // compile and run configurations from above...
    "debugCommand": ["gdbserver", ":${debugPort}", "${fileDirname}/${fileBasenameNoExtension}"],
    "debugAttachConfig": "GDB: Attach"
  }
}
```

1. Create a GDB attach configuration in `.vscode/launch.json`:

```json
{
  "configurations": [
    {
      "name": "GDB: Attach",
      "type": "gdb",
      "request": "attach",
      "executable": "${fileDirname}/${fileBasenameNoExtension}",
      "target": ":${debugPort}",
      "remote": true,
      "cwd": "${workspaceRoot}",
      "valuesFormatting": "prettyPrinters"
    }
  ]
}
```

</details>

<details>
  <summary>🐍 Example Python configuration</summary>

I recommend Microsoft's official [**Python Debugger**](https://marketplace.visualstudio.com/items?itemName=ms-python.debugpy) for the best experience. The extension has built-in support for `debugpy`, which is the de-facto Python debugging server.

🔔 Ensure you have `debugpy` installed via `pip`.

Here are the steps for **Python Debugger**:

1. Add these settings for `.py`:

```json
{
  ".py": {
    // compile and run configurations from above...
    "debugCommand": [
      "python",
      "-m",
      "debugpy",
      "--listen",
      "${debugPort}",
      "--wait-for-client",
      "${file}"
    ],
    "debugAttachConfig": "Python: Attach"
  }
}
```

1. Create a `debugpy` attach configuration in `.vscode/launch.json`:

```json
{
  "configurations": [
    {
      "name": "Python: Attach",
      "type": "debugpy",
      "request": "attach",
      "connect": {
        "port": "${debugPort}"
      },
      "justMyCode": true
    }
  ]
}
```

</details>

<details>
  <summary>♨️ Example Java configuration</summary>

I recommend Microsoft's official [**Debugger for Java**](https://marketplace.visualstudio.com/items?itemName=vscjava.vscode-java-debug) for the best experience. For some reason, Oracle's **Java** extension ignores breakpoints.

**‼️Compile your Java files with debug symbols!** Add `-g` flag to your compile command.

🔔 Ensure you have **Java Development Kit** version 1.8+ installed.

Here are the steps for **Debugger for Java**:

1. Add these settings for `.java`:

```json
{
  ".java": {
    // compile and run configurations from above...
    "debugCommand": [
      "java",
      "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=${debugPort}",
      "-cp",
      "${fileDirname}",
      "${fileBasenameNoExtension}"
    ],
    "debugAttachConfig": "Java: Attach"
  }
}
```

1. Create a Java attach configuration in `.vscode/launch.json`:

```json
{
  "configurations": [
    {
      "name": "Java: Attach",
      "type": "java",
      "request": "attach",
      "hostName": "localhost",
      "port": "${debugPort}"
    }
  ]
}
```

</details>

---

### 🐞 Stress Tester

We need both a file that outputs the correct solution and another that outputs a random input to both the current and correct solution. Additional information needs to be added to `runSettings.json` to tell the Stress Tester the names of these files. Here is the default example provided by the extension:

```json
{
  "generatorFile": "${fileDirname}/${fileBasenameNoExtension}__Generator${fileExtname}",
  "goodSolutionFile": "${fileDirname}/${fileBasenameNoExtension}__Good${fileExtname}"
}
```

**✨ The extension provides a 64-bit integer seed input for random number generators!**

**💡TIP**: To stress test for **Runtime Error** instead of **Wrong Answer**, have the good solution be the same as the one to bruteforce against!

| ![Stress Tester Gif](media/stress_tester.gif) |
| :-------------------------------------------: |
|         _Demo of stress testing A+B!_         |

<details>
  <summary>Settings for Stress Tester</summary>

- `delayBetweenTestcases`: Amount of delay between generated testcases in milliseconds
- `stressTestcaseTimeLimit`: Maximum time in milliseconds the Stress Tester is allowed to spend on one testcase
- `stressTestcaseMemoryLimit`: Maximum time in megabytes the Stress Tester is allowed to use on one testcase
- `stressTimeLimit`: Maximum time in milliseconds the Stress Tester is allowed to run
</details>

---

### 🗨️ Interactive Mode

We need to tell the extension the name of our interactor file. Here is the default example provided by the extension:

```json
{
  "interactorFile": "${fileDirname}/${fileBasenameNoExtension}__Interactor${fileExtname}"
}
```

**✨ The interactor becomes the judge during stress test in interactive mode!**

‼️**FLUSH YOUR OUTPUTS!** Even though this requirement has been stated in every interactive problem, it is still worth mentioning in case the files are interacting weirdly. **FLUSHING SHOULD BE THE FIRST THING TO DOUBLE CHECK**.

Due to the lack of standardization of interactor's results, I have taken the middle ground of various online judges' interactor's behavior. **The exit code of the interactor will be used to determine the acceptance of the solution**. Below lists the exit codes and the verdict:

| Code                      | Verdict          |
| ------------------------- | ---------------- |
| 0                         | ✅ Accepted      |
| Non-zero                  | ❌ Wrong Answer  |
| _null_ (often from crash) | ⚠️ Runtime Error |

**ℹ️ Partial points are not supported!**

Interactive testcases have a special badge to make them distinguishable. If there is no set secret, the testcase will ask you to provide one. **This is a multi-line textbox because you have to give all the data in one go!**

| ![Interactive Workflow Gif](media/interactive-workflow.gif) |
| :---------------------------------------------------------: |
| _The convenient workflow of running interactive testcases!_ |

|      ![Interactive Stress Test Gif](media/interactive-stress-test.gif)      |
| :-------------------------------------------------------------------------: |
| _Stress testing interactives is almost the same as regular stress testing!_ |

---

### 🛜 Competitive Companion

[Competitive Companion](https://github.com/jmerle/competitive-companion) is a widely recognized browser plugin to conveniently fetch problem inputs. The plugin works with wide range of online judges and is actively maintained. Native support has been integrated directly into the extension for optimal workflow.

|      ![Problem Parsing Gif](media/problem_parsing.gif)      |
| :---------------------------------------------------------: |
| _Using Competitive Companion to parse a CodeForces problem_ |

| ![Contest Parsing Gif](media/contest_parsing.gif) |
| :-----------------------------------------------: |
|   _We can parse an entire CodeForces Contest!_    |

<details>
  <summary>Settings for Competitive Companion integration</summary>

- `automaticallyStartCompetitiveCompanion` (default: `true`): Automatically start listening for Competitive Companion when VSCode starts
- `openSelectedFiles` (default: `true`): Whether to open all the selected files
- `askForWhichFile` (default: `false`): Ask for which file to write testcase onto, even when a file is currently opened and only a single problem has been received
- `includePattern` (default: `**/*`): Glob pattern to filter in the included files for asking prompt
- `excludePattern` (default: _empty_): Glob pattern to filter out the included files for asking prompt
- `port` (default: _1327_): Port number to listen from Competitive Companion
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

### © Attributions

- [FastOlympicCoding](https://github.com/Jatana/FastOlympicCoding): The original Sublime Text package that inspired this extension 💖
- [Flaticon](https://www.flaticon.com/): Icon for this extension 💖
