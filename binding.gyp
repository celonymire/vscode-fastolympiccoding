{
  "targets": [
    {
      "target_name": "win32-process-monitor",
      "sources": [
        "src/addons/win32-process-monitor.cpp"
      ],
      "include_dirs": [
        "<!(node -p \"require('node-addon-api').include_dir\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "conditions": [
        ["OS != \"win\"", { "type": "none" }]
      ]
    },
    {
      "target_name": "linux-process-monitor",
      "sources": [
        "src/addons/linux-process-monitor.cpp"
      ],
      "include_dirs": [
        "<!(node -p \"require('node-addon-api').include_dir\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "conditions": [
        ["OS != \"linux\"", { "type": "none" }]
      ]
    },
    {
      "target_name": "darwin-process-monitor",
      "sources": [
        "src/addons/darwin-process-monitor.cpp"
      ],
      "include_dirs": [
        "<!(node -p \"require('node-addon-api').include_dir\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "conditions": [
        ["OS != \"mac\"", { "type": "none" }]
      ]
    },
    {
      "target_name": "rlimit-wrapper",
      "type": "executable",
      "sources": [
        "src/addons/rlimit-wrapper.c"
      ],
      "conditions": [
        ["OS != \"mac\"", { "type": "none" }]
      ]
    }
  ]
}
