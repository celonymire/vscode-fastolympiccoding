# Debugging

The extension typically attaches the debugger to an existing process, which allows custom inputs to be propagated to the program. However, each language has its own set of tooling. Adapt the commands as necessary!

![Debugging Gif](../media/debugging.gif)

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
    "debugCommand": [
      "gdbserver",
      ":${debugPort}",
      "${fileDirname}/${fileBasenameNoExtension}${exeExtname}"
    ],
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
      "executable": "${fileDirname}/${fileBasenameNoExtension}${exeExtname}",
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
